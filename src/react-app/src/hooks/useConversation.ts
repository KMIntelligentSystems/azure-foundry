/** Minimal conversation hook for Foundry React. */
import { useState } from "react";

export interface ConversationMessage {
  id: string;
  timestamp: string; // ISO 8601
  kind: "prompt" | "response" | "question";
  role: "user" | "assistant" | "agent";
  text: string;
}

export function useConversation() {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);

  const addMessage = (role: "user" | "assistant", text: string) => {
    const msg: ConversationMessage = {
      id: `${Date.now()}-${Math.random()}`,
      timestamp: new Date().toISOString(),
      kind: role === "user" ? "prompt" : "response",
      role,
      text,
    };
    setMessages((prev) => [...prev, msg]);
    if (!open) setUnread((n) => n + 1);
  };

  const togglePanel = () => {
    setOpen(!open);
    setUnread(0);
  };

  return { messages, open, unread, addMessage, togglePanel };
}
