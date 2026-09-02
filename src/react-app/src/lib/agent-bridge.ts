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
  steps?: Array<{ role: string; task: string; deployment: string }>;
  role?: string;
  deployment?: string;
  task?: string;
  output?: string;
  error?: string;
  ok?: boolean;
  modelCalls?: number;
  toolExecutions?: number;
  terminatedBy?: string;
}

export interface OrchestratorResult {
  ok: boolean;
  conversationId: string;
  plan?: { rationale: string; steps: Array<{ role: string; task: string; deployment: string }> };
  plans?: Array<{ rationale: string; continuePlanning: boolean; steps: Array<{ role: string; task: string; deployment: string }> }>;
  steps?: Array<{ role: string; deployment: string; output: string; usage: { input: number; output: number }; round?: number; modelCalls: number; toolExecutions: number; terminatedBy: string }>;
  artifacts?: Array<{ path: string; kind: string; bytes: number; mimeType: string; url?: string; valid?: boolean }>;
  response: string;
  totals: { input: number; output: number };
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
    const url = gatewayUrl();
    const maxAttempts = 3;
    let attempt = 0;
    let settled = false;
    let socket: WebSocket | null = null;
    let promptSent = false;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;

    const clearConnectTimer = () => {
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = null;
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearConnectTimer();
      socket?.close();
      reject(error);
    };

    const promptMessage = JSON.stringify({
      type: "prompt",
      conversation_id: options.conversationId,
      promptText: options.promptText,
      user_id: options.userId,
      access_token: options.accessToken ?? null,
    });

    const connect = () => {
      if (settled) return;
      attempt++;
      promptSent = false;
      let opened = false;
      let socketError = false;
      socket = new WebSocket(url);

      connectTimer = setTimeout(() => {
        if (settled || promptSent) return;
        socket?.close();
      }, 15_000);

      socket.onopen = () => { opened = true; };
      socket.onmessage = (message) => {
        let payload: { type: string; event?: AgentWireEvent; result?: OrchestratorResult; error?: string };
        try {
          payload = JSON.parse(String(message.data));
        } catch {
          fail(new Error("ACA gateway returned invalid JSON"));
          return;
        }
        if (payload.type === "ready" && !promptSent) {
          clearConnectTimer();
          promptSent = true;
          socket?.send(promptMessage);
        } else if (payload.type === "agent_event" && payload.event) {
          options.onEvent(payload.event);
        } else if (payload.type === "result" && payload.result) {
          if (settled) return;
          settled = true;
          clearConnectTimer();
          socket?.close();
          resolve(payload.result);
        } else if (payload.type === "error") {
          fail(new Error(payload.error || "ACA gateway error"));
        }
        // heartbeat messages deliberately require no client action; browser
        // WebSocket implementations answer protocol pings automatically.
      };
      socket.onerror = () => { socketError = true; };
      socket.onclose = (event) => {
        clearConnectTimer();
        if (settled) return;
        if (!promptSent && attempt < maxAttempts) {
          setTimeout(connect, 750 * attempt);
          return;
        }
        const detail = `attempts=${attempt}, opened=${opened}, sent=${promptSent}, close=${event.code}${event.reason ? ` (${event.reason})` : ""}, online=${navigator.onLine}, origin=${window.location.origin}, gateway=${url}`;
        fail(new Error(promptSent
          ? `ACA orchestrator connection closed before the turn completed (${detail})`
          : `Unable to connect to the ACA orchestrator gateway (${detail}${socketError ? ", websocket-error=true" : ""})`));
      };
    };

    connect();
  });
}

export async function abortAgent(): Promise<void> {
  throw new Error("Abort is not yet implemented by the ACA gateway");
}

export async function answerUserQuestion(_id: string, _response: string): Promise<void> {
  throw new Error("User questions are not yet implemented by the ACA gateway");
}
