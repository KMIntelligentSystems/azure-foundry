/**
 * Iterative orchestrator: planner → validate → execute → replan as needed.
 *
 * Discovery is a first-class round. A reader can resolve a prompt/artifact,
 * return it to the planner, and only then does the planner choose substantive
 * statistician/coder work. All rounds remain inside one synchronous turn.
 */
import { plan, type Plan, type PlanStep } from "./planner.js";
import { validatePlan } from "./validate_plan.js";
import { getRole } from "./imports.js";
import { runRole } from "./toolbox.js";
import { collectArtifacts, renderPendingTree, type ArtifactRef } from "./artifacts.js";
import {
  loadSession,
  saveSession,
  summarizePrior,
  type SessionState,
  type TurnRecord,
} from "./session.js";
import type { AgentEventSink } from "./events.js";

export interface StepResult {
  role: string;
  deployment: string;
  task: string;
  output: string;
  usage: { input: number; output: number };
  round: number;
  modelCalls: number;
  toolExecutions: number;
  terminatedBy: "finish" | "text" | "limit";
}

export interface OrchestratorResult {
  ok: boolean;
  conversationId: string;
  /** Flattened aggregate retained for React/backward compatibility. */
  plan?: Plan;
  plans?: Plan[];
  validationErrors?: string[];
  steps?: StepResult[];
  artifacts?: ArtifactRef[];
  response: string;
  totals: { input: number; output: number };
}

const MAX_STEP_OUTPUT_CHARS = 6_000;
const MAX_PLANNING_ROUNDS = 6;

async function emit(sink: AgentEventSink | undefined, event: Parameters<AgentEventSink>[0]): Promise<void> {
  await sink?.(event);
}

async function executeStep(
  step: PlanStep,
  upstream: StepResult[],
  conversationId: string,
  round: number,
  userId?: string,
): Promise<StepResult> {
  const role = getRole(step.role);
  if (!role) throw new Error(`role '${step.role}' vanished after validation`);
  const upstreamText = upstream.length === 0
    ? "(no upstream results)"
    : upstream.map((u) => `--- round ${u.round}: ${u.role} ---\n${u.output.slice(0, MAX_STEP_OUTPUT_CHARS)}`).join("\n");
  const res = await runRole(
    role, step.deployment, step.task, upstreamText, conversationId,
    { userId }, round,
  );
  return {
    role: step.role, deployment: step.deployment, task: step.task,
    output: res.output, usage: res.usage, round,
    modelCalls: res.modelCalls,
    toolExecutions: res.toolExecutions,
    terminatedBy: res.terminatedBy,
  };
}

function plannerRoundContext(session: SessionState, steps: StepResult[]): string {
  const prior = summarizePrior(session);
  if (steps.length === 0) return prior;
  const current = steps.map((step) =>
    `--- round ${step.round}: ${step.role} [${step.deployment}] ---\nTASK: ${step.task}\nOUTPUT:\n${step.output.slice(0, MAX_STEP_OUTPUT_CHARS)}`,
  ).join("\n\n");
  return `${prior}\n\nCURRENT TURN EXECUTION RESULTS:\n${current}\n\nWorkspace files produced by these steps persist for the next round.`;
}

function planningPrompt(prompt: string, session: SessionState): string {
  if (!/^\s*(continue|retry|resume|try again)\b/i.test(prompt)) return prompt;
  // A failed retry may itself contain a planner-narrowed task. Recover the
  // fullest prior specification, not merely the last step, so "continue"
  // cannot silently drop models, validation, outputs, or chart feeds.
  const previousTask = session.turns
    .flatMap((turn) => turn.steps.map((step) => step.task))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0];
  if (!previousTask) return prompt;
  return `${prompt.trim()}\n\nRETRY/RESUME THE COMPLETE PREVIOUS TASK WITHOUT NARROWING ITS SCOPE:\n${previousTask}`;
}

export async function orchestrate(
  prompt: string,
  conversationId?: string,
  userId?: string,
  eventSink?: AgentEventSink,
): Promise<OrchestratorResult> {
  const totals = { input: 0, output: 0 };
  const id = conversationId && conversationId.trim() ? conversationId : `anon-${Date.now()}`;
  const session = loadSession(id);
  const plans: Plan[] = [];
  const steps: StepResult[] = [];
  const validationErrors: string[] = [];
  const effectivePrompt = planningPrompt(prompt, session);

  await emit(eventSink, { type: "agent_start", conversationId: id, prompt });

  try {
    for (let round = 1; round <= MAX_PLANNING_ROUNDS; round++) {
      await emit(eventSink, { type: "planning_start", conversationId: id, round });
      const planned = await plan(effectivePrompt, plannerRoundContext(session, steps));
      totals.input += planned.usage.input;
      totals.output += planned.usage.output;
      const verdict = validatePlan(planned.plan);
      plans.push(verdict.plan);
      validationErrors.push(...verdict.errors.map((error) => `round ${round}: ${error}`));

      await emit(eventSink, {
        type: "plan",
        conversationId: id,
        round,
        rationale: verdict.plan.rationale,
        continuePlanning: verdict.plan.continuePlanning,
        steps: verdict.plan.steps,
      });
      if (verdict.errors.length) {
        await emit(eventSink, { type: "validation", conversationId: id, round, errors: verdict.errors });
      }

      if (!verdict.ok) {
        record(session, prompt, plans, steps, totals, false);
        await emit(eventSink, { type: "agent_end", conversationId: id, ok: false });
        return {
          ok: false,
          conversationId: id,
          plan: aggregatePlan(plans),
          plans,
          validationErrors,
          steps,
          response: `Plan rejected by validator: ${verdict.errors.join("; ")}`,
          totals,
        };
      }

      for (let index = 0; index < verdict.plan.steps.length; index++) {
        const step = verdict.plan.steps[index];
        await emit(eventSink, {
          type: "step_start", conversationId: id, round, index,
          role: step.role, deployment: step.deployment, task: step.task,
        });
        const result = await executeStep(step, steps, id, round, userId);
        totals.input += result.usage.input;
        totals.output += result.usage.output;
        steps.push(result);
        await emit(eventSink, {
          type: "step_end", conversationId: id, round, index,
          role: result.role, deployment: result.deployment,
          output: result.output, usage: result.usage,
          modelCalls: result.modelCalls,
          toolExecutions: result.toolExecutions,
          terminatedBy: result.terminatedBy,
        });
      }

      if (!verdict.plan.continuePlanning) {
        const completed = steps.every((step) => step.terminatedBy !== "limit");
        record(session, prompt, plans, steps, totals, completed);
        const artifacts = await collectArtifacts(id, userId);
        const response = formatResponse(plans, validationErrors, steps, artifacts);
        await emit(eventSink, { type: "agent_end", conversationId: id, ok: completed });
        return {
          ok: completed,
          conversationId: id,
          plan: aggregatePlan(plans),
          plans,
          ...(validationErrors.length ? { validationErrors } : {}),
          steps,
          artifacts,
          response,
          totals,
        };
      }

      await emit(eventSink, { type: "replanning", conversationId: id, round });
    }

    throw new Error(`iterative planner exceeded ${MAX_PLANNING_ROUNDS} rounds without a terminal plan`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record(session, prompt, plans, steps, totals, false);
    const artifacts = await collectArtifacts(id, userId);
    await emit(eventSink, { type: "agent_error", conversationId: id, error: message });
    await emit(eventSink, { type: "agent_end", conversationId: id, ok: false });
    return {
      ok: false,
      conversationId: id,
      plan: aggregatePlan(plans),
      plans,
      ...(validationErrors.length ? { validationErrors } : {}),
      steps,
      artifacts,
      response: `Turn failed after producing partial results: ${message}\n\n${formatResponse(plans, validationErrors, steps, artifacts)}`,
      totals,
    };
  }
}

function aggregatePlan(plans: Plan[]): Plan {
  return {
    rationale: plans.map((p, i) => `Round ${i + 1}: ${p.rationale}`).join(" | "),
    continuePlanning: false,
    steps: plans.flatMap((p) => p.steps),
  };
}

function formatResponse(plans: Plan[], errors: string[], steps: StepResult[], artifacts: ArtifactRef[]): string {
  return [
    ...plans.map((p, i) => `PLAN ROUND ${i + 1}: ${p.rationale}${p.continuePlanning ? " (replan after execution)" : ""}`),
    ...(errors.length ? [`VALIDATOR NOTES: ${errors.join("; ")}`, ""] : []),
    ...steps.map((s, i) => `STEP ${i + 1} / ROUND ${s.round} [${s.role} on ${s.deployment} · ${s.modelCalls} calls / ${s.toolExecutions} tools]\n${s.output}`),
    "",
    renderPendingTree(artifacts),
  ].join("\n");
}

function record(
  session: SessionState,
  prompt: string,
  plans: Plan[],
  steps: StepResult[],
  totals: { input: number; output: number },
  ok: boolean,
): void {
  const turn: TurnRecord = {
    at: new Date().toISOString(),
    prompt,
    planRationale: plans.map((p, i) => `Round ${i + 1}: ${p.rationale}`).join(" | "),
    steps: steps.map((s) => ({
      at: new Date().toISOString(),
      role: s.role,
      deployment: s.deployment,
      task: s.task,
      output: s.output,
      usage: s.usage,
    })),
    totals,
    ok,
  };
  session.turns.push(turn);
  saveSession(session);
}
