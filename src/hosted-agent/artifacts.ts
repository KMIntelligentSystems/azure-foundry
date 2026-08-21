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
  valid?: boolean;    // set when the coder validated it (chunk-7 upload adds url)
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

export function collectArtifacts(conversationId: string): ArtifactRef[] {
  const ws = workspaceRoot(conversationId);
  if (!fs.existsSync(ws)) return [];
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(ws, path.join(d, e.name))],
    );
  return walk(ws)
    .filter((f) => !f.startsWith(".exec-"))
    .map((f) => {
      const full = path.join(ws, f);
      const kind: ArtifactRef["kind"] = CHART_RE.test(f)
        ? "chart"
        : DATA_RE.test(f)
          ? "data"
          : NOTES_RE.test(f)
            ? "notes"
            : "other";
      return { path: f.replace(/\\/g, "/"), kind, bytes: fs.statSync(full).size };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
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
      lines.push(`${last ? "└──" : "├──"} ${a.path}  [${a.kind}${a.valid === true ? ", valid" : ""}]  ${a.bytes}B`);
    });
  });
  return lines.join("\n");
}
