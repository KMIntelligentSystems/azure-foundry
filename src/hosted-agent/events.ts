export type AgentEvent =
  | { type: "agent_start"; conversationId: string; prompt: string }
  | { type: "planning_start"; conversationId: string; round: number }
  | { type: "plan"; conversationId: string; round: number; rationale: string; continuePlanning: boolean; steps: Array<{ role: string; task: string; deployment: string; budgetProfile: string }> }
  | { type: "validation"; conversationId: string; round: number; errors: string[] }
  | { type: "step_start"; conversationId: string; round: number; index: number; role: string; deployment: string; task: string; budgetProfile: string; stepCeilingDollars: number; turnCostDollars: number; turnCeilingDollars: number }
  | { type: "step_end"; conversationId: string; round: number; index: number; role: string; deployment: string; output: string; usage: { input: number; output: number }; budgetProfile: string; modelCalls: number; toolExecutions: number; stepCostDollars: number; stepCeilingDollars: number; turnCostDollars: number; turnCeilingDollars: number; terminatedBy: string }
  | { type: "replanning"; conversationId: string; round: number }
  | { type: "agent_end"; conversationId: string; ok: boolean }
  | { type: "agent_error"; conversationId: string; error: string };

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;
