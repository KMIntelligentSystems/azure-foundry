/** Chunk-3 smoke A: a real tool loop (reader role writes + reads a workspace file). */
import { orchestrate } from "../src/hosted-agent/orchestrator.js";
const cid = `smoke3-${Date.now()}`;
const r = await orchestrate(
  "Write a file notes/hello.txt containing the line 'toolbox works', then read it back and confirm its contents.",
  cid,
);
console.log(JSON.stringify({ ok: r.ok, conversationId: r.conversationId, plan: r.plan?.rationale,
  steps: r.steps?.map(s => ({ role: s.role, dep: s.deployment, out: s.output.slice(0, 200) })) }, null, 2));
process.exit(r.ok ? 0 : 1);
