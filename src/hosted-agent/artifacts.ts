/**
 * artifacts.ts — the manifest of everything a run produced (chunk 6).
 * Reads the conversation workspace at finish time and classifies files by
 * role (chart / data / notes). Chunk-6 scope: workspace-relative refs +
 * validation flags. Later chunks can add the upload protocol (POST to the
 * host's /ui/api/artifacts, HMAC'd) without changing orchestrator.ts —
 * this module is the single seam.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface ArtifactRef {
  path: string;       // workspace-relative
  kind: "chart" | "data" | "notes" | "other";
  bytes: number;
  mimeType: string;
  /** Pending-file URL in artifact-service storage. Uploading does not save the
   * file into the catalog; the user still controls that publication step. */
  url?: string;
  valid?: boolean;
}

const CHART_RE = /\.(html)$/i;
const DATA_RE = /\.(csv|json)$/i;
const NOTES_RE = /\.(md|txt)$/i;

function workspaceRoot(conversationId: string): string {
  const safe = conversationId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "anon";
  const base =
    process.env["WORKSPACE_ROOT"] ??
    (fs.existsSync(os.homedir()) ? path.join(os.homedir(), "workspace") : path.join(os.tmpdir(), "workspace"));
  return path.join(base, safe);
}

function mimeTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html") return "text/html";
  if (ext === ".json") return "application/json";
  if (ext === ".csv") return "text/csv";
  if (ext === ".md") return "text/markdown";
  if (ext === ".txt") return "text/plain";
  return "application/octet-stream";
}

async function uploadPending(fullPath: string, relativePath: string, mimeType: string, userId: string): Promise<string | undefined> {
  const service = process.env["ARTIFACT_SERVICE_URL"] ??
    "https://artifact-service.bravesea-f16a8310.eastus.azurecontainerapps.io";
  try {
    const response = await fetch(`${service}/artifacts/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-User-Id": userId,
        "X-File-Name": path.basename(relativePath),
        "X-Mime-Type": mimeType,
      },
      body: fs.readFileSync(fullPath),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { url?: string };
    return body.url ? (body.url.startsWith("http") ? body.url : `${service}${body.url}`) : undefined;
  } catch {
    return undefined;
  }
}

export async function collectArtifacts(conversationId: string, userId?: string): Promise<ArtifactRef[]> {
  const ws = workspaceRoot(conversationId);
  if (!fs.existsSync(ws)) return [];
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(ws, path.join(d, e.name))],
    );
  const refs = walk(ws)
    .filter((f) => !path.basename(f).startsWith(".exec-") && path.basename(f) !== ".workspace-owner.json")
    .map((f) => {
      const full = path.join(ws, f);
      const kind: ArtifactRef["kind"] = CHART_RE.test(f)
        ? "chart"
        : DATA_RE.test(f)
          ? "data"
          : NOTES_RE.test(f)
            ? "notes"
            : "other";
      return { path: f.replace(/\\/g, "/"), kind, bytes: fs.statSync(full).size, mimeType: mimeTypeFor(f) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  if (!userId) return refs;
  return await Promise.all(refs.map(async (ref) => ({
    ...ref,
    url: await uploadPending(path.join(ws, ref.path), ref.path, ref.mimeType, userId),
  })));
}

/** Pending-tree rendering (mirrors the http_proxy conversation convention). */
export function renderPendingTree(artifacts: ArtifactRef[]): string {
  if (artifacts.length === 0) return "(no artifacts produced)";
  const byKind = new Map<string, ArtifactRef[]>();
  for (const a of artifacts) {
    const arr = byKind.get(a.kind) ?? [];
    arr.push(a);
    byKind.set(a.kind, arr);
  }
  const order: ArtifactRef["kind"][] = ["chart", "data", "notes", "other"];
  const lines: string[] = ["📋 Pending artifacts (not yet saved to catalog)", ""];
  const kinds = order.filter((k) => byKind.has(k));
  kinds.forEach((k, ki) => {
    const arr = byKind.get(k)!;
    arr.forEach((a, ai) => {
      const last = ki === kinds.length - 1 && ai === arr.length - 1;
      lines.push(`${last ? "└──" : "├──"} ${a.path}  [${a.kind}${a.valid === true ? ", valid" : ""}]  ${a.bytes}B${a.url ? `\n    ${a.url}` : ""}`);
    });
  });
  return lines.join("\n");
}
