/**
 * upload-prompt.mjs — push a local prompt file into the Azure prompt library
 * (artifact-service catalog: category "Prompts", subject "Prompt Library",
 * tag "prompt", mimeType text/markdown). The hosted-agent reader role can
 * then fetch it by name; the planner routes prompt-file references to reader.
 *
 * Usage:
 *   node scripts/upload-prompt.mjs <path/to/file.md> [--base <url>] [--user <id>]
 *
 * Example:
 *   node scripts/upload-prompt.mjs ../http_proxy/prompts/aug-2026-ADL.md
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_BASE =
  process.env["ARTIFACT_SERVICE_URL"] ??
  "https://artifact-service.bravesea-f16a8310.eastus.azurecontainerapps.io";

const args = new Map();
const positional = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a, process.argv[++i]);
  else positional.push(a);
}
const file = positional[0];
if (!file) {
  console.error("usage: node scripts/upload-prompt.mjs <file.md> [--base <url>] [--user <id>]");
  process.exit(1);
}
const base = args.get("--base") ?? DEFAULT_BASE;
const userId = args.get("--user") ?? "admin-bootstrap";
const content = fs.readFileSync(file, "utf8");
const filename = path.basename(file);
const title = filename.replace(/\.md$/i, "");

// 1. upload raw bytes
const upRes = await fetch(`${base}/artifacts/upload`, {
  method: "POST",
  headers: {
    "Content-Type": "application/octet-stream",
    "X-User-Id": userId,
    "X-File-Name": filename,
    "X-Mime-Type": "text/markdown",
  },
  body: content,
});
if (!upRes.ok) throw new Error(`upload ${filename}: HTTP ${upRes.status}`);
const { url } = await upRes.json();

// 2. catalog row (role user; admin not required for catalog writes)
// The artifact-service container can briefly refuse connections while it
// restarts (Azure Files lock on revision swap), so retry the POST.
let catRes;
for (let attempt = 1; attempt <= 5; attempt++) {
  catRes = await fetch(`${base}/artifacts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": userId,
      "X-User-Role": "user",
    },
    body: JSON.stringify({
      category: "Prompts",
      subject: "Prompt Library",
      title,
      mimeType: "text/markdown",
      url,
      tags: "prompt",
    }),
  });
  if (catRes.ok) break;
  const text = await catRes.text();
  if (attempt === 5) throw new Error(`catalog ${filename}: HTTP ${catRes.status} ${text}`);
  console.log(`catalog attempt ${attempt} -> HTTP ${catRes.status}; retrying in 5s…`);
  await new Promise((r) => setTimeout(r, 5000));
}
const { id } = await catRes.json();

console.log(`uploaded: ${title}`);
console.log(`  id:  ${id}`);
console.log(`  url: ${base}${url}`);
console.log(`  ref: "run the ${title} prompt" in the SWA chat`);
