/**
 * Chunk-1 smoke: runs the orchestrator locally against Foundry.
 * Uses your az-login identity (DefaultAzureCredential) — the same path the
 * sandbox's injected identity takes, minus the sandbox.
 *
 *   npx tsx scripts/smoke-chunk1.ts
 *   PROMPT="..." npx tsx scripts/smoke-chunk1.ts
 */
import { orchestrate } from "../src/hosted-agent/orchestrator.js";

const prompt =
  process.env["PROMPT"] ??
  "Summarize the June 2026 M3 shipments data and write a two-sentence briefing.";

const result = await orchestrate(prompt);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
