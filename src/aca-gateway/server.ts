/**
 * ACA synchronous WebSocket gateway.
 *
 * The browser keeps one socket open for the whole orchestrator turn. Events
 * stream as NDJSON-like WebSocket messages; the final result terminates the
 * turn without converting it into an asynchronous job/polling workflow.
 */
import http from "node:http";
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  runDynamicOrchestrator,
  type DynamicOrchestratorEvent,
} from "../hosted-agent/dynamic-orchestrator.js";

const PORT = Number(process.env["PORT"] ?? 8080);
const ALLOWED_ORIGINS = (process.env["ALLOWED_ORIGINS"] ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean);
const ALLOW_INSECURE_USER_ID = process.env["ALLOW_INSECURE_USER_ID"] === "true";
const CLIENT_ID = process.env["ACA_GATEWAY_CLIENT_ID"] ?? "";
const TENANT_ID = process.env["ENTRA_TENANT_ID"] ?? "";
const ADMIN_OBJECT_IDS = new Set((process.env["ADMIN_OBJECT_IDS"] ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
const OPENID_CONFIG = process.env["OPENID_CONFIG_URL"] ?? `https://login.microsoftonline.com/${TENANT_ID || "common"}/v2.0/.well-known/openid-configuration`;

interface PromptMessage {
  type: "prompt";
  conversation_id?: string;
  promptText: string;
  user_id?: string;
  access_token?: string;
}

interface ResumeMessage {
  type: "resume";
  conversation_id: string;
  after_event?: number;
  user_id?: string;
  access_token?: string;
}

type ClientMessage = PromptMessage | ResumeMessage;

interface AuthenticatedUser {
  id: string;
  claims: Record<string, unknown>;
}

type Jwk = Record<string, unknown> & { kid?: string; kty?: string; alg?: string; n?: string; e?: string };

let openIdCache: { jwksUri: string; expiresAt: number } | null = null;
let jwksCache: { keys: Jwk[]; expiresAt: number } | null = null;

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

async function jwksUri(): Promise<string> {
  if (openIdCache && openIdCache.expiresAt > Date.now()) return openIdCache.jwksUri;
  const response = await fetch(OPENID_CONFIG);
  if (!response.ok) throw new Error(`OpenID configuration HTTP ${response.status}`);
  const body = await response.json() as { jwks_uri?: string };
  if (!body.jwks_uri) throw new Error("OpenID configuration lacks jwks_uri");
  openIdCache = { jwksUri: body.jwks_uri, expiresAt: Date.now() + 60 * 60 * 1000 };
  return body.jwks_uri;
}

async function signingKeys(): Promise<Jwk[]> {
  if (jwksCache && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  const response = await fetch(await jwksUri());
  if (!response.ok) throw new Error(`JWKS HTTP ${response.status}`);
  const body = await response.json() as { keys?: Jwk[] };
  jwksCache = { keys: body.keys ?? [], expiresAt: Date.now() + 60 * 60 * 1000 };
  return jwksCache.keys;
}

async function authenticate(message: Pick<PromptMessage, "user_id" | "access_token">): Promise<AuthenticatedUser> {
  if (ALLOW_INSECURE_USER_ID) {
    const id = String(message.user_id ?? "").trim().toLowerCase();
    if (!id) throw new Error("user_id is required in insecure local mode");
    return { id, claims: {} };
  }
  if (!CLIENT_ID || !TENANT_ID) throw new Error("ACA_GATEWAY_CLIENT_ID and ENTRA_TENANT_ID must be configured");
  const token = String(message.access_token ?? "");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("access_token is required");
  const header = decodeSegment(parts[0]);
  const claims = decodeSegment(parts[1]);
  if (header["alg"] !== "RS256" || typeof header["kid"] !== "string") throw new Error("unsupported token signature");
  const key = (await signingKeys()).find((candidate) => candidate.kid === header["kid"]);
  if (!key) throw new Error("token signing key not found");
  const cryptoKey = createPublicKey({ key: key as any, format: "jwk" });
  const verified = verifySignature(
    "RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), cryptoKey, Buffer.from(parts[2], "base64url"),
  );
  if (!verified) throw new Error("invalid access_token signature");
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims["exp"] !== "number" || claims["exp"] <= now) throw new Error("access_token expired");
  if (claims["tid"] !== TENANT_ID) throw new Error("access_token tenant mismatch");
  const acceptedIssuers = new Set([`https://login.microsoftonline.com/${TENANT_ID}/v2.0`, `https://sts.windows.net/${TENANT_ID}/`]);
  if (typeof claims["iss"] !== "string" || !acceptedIssuers.has(claims["iss"])) throw new Error("access_token issuer mismatch");
  const aud = claims["aud"];
  const acceptedAudiences = new Set([CLIENT_ID, `api://${CLIENT_ID}`]);
  if (!(typeof aud === "string" && acceptedAudiences.has(aud)) &&
      !(Array.isArray(aud) && aud.some((value) => typeof value === "string" && acceptedAudiences.has(value)))) {
    throw new Error("access_token audience mismatch");
  }
  const objectId = String(claims["oid"] ?? "").trim().toLowerCase();
  const id = ADMIN_OBJECT_IDS.has(objectId)
    ? "admin"
    : String(claims["preferred_username"] ?? objectId ?? claims["sub"] ?? "").trim().toLowerCase();
  if (!id) throw new Error("access_token has no stable user identity");
  return { id, claims };
}

function allowedOrigin(origin: string | undefined): boolean {
  if (ALLOWED_ORIGINS.length === 0) return true;
  return Boolean(origin && ALLOWED_ORIGINS.includes(origin));
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

interface ActiveTurn {
  conversationId: string;
  userId: string;
  promptText: string;
  subscribers: Set<WebSocket>;
  messages: unknown[];
  completed: boolean;
}

const activeTurns = new Map<string, ActiveTurn>();

function publish(turn: ActiveTurn, payload: unknown): void {
  turn.messages.push(payload);
  for (const subscriber of turn.subscribers) send(subscriber, payload);
}

function dynamicWireEvent(turn: ActiveTurn, event: DynamicOrchestratorEvent): void {
  const conversationId = turn.conversationId;
  switch (event.type) {
    case "orchestrator_start":
      publish(turn, { type: "agent_event", event: { type: "agent_start", conversationId, prompt: turn.promptText } });
      break;
    case "orchestrator_round_start":
      publish(turn, { type: "agent_event", event: { type: "planning_start", conversationId, round: event.round ?? 1 } });
      break;
    case "orchestrator_actions": {
      const delegates = (event.actions ?? []).flatMap((action) =>
        action.type === "delegate" ? [action]
          : action.type === "delegate_parallel" ? action.tasks.map((task, index) => ({ type: "delegate" as const, callId: `${action.callId}:${index}`, ...task }))
            : [],
      );
      if (delegates.length > 0) {
        publish(turn, {
          type: "agent_event",
          event: {
            type: "plan", conversationId, round: event.round ?? 1,
            rationale: `Dynamic orchestrator delegated ${delegates.length} specialist task(s)${(event.actions ?? []).some((action) => action.type === "delegate_parallel") ? " as an explicit parallel batch" : ""}.`,
            continuePlanning: true,
            steps: delegates.map((action) => ({ role: action.agent, task: action.task, deployment: action.deployment })),
          },
        });
      }
      break;
    }
    case "delegation_start":
      if (event.action) {
        publish(turn, { type: "agent_event", event: {
          type: "step_start", conversationId, round: event.round ?? 1, index: 0,
          role: event.action.agent, deployment: event.action.deployment, task: event.action.task,
        } });
      }
      break;
    case "delegation_end":
      if (event.result) {
        publish(turn, { type: "agent_event", event: {
          type: "step_end", conversationId, round: event.round ?? 1, index: 0,
          role: event.result.agent, deployment: event.result.deployment,
          output: event.result.summary, usage: event.result.usage,
          modelCalls: event.result.modelCalls, toolExecutions: event.result.toolExecutions,
          terminatedBy: event.result.status === "succeeded" ? "finish" : "limit",
        } });
      }
      break;
    case "orchestrator_error":
      publish(turn, { type: "agent_event", event: { type: "agent_error", conversationId, error: event.error ?? "dynamic orchestrator failed" } });
      break;
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/readiness") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404).end();
});

const sockets = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const origin = req.headers.origin;
  if (url.pathname !== "/ws/agent" || !allowedOrigin(origin)) {
    console.warn(`[aca-gateway] websocket upgrade rejected path=${url.pathname} origin=${origin ?? "(none)"}`);
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws, req));
});

sockets.on("connection", (socket, request) => {
  const origin = request.headers.origin ?? "(none)";
  const forwardedFor = request.headers["x-forwarded-for"] ?? request.socket.remoteAddress ?? "(unknown)";
  console.log(`[aca-gateway] websocket connected origin=${origin} forwardedFor=${forwardedFor}`);
  let working = false;
  let alive = true;
  socket.on("pong", () => { alive = true; });
  const heartbeat = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    if (socket.readyState === WebSocket.OPEN) {
      socket.ping();
      send(socket, { type: "heartbeat", at: new Date().toISOString(), working });
    }
  }, 25_000);
  socket.on("close", (code, reason) => {
    clearInterval(heartbeat);
    for (const turn of activeTurns.values()) turn.subscribers.delete(socket);
    console.log(`[aca-gateway] websocket closed code=${code} reason=${reason.toString() || "(none)"} working=${working}`);
  });
  socket.on("error", (error) => console.error(`[aca-gateway] websocket error: ${error.message}`));
  send(socket, { type: "ready" });

  socket.on("message", async (bytes) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(bytes.toString()) as ClientMessage;
    } catch {
      send(socket, { type: "error", error: "invalid JSON" });
      return;
    }
    if (message.type === "resume") {
      try {
        const user = await authenticate(message);
        const turn = activeTurns.get(message.conversation_id);
        if (!turn) throw new Error("active turn not found; submit a new prompt");
        if (turn.userId !== user.id) throw new Error("active conversation belongs to another user");
        turn.subscribers.add(socket);
        working = !turn.completed;
        const after = Number.isInteger(message.after_event) && Number(message.after_event) >= 0
          ? Number(message.after_event)
          : 0;
        for (const payload of turn.messages.slice(after)) send(socket, payload);
      } catch (error) {
        send(socket, { type: "error", error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (message.type !== "prompt" || !message.promptText?.trim()) {
      send(socket, { type: "error", error: "promptText is required" });
      return;
    }
    if (working) {
      send(socket, { type: "error", error: "a synchronous turn is already running on this socket" });
      return;
    }

    working = true;
    try {
      const user = await authenticate(message);
      const conversationId = message.conversation_id?.trim() || `conv-${Date.now()}`;
      const existing = activeTurns.get(conversationId);
      if (existing && !existing.completed) {
        if (existing.userId !== user.id) throw new Error("active conversation belongs to another user");
        existing.subscribers.add(socket);
        for (const payload of existing.messages) send(socket, payload);
        return;
      }

      const turn: ActiveTurn = {
        conversationId,
        userId: user.id,
        promptText: message.promptText,
        subscribers: new Set([socket]),
        messages: [],
        completed: false,
      };
      activeTurns.set(conversationId, turn);
      const runId = conversationId; // conversation owns pending artifacts across follow-up turns
      void runDynamicOrchestrator(message.promptText, {
        runId,
        userId: user.id,
        eventSink: (event) => dynamicWireEvent(turn, event),
      }).then((dynamic) => {
        const result = {
          ok: dynamic.ok,
          conversationId,
          runId,
          response: dynamic.response,
          steps: dynamic.delegations.map((item) => ({
            role: item.agent, deployment: item.deployment, output: item.summary,
            usage: item.usage, modelCalls: item.modelCalls,
            toolExecutions: item.toolExecutions,
            terminatedBy: item.status === "succeeded" ? "finish" : "limit",
          })),
          artifacts: dynamic.artifacts.map((artifact) => ({
            id: artifact.id,
            runId: artifact.runId,
            agent: artifact.agent,
            callId: artifact.callId,
            path: artifact.path,
            kind: artifact.kind,
            bytes: artifact.bytes,
            mimeType: artifact.mimeType,
          })),
          totals: dynamic.usage,
        };
        publish(turn, { type: "agent_event", event: { type: "agent_end", conversationId, ok: dynamic.ok } });
        publish(turn, { type: "result", result });
        turn.completed = true;
      }).catch((error) => {
        publish(turn, { type: "error", error: error instanceof Error ? error.message : String(error) });
        turn.completed = true;
      });
    } catch (error) {
      send(socket, { type: "error", error: error instanceof Error ? error.message : String(error) });
    } finally {
      working = false;
    }
  });
});

server.listen(PORT, () => {
  console.log(`[aca-gateway] listening on :${PORT} (WS /ws/agent, GET /health)`);
});
