/** Minimal agent-bridge for Foundry React — no WS, no pi harness. */

export interface ThinkingEntry {
  id: string;
  timestamp: string; // ISO 8601
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

// Stub event emitter (unused in Foundry React, but kept for component compatibility)
export const artifactEvents = new EventTarget();

export async function abortAgent(): Promise<void> {
  throw new Error("Abort not implemented for Foundry hosted agent");
}

export async function answerUserQuestion(_id: string, _response: string): Promise<void> {
  throw new Error("User questions not implemented for Foundry hosted agent");
}
