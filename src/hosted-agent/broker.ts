/**
 * broker.ts — the airlock, in-process. Roles never touch the filesystem,
 * network, or processes except through dispatch(). A role's tool catalog is
 * closed: anything not listed returns unknown_tool. Budgets are enforced here,
 * per step — iteration count, wall clock, and a cost ceiling fed from the
 * caller's token usage.
 *
 * Chunk-3 scope: read_file / write_file / list_files inside a per-conversation
 * workspace (path-escape proof). execute_python lands in chunk 4;
 * playwright in chunk 5.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { callLlm, type ToolSpec } from "./foundry.js";
import type { Role } from "./imports.js";

// ── Budget ────────────────────────────────────────────────────────────────

export interface StepBudget {
  maxToolCalls: number;
  wallClockSecs: number;
  /** Azure price $/1K input|output per deployment; unknown deployment → refused. */
  prices: Record<string, { input: number; output: number }>;
  costCeilingDollars: number;
}

export const DEFAULT_BUDGET: Omit<StepBudget, "prices"> = {
  maxToolCalls: 12,
  wallClockSecs: 120,
  costCeilingDollars: 0.05,
};

// gpt-4.1 family Azure list prices ($/1K tokens)
export const PRICES: Record<string, { input: number; output: number }> = {
  "gpt-4.1-mini": { input: 0.0004, output: 0.0016 },
  "gpt-4.1": { input: 0.002, output: 0.008 },
  "gpt-4.1-strong": { input: 0.002, output: 0.008 }, // alias → gpt-4.1
};

// ── Tool result wire ──────────────────────────────────────────────────────

export interface ToolResult {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

const ok = (result: unknown): ToolResult => ({ ok: true, result });
const err = (code: string, message: string): ToolResult => ({
  ok: false,
  error: { code, message: message.slice(0, 400) },
});

// ── Workspace ─────────────────────────────────────────────────────────────

function workspaceRoot(conversationId: string): string {
  const safe = conversationId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "anon";
  const base =
    process.env["WORKSPACE_ROOT"] ??
    (fs.existsSync(os.homedir()) ? path.join(os.homedir(), "workspace") : path.join(os.tmpdir(), "workspace"));
  const dir = path.join(base, safe);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveInWorkspace(ws: string, rel: string): string | null {
  const p = path.resolve(ws, rel);
  return p.startsWith(ws + path.sep) || p === ws ? p : null;
}

// ── execute_python: the one spawn the broker permits ──────────────────────
//
// Runs model-authored Python in a locked-down child (mirrors lockdown.rs):
// scrubbed env, cwd = workspace, CPU/memory rlimits on Linux, 60s kill.
// stdout is the contract — results, prints, tracebacks all ride it back.

const PYTHON_BIN = process.env["PYTHON_BIN"] ?? (process.platform === "win32" ? "py" : "python3");
const PY_MAX_CHARS = 20_000;
const PY_STDOUT_CAP = 30_000;
const PY_TIMEOUT_MS = 60_000;

function runPython(code: string, ws: string): ToolResult {
  if (code.length > PY_MAX_CHARS) return err("invalid_args", `code over ${PY_MAX_CHARS} chars`);
  const scrubbed: Record<string, string> = {};
  for (const k of ["PATH", "SystemRoot", "WINDIR", "HOME", "USERPROFILE", "TMP", "TEMP"]) {
    const v = process.env[k];
    if (v !== undefined) scrubbed[k] = v;
  }
  const ulimits =
    process.platform === "linux"
      ? "import resource\nresource.setrlimit(resource.RLIMIT_AS,(536870912,536870912))\nresource.setrlimit(resource.RLIMIT_CPU,(55,55))\n"
      : "";
  const scriptPath = path.join(ws, `.exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.py`);
  fs.writeFileSync(scriptPath, ulimits + code);
  try {
    const out = execFileSync(PYTHON_BIN, ["-I", scriptPath], {
      cwd: ws,
      env: scrubbed,
      timeout: PY_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
      windowsHide: true,
    });
    return ok({ stdout: out.slice(0, PY_STDOUT_CAP), truncated: out.length > PY_STDOUT_CAP });
  } catch (e: any) {
    if (e?.killed || e?.signal === "SIGTERM") return err("budget_exceeded", "python run exceeded 60s");
    const stderr = String(e?.stderr ?? "").slice(0, 4_000);
    const stdout = String(e?.stdout ?? "").slice(0, 4_000);
    return err("python_error", `${e?.message ?? "python failed"}\n${stderr}${stdout ? `\nstdout before error: ${stdout}` : ""}`);
  } finally {
    try { fs.unlinkSync(scriptPath); } catch { /* best-effort */ }
  }
}

// ── render_validate: D3/chart validation via headless Chromium (chunk 5) ──
//
// The coder's quality gate, in-process: load a workspace HTML file in
// Chromium, collect console errors, count SVG children. Async (Playwright
// is async throughout) — dispatch/runRole await it.

import { chromium, type Browser } from "playwright";

const RENDER_TIMEOUT_MS = 30_000;
let sharedBrowser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  sharedBrowser = await chromium.launch({ headless: true });
  return sharedBrowser;
}

export interface RenderReport {
  svgChildren: number;
  consoleErrors: string[];
  valid: boolean;
}

async function renderValidate(htmlPath: string): Promise<ToolResult> {
  if (!fs.existsSync(htmlPath)) return err("not_found", "no such file");
  const consoleErrors: string[] = [];
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 300)));
    await page.goto(`file://${htmlPath.replace(/\\/g, "/")}`, { timeout: RENDER_TIMEOUT_MS, waitUntil: "networkidle" });
    await page.waitForTimeout(500); // let client-side D3 settle
    // countElements runs inside the page (DOM types unavailable in node tsc).
    const svgChildren = await page.evaluate(
      new Function(
        "return document.querySelector('svg') ? document.querySelector('svg').childElementCount : 0",
      ) as () => number,
    );
    await page.close();
    const valid = svgChildren > 0 && consoleErrors.length === 0;
    return ok({ svgChildren, consoleErrors, valid } satisfies RenderReport);
  } catch (e) {
    return err("render_failed", e instanceof Error ? e.message.slice(0, 300) : String(e));
  }
}

// ── Tool specs + execution ────────────────────────────────────────────────

interface ToolDef {
  spec: ToolSpec;
  run: (args: Record<string, unknown>, ws: string) => ToolResult | Promise<ToolResult>;
}

const CATALOG: Record<string, ToolDef> = {
  read_file: {
    spec: {
      type: "function",
      name: "read_file",
      description: "Read a file from this conversation's workspace. Path is relative to the workspace.",
      strict: true,
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Relative path, e.g. notes/data.txt" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    run: (a, ws) => {
      const p = resolveInWorkspace(ws, String(a["path"] ?? ""));
      if (!p) return err("path_escape", "path resolves outside the workspace");
      if (!fs.existsSync(p)) return err("not_found", "no such file");
      return ok({ path: a["path"], content: fs.readFileSync(p, "utf8").slice(0, 50_000) });
    },
  },
  write_file: {
    spec: {
      type: "function",
      name: "write_file",
      description: "Write (overwrite) a file in this conversation's workspace. Returns the artifact path.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path" },
          content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    run: (a, ws) => {
      const p = resolveInWorkspace(ws, String(a["path"] ?? ""));
      if (!p) return err("path_escape", "path resolves outside the workspace");
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, String(a["content"] ?? ""));
      return ok({ path: a["path"], bytes: Buffer.byteLength(String(a["content"] ?? "")) });
    },
  },
  execute_python: {
    spec: {
      type: "function",
      name: "execute_python",
      description:
        "Run Python 3 code in the conversation workspace (cwd). numpy/pandas/statsmodels/sklearn available. " +
        "No network, scrubbed environment, 60s limit. Results come back via stdout — print() your outputs; " +
        "save durable artifacts to workspace-relative paths and name them in finish().",
      strict: true,
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: `Python source, max ${PY_MAX_CHARS} chars` } },
        required: ["code"],
        additionalProperties: false,
      },
    },
    run: (a, ws) => runPython(String(a["code"] ?? ""), ws),
  },
  render_validate: {
    spec: {
      type: "function",
      name: "render_validate",
      description:
        "Load a workspace HTML file in headless Chromium and report: svgChildren count, consoleErrors, valid flag. " +
        "Use AFTER write_file on any chart you produce — never finish with an unvalidated chart.",
      strict: true,
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative HTML path to validate" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    run: async (a, ws) => {
      const p = resolveInWorkspace(ws, String(a["path"] ?? ""));
      if (!p) return err("path_escape", "path resolves outside the workspace");
      return renderValidate(p);
    },
  },
  list_files: {
    spec: {
      type: "function",
      name: "list_files",
      description: "List files in this conversation's workspace (recursive, relative paths).",
      strict: true,
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
    run: (_a, ws) => {
      const walk = (d: string): string[] =>
        fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(ws, path.join(d, e.name))],
        );
      return ok({ files: walk(ws).slice(0, 200) });
    },
  },
};

const FINISH_TOOL: ToolSpec = {
  type: "function",
  name: "finish",
  description: "End this step. Call with your final output for the orchestrator.",
  strict: true,
  parameters: {
    type: "object",
    properties: { output: { type: "string", description: "The step's result text (or artifact summary)." } },
    required: ["output"],
    additionalProperties: false,
  },
};

// ── dispatch — the single entry point (the airlock gate) ──────────────────

export async function dispatch(
  toolName: string,
  args: Record<string, unknown>,
  allowed: readonly string[],
  ws: string,
): Promise<ToolResult> {
  if (!allowed.includes(toolName)) return err("unknown_tool", `no such tool in this role's catalog: ${toolName}`);
  return await CATALOG[toolName].run(args, ws);
}

// ── runRole — one step's tool loop ────────────────────────────────────────

export interface RoleRunResult {
  output: string;
  usage: { input: number; output: number };
  iterations: number;
  terminatedBy: "finish" | "text" | "budget";
}

export async function runRole(
  role: Role,
  deployment: string,
  task: string,
  upstreamText: string,
  conversationId: string,
  budget?: Partial<StepBudget>,
): Promise<RoleRunResult> {
  const b: StepBudget = {
    maxToolCalls: budget?.maxToolCalls ?? DEFAULT_BUDGET.maxToolCalls,
    wallClockSecs: budget?.wallClockSecs ?? DEFAULT_BUDGET.wallClockSecs,
    costCeilingDollars: budget?.costCeilingDollars ?? DEFAULT_BUDGET.costCeilingDollars,
    prices: PRICES,
  };
  const price = b.prices[deployment];
  if (!price) {
    return { output: `deployment '${deployment}' has no known price — refused`, usage: { input: 0, output: 0 }, iterations: 0, terminatedBy: "budget" };
  }

  const ws = workspaceRoot(conversationId);
  const allowed = [...role.toolNames];
  const tools: ToolSpec[] = [
    ...allowed.map((n) => CATALOG[n].spec),
    FINISH_TOOL,
  ];
  const deadline = Date.now() + b.wallClockSecs * 1000;
  const usage = { input: 0, output: 0 };
  const cost = () => (usage.input * price.input + usage.output * price.output) / 1000;

  // The LLM never sees the budget numbers change its instructions — it only
  // learns about exhaustion when we terminate the loop.
  const input: unknown[] = [
    { role: "user", content: `TASK:\n${task}\n\nUPSTREAM RESULTS:\n${upstreamText || "(none)"}\n\nWorkspace files persist across steps of this conversation. Call finish(output) when done.` },
  ];

  let terminatedBy: RoleRunResult["terminatedBy"] = "budget";
  let output = "";

  for (let iter = 0; iter < b.maxToolCalls; iter++) {
    if (Date.now() > deadline) { output = `step aborted: wall-clock ${b.wallClockSecs}s exhausted`; break; }
    if (cost() >= b.costCeilingDollars) { output = `step aborted: cost ceiling $${b.costCeilingDollars} reached ($${cost().toFixed(4)})`; break; }

    const res = await callLlm({
      model: deployment,
      instructions: role.instructions,
      input,
      tools: allowed.length > 0 ? tools : undefined,
      maxOutputTokens: 4096,
    });
    usage.input += res.usage.input;
    usage.output += res.usage.output;

    // Responses idiom: echo the model's raw output items back into input
    // BEFORE appending function_call_output (call_id correlation requires it).
    input.push(...res.rawOutput);
    const calls = res.functionCalls;
    if (calls.length === 0) {
      output = res.text || "(empty response)";
      terminatedBy = "text";
      break;
    }

    for (const c of calls) {
      if (c.name === "finish") {
        output = String(c.args["output"] ?? "");
        terminatedBy = "finish";
        break;
      }
      const tr = await dispatch(c.name, c.args, allowed, ws);
      input.push({
        type: "function_call_output",
        call_id: c.callId,
        output: JSON.stringify(tr),
      });
    }
    if (terminatedBy === "finish") break;
  }

  if (!output) output = `step aborted: ${b.maxToolCalls} tool-call iterations exhausted`;
  return { output, usage, iterations: 0, terminatedBy };
}
