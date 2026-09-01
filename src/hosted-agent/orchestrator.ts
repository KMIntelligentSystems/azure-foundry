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
import { BUDGET_PROFILES, TurnBudgetLedger, inferTurnBudgetClass, type BudgetSnapshot } from "./budgets.js";

export interface StepResult {
  role: string;
  deployment: string;
  task: string;
  output: string;
  usage: { input: number; output: number };
  round: number;
  budgetProfile: PlanStep["budgetProfile"];
  modelCalls: number;
  toolExecutions: number;
  estimatedCostDollars: number;
  stepCeilingDollars: number;
  terminatedBy: "finish" | "text" | "budget";
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
  totals: { input: number; output: number; estimatedCostDollars: number };
  budget: BudgetSnapshot;
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
  ledger: TurnBudgetLedger,
  userId?: string,
): Promise<StepResult> {
  const role = getRole(step.role);
  if (!role) throw new Error(`role '${step.role}' vanished after validation`);
  const upstreamText = upstream.length === 0
    ? "(no upstream results)"
    : upstream.map((u) => `--- round ${u.round}: ${u.role} ---\n${u.output.slice(0, MAX_STEP_OUTPUT_CHARS)}`).join("\n");
  const res = await runRole(
    role, step.deployment, step.task, upstreamText, conversationId,
    step.budgetProfile, ledger, { userId }, round,
  );
  return {
    role: step.role, deployment: step.deployment, task: step.task,
    output: res.output, usage: res.usage, round,
    budgetProfile: res.profile, modelCalls: res.modelCalls,
    toolExecutions: res.toolExecutions,
    estimatedCostDollars: res.estimatedCostDollars,
    stepCeilingDollars: res.stepCeilingDollars,
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

export async function orchestrate(
  prompt: string,
  conversationId?: string,
  userId?: string,
  eventSink?: AgentEventSink,
): Promise<OrchestratorResult> {
  const totals = { input: 0, output: 0, estimatedCostDollars: 0 };
  const ledger = new TurnBudgetLedger(inferTurnBudgetClass(prompt));
  const id = conversationId && conversationId.trim() ? conversationId : `anon-${Date.now()}`;
  const session = loadSession(id);
  const plans: Plan[] = [];
  const steps: StepResult[] = [];
  const validationErrors: string[] = [];

  await emit(eventSink, { type: "agent_start", conversationId: id, prompt });

  try {
    for (let round = 1; round <= MAX_PLANNING_ROUNDS; round++) {
      await emit(eventSink, { type: "planning_start", conversationId: id, round });
      const planned = await plan(prompt, plannerRoundContext(session, steps), ledger, round);
      totals.input += planned.usage.input;
      totals.output += planned.usage.output;
      totals.estimatedCostDollars = ledger.costDollars;
      const verdict = validatePlan(planned.plan, prompt);
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
          budget: ledger.snapshot(),
        };
      }

      for (let index = 0; index < verdict.plan.steps.length; index++) {
        if (ledger.costDollars >= ledger.policy.costCeilingDollars) {
          throw new Error(`budget_exhausted: turn cost $${ledger.costDollars.toFixed(4)} reached $${ledger.policy.costCeilingDollars.toFixed(2)} ceiling before step ${index + 1}`);
        }
        const step = verdict.plan.steps[index];
        await emit(eventSink, {
          type: "step_start", conversationId: id, round, index,
          role: step.role, deployment: step.deployment, task: step.task,
          budgetProfile: step.budgetProfile,
          stepCeilingDollars: BUDGET_PROFILES[step.budgetProfile].costCeilingDollars,
          turnCostDollars: ledger.costDollars,
          turnCeilingDollars: ledger.policy.costCeilingDollars,
        });
        const result = await executeStep(step, steps, id, round, ledger, userId);
        totals.input += result.usage.input;
        totals.output += result.usage.output;
        totals.estimatedCostDollars = ledger.costDollars;
        steps.push(result);
        await emit(eventSink, {
          type: "step_end", conversationId: id, round, index,
          role: result.role, deployment: result.deployment,
          output: result.output, usage: result.usage,
          budgetProfile: result.budgetProfile,
          modelCalls: result.modelCalls,
          toolExecutions: result.toolExecutions,
          stepCostDollars: result.estimatedCostDollars,
          stepCeilingDollars: result.stepCeilingDollars,
          turnCostDollars: ledger.costDollars,
          turnCeilingDollars: ledger.policy.costCeilingDollars,
          terminatedBy: result.terminatedBy,
        });
        if (result.terminatedBy === "budget") {
          throw new Error(`budget_exhausted: ${result.role} ${result.budgetProfile} step terminated; no later step or planning round was started`);
        }
      }

      if (!verdict.plan.continuePlanning) {
        const completed = steps.every((step) => step.terminatedBy !== "budget");
        record(session, prompt, plans, steps, totals, completed);
        const artifacts = collectArtifacts(id);
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
          budget: ledger.snapshot(),
        };
      }

      if (ledger.costDollars >= ledger.policy.costCeilingDollars) {
        throw new Error(`budget_exhausted: turn cost $${ledger.costDollars.toFixed(4)} reached $${ledger.policy.costCeilingDollars.toFixed(2)} ceiling before replanning`);
      }
      await emit(eventSink, { type: "replanning", conversationId: id, round });
    }

    throw new Error(`iterative planner exceeded ${MAX_PLANNING_ROUNDS} rounds without a terminal plan`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    totals.estimatedCostDollars = ledger.costDollars;
    record(session, prompt, plans, steps, totals, false);
    if (message.startsWith("budget_exhausted:")) {
      const artifacts = collectArtifacts(id);
      await emit(eventSink, { type: "agent_error", conversationId: id, error: message });
      return {
        ok: false,
        conversationId: id,
        plan: aggregatePlan(plans),
        plans,
        ...(validationErrors.length ? { validationErrors } : {}),
        steps,
        artifacts,
        response: `${message}\n\n${renderPendingTree(artifacts)}`,
        totals,
        budget: ledger.snapshot(),
      };
    }
    await emit(eventSink, { type: "agent_error", conversationId: id, error: message });
    throw error;
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
    ...steps.map((s, i) => `STEP ${i + 1} / ROUND ${s.round} [${s.role} on ${s.deployment} · ${s.budgetProfile} · $${s.estimatedCostDollars.toFixed(4)} / $${s.stepCeilingDollars.toFixed(2)}]\n${s.output}`),
    "",
    renderPendingTree(artifacts),
  ].join("\n");
}

function record(
  session: SessionState,
  prompt: string,
  plans: Plan[],
  steps: StepResult[],
  totals: { input: number; output: number; estimatedCostDollars: number },
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
