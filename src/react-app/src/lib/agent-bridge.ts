/** ACA WebSocket bridge for one synchronous orchestrator turn. */

export interface ThinkingEntry {
  id: string;
  timestamp: string;
  kind: "assistant_text" | "reasoning" | "tool_call" | "tool_result" | "status" | "agent_start" | "agent_end" | "turn_start" | "turn_end";
  label: string;
  body?: string;
  isError?: boolean;
  streaming?: boolean;
}

export interface UserQuestion {
  id: string;
  prompt: string;
  choices?: string[];
  defaultChoice?: string;
  allowFreeText?: boolean;
  timeoutMs: number;
}

export interface AgentWireEvent {
  type: string;
  conversationId?: string;
  round?: number;
  index?: number;
  rationale?: string;
  continuePlanning?: boolean;
  steps?: Array<{ role: string; task: string; deployment: string; budgetProfile?: string }>;
  role?: string;
  deployment?: string;
  task?: string;
  output?: string;
  error?: string;
  budgetProfile?: string;
  modelCalls?: number;
  toolExecutions?: number;
  stepCostDollars?: number;
  stepCeilingDollars?: number;
  turnCostDollars?: number;
  turnCeilingDollars?: number;
  terminatedBy?: string;
}

export interface OrchestratorResult {
  ok: boolean;
  conversationId: string;
  plan?: { rationale: string; steps: Array<{ role: string; task: string; deployment: string; budgetProfile: string }> };
  plans?: Array<{ rationale: string; continuePlanning: boolean; steps: Array<{ role: string; task: string; deployment: string; budgetProfile: string }> }>;
  steps?: Array<{ role: string; deployment: string; output: string; usage: { input: number; output: number }; round?: number; budgetProfile: string; modelCalls: number; toolExecutions: number; estimatedCostDollars: number; stepCeilingDollars: number; terminatedBy: string }>;
  artifacts?: Array<{ path: string; kind: string; bytes: number; valid?: boolean }>;
  response: string;
  totals: { input: number; output: number; estimatedCostDollars: number };
  budget: { turnClass: string; turnCeilingDollars: number; turnCostDollars: number; remainingDollars: number; plannerCalls: number; modelCalls: number };
}

export const artifactEvents = new EventTarget();

function gatewayUrl(): string {
  const configured = (import.meta.env.VITE_AGENT_WS_URL as string | undefined)?.trim();
  if (configured) return configured;
  if (import.meta.env.DEV) return "ws://localhost:8080/ws/agent";
  throw new Error("VITE_AGENT_WS_URL is not configured for the ACA orchestrator gateway");
}

export function runSynchronousTurn(options: {
  conversationId: string;
  promptText: string;
  userId: string;
  accessToken?: string;
  onEvent: (event: AgentWireEvent) => void;
}): Promise<OrchestratorResult> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(gatewayUrl());
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(error);
    };

    socket.onopen = () => {
      socket.send(JSON.stringify({
        type: "prompt",
        conversation_id: options.conversationId,
        promptText: options.promptText,
        user_id: options.userId,
        access_token: options.accessToken ?? null,
      }));
    };
    socket.onmessage = (message) => {
      let payload: { type: string; event?: AgentWireEvent; result?: OrchestratorResult; error?: string };
      try {
        payload = JSON.parse(String(message.data));
      } catch {
        fail(new Error("ACA gateway returned invalid JSON"));
        return;
      }
      if (payload.type === "agent_event" && payload.event) {
        options.onEvent(payload.event);
      } else if (payload.type === "result" && payload.result) {
        if (settled) return;
        settled = true;
        socket.close();
        resolve(payload.result);
      } else if (payload.type === "error") {
        fail(new Error(payload.error || "ACA gateway error"));
      }
    };
    socket.onerror = () => fail(new Error("Unable to connect to the ACA orchestrator gateway"));
    socket.onclose = () => {
      if (!settled) fail(new Error("ACA orchestrator connection closed before the turn completed"));
    };
  });
}

export async function abortAgent(): Promise<void> {
  throw new Error("Abort is not yet implemented by the ACA gateway");
}

export async function answerUserQuestion(_id: string, _response: string): Promise<void> {
  throw new Error("User questions are not yet implemented by the ACA gateway");
}
