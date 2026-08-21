/** Chunk-3 smoke B: dispatch gates — unknown tool, path escape, budget price refusal. */
import { dispatch, runRole } from "../src/hosted-agent/broker.js";
import { getRole } from "../src/hosted-agent/imports.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "wstest-"));

// 1. unknown tool
const t1 = dispatch("delete_everything", {}, ["read_file"], ws);
console.log("unknown_tool:", !t1.ok && t1.error?.code === "unknown_tool" ? "PASS" : `FAIL ${JSON.stringify(t1)}`);

// 2. tool not in this role's catalog
const t2 = dispatch("write_file", { path: "x", content: "y" }, ["read_file"], ws);
console.log("catalog gate:", !t2.ok && t2.error?.code === "unknown_tool" ? "PASS" : `FAIL ${JSON.stringify(t2)}`);

// 3. path escape
const t3 = dispatch("read_file", { path: "../../../etc/passwd" }, ["read_file"], ws);
console.log("path_escape:", !t3.ok && t3.error?.code === "path_escape" ? "PASS" : `FAIL ${JSON.stringify(t3)}`);

// 4. unpriced deployment refused before any LLM call
const role = getRole("reader")!;
const t4 = await runRole(role, "gpt-5.6-sol", "anything", "", "gate-test");
console.log("price gate:", t4.output.includes("no known price") ? "PASS" : `FAIL ${t4.output.slice(0, 80)}`);
