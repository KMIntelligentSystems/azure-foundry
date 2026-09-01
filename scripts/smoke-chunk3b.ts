/** Chunk-3 smoke B: dispatch gates — unknown tool and path safety. */
import { dispatch } from "../src/hosted-agent/toolbox.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "wstest-"));

// 1. unknown tool
const t1 = await dispatch("delete_everything", {}, ["read_file"], ws);
console.log("unknown_tool:", !t1.ok && t1.error?.code === "unknown_tool" ? "PASS" : `FAIL ${JSON.stringify(t1)}`);

// 2. tool not in this role's catalog
const t2 = await dispatch("write_file", { path: "x", content: "y" }, ["read_file"], ws);
console.log("catalog gate:", !t2.ok && t2.error?.code === "unknown_tool" ? "PASS" : `FAIL ${JSON.stringify(t2)}`);

// 3. path escape
const t3 = await dispatch("read_file", { path: "../../../etc/passwd" }, ["read_file"], ws);
console.log("path_escape:", !t3.ok && t3.error?.code === "path_escape" ? "PASS" : `FAIL ${JSON.stringify(t3)}`);

// 4. directory paths produce a recoverable tool error, not an EISDIR throw
const t4 = await dispatch("read_file", { path: "." }, ["read_file"], ws);
console.log("directory read:", !t4.ok && t4.error?.code === "not_file" ? "PASS" : `FAIL ${JSON.stringify(t4)}`);
const t4b = await dispatch("write_file", { path: ".", content: "bad target" }, ["write_file"], ws);
console.log("directory write:", !t4b.ok && t4b.error?.code === "not_file" ? "PASS" : `FAIL ${JSON.stringify(t4b)}`);

// 5. upload and render paths enforce the same regular-file contract
const t5 = await dispatch(
  "save_artifact",
  { path: ".", category: "Test", subject: "Path safety" },
  ["save_artifact"],
  ws,
  { userId: "smoke" },
);
console.log("directory upload:", !t5.ok && t5.error?.code === "not_file" ? "PASS" : `FAIL ${JSON.stringify(t5)}`);
const t6 = await dispatch("render_validate", { path: "." }, ["render_validate"], ws);
console.log("directory render:", !t6.ok && t6.error?.code === "not_file" ? "PASS" : `FAIL ${JSON.stringify(t6)}`);

// 6. missing paths preserve the structured not_found contract
const t7 = await dispatch("read_file", { path: "missing.txt" }, ["read_file"], ws);
console.log("missing file:", !t7.ok && t7.error?.code === "not_found" ? "PASS" : `FAIL ${JSON.stringify(t7)}`);

// (budget price-refusal gate removed with budgets.ts)
