/** Smoke: user asks to create a chart and save it to catalog. */
import { orchestrate } from "../src/hosted-agent/orchestrator.js";

const cid = `save-${Date.now()}`;
const userId = "kim";

const prompt = `Create charts/test-save.html — a simple D3 line chart of [5, 8, 6, 10, 12] over Jan..May, dark theme, titled "Save test". Then save it to the catalog: category=Economics, subject=M3 Manufacturing, title="June shipments test".`;

const result = await orchestrate(prompt, cid, userId);
console.log("ok:", result.ok);
console.log("steps:", result.steps?.map(s => `${s.role}[${s.deployment}]`).join(" → "));
console.log("artifacts:", result.artifacts?.map(a => a.path));
if (result.steps) {
  const saveStep = result.steps.find(s => s.output.includes("save_artifact") || s.output.includes("artifactId"));
  if (saveStep) console.log("save result:", saveStep.output.slice(0, 300));
}
process.exit(result.ok ? 0 : 1);
