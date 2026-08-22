/**
 * orchestrator.ts — the outer loop. planner → validate_plan → execute steps
 * → finish. Chunk 1: roles have NO tools; execution is one Responses call per
 * step whose final text becomes that step's output. Tool catalogs land in
 * chunk 3 (broker.ts).
 */
import { callLlm } from "./foundry.js";
import { plan, type Plan, type PlanStep, DEPLOYMENT_ALIAS } from "./planner.js";
import { validatePlan } from "./validate_plan.js";
import { getRole } from "./imports.js";
import { runRole } from "./broker.js";
import { collectArtifacts, renderPendingTree, type ArtifactRef } from "./artifacts.js";
import {
  loadSession,
  saveSession,
  summarizePrior,
  type SessionState,
  type TurnRecord,
} from "./session.js";

export interface StepResult {
  role: string;
  deployment: string;
  output: string;
  usage: { input: number; output: number };
}

export interface OrchestratorResult {
  ok: boolean;
  conversationId: string;
  plan?: Plan;
  validationErrors?: string[];
  steps?: StepResult[];
  artifacts?: ArtifactRef[];
  response: string;
  totals: { input: number; output: number };
}

const MAX_STEP_OUTPUT_CHARS = 6_000;

async function executeStep(step: PlanStep, upstream: StepResult[], conversationId: string, userId?: string): Promise<StepResult> {
  const role = getRole(step.role);
  if (!role) throw new Error(`role '${step.role}' vanished after validation`);
  const upstreamText =
    upstream.length === 0
      ? "(no upstream results)"
      : upstream.map((u) => `--- ${u.role} ---\n${u.output.slice(0, MAX_STEP_OUTPUT_CHARS)}`).join("\n");
  const actualDeployment = DEPLOYMENT_ALIAS[step.deployment] ?? step.deployment;
  const res = await runRole(role, actualDeployment, step.task, upstreamText, conversationId, undefined, { userId });
  // Report the alias (what the plan asked for), not the mapped target.
  return { role: step.role, deployment: step.deployment, output: res.output, usage: res.usage };
}

export async function orchestrate(prompt: string, conversationId?: string, userId?: string): Promise<OrchestratorResult> {
  const totals = { input: 0, output: 0 };
  const id = conversationId && conversationId.trim() ? conversationId : `anon-${Date.now()}`;
  const session = loadSession(id);

  // Call 1: planner (strong deployment, structured plan only). Prior turns are
  // part of the planner's context — the LLM sees nothing we don't give it.
  const rawPlan = await plan(prompt, summarizePrior(session));

  // THE GATE — no worker token is spent before this passes.
  const verdict = validatePlan(rawPlan);
  if (!verdict.ok) {
    record(session, prompt, rawPlan, [], totals, false);
    return {
      ok: false,
      conversationId: id,
      plan: rawPlan,
      validationErrors: verdict.errors,
      response: `Plan rejected by validator: ${verdict.errors.join("; ")}`,
      totals,
    };
  }

  // Execute steps sequentially (chunk 1: simple chain; parallelism is a later decision)
  const steps: StepResult[] = [];
  for (const step of verdict.plan.steps) {
    const r = await executeStep(step, steps, id, userId);
    totals.input += r.usage.input;
    totals.output += r.usage.output;
    steps.push(r);
  }

  record(session, prompt, verdict.plan, steps, totals, true);

  const artifacts = collectArtifacts(id);
  const response = [
    `PLAN: ${verdict.plan.rationale}`,
    ...(verdict.errors.length > 0 ? [`VALIDATOR NOTES: ${verdict.errors.join("; ")}`, ``] : []),
    ...steps.map((s, i) => `STEP ${i + 1} [${s.role} on ${s.deployment}]\n${s.output}`),
    ``,
    renderPendingTree(artifacts),
  ].join("\n");

  return {
    ok: true,
    conversationId: id,
    plan: verdict.plan,
    ...(verdict.errors.length > 0 ? { validationErrors: verdict.errors } : {}),
    steps,
    artifacts,
    response,
    totals,
  };
}

function record(
  session: SessionState,
  prompt: string,
  plan: Plan,
  steps: StepResult[],
  totals: { input: number; output: number },
  ok: boolean,
): void {
  const turn: TurnRecord = {
    at: new Date().toISOString(),
    prompt,
    planRationale: plan.rationale,
    steps: steps.map((s) => ({
      at: new Date().toISOString(),
      role: s.role,
      deployment: s.deployment,
      task: plan.steps.find((p) => p.role === s.role)?.task ?? "",
      output: s.output,
      usage: s.usage,
    })),
    totals,
    ok,
  };
  session.turns.push(turn);
  saveSession(session);
}
