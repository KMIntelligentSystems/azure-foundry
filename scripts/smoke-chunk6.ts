/** Chunk-6 smoke: full mini-pipeline in ONE conversation —
 *  statistician (data + regression) → coder (validated chart) → pending tree. */
import { orchestrate } from "../src/hosted-agent/orchestrator.js";
const cid = `smoke6-${Date.now()}`;
const prompt = `In the conversation workspace: (1) create data/obs.csv with x=1..12 and y = 5 + 1.5x + noise (use values 6.7, 8.1, 9.9, 11.4, 12.8, 14.5, 15.7, 17.2, 18.9, 20.3, 22.1, 23.4); (2) fit OLS y ~ a + b*x in Python and write notes/model.json with slope, intercept, r_squared; (3) create charts/series.html — a D3 line chart of the series with the fitted line overlaid, dark theme, validated with render_validate. Then finish.`;
const r = await orchestrate(prompt, cid);
console.log("ok:", r.ok);
console.log("validationErrors:", r.validationErrors ?? "none");
console.log("steps:", r.steps?.map(s => `${s.role}[${s.deployment}]`).join(" → "));
console.log("artifacts:", JSON.stringify(r.artifacts));
console.log("\n--- response tail ---");
console.log(r.response.split("\n").slice(-8).join("\n"));
process.exit(r.ok ? 0 : 1);
