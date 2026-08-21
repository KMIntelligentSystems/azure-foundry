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

/** One stateless Responses call. Returns parsed function calls + text. */
export async function callLlm(opts: CallOpts): Promise<LlmResult> {
  const res = await fetch(`${ENDPOINT}/openai/v1/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await bearer()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      instructions: opts.instructions,
      input: opts.input,
      tools: opts.tools ?? [],
      tool_choice: (opts.tools?.length ?? 0) > 0 ? "auto" : "none",
      temperature: 0,
      max_output_tokens: opts.maxOutputTokens ?? 4096,
      store: false,
    }),
  });
  if (!res.ok) {
    throw new Error(`Foundry Responses HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
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
