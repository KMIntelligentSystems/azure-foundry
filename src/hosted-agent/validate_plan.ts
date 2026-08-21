/**
 * validate_plan.ts — THE GATE. Pure function: plan in, verdict out.
 * Runs before ANY worker token is spent. A planner-authored plan is inert
 * JSON until this passes it.
 */
import { ALLOWLIST, type Plan } from "./planner.js";
import { getRole } from "./imports.js";

export interface PlanVerdict {
  ok: boolean;
  errors: string[];
  plan: Plan; // clamped copy (unknown steps removed)
}

const MAX_STEPS = 5;
const MAX_TASK_CHARS = 2_000;

export function validatePlan(plan: Plan): PlanVerdict {
  const errors: string[] = [];
  const workerDeployments = new Set(
    ALLOWLIST.filter((d) => d.kind === "worker").map((d) => d.name),
  );
  const plannerDeployments = new Set(
    ALLOWLIST.filter((d) => d.kind === "planner").map((d) => d.name),
  );

  if (plan.steps.length === 0) errors.push("plan has zero steps");
  if (plan.steps.length > MAX_STEPS) errors.push(`plan exceeds ${MAX_STEPS} steps (${plan.steps.length})`);

  const steps = plan.steps.filter((s) => {
    if (!getRole(s.role)) {
      errors.push(`step role '${s.role}' is not in the role catalogue`);
      return false;
    }
    if (plannerDeployments.has(s.deployment)) {
      errors.push(`step '${s.role}' targets planner deployment '${s.deployment}' — planner deployments cannot run steps`);
      return false;
    }
    if (!workerDeployments.has(s.deployment)) {
      errors.push(`step '${s.role}' targets '${s.deployment}' — not in the worker allowlist`);
      return false;
    }
    if (!s.task || s.task.length > MAX_TASK_CHARS) {
      errors.push(`step '${s.role}' task missing or over ${MAX_TASK_CHARS} chars`);
      return false;
    }
    return true;
  });

  if (steps.length === 0 && plan.steps.length > 0) {
    errors.push("all steps rejected");
  }

  // Partially-invalid plans proceed on surviving steps (errors reported, not fatal).
  // A plan is rejected only when NOTHING survives or structural limits broke.
  const ok = steps.length > 0 && plan.steps.length <= MAX_STEPS;
  return { ok, errors, plan: { rationale: plan.rationale, steps } };
}
