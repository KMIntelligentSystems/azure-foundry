/** Chunk-4 direct: run the statistician role on a real stats task (planner bypassed). */
import { runRole } from "../src/hosted-agent/toolbox.js";
import { getRole } from "../src/hosted-agent/imports.js";

const cid = `smoke4b-${Date.now()}`;
const role = getRole("statistician")!;
const task = `Write the workspace file data/obs.csv with header x,y and rows:
1,3.2  2,5.1  3,6.8  4,9.3  5,10.9  6,13.2  7,14.7  8,17.4  9,19.1  10,20.8
Then in Python fit y ~ a + b*x via OLS (statsmodels), print the slope b and its 95% CI,
and write notes/card.json with {slope, ci_low, ci_high, r_squared}.`;
const r = await runRole(role, "gpt-4.1-mini", task, "(no upstream)", cid);
console.log("terminatedBy:", r.terminatedBy);
console.log("usage:", JSON.stringify(r.usage));
console.log("output:", r.output);
process.exit(r.terminatedBy === "finish" ? 0 : 1);
