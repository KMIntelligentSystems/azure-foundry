/**
 * planner.ts — the planner/executor split (design: n2-orchestrator-emulation.md).
 * Call 1 runs on the planner deployment and returns a STRUCTURED plan via one
 * function call. The plan is inert data until validate_plan.ts passes it.
 */
import { callLlm } from "./foundry.js";
import { describeRolesForPlanner } from "./imports.js";
import {
  BUDGET_PROFILES,
  ROLE_PROFILE_ALLOWLIST,
  TurnBudgetLedger,
  estimateInputTokens,
  type BudgetProfileName,
  type TokenUsage,
} from "./budgets.js";

export interface PlanStep {
  role: string;
  task: string;
  deployment: string;
  budgetProfile: BudgetProfileName;
}

export interface Plan {
  steps: PlanStep[];
  rationale: string;
  /** True when execution should return to the planner after these steps. */
  continuePlanning: boolean;
}

export interface DeploymentEntry {
  name: string;
  /** "planner" may only plan; "worker" may only run steps. */
  kind: "planner" | "worker";
  costHint: string; // shown to the planner so allocation is informed
}

export const ALLOWLIST: DeploymentEntry[] = [
  // NOTE: gpt-5.6-sol (the design-doc planner) has zero quota in this subscription
  // (2026-08-19; deployment request → InsufficientQuota). gpt-4.1 is the deployed
  // strong planner until a quota request lands.
  { name: "gpt-4.1", kind: "planner", costHint: "strongest deployed; planning only" },
  { name: "gpt-4.1-mini", kind: "worker", costHint: "cheap + fast; default for routine steps" },
  { name: "gpt-4.1-strong", kind: "worker", costHint: "same gpt-4.1 weights, marked for statistics — deployment alias, not a separate model" },
];

// The alias maps onto the same underlying deployment; the marker exists so the
// validator can distinguish "planner seat" from "strong worker seat" without
// two Azure deployments (which would double quota).
export const PLANNER_DEPLOYMENT = "gpt-4.1";

function plannerInstructions(): string {
  const zoo = ALLOWLIST.map(
    (d) => `- ${d.name} (${d.kind}): ${d.costHint}`,
  ).join("\n");
  return `You are the PLANNER for a data-visualization agent. A user prompt arrives;
you decompose it into an execution plan and NOTHING else.

AVAILABLE ROLES (the only roles that exist):
${describeRolesForPlanner()}

AVAILABLE DEPLOYMENTS (choose one per step; cheaper is better when quality allows):
${zoo}

BUDGET PROFILES (classify workload only; trusted runtime owns all limits):
${Object.values(BUDGET_PROFILES).map((profile) => `- ${profile.name}`).join("\n")}

ROLE/PROFILE COMPATIBILITY:
${Object.entries(ROLE_PROFILE_ALLOWLIST).map(([role, profiles]) => `- ${role}: ${profiles.join(" | ")}`).join("\n")}

RULES:
- Output exactly one call to emit_plan. No prose, no other tools.
- 1-5 steps. Each step: role (from the list), task (self-contained instruction),
  deployment (a WORKER deployment; never a planner one), and budgetProfile
  (one compatible named profile). Never emit dollar or token limits.
- Classify narrowly: availability/coverage → metadata; prompt/URL/artifact
  discovery → discovery; latest value/YoY/cutoff → simple-transform; regression,
  diagnostics, a fixed OLS/ADL, or a small backtest → standard-analysis; the
  complete four-model ADL workflow → full-nowcast; one chart → single-chart;
  multiple charts → chart-batch.
- Set continuePlanning=true whenever a step discovers information that is
  required to choose later work: resolving a prompt file/URL, inspecting an
  unknown artifact, or researching a source. In that case emit ONLY the
  discovery step(s). The orchestrator will execute them, return their outputs
  and workspace state to you, and ask you for the next plan. Do not guess the
  downstream role before discovery is complete.
- Set continuePlanning=false only when these steps complete the user's request.
- SELF-CONTAINED means VERBATIM: the worker sees ONLY the task text. Every URL
  (INCLUDING its full query string — SAS signatures live there), artifact id,
  file path, or exact instruction the step needs must be copied INTO the task
  text. A task that says "fetch the provided URL" without the URL is a failed
  plan.
- INDICATOR PANEL: when the task involves refresh.db:indicator_history — the ADL
  panel, nowcasts, leading indicators — route to statistician (it has the panel
  read + Python verbs); reader and catalog roles cannot do that work.
- Do not invent roles. If the prompt needs no roles, emit a plan with a single
  step whose role best answers directly.

PROMPT FILES: reusable prompt documents live in the artifact catalog as
text/markdown artifacts tagged "prompt" (category "Prompts"). When the user
references a prompt file by name (e.g. "run the aug-2026-ADL prompt" or
"/prompts/aug-2026-ADL.md"), emit ONLY a reader step that lists prompt-tagged
artifacts and reads the matching one, with continuePlanning=true. On the next
planning round the resolved contents will be in PRIOR EXECUTION RESULTS; then
plan the statistician/coder work required by those contents.`;
}

const EMIT_PLAN_TOOL = {
  type: "function" as const,
  name: "emit_plan",
  description: "Emit the execution plan for the user prompt.",
  strict: true,
  parameters: {
    type: "object",
    properties: {
      rationale: { type: "string", description: "One sentence on the allocation." },
      continuePlanning: { type: "boolean", description: "Whether the orchestrator must execute these steps and ask the planner for another plan." },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            role: { type: "string" },
            task: { type: "string" },
            deployment: { type: "string" },
            budgetProfile: { type: "string", enum: Object.keys(BUDGET_PROFILES) },
          },
          required: ["role", "task", "deployment", "budgetProfile"],
          additionalProperties: false,
        },
      },
    },
    required: ["rationale", "continuePlanning", "steps"],
    additionalProperties: false,
  },
};

export interface PlanResult {
  plan: Plan;
  usage: TokenUsage;
  estimatedCostDollars: number;
}

/** One planning round: prompt + prior/round context → raw plan + charged usage. */
export async function plan(
  prompt: string,
  priorContext = "(no prior turns)",
  ledger?: TurnBudgetLedger,
  round = 1,
  modelCaller: typeof callLlm = callLlm,
): Promise<PlanResult> {
  const instructions = plannerInstructions();
  const input = [
    {
      role: "user",
      content: `PRIOR CONVERSATION:\n${priorContext}\n\nCURRENT PROMPT:\n${prompt}`,
    },
  ];
  const maxOutputTokens = 2_048;
  if (ledger) {
    const admission = ledger.canStartPlannerCall(
      PLANNER_DEPLOYMENT,
      estimateInputTokens({ instructions, input, tools: EMIT_PLAN_TOOL }),
      maxOutputTokens,
    );
    if (!admission.ok) throw new Error(`budget_exhausted: ${admission.reason}`);
  }
  const res = await modelCaller({
    model: PLANNER_DEPLOYMENT,
    instructions,
    input,
    tools: [EMIT_PLAN_TOOL],
    maxOutputTokens,
  });
  const charge = ledger?.charge({
    kind: "planner",
    deployment: PLANNER_DEPLOYMENT,
    round,
    usage: res.usage,
  });
  const call = res.functionCalls.find((c) => c.name === "emit_plan");
  if (!call) {
    throw new Error(`planner produced no emit_plan call (text: ${res.text.slice(0, 200)})`);
  }
  return {
    plan: {
      rationale: String(call.args["rationale"] ?? ""),
      continuePlanning: call.args["continuePlanning"] === true,
      steps: (call.args["steps"] as PlanStep[] | undefined) ?? [],
    },
    usage: res.usage,
    estimatedCostDollars: charge?.estimatedCostDollars ?? 0,
  };
}
