/**
 * Trusted application budget policy.
 *
 * The planner may classify work with a named profile, but it never controls
 * dollar values. This module owns prices, profile limits, compatibility,
 * prompt-relative clamps, admission reservations, and turn accounting.
 */

export type BudgetProfileName =
  | "metadata"
  | "discovery"
  | "simple-transform"
  | "standard-analysis"
  | "full-nowcast"
  | "single-chart"
  | "chart-batch"
  | "writing"
  | "operation";

export type TurnBudgetClass = "simple" | "standard" | "full";

export interface DeploymentPrice {
  input: number;
  output: number;
}

export interface BudgetProfile {
  name: BudgetProfileName;
  maxModelCalls: number;
  maxToolExecutions: number;
  wallClockSecs: number;
  maxOutputTokensPerCall: number;
  costCeilingDollars: number;
}

export interface TurnBudgetPolicy {
  name: TurnBudgetClass;
  maxPlannerCalls: number;
  costCeilingDollars: number;
}

export interface TokenUsage {
  input: number;
  output: number;
}

export interface ModelCallCharge {
  kind: "planner" | "worker";
  deployment: string;
  role?: string;
  round?: number;
  profile?: BudgetProfileName;
  usage: TokenUsage;
  estimatedCostDollars: number;
}

export interface BudgetSnapshot {
  turnClass: TurnBudgetClass;
  turnCeilingDollars: number;
  turnCostDollars: number;
  remainingDollars: number;
  plannerCalls: number;
  modelCalls: number;
  calls: ModelCallCharge[];
}

// Azure list-price estimates in dollars per 1K tokens. Aliases must resolve to
// the actual billed deployment before lookup. Production may override the
// complete table with trusted BUDGET_PRICES_JSON configuration.
const DEFAULT_PRICES: Record<string, DeploymentPrice> = {
  "gpt-4.1-mini": { input: 0.0004, output: 0.0016 },
  "gpt-4.1": { input: 0.002, output: 0.008 },
};

export const DEPLOYMENT_ALIASES: Record<string, string> = {
  "gpt-4.1-strong": "gpt-4.1",
};

export const BUDGET_PROFILES: Record<BudgetProfileName, BudgetProfile> = {
  metadata: {
    name: "metadata", maxModelCalls: 4, maxToolExecutions: 4,
    wallClockSecs: 45, maxOutputTokensPerCall: 1_000, costCeilingDollars: 0.03,
  },
  discovery: {
    name: "discovery", maxModelCalls: 6, maxToolExecutions: 8,
    wallClockSecs: 90, maxOutputTokensPerCall: 1_500, costCeilingDollars: 0.08,
  },
  "simple-transform": {
    name: "simple-transform", maxModelCalls: 8, maxToolExecutions: 8,
    wallClockSecs: 120, maxOutputTokensPerCall: 2_000, costCeilingDollars: 0.15,
  },
  "standard-analysis": {
    name: "standard-analysis", maxModelCalls: 16, maxToolExecutions: 16,
    wallClockSecs: 300, maxOutputTokensPerCall: 4_096, costCeilingDollars: 0.35,
  },
  "full-nowcast": {
    name: "full-nowcast", maxModelCalls: 30, maxToolExecutions: 30,
    wallClockSecs: 900, maxOutputTokensPerCall: 6_000, costCeilingDollars: 1.25,
  },
  "single-chart": {
    name: "single-chart", maxModelCalls: 8, maxToolExecutions: 8,
    wallClockSecs: 120, maxOutputTokensPerCall: 4_096, costCeilingDollars: 0.15,
  },
  "chart-batch": {
    name: "chart-batch", maxModelCalls: 30, maxToolExecutions: 30,
    wallClockSecs: 900, maxOutputTokensPerCall: 6_000, costCeilingDollars: 0.75,
  },
  writing: {
    name: "writing", maxModelCalls: 4, maxToolExecutions: 2,
    wallClockSecs: 90, maxOutputTokensPerCall: 3_000, costCeilingDollars: 0.08,
  },
  operation: {
    name: "operation", maxModelCalls: 4, maxToolExecutions: 4,
    wallClockSecs: 120, maxOutputTokensPerCall: 1_500, costCeilingDollars: 0.05,
  },
};

export const TURN_BUDGETS: Record<TurnBudgetClass, TurnBudgetPolicy> = {
  simple: { name: "simple", maxPlannerCalls: 3, costCeilingDollars: 0.20 },
  standard: { name: "standard", maxPlannerCalls: 6, costCeilingDollars: 0.60 },
  full: { name: "full", maxPlannerCalls: 6, costCeilingDollars: 2.00 },
};

export const ROLE_PROFILE_ALLOWLIST: Record<string, readonly BudgetProfileName[]> = {
  reader: ["metadata", "discovery"],
  statistician: ["simple-transform", "standard-analysis", "full-nowcast"],
  coder: ["single-chart", "chart-batch"],
  operator: ["operation"],
  researcher: ["discovery"],
  writer: ["writing"],
};

const ROLE_PROFILE_RANK: Record<string, Partial<Record<BudgetProfileName, number>>> = {
  reader: { metadata: 0, discovery: 1 },
  statistician: { "simple-transform": 0, "standard-analysis": 1, "full-nowcast": 2 },
  coder: { "single-chart": 0, "chart-batch": 1 },
  operator: { operation: 0 },
  researcher: { discovery: 0 },
  writer: { writing: 0 },
};

function parseConfiguredPrices(): Record<string, DeploymentPrice> {
  const raw = process.env["BUDGET_PRICES_JSON"]?.trim();
  if (!raw) return DEFAULT_PRICES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`BUDGET_PRICES_JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("BUDGET_PRICES_JSON must be an object keyed by deployment");
  }
  const prices: Record<string, DeploymentPrice> = {};
  for (const [deployment, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`BUDGET_PRICES_JSON.${deployment} must contain input and output prices`);
    }
    const input = Number((value as Record<string, unknown>)["input"]);
    const output = Number((value as Record<string, unknown>)["output"]);
    if (!Number.isFinite(input) || input <= 0 || !Number.isFinite(output) || output <= 0) {
      throw new Error(`BUDGET_PRICES_JSON.${deployment} prices must be positive numbers`);
    }
    prices[deployment] = { input, output };
  }
  if (Object.keys(prices).length === 0) throw new Error("BUDGET_PRICES_JSON cannot be empty");
  return prices;
}

export const PRICES = parseConfiguredPrices();

export function actualDeployment(deployment: string): string {
  return DEPLOYMENT_ALIASES[deployment] ?? deployment;
}

export function priceFor(deployment: string): DeploymentPrice | undefined {
  return PRICES[actualDeployment(deployment)];
}

export function usageCost(deployment: string, usage: TokenUsage): number {
  const price = priceFor(deployment);
  if (!price) throw new Error(`deployment '${deployment}' has no configured budget price`);
  return (usage.input * price.input + usage.output * price.output) / 1_000;
}

export function reservationCost(deployment: string, estimatedInputTokens: number, maxOutputTokens: number): number {
  return usageCost(deployment, {
    input: Math.max(0, Math.ceil(estimatedInputTokens)),
    output: Math.max(0, Math.ceil(maxOutputTokens)),
  });
}

/** Conservative token estimate for admission control; actual usage is charged after the call. */
export function estimateInputTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.max(1, Math.ceil(Buffer.byteLength(text ?? "", "utf8") / 3.5));
}

export function isBudgetProfileName(value: string): value is BudgetProfileName {
  return Object.prototype.hasOwnProperty.call(BUDGET_PROFILES, value);
}

export function profileAllowedForRole(role: string, profile: BudgetProfileName): boolean {
  return ROLE_PROFILE_ALLOWLIST[role]?.includes(profile) === true;
}

/** Trusted maximum derived from user intent. The planner cannot exceed it. */
export function maximumProfileFor(role: string, prompt: string): BudgetProfileName {
  // Only original user intent is trusted for the maximum. A planner-authored
  // task must not be able to escalate its own spending classification.
  const text = prompt.toLowerCase();
  switch (role) {
    case "statistician": {
      const fullRequested = /\b(full|complete|all four|lasso|elastic[- ]?net|model comparison|full nowcast|complete nowcast)\b/.test(text)
        || /aug[- ]?2026[- ]?adl/.test(text);
      if (fullRequested) return "full-nowcast";
      const standardRequested = /\b(fit|regression|ols|adl|arima|sarima|model|backtest|diagnostic|prediction interval|forecast|nowcast)\b/.test(text);
      return standardRequested ? "standard-analysis" : "simple-transform";
    }
    case "coder":
      return /\b(batch|gallery|multiple|several|dashboard|report|all charts)\b/.test(text) ? "chart-batch" : "single-chart";
    case "reader":
      return /\b(discover|fetch|resolve|prompt|artifact|url|research|inspect)\b/.test(text) || text.includes("/prompts/") ? "discovery" : "metadata";
    case "operator": return "operation";
    case "researcher": return "discovery";
    case "writer": return "writing";
    default: return "metadata";
  }
}

export function clampProfile(role: string, requested: BudgetProfileName, prompt: string): {
  profile: BudgetProfileName;
  clamped: boolean;
  reason?: string;
} {
  if (!profileAllowedForRole(role, requested)) {
    const fallback = maximumProfileFor(role, prompt);
    return { profile: fallback, clamped: true, reason: `${role} cannot use ${requested}; clamped to ${fallback}` };
  }
  const maximum = maximumProfileFor(role, prompt);
  const ranks = ROLE_PROFILE_RANK[role] ?? {};
  if ((ranks[requested] ?? Number.POSITIVE_INFINITY) > (ranks[maximum] ?? Number.NEGATIVE_INFINITY)) {
    return { profile: maximum, clamped: true, reason: `${requested} exceeds prompt-relative maximum ${maximum}` };
  }
  return { profile: requested, clamped: false };
}

export function inferTurnBudgetClass(prompt: string): TurnBudgetClass {
  const text = prompt.toLowerCase();
  if (/\b(full|complete|all four|lasso|elastic[- ]?net|full nowcast|complete nowcast|chart batch|dashboard|report)\b/.test(text)
      || /aug[- ]?2026[- ]?adl/.test(text)) return "full";
  if (/\b(fit|regression|ols|adl|arima|sarima|model|backtest|diagnostic|forecast|nowcast|chart)\b/.test(text)) return "standard";
  return "simple";
}

export class TurnBudgetLedger {
  readonly policy: TurnBudgetPolicy;
  private readonly charges: ModelCallCharge[] = [];

  constructor(turnClass: TurnBudgetClass) {
    this.policy = TURN_BUDGETS[turnClass];
  }

  get costDollars(): number {
    return this.charges.reduce((sum, charge) => sum + charge.estimatedCostDollars, 0);
  }

  get plannerCalls(): number {
    return this.charges.filter((charge) => charge.kind === "planner").length;
  }

  get modelCalls(): number {
    return this.charges.length;
  }

  canStartPlannerCall(deployment: string, estimatedInputTokens: number, maxOutputTokens: number): { ok: boolean; reason?: string; reservedCost: number } {
    if (!priceFor(deployment)) return { ok: false, reason: `deployment '${deployment}' has no configured budget price`, reservedCost: 0 };
    if (this.plannerCalls >= this.policy.maxPlannerCalls) {
      return { ok: false, reason: `turn planner-call ceiling ${this.policy.maxPlannerCalls} reached`, reservedCost: 0 };
    }
    return this.canReserve(deployment, estimatedInputTokens, maxOutputTokens);
  }

  canReserve(deployment: string, estimatedInputTokens: number, maxOutputTokens: number): { ok: boolean; reason?: string; reservedCost: number } {
    if (!priceFor(deployment)) return { ok: false, reason: `deployment '${deployment}' has no configured budget price`, reservedCost: 0 };
    const reservedCost = reservationCost(deployment, estimatedInputTokens, maxOutputTokens);
    const projected = this.costDollars + reservedCost;
    if (projected > this.policy.costCeilingDollars) {
      return {
        ok: false,
        reason: `turn budget admission refused: $${projected.toFixed(4)} projected > $${this.policy.costCeilingDollars.toFixed(2)} ceiling`,
        reservedCost,
      };
    }
    return { ok: true, reservedCost };
  }

  charge(call: Omit<ModelCallCharge, "estimatedCostDollars">): ModelCallCharge {
    const charged: ModelCallCharge = { ...call, estimatedCostDollars: usageCost(call.deployment, call.usage) };
    this.charges.push(charged);
    return charged;
  }

  snapshot(): BudgetSnapshot {
    return {
      turnClass: this.policy.name,
      turnCeilingDollars: this.policy.costCeilingDollars,
      turnCostDollars: this.costDollars,
      remainingDollars: Math.max(0, this.policy.costCeilingDollars - this.costDollars),
      plannerCalls: this.plannerCalls,
      modelCalls: this.modelCalls,
      calls: this.charges.map((charge) => ({ ...charge, usage: { ...charge.usage } })),
    };
  }
}
