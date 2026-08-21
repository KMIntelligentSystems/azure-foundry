/** Chunk-5 smoke: coder produces a D3 chart and validates it in Chromium. */
import { runRole } from "../src/hosted-agent/broker.js";
import { getRole } from "../src/hosted-agent/imports.js";

const cid = `smoke5-${Date.now()}`;
const role = getRole("coder")!;
const task = `Create charts/line.html: a simple D3 line chart of the series
[10, 12, 11, 15, 18, 17, 22] over months Jan..Jul 2026, dark theme, titled
"Chunk-5 smoke series". Then call render_validate on it and report the result.`;
const r = await runRole(role, "gpt-4.1-mini", task, "(no upstream)", cid);
console.log("terminatedBy:", r.terminatedBy);
console.log("output:", r.output.slice(0, 500));
process.exit(r.terminatedBy === "finish" ? 0 : 1);
