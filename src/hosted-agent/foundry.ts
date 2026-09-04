/**
 * foundry.ts — the ONLY module that talks to the LLM. Every model call in
 * this container crosses one of the two functions below; nothing else in
 * the codebase holds an Authorization header or an endpoint URL.
 *
 * Auth: sandbox-injected agent identity (DefaultAzureCredential); token
 * cached for the process and refreshed on expiry. Stateless calls
 * (store:false) — each request is a pure function of its payload.
 */
import { DefaultAzureCredential } from "@azure/identity";

export const ENDPOINT =
  process.env["FOUNDRY_PROJECT_ENDPOINT"] ??
  process.env["AZURE_AI_PROJECT_ENDPOINT"] ??
  "https://forecastingmodule.services.ai.azure.com/api/projects/proj-default";

const SCOPE = "https://ai.azure.com/.default";
const MAX_RESPONSE_ATTEMPTS = Math.max(1, Number(process.env["FOUNDRY_MAX_ATTEMPTS"] ?? 6));
const MAX_RETRY_DELAY_MS = Math.max(1_000, Number(process.env["FOUNDRY_MAX_RETRY_DELAY_MS"] ?? 120_000));
const credential = new DefaultAzureCredential();
let cached: { token: string; expiresAt: number } | null = null;

async function bearer(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const t = await credential.getToken(SCOPE);
  cached = { token: t.token, expiresAt: t.expiresOnTimestamp };
  return t.token;
}

export interface ToolSpec {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

export interface FunctionCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LlmResult {
  functionCalls: FunctionCall[];
  text: string;
  usage: { input: number; output: number };
  /** Raw output items — a tool loop MUST append these to its input before the
   *  function_call_output items (the API correlates outputs by call_id against
   *  echoed function_call items; omitting them 400s). */
  rawOutput: unknown[];
}

export interface CallOpts {
  model: string;
  instructions: string;
  input: unknown[];
  tools?: ToolSpec[];
  maxOutputTokens?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function durationMs(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const raw = value.trim();
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw) * 1_000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  let total = 0;
  let matched = false;
  for (const part of raw.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h)/gi)) {
    matched = true;
    const amount = Number(part[1]);
    const unit = part[2].toLowerCase();
    total += amount * (unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000);
  }
  return matched ? total : undefined;
}

function milliseconds(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : durationMs(value);
}

export function retryDelayMs(headers: Headers, attempt: number): number {
  const candidates = [
    milliseconds(headers.get("retry-after-ms")),
    milliseconds(headers.get("x-ms-retry-after-ms")),
    durationMs(headers.get("retry-after")),
    durationMs(headers.get("x-ratelimit-reset-requests")),
    durationMs(headers.get("x-ratelimit-reset-tokens")),
  ].filter((value): value is number => value !== undefined && Number.isFinite(value));
  const exponential = Math.min(MAX_RETRY_DELAY_MS, 2_000 * (2 ** Math.max(0, attempt - 1)));
  const serverDelay = candidates.length ? Math.max(...candidates) : 0;
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(exponential, serverDelay) + jitter);
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** One stateless Responses call. Returns parsed function calls + text. */
export async function callLlm(opts: CallOpts): Promise<LlmResult> {
  const body = JSON.stringify({
    model: opts.model,
    instructions: opts.instructions,
    input: opts.input,
    tools: opts.tools ?? [],
    tool_choice: (opts.tools?.length ?? 0) > 0 ? "auto" : "none",
    parallel_tool_calls: true,
    temperature: 0,
    max_output_tokens: opts.maxOutputTokens ?? 4096,
    store: false,
  });

  let res: Response | undefined;
  let lastNetworkError: unknown;
  for (let attempt = 1; attempt <= MAX_RESPONSE_ATTEMPTS; attempt++) {
    try {
      res = await fetch(`${ENDPOINT}/openai/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await bearer()}`,
          "Content-Type": "application/json",
        },
        body,
      });
      if (res.ok) break;
      const detail = (await res.text()).slice(0, 400);
      if (!retryableStatus(res.status) || attempt === MAX_RESPONSE_ATTEMPTS) {
        throw new Error(`Foundry Responses HTTP ${res.status} after ${attempt} attempt(s): ${detail}`);
      }
      const delay = retryDelayMs(res.headers, attempt);
      console.warn(`[foundry] HTTP ${res.status} for ${opts.model}; retry ${attempt + 1}/${MAX_RESPONSE_ATTEMPTS} in ${delay}ms`);
      await sleep(delay);
      res = undefined;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Foundry Responses HTTP")) throw error;
      lastNetworkError = error;
      if (attempt === MAX_RESPONSE_ATTEMPTS) break;
      const delay = Math.min(MAX_RETRY_DELAY_MS, 2_000 * (2 ** Math.max(0, attempt - 1)) + Math.floor(Math.random() * 500));
      console.warn(`[foundry] network failure for ${opts.model}; retry ${attempt + 1}/${MAX_RESPONSE_ATTEMPTS} in ${delay}ms`);
      await sleep(delay);
    }
  }
  if (!res?.ok) {
    throw new Error(`Foundry Responses network failure after ${MAX_RESPONSE_ATTEMPTS} attempt(s): ${lastNetworkError instanceof Error ? lastNetworkError.message : String(lastNetworkError ?? "no response")}`);
  }
  const data = (await res.json()) as { output?: any[]; usage?: any };
  const output = data.output ?? [];
  const functionCalls: FunctionCall[] = output
    .filter((o) => o?.type === "function_call")
    .map((o) => {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(o.arguments ?? "{}"); } catch { /* malformed args → empty */ }
      return { callId: o.call_id ?? "", name: o.name ?? "", args };
    });
  const text = output
    .filter((o) => o?.type === "message")
    .flatMap((o) => o.content ?? [])
    .map((c: any) => c?.text ?? "")
    .join("");
  return {
    functionCalls,
    text,
    usage: {
      input: data.usage?.input_tokens ?? 0,
      output: data.usage?.output_tokens ?? 0,
    },
    rawOutput: output,
  };
}
