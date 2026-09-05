/**
 * deployments.ts — runtime-owned model deployment mapping.
 *
 * Phase-1 refactor (design/new-foundry-design.md): the orchestrator model
 * never chooses deployments. Each role carries its default deployment in its
 * agents/*.md frontmatter (statistician/coder → gpt-4.1, reader/operator/
 * writer/researcher → gpt-4.1-mini); the runtime resolves it at validation
 * time. This module only owns the orchestrator's own deployment constant —
 * previously imported from planner.ts, which made the dormant legacy planner
 * a live dependency of the dynamic stack.
 */
export const ORCHESTRATOR_DEPLOYMENT =
  process.env["ORCHESTRATOR_DEPLOYMENT"] ?? "gpt-4.1";
