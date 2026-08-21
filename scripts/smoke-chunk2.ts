/** Chunk-2 smoke: two turns on one conversation_id — turn 2 must see turn 1. */
import { orchestrate } from "../src/hosted-agent/orchestrator.js";

const cid = `smoke-${Date.now()}`;
console.log(`conversation: ${cid}\n`);

const t1 = await orchestrate("Summarize June 2026 M3 shipments.", cid);
console.log(`turn 1 ok=${t1.ok} steps=${t1.steps?.length}`);

const t2 = await orchestrate("Now write a one-sentence headline from the previous summary.", cid);
console.log(`turn 2 ok=${t2.ok} steps=${t2.steps?.length}`);
console.log(`turn 2 plan: ${t2.plan?.rationale}`);
console.log(`turn 2 output: ${t2.steps?.[0]?.output?.slice(0, 200)}`);
process.exit(t1.ok && t2.ok ? 0 : 1);
