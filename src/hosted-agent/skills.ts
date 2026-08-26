/**
 * Runtime skill catalogue.
 *
 * Skills are application-owned behavioral method documents, not executable
 * pipelines or Foundry-native resources. The statistician discovers and reads
 * SKILL.md, then authors Python against the generic execute_python tool. In
 * both source and image they live under the hosted-agent runtime tree.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
}

function candidateRoots(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    process.env["SKILLS_ROOT"] ?? "",
    path.join(here, "skills"),
    path.resolve(process.cwd(), "src", "hosted-agent", "skills"),
  ].filter(Boolean);
}

export function skillsRoot(): string {
  const root = candidateRoots().find((p) => fs.existsSync(p) && fs.statSync(p).isDirectory());
  if (!root) throw new Error(`skill catalogue not found; checked: ${candidateRoots().join(", ")}`);
  return root;
}

function frontmatter(raw: string): Record<string, string> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) result[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return result;
}

export function listSkills(): SkillSummary[] {
  const root = skillsRoot();
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const skillPath = path.join(root, entry.name, "SKILL.md");
      if (!fs.existsSync(skillPath)) return [];
      const raw = fs.readFileSync(skillPath, "utf8");
      const fm = frontmatter(raw);
      return [{
        name: fm["name"] || entry.name,
        description: fm["description"] || "",
        path: `src/hosted-agent/skills/${entry.name}/SKILL.md`,
      }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkill(name: string): { name: string; path: string; content: string } | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(name)) return null;
  const root = skillsRoot();
  const skillPath = path.resolve(root, name, "SKILL.md");
  if (!skillPath.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(skillPath)) return null;
  return {
    name,
    path: `src/hosted-agent/skills/${name}/SKILL.md`,
    content: fs.readFileSync(skillPath, "utf8"),
  };
}
