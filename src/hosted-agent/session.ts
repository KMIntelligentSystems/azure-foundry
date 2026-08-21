/**
 * session.ts — per-conversation state. The LLM is stateless; this module is
 * the entire memory of the system. Chunk 2 scope: a STEP LEDGER (every step's
 * role, deployment, output, usage) persisted as JSON, so invocations sharing a
 * conversation_id can see prior runs and upstream context.
 *
 * Root selection: $HOME/session when HOME is writable (the hosted sandbox
 * guarantees per-session persistent $HOME); /tmp/session locally.
 * Chunk-3+ upgrade path: durable artifacts go to the artifact service over
 * HTTPS; this stays the in-session working memory.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface StepRecord {
  at: string;
  role: string;
  deployment: string;
  task: string;
  output: string;
  usage: { input: number; output: number };
}

export interface TurnRecord {
  at: string;
  prompt: string;
  planRationale?: string;
  steps: StepRecord[];
  totals: { input: number; output: number };
  ok: boolean;
}

export interface SessionState {
  conversationId: string;
  createdAt: string;
  turns: TurnRecord[];
}

const MAX_TURNS = 50;

function sessionRoot(): string {
  const home = os.homedir();
  const root =
    process.env["SESSION_ROOT"] ??
    (home && fs.existsSync(home) ? path.join(home, "session") : path.join(os.tmpdir(), "session"));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function safeId(id: string): string {
  // conversation_id comes from the caller; never let it become a path escape.
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "anon";
}

function sessionFile(conversationId: string): string {
  return path.join(sessionRoot(), `${safeId(conversationId)}.json`);
}

export function loadSession(conversationId: string): SessionState {
  try {
    const raw = fs.readFileSync(sessionFile(conversationId), "utf8");
    const s = JSON.parse(raw) as SessionState;
    if (Array.isArray(s.turns)) return s;
  } catch { /* missing or corrupt → fresh session */ }
  return { conversationId, createdAt: new Date().toISOString(), turns: [] };
}

export function saveSession(state: SessionState): void {
  state.turns = state.turns.slice(-MAX_TURNS);
  fs.writeFileSync(sessionFile(state.conversationId), JSON.stringify(state, null, 2));
}

/** Prior-step summary fed to the planner's input (chunk-2: last 3 turns).
 *  Includes compact step OUTPUTS — a meta-turn ("now write X from the previous
 *  summary") is unplannable without seeing what the previous summary said. */
export function summarizePrior(state: SessionState): string {
  const recent = state.turns.slice(-3);
  if (recent.length === 0) return "(no prior turns in this conversation)";
  return recent
    .map((t) => {
      const steps = t.steps
        .map((s) => `    · ${s.role} [${s.deployment}]: ${s.output.slice(0, 300)}`)
        .join("\n");
      return `- [${t.at}] prompt: ${t.prompt.slice(0, 140)} → ${t.ok ? "ok" : "failed"}\n${steps}`;
    })
    .join("\n");
}
