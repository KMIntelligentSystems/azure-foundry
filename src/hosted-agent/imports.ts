/**
 * imports.ts — role catalogue. Loads agents/*.md at startup into compiled
 * Role objects. Markdown is the authoring format only; after this module
 * runs, nothing downstream knows Markdown exists.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Role {
  name: string;
  description: string;
  defaultDeployment: string;
  toolNames: string[];
  instructions: string;
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROLES_DIR = [
  process.env["AGENTS_ROOT"] ?? "",
  path.resolve(MODULE_DIR, "agents"),
  path.resolve(process.cwd(), "src", "hosted-agent", "agents"),
].filter(Boolean).find((p) => fs.existsSync(p) && fs.statSync(p).isDirectory()) ?? path.resolve(MODULE_DIR, "agents");

function parseRoleFile(filename: string): Role {
  const raw = fs.readFileSync(path.join(ROLES_DIR, filename), "utf8");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error(`${filename}: missing YAML frontmatter`);
  const fm: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  const name = fm["name"];
  if (!name) throw new Error(`${filename}: frontmatter lacks 'name'`);
  return {
    name,
    description: fm["description"] ?? "",
    defaultDeployment: fm["defaultDeployment"] ?? "gpt-4.1-mini",
    toolNames: (fm["tools"] ?? "[]")
      .replace(/[[\]]/g, "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    instructions: m[2].trim(),
  };
}

let catalogue: Role[] | null = null;

export function loadRoles(): Role[] {
  if (catalogue) return catalogue;
  catalogue = fs
    .readdirSync(ROLES_DIR)
    .filter((f) => f.endsWith(".md"))
    .map(parseRoleFile);
  if (catalogue.length === 0) throw new Error("no role files found in " + ROLES_DIR);
  return catalogue;
}

export function getRole(name: string): Role | undefined {
  return loadRoles().find((r) => r.name === name);
}

/** The catalogue text the planner sees (cost/perf hints live in the allowlist). */
export function describeRolesForPlanner(): string {
  return loadRoles()
    .map((r) => `- ${r.name}: ${r.description} (default deployment: ${r.defaultDeployment})`)
    .join("\n");
}
