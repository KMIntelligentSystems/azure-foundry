/**
 * hosted-agent hello — minimal code-first Foundry hosted agent.
 *
 * Container contract (Invocations protocol, hand-rolled):
 *   GET  /health       → {ok:true}                        (platform health check)
 *   POST /invocations  → arbitrary JSON in, JSON out      (our agent surface)
 *
 * The sandbox injects an agent identity (per-agent Entra ID) that
 * DefaultAzureCredential picks up; the model call below proves the
 * "hooks into Foundry" path without any stored secret.
 */
import http from "node:http";
import { DefaultAzureCredential } from "@azure/identity";
import { runDynamicOrchestrator } from "./dynamic-orchestrator.js";

// The Foundry gateway routes to containers on 8088; the protocol libraries
// (Py/.NET) also expose /readiness — hand-rolled, so we implement both.
const PORT = Number(process.env["PORT"] ?? 8088);
const ENDPOINT =
  process.env["AZURE_AI_PROJECT_ENDPOINT"] ??
  process.env["FOUNDRY_PROJECT_ENDPOINT"] ??
  "https://forecastingmodule.services.ai.azure.com/api/projects/proj-default";
const MODEL = process.env["MODEL_DEPLOYMENT_NAME"] ?? "gpt-4.1-mini";

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw); } catch { return { _raw: raw }; }
}

async function callModel(prompt: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  try {
    const cred = new DefaultAzureCredential();
    const token = await cred.getToken("https://ai.azure.com/.default");
    const res = await fetch(`${ENDPOINT}/openai/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, input: prompt, max_output_tokens: 128, store: false }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const data = (await res.json()) as { output?: any[] };
    const text = (data.output ?? [])
      .filter((o: any) => o?.type === "message")
      .flatMap((o: any) => o.content ?? [])
      .map((c: any) => c?.text ?? "")
      .join("");
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/readiness")) {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/invocations") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const prompt =
      typeof body?.["promptText"] === "string"
        ? (body["promptText"] as string)
        : typeof body?.["input"] === "string"
          ? (body["input"] as string)
          : "";

    // Chunk-0 hello path kept: probes/agent smoke via {hello:true}.
    if (body?.["hello"] === true || !prompt) {
      const model = await callModel(prompt || "say hello from the hosted agent");
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        agent: "hello-hosted",
        received: body,
        model: { deployment: MODEL, ...model },
        env_seen: Object.keys(process.env).filter((k) => /^(AZURE_|FOUNDRY_|AGENT_|MSI_|IDENTITY_)/.test(k)).sort(),
      }));
      return;
    }

    // Dynamic orchestrator: model-driven delegate/delegate_parallel/finish loop.
    // (The legacy planner stack — planner.ts / validate_plan.ts / orchestrator.ts —
    // is retained in-tree as the earlier synchronous design but has no callers.)
    try {
      const conversationId = typeof body?.["conversation_id"] === "string" && (body["conversation_id"] as string).trim()
        ? (body["conversation_id"] as string)
        : `anon-${Date.now()}`;
      const result = await runDynamicOrchestrator(prompt, {
        runId: conversationId, // conversation owns pending artifacts across follow-up turns
        userId: typeof body?.["user_id"] === "string" ? (body["user_id"] as string) : undefined,
      });
      // The banner carries the platform-injected version so callers can
      // verify which agent version answered (FOUNDRY_AGENT_VERSION is set by
      // the hosted-agent runtime; "dev" locally).
      res.writeHead(result.ok ? 200 : 422, { "Content-Type": "application/json" }).end(JSON.stringify({
        agent: `orchestrator v${process.env["FOUNDRY_AGENT_VERSION"] ?? "dev"} (dynamic delegate→finish)`,
        conversationId,
        ...result,
      }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({
        error: e instanceof Error ? e.message : String(e),
      }));
    }
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.log(`[hello-hosted] listening on :${PORT} (POST /invocations, GET /health)`);
  console.log(`[hello-hosted] env keys: ${Object.keys(process.env).filter((k) => /^(AZURE_|FOUNDRY_|AGENT_|MSI_|IDENTITY_)/.test(k)).sort().join(", ") || "(none)"}`);
});
