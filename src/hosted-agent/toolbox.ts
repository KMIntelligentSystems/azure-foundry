/**
 * toolbox.ts — the flow-1 interactive orchestrator's tool runtime.
 *
 * ARCHITECTURE NOTE (2026-08-26 correction — this module was broker.ts):
 * This is NOT the airlock, and the SWA does not depend on one. In the source
 * app (http_proxy) the trust split is:
 *
 *   flow 1 (interactive, human-in-the-loop): React app → host → orchestrator
 *     agent with an OPEN tool set (fetch_page, web_search, query_artifacts,
 *     execute_python, playwright...). No broker in this path.
 *   flow 2 (unattended refresh): the oracle + 4-verb airlock — source oracle
 *     is the Rust daemon (c:/repos/daemon, ACA app `daemon-airlock`); the
 *     target oracle is http_proxy's src/refresh. THAT is where the closed
 *     catalog belongs, because no human watches those runs.
 *
 * The N2 design doc mistakenly copied flow-2's airlock property ("roles never
 * touch FS/network except through the broker") into this flow-1 container.
 * The correction: per-role tool lists remain as least-privilege scoping
 * (LLM proposes, runtime disposes) — but this
 * catalog is the orchestrator's TOOLBOX: it grows with ordinary capabilities
 * (fetch_url, workspace files, catalog read/save, python, render_validate)
 * without airlock justification, and it holds no signing keys or secrets.
 * The one refresh-adjacent verb (sync_indicator_history) is gated server-side
 * at the artifact-service (admin role + HMAC) — not by anything in this file.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { callLlm, type ToolSpec } from "./foundry.js";
import type { Role } from "./imports.js";
import { listSkills, readSkill } from "./skills.js";

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

/** Return a structured tool error instead of letting readFile/render operations
 * throw when a model supplies the workspace root ("."/empty) or a directory. */
function workspaceFileError(fullPath: string): ToolResult | null {
  try {
    if (!fs.statSync(fullPath).isFile()) {
      return err("not_file", "path is a directory; use list_files to inspect the workspace");
    }
    return null;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as NodeJS.ErrnoException).code)
      : "";
    if (code === "ENOENT") return err("not_found", "no such file");
    return err("file_access_error", error instanceof Error ? error.message : String(error));
  }
}

/** A new file may not exist yet, but an existing output target must be a file. */
function workspaceWriteTargetError(fullPath: string): ToolResult | null {
  try {
    if (fs.existsSync(fullPath) && !fs.statSync(fullPath).isFile()) {
      return err("not_file", "output path is a directory; provide a file path");
    }
    return null;
  } catch (error) {
    return err("file_access_error", error instanceof Error ? error.message : String(error));
  }
}

// ── save_artifact: upload workspace file to artifact service (chunk 7) ────
//
// The user's "save this to catalog X" prompt becomes a tool call here. The
// toolbox reads the workspace file, uploads it to the artifact service
// (which stores it and returns a URL), then saves the metadata.

// Read lazily: tests and embedders set the env before dispatch, not import.
function artifactServiceUrl(): string {
  return process.env["ARTIFACT_SERVICE_URL"] ??
    "https://artifact-service.bravesea-f16a8310.eastus.azurecontainerapps.io";
}

async function saveArtifactToCatalog(
  args: Record<string, unknown>,
  ws: string,
  userId: string,
): Promise<ToolResult> {
  const path = String(args["path"] ?? "");
  const category = String(args["category"] ?? "");
  const subject = String(args["subject"] ?? "");
  const title = String(args["title"] ?? path);
  const tags = args["tags"] ? String(args["tags"]) : undefined;

  if (!category || !subject) {
    return err("invalid_args", "category and subject are required");
  }

  const fullPath = resolveInWorkspace(ws, path);
  if (!fullPath) return err("path_escape", "path resolves outside the workspace");
  const fileError = workspaceFileError(fullPath);
  if (fileError) return fileError;

  const content = fs.readFileSync(fullPath);
  const mimeType = path.endsWith(".html") ? "text/html" : path.endsWith(".json") ? "application/json" : path.endsWith(".md") ? "text/markdown" : "application/octet-stream";

  // Upload file content to artifact service (which stores it + returns URL)
  /*
- Upload shape: POST {artifactServiceUrl}/artifacts/upload (toolbox wraps it as save_artifact)
 - Sync: POST {artifactServiceUrl}/refresh-sync — a privileged system verb, ~HTTP 4xx surfaces as sync_failed

  */
  try {
    const uploadRes = await fetch(`${artifactServiceUrl()}/artifacts/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-User-Id": userId,
        "X-File-Name": path.split("/").pop() ?? "artifact",
        "X-Mime-Type": mimeType,
      },
      body: content,
    });
    if (!uploadRes.ok) {
      return err("upload_failed", `artifact service upload: HTTP ${uploadRes.status}`);
    }
    const { url } = (await uploadRes.json()) as { url: string };

    // Save metadata to catalog
    const saveRes = await fetch(`${artifactServiceUrl()}/artifacts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-User-Id": userId,
        "X-User-Role": "user", // orchestrator acts as the user who prompted
      },
      body: JSON.stringify({ category, subject, title, mimeType, url, tags }),
    });
    if (!saveRes.ok) {
      return err("save_failed", `artifact service save: HTTP ${saveRes.status}`);
    }
    const saved = (await saveRes.json()) as { id: string };
    return ok({ artifactId: saved.id, url, title, category, subject });
  } catch (e) {
    return err("network_error", e instanceof Error ? e.message : String(e));
  }
}

// ── Catalog read tools (artifact service) ────────────────────────────────
//
// The user's saved artifacts live in the artifact service (SQLite
// artifacts.db behind /artifacts), NOT in the workspace. These two tools
// are the read side of that catalog; save_artifact above is the write side.

interface CatalogEntry {
  id: string;
  user_id: string;
  category: string;
  subject: string;
  title: string;
  mime_type: string;
  url: string;
  created_at: string;
  tags: string | null;
}

function resolveContentUrl(url: string): string {
  return url.startsWith("http") ? url : `${artifactServiceUrl()}${url}`;
}

async function listArtifactsFromCatalog(args: Record<string, unknown>, userId: string): Promise<ToolResult> {
  try {
    const res = await fetch(`${artifactServiceUrl()}/artifacts`, {
      headers: { "X-User-Id": userId },
    });
    if (!res.ok) {
      return err("list_failed", `artifact service list: HTTP ${res.status}`);
    }
    let entries = ((await res.json()) as { artifacts: CatalogEntry[] }).artifacts ?? [];
    const category = args["category"] ? String(args["category"]).toLowerCase() : undefined;
    const subject = args["subject"] ? String(args["subject"]).toLowerCase() : undefined;
    const tags = args["tags"] ? String(args["tags"]).toLowerCase() : undefined;
    const mimeType = args["mime_type"] ? String(args["mime_type"]).toLowerCase() : undefined;
    if (category) entries = entries.filter((e) => e.category.toLowerCase().includes(category));
    if (subject) entries = entries.filter((e) => e.subject.toLowerCase().includes(subject));
    if (tags) entries = entries.filter((e) => (e.tags ?? "").toLowerCase().includes(tags));
    if (mimeType) entries = entries.filter((e) => e.mime_type.toLowerCase().startsWith(mimeType));
    const total = entries.length;
    entries = entries.slice(0, 50);
    return ok({
      total,
      shown: entries.length,
      artifacts: entries.map((e) => ({
        id: e.id,
        title: e.title,
        category: e.category,
        subject: e.subject,
        mimeType: e.mime_type,
        url: resolveContentUrl(e.url),
        createdAt: e.created_at,
        tags: e.tags,
      })),
    });
  } catch (e) {
    return err("network_error", e instanceof Error ? e.message : String(e));
  }
}

async function readArtifactContent(args: Record<string, unknown>, userId: string): Promise<ToolResult> {
  const id = String(args["artifact_id"] ?? "");
  if (!id) return err("invalid_args", "artifact_id is required");
  try {
    const metaRes = await fetch(`${artifactServiceUrl()}/artifacts/${encodeURIComponent(id)}`, {
      headers: { "X-User-Id": userId },
    });
    if (!metaRes.ok) {
      return err("not_found", `artifact service get: HTTP ${metaRes.status}`);
    }
    const meta = (await metaRes.json()) as CatalogEntry;
    const contentUrl = resolveContentUrl(meta.url);
    const contentRes = await fetch(contentUrl, { headers: { "X-User-Id": userId } });
    if (!contentRes.ok) {
      return err("fetch_failed", `artifact content fetch: HTTP ${contentRes.status}`);
    }
    const text = await contentRes.text();
    return ok({
      id: meta.id,
      title: meta.title,
      mimeType: meta.mime_type,
      url: contentUrl,
      content: text.slice(0, 50_000),
      truncated: text.length > 50_000,
    });
  } catch (e) {
    return err("network_error", e instanceof Error ? e.message : String(e));
  }
}

// ── execute_python: the one spawn the runtime permits ──────────────────────
//
// Runs model-authored Python in a locked-down child (mirrors lockdown.rs):
// scrubbed env, cwd = workspace, CPU/memory rlimits on Linux, 60s kill.
// stdout is the contract — results, prints, tracebacks all ride it back.

const PYTHON_BIN = process.env["PYTHON_BIN"] ?? (process.platform === "win32" ? "py" : "python3");
const PY_MAX_CHARS = 20_000;
const PY_STDOUT_CAP = 30_000;
const PY_TIMEOUT_MS = 60_000;

interface PanelStageRequest {
  subject?: string | null;
  series: string[];
  path: string;
}

interface StagedPanel {
  path: string;
  subject: string | null;
  series: string[];
  seriesCount: number;
  observations: number;
  panelHash: string | null;
  ranges: Array<{ seriesId: string; observations: number; range: [string, string] | null }>;
}

async function stageIndicatorPanel(
  request: PanelStageRequest,
  ws: string,
  userId: string,
): Promise<{ ok: true; staged: StagedPanel } | { ok: false; error: ToolResult }> {
  const rel = String(request.path ?? "");
  const series = Array.isArray(request.series) ? request.series.map(String) : [];
  if (!rel || series.length === 0) {
    return { ok: false, error: err("invalid_args", "stage_indicator_panel requires path and at least one series") };
  }
  const fullPath = resolveInWorkspace(ws, rel);
  if (!fullPath) return { ok: false, error: err("path_escape", "staged panel path resolves outside the workspace") };
  const targetError = workspaceWriteTargetError(fullPath);
  if (targetError) return { ok: false, error: targetError };

  try {
    const res = await fetch(`${artifactServiceUrl()}/refresh-panel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-User-Id": userId,
        "X-User-Role": "admin",
      },
      body: JSON.stringify({ subject: request.subject ?? null, series }),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      return { ok: false, error: err("panel_failed", `artifact-service refresh-panel: HTTP ${res.status} ${text.slice(0, 200)}`) };
    }
    const body = JSON.parse(text) as {
      subjectId?: string | null;
      series?: string[];
      rows?: Array<{ seriesId: string; observations: Array<{ date: string; value: number; is_preliminary: number }> }>;
      panelHash?: string;
    };
    const rows = body.rows ?? [];
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const tmp = `${fullPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify({
      subjectId: body.subjectId ?? request.subject ?? null,
      series: body.series ?? series,
      rows,
      panelHash: body.panelHash ?? null,
    }));
    fs.renameSync(tmp, fullPath);

    const ranges = rows.map((row) => ({
      seriesId: row.seriesId,
      observations: row.observations.length,
      range: row.observations.length
        ? [row.observations[0].date, row.observations[row.observations.length - 1].date] as [string, string]
        : null,
    }));
    return {
      ok: true,
      staged: {
        path: rel.replace(/\\/g, "/"),
        subject: body.subjectId ?? request.subject ?? null,
        series: body.series ?? series,
        seriesCount: rows.length,
        observations: ranges.reduce((n, row) => n + row.observations, 0),
        panelHash: body.panelHash ?? null,
        ranges,
      },
    };
  } catch (e) {
    return { ok: false, error: err("network_error", e instanceof Error ? e.message : String(e)) };
  }
}

async function runPython(
  code: string,
  ws: string,
  ctx?: { userId?: string },
  stageRequest?: PanelStageRequest | null,
): Promise<ToolResult> {
  if (code.length > PY_MAX_CHARS) return err("invalid_args", `code over ${PY_MAX_CHARS} chars`);
  let stagedInput: StagedPanel | undefined;
  if (stageRequest) {
    const stage = await stageIndicatorPanel(stageRequest, ws, ctx?.userId ?? "unknown");
    if (!stage.ok) return stage.error;
    stagedInput = stage.staged;
  }
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
    return ok({
      ...(stagedInput ? { stagedInput } : {}),
      stdout: out.slice(0, PY_STDOUT_CAP),
      truncated: out.length > PY_STDOUT_CAP,
    });
  } catch (e: any) {
    if (e?.killed || e?.signal === "SIGTERM") return err("timeout_exceeded", "python run exceeded 60s");
    const stderr = String(e?.stderr ?? "").slice(0, 4_000);
    const stdout = String(e?.stdout ?? "").slice(0, 4_000);
    return err("python_error", `${e?.message ?? "python failed"}\n${stderr}${stdout ? `\nstdout before error: ${stdout}` : ""}`);
  } finally {
    try { fs.unlinkSync(scriptPath); } catch { /* best-effort */ }
  }
}

// ── fetch_url: read one external URL into the conversation ───────────────
//
// An ordinary flow-1 capability (mirrors http_proxy's fetch_page). Roles
// otherwise cannot touch the network except the hardcoded artifact-service
// URLs, so this is deliberately guarded: http(s)
// only, loopback/private hosts refused (SSRF), streamed body capped, 30s
// timeout. Optional env FETCH_URL_ALLOWLIST (comma-separated host suffixes)
// tightens it further when set — e.g. "blob.core.windows.net".

const FETCH_MAX_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "169.254.169.254") return true; // Azure IMDS
  if (h === "[::1]" || h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd")) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return true;
  }
  return false;
}

async function fetchUrl(args: Record<string, unknown>): Promise<ToolResult> {
  const raw = String(args["url"] ?? "");
  let u: URL;
  try { u = new URL(raw); } catch { return err("invalid_args", "malformed URL"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") return err("invalid_args", "only http(s) URLs");
  if (isPrivateHost(u.hostname)) return err("refused", "loopback/private hosts are not fetchable");
  const allow = (process.env["FETCH_URL_ALLOWLIST"] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allow.length && !allow.some((sfx) => u.hostname.toLowerCase().endsWith(sfx))) {
    return err("refused", `host not in FETCH_URL_ALLOWLIST: ${u.hostname}`);
  }
  try {
    const res = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return err("fetch_failed", `HTTP ${res.status}`);
    const contentType = res.headers.get("content-type") ?? "";
    // Stream with a byte cap instead of buffering the whole body.
    const chunks: Buffer[] = [];
    let bytes = 0, truncated = false;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (bytes + value.byteLength > FETCH_MAX_BYTES) {
          truncated = true;
          chunks.push(Buffer.from(value.subarray(0, FETCH_MAX_BYTES - bytes)));
          bytes = FETCH_MAX_BYTES;
          reader.cancel().catch(() => { /* best-effort */ });
          break;
        }
        chunks.push(Buffer.from(value));
        bytes += value.byteLength;
      }
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return ok({
      url: u.toString(),
      contentType,
      bytes,
      content: text.slice(0, 100_000),
      truncated: truncated || text.length > 100_000,
    });
  } catch (e) {
    return err("network_error", e instanceof Error ? e.message.slice(0, 300) : String(e));
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
  const fileError = workspaceFileError(htmlPath);
  if (fileError) return fileError;
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
  run: (args: Record<string, unknown>, ws: string, ctx?: { userId?: string }) => ToolResult | Promise<ToolResult>;
}

const CATALOG: Record<string, ToolDef> = {
  list_skills: {
    spec: {
      type: "function",
      name: "list_skills",
      description: "List the hosted orchestrator's behavioral statistical method skills. Read the matching SKILL.md before computing; do not improvise a missing method.",
      strict: true,
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
    run: () => ok({ skills: listSkills() }),
  },
  read_skill: {
    spec: {
      type: "function",
      name: "read_skill",
      description: "Read one complete hosted-agent skills/<name>/SKILL.md behavioral method document.",
      strict: true,
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Skill folder/name, e.g. adl-monthly-nowcast" } },
        required: ["name"],
        additionalProperties: false,
      },
    },
    run: (a) => {
      const skill = readSkill(String(a["name"] ?? ""));
      return skill ? ok(skill) : err("not_found", `skill not found: ${String(a["name"] ?? "")}`);
    },
  },
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
      const fileError = workspaceFileError(p);
      if (fileError) return fileError;
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
      const targetError = workspaceWriteTargetError(p);
      if (targetError) return targetError;
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
        "Run agent-authored Python 3 code in the conversation workspace (cwd). numpy/pandas/statsmodels/sklearn available. " +
        "For indicator-panel work, use stage_indicator_panel in THIS call: the runtime fetches raw refresh-panel observations " +
        "and writes them to the requested workspace path before Python starts. Raw observations are never returned to the LLM; " +
        "Python must open the staged JSON and apply the selected SKILL.md itself. No network, scrubbed environment, 60s limit. " +
        "Results come back via stdout; save durable outputs to workspace-relative paths.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: `Python source, max ${PY_MAX_CHARS} chars` },
          stage_indicator_panel: {
            type: ["object", "null"],
            description: "Optional raw-panel staging performed by execute_python before the script starts.",
            properties: {
              subject: { type: ["string", "null"], description: "Provenance subject label." },
              series: { type: "array", items: { type: "string" }, description: "Exact indicator_history series IDs required by the skill." },
              path: { type: "string", description: "Workspace-relative JSON destination, e.g. inputs/indicator-panel.json." },
            },
            required: ["subject", "series", "path"],
            additionalProperties: false,
          },
        },
        required: ["code", "stage_indicator_panel"],
        additionalProperties: false,
      },
    },
    run: (a, ws, ctx) => runPython(
      String(a["code"] ?? ""),
      ws,
      ctx,
      (a["stage_indicator_panel"] as PanelStageRequest | null | undefined) ?? null,
    ),
  },
  list_artifacts: {
    spec: {
      type: "function",
      name: "list_artifacts",
      description:
        "List entries in the user's saved artifact catalog (the SQLite artifacts.db behind the artifact service — " +
        "NOT workspace files). Returns id, title, category, subject, mimeType, content url, createdAt. " +
        "Use first whenever the user asks about their catalog, saved charts, or artifacts.db.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          category: { type: ["string", "null"], description: "Filter: category substring (optional)" },
          subject: { type: ["string", "null"], description: "Filter: subject substring (optional)" },
          tags: { type: ["string", "null"], description: "Filter: tag substring (optional)" },
          mime_type: { type: ["string", "null"], description: "Filter: mime prefix, e.g. text/html for charts (optional)" },
        },
        required: ["category", "subject", "tags", "mime_type"],
        additionalProperties: false,
      },
    },
    run: async (a, _ws, ctx) => listArtifactsFromCatalog(a, ctx?.userId ?? "unknown"),
  },
  read_artifact: {
    spec: {
      type: "function",
      name: "read_artifact",
      description:
        "Read one entry from the user's artifact catalog by id (from list_artifacts). Returns metadata plus " +
        "the artifact content (truncated at 50k chars). Use after list_artifacts to inspect a chart's HTML or text.",
      strict: true,
      parameters: {
        type: "object",
        properties: { artifact_id: { type: "string", description: "Catalog entry id" } },
        required: ["artifact_id"],
        additionalProperties: false,
      },
    },
    run: async (a, _ws, ctx) => readArtifactContent(a, ctx?.userId ?? "unknown"),
  },
  save_artifact: {
    spec: {
      type: "function",
      name: "save_artifact",
      description:
        "Save a workspace file to the user's artifact catalog. Uploads the file content and stores metadata. " +
        "Use when the user asks to 'save this chart' or 'add to catalog'.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path (e.g. charts/line.html)" },
          category: { type: "string", description: "Catalog category (e.g. Economics, Psychology)" },
          subject: { type: "string", description: "Catalog subject (e.g. M3 Manufacturing, Cognitive Tests)" },
          title: { type: "string", description: "Display title (defaults to filename)" },
          tags: { type: ["string", "null"], description: "Comma-separated tags (optional)" },
        },
        required: ["path", "category", "subject", "title", "tags"],
        additionalProperties: false,
      },
    },
    run: async (a, ws, ctx) => saveArtifactToCatalog(a, ws, ctx?.userId ?? "unknown"),
  },
  sync_indicator_history: {
    spec: {
      type: "function",
      name: "sync_indicator_history",
      description:
        "Push the catalog's tagged backbone CSVs (text/csv artifacts) to the refresh-daemon's " +
        "indicator_history (HMAC-authed /refresh/bootstrap, idempotent upsert on series+month). " +
        "Server-side deterministic bridge — the agent sees only the SyncReport, never CSV bytes. " +
        "dryRun previews without posting.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          dryRun: { type: ["boolean", "null"], description: "Build and report the payload without posting (optional)." },
        },
        required: ["dryRun"],
        additionalProperties: false,
      },
    },
    run: async (a, _ws, ctx) => {
      const res = await fetch(`${artifactServiceUrl()}/refresh-sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-User-Id": ctx?.userId ?? "unknown",
          // refresh-sync is a privileged system verb — the artifact-service
          // route accepts admin role only for this one path.
          "X-User-Role": "admin",
        },
        body: JSON.stringify({ dryRun: a["dryRun"] === true }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return err("sync_failed", `artifact-service refresh-sync: HTTP ${res.status} ${detail.slice(0, 200)}`);
      }
      const report = (await res.json()) as unknown;
      return ok(report);
    },
  },
  read_indicator_panel: {
    spec: {
      type: "function",
      name: "read_indicator_panel",
      description:
        "Read the deterministic indicator panel from refresh.db indicator_history — " +
        "the same data the http_proxy statistician reads from data/refresh.db — " +
        "through the artifact-service proxy (admin-gated, HMAC to the daemon). " +
        "Returns a shaped summary per series (seriesId, observations, range, hash) — " +
        "never the full raw panel. Call with the series the skill needs (e.g. the 13-series ADL panel). " +
        "Always call BEFORE execute_python when the task is over the indicator panel; " +
        "never invent file names like refresh.db — it is not a workspace file.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          subject: { type: ["string", "null"], description: "Optional subject label (provenance only)." },
          series: { type: "array", items: { type: "string" }, description: "indicator_history series_ids to export (e.g. m3_total_shipments_nsa, fred_ipman)." },
        },
        required: ["subject", "series"],
        additionalProperties: false,
      },
    },
    run: async (a, _ws, ctx) => {
      const res = await fetch(`${artifactServiceUrl()}/refresh-panel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-User-Id": ctx?.userId ?? "unknown",
          "X-User-Role": "admin",
        },
        body: JSON.stringify({ subject: a["subject"] ?? null, series: a["series"] ?? [] }),
      });
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        return err("panel_failed", `artifact-service refresh-panel: HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      const body = JSON.parse(text) as {
        series?: string[];
        rows?: Array<{ seriesId: string; observations: Array<{ date: string; value: number; is_preliminary: number }> }>;
        panelHash?: string;
      };
      // Shaped summary — the LLM sees the panel contract (which series, how
      // much, what hash to cite), not thousands of raw rows.
      const summary = (body.rows ?? []).map((r) => ({
        seriesId: r.seriesId,
        observations: r.observations.length,
        range: r.observations.length ? [r.observations[0].date, r.observations[r.observations.length - 1].date] : null,
      }));
      return ok({
        subject: a["subject"] ?? null,
        series: body.series ?? [],
        panelHash: body.panelHash ?? null,
        summary,
      });
    },
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
  fetch_url: {
    spec: {
      type: "function",
      name: "fetch_url",
      description:
        "Fetch one external URL (http/https) and return its text content (capped at 100k chars). " +
        "Use for SAS-signed Azure blob links, raw data files, and web pages the user names. " +
        "GET only; loopback/private hosts refused.",
      strict: true,
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Full URL including any SAS query string" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
    run: async (a) => fetchUrl(a),
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

// ── dispatch — the single entry point (per-role scoping gate) ─────────────
//
// This is least-privilege hygiene (a role only sees the tools its .md grants),
// not a trust boundary: everything in CATALOG is a legitimate orchestrator
// capability, and new ones are added here as the toolbox grows.

export async function dispatch(
  toolName: string,
  args: Record<string, unknown>,
  allowed: readonly string[],
  ws: string,
  ctx?: { userId?: string },
): Promise<ToolResult> {
  if (!allowed.includes(toolName)) return err("unknown_tool", `tool not granted to this role: ${toolName}`);
  return await CATALOG[toolName].run(args, ws, ctx);
}

// ── runRole — one step's tool loop ────────────────────────────────────────

// Hard safety bounds for the tool loop — fixed runtime guards, not budgeting:
// the model gets enough room for a substantive step, then the loop terminates.
const MAX_MODEL_CALLS = 30;
const MAX_TOOL_EXECUTIONS = 30;
const WALL_CLOCK_SECS = 900;
const MAX_OUTPUT_TOKENS_PER_CALL = 8192;

export interface RoleRunResult {
  output: string;
  usage: { input: number; output: number };
  modelCalls: number;
  toolExecutions: number;
  terminatedBy: "finish" | "text" | "limit";
}

export async function runRole(
  role: Role,
  deployment: string,
  task: string,
  upstreamText: string,
  conversationId: string,
  ctx?: { userId?: string },
  round = 1,
  modelCaller: typeof callLlm = callLlm,
): Promise<RoleRunResult> {
  const ws = workspaceRoot(conversationId);
  const allowed = [...role.toolNames];
  const tools: ToolSpec[] = [
    ...allowed.map((n) => CATALOG[n].spec),
    FINISH_TOOL,
  ];
  const deadline = Date.now() + WALL_CLOCK_SECS * 1000;
  const usage = { input: 0, output: 0 };
  let modelCalls = 0;
  let toolExecutions = 0;

  const input: unknown[] = [
    { role: "user", content: `TASK:\n${task}\n\nUPSTREAM RESULTS:\n${upstreamText || "(none)"}\n\nWorkspace files persist across steps of this conversation. Call finish(output) when done.` },
  ];

  let terminatedBy: RoleRunResult["terminatedBy"] = "limit";
  let output = "";

  for (let iter = 0; iter < MAX_MODEL_CALLS; iter++) {
    if (Date.now() > deadline) { output = `step aborted: wall-clock ${WALL_CLOCK_SECS}s exhausted`; break; }
    const res = await modelCaller({
      model: deployment,
      instructions: role.instructions,
      input,
      tools: allowed.length > 0 ? tools : undefined,
      maxOutputTokens: MAX_OUTPUT_TOKENS_PER_CALL,
    });
    modelCalls++;
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
      if (toolExecutions >= MAX_TOOL_EXECUTIONS) {
        output = `step aborted: ${MAX_TOOL_EXECUTIONS} tool executions exhausted`;
        terminatedBy = "limit";
        break;
      }
      toolExecutions++;
      const tr = await dispatch(c.name, c.args, allowed, ws, ctx);
      input.push({
        type: "function_call_output",
        call_id: c.callId,
        output: JSON.stringify(tr),
      });
    }
    if (terminatedBy === "finish") break;
  }

  if (!output) output = `step aborted: ${MAX_MODEL_CALLS} model calls exhausted`;
  return { output, usage, modelCalls, toolExecutions, terminatedBy };
}
