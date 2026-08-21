/** Chunk-4 smoke: statistician computes a real regression in Python. */
import { orchestrate } from "../src/hosted-agent/orchestrator.js";
const cid = `smoke4-${Date.now()}`;
const r = await orchestrate(
  "The workspace file data/obs.csv does not exist yet. First write it with rows x,y for x=1..10, y=2*x+1+small noise (e.g. 3.2,5.1,6.8,9.3,10.9,13.2,14.7,17.4,19.1,20.8). Then fit y ~ a + b*x with OLS in Python, report b with a 95% CI, and write the model card to notes/card.json.",
  cid,
);
console.log(JSON.stringify({ ok: r.ok, plan: r.plan?.rationale,
  steps: r.steps?.map(s => ({ role: s.role, dep: s.deployment, out: s.output.slice(0, 400) })) }, null, 2));
process.exit(r.ok ? 0 : 1);
