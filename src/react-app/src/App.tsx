import { useState, useEffect } from "react";
import { ThinkingPanel } from "./components/ThinkingPanel";
import { ConversationPanel } from "./components/ConversationPanel";
import "./App.css";

interface Artifact {
  path: string;
  kind: string;
  bytes: number;
  valid?: boolean;
}

interface OrchestratorResult {
  ok: boolean;
  conversationId: string;
  plan?: { rationale: string; steps: Array<{ role: string; task: string; deployment: string }> };
  steps?: Array<{ role: string; deployment: string; output: string; usage: { input: number; output: number } }>;
  artifacts?: Artifact[];
  response: string;
  totals: { input: number; output: number };
}

interface ThinkingEntry {
  id: string;
  timestamp: string;
  kind: "assistant_text" | "reasoning" | "tool_call" | "tool_result" | "status" | "agent_start" | "agent_end" | "turn_start" | "turn_end";
  label: string;
  body?: string;
  isError?: boolean;
  streaming?: boolean;
}

interface ConversationMessage {
  id: string;
  timestamp: string;
  kind: "prompt" | "response" | "question";
  role: "user" | "assistant" | "agent";
  text: string;
}

export function App() {
  return <FoundryApp />;
}

function FoundryApp() {
  const [prompt, setPrompt] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OrchestratorResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Thinking + conversation state (mirrors http_proxy panels)
  const [thinkingEntries, setThinkingEntries] = useState<ThinkingEntry[]>([]);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [thinkingUnread, setThinkingUnread] = useState(0);
  const [conversationMessages, setConversationMessages] = useState<ConversationMessage[]>([]);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [conversationUnread, setConversationUnread] = useState(0);

  useEffect(() => {
    if (!conversationId) {
      setConversationId(`conv-${Date.now()}`);
    }
  }, [conversationId]);

  const addThinking = (kind: ThinkingEntry["kind"], label: string, body?: string, isError = false) => {
    const entry: ThinkingEntry = {
      id: `${Date.now()}-${Math.random()}`,
      timestamp: new Date().toISOString(),
      kind,
      label,
      body,
      isError,
    };
    setThinkingEntries((prev) => [...prev, entry]);
    if (!thinkingOpen) setThinkingUnread((n) => n + 1);
  };

  const addConversation = (role: "user" | "assistant", text: string) => {
    const msg: ConversationMessage = {
      id: `${Date.now()}-${Math.random()}`,
      timestamp: new Date().toISOString(),
      kind: role === "user" ? "prompt" : "response",
      role,
      text,
    };
    setConversationMessages((prev) => [...prev, msg]);
    if (!conversationOpen) setConversationUnread((n) => n + 1);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || loading) return;

    setLoading(true);
    setError(null);
    setResult(null);

    addConversation("user", prompt);
    addThinking("agent_start", `Invoking orchestrator (conversation: ${conversationId})…`);

    try {
      const res = await fetch("/api/invoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId, promptText: prompt }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }

      const data = (await res.json()) as OrchestratorResult;
      setResult(data);

      // Populate thinking panel from the orchestrator's steps
      if (data.plan) {
        addThinking("reasoning", "Plan", data.plan.rationale);
        data.plan.steps.forEach((s, i) => {
          addThinking("reasoning", `Step ${i + 1}`, `${s.role} on ${s.deployment} — ${s.task}`);
        });
      }
      if (data.steps) {
        data.steps.forEach((s) => {
          addThinking("tool_call", `${s.role} [${s.deployment}]`, undefined, false);
          addThinking("tool_result", "Result", s.output.slice(0, 300) + (s.output.length > 300 ? "…" : ""));
        });
      }
      if (data.artifacts && data.artifacts.length > 0) {
        addThinking("status", "Artifacts", data.artifacts.map((a) => a.path).join(", "));
      }
      addThinking("agent_end", `Done. Tokens: ${data.totals.input} in, ${data.totals.output} out`);

      addConversation("assistant", data.response);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      addThinking("agent_end", `Error: ${msg}`, undefined, true);
      addConversation("assistant", `Error: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const handleNewConversation = () => {
    setConversationId(`conv-${Date.now()}`);
    setResult(null);
    setError(null);
    setPrompt("");
    setThinkingEntries([]);
    setThinkingUnread(0);
    setConversationMessages([]);
    setConversationUnread(0);
  };

  return (
    <div className="app-shell">
      <nav className="navbar">
        <span className="brand">Foundry Orchestrator</span>
        <span className="user-pill" title={`Conversation: ${conversationId}`}>
          💬 {conversationId.slice(0, 12)}…
        </span>
        <input
          className="prompt-bar"
          placeholder="Ask the orchestrator…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit(e)}
          disabled={loading}
        />
        <button
          className="submit-btn"
          onClick={handleSubmit}
          disabled={loading || !prompt.trim()}
        >
          {loading ? "Working…" : "Submit"}
        </button>
        <button
          className="abort-btn"
          onClick={handleNewConversation}
          title="Start a new conversation"
        >
          New
        </button>
        <ConversationPanel
          messages={conversationMessages}
          open={conversationOpen}
          unread={conversationUnread}
          working={loading}
          onClose={() => {
            setConversationOpen(!conversationOpen);
            setConversationUnread(0);
          }}
        />
        <ThinkingPanel
          entries={thinkingEntries}
          open={thinkingOpen}
          unread={thinkingUnread}
          working={loading}
          onToggle={() => {
            setThinkingOpen(!thinkingOpen);
            setThinkingUnread(0);
          }}
          onClose={() => setThinkingOpen(false)}
        />
      </nav>

      <main className="viewer">
        {error && (
          <div className="notice notice-error" role="alert">
            <span>{error}</span>
          </div>
        )}

        {loading && (
          <div className="working-state">
            <div className="spinner" />
            <p>Orchestrator is planning and executing…</p>
          </div>
        )}

        {result && (
          <div style={{ padding: "2rem", maxWidth: "1000px", margin: "0 auto" }}>
            {result.plan && (
              <div style={{ marginBottom: "1.5rem", padding: "1rem", background: "#0d1117", borderRadius: "6px" }}>
                <h3 style={{ color: "#8b949e", fontSize: "0.9rem", marginBottom: "0.5rem" }}>Plan</h3>
                <p style={{ margin: 0, color: "#c9d1d9" }}>{result.plan.rationale}</p>
                <ul style={{ marginTop: "0.5rem", paddingLeft: "1.5rem" }}>
                  {result.plan.steps.map((s, i) => (
                    <li key={i} style={{ color: "#8b949e", fontSize: "0.85rem" }}>
                      {s.role} on {s.deployment}: {s.task}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {result.steps && result.steps.length > 0 && (
              <div style={{ marginBottom: "1.5rem" }}>
                <h3 style={{ color: "#8b949e", fontSize: "0.9rem", marginBottom: "0.5rem" }}>Steps</h3>
                {result.steps.map((s, i) => (
                  <div
                    key={i}
                    style={{
                      padding: "0.75rem",
                      background: "#0d1117",
                      borderRadius: "6px",
                      marginBottom: "0.5rem",
                      borderLeft: "3px solid #58a6ff",
                    }}
                  >
                    <div style={{ color: "#58a6ff", fontSize: "0.85rem", marginBottom: "0.25rem" }}>
                      {s.role} [{s.deployment}]
                    </div>
                    <div style={{ color: "#c9d1d9", whiteSpace: "pre-wrap" }}>{s.output}</div>
                  </div>
                ))}
              </div>
            )}

            {result.artifacts && result.artifacts.length > 0 && (
              <div style={{ marginBottom: "1.5rem" }}>
                <h3 style={{ color: "#8b949e", fontSize: "0.9rem", marginBottom: "0.5rem" }}>Artifacts</h3>
                <ul style={{ listStyle: "none", padding: 0 }}>
                  {result.artifacts.map((a, i) => (
                    <li
                      key={i}
                      style={{
                        padding: "0.5rem",
                        background: "#0d1117",
                        borderRadius: "4px",
                        marginBottom: "0.25rem",
                        color: "#c9d1d9",
                        fontSize: "0.85rem",
                      }}
                    >
                      <code>{a.path}</code> [{a.kind}] {a.bytes}B{a.valid ? " ✓" : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div style={{ padding: "1rem", background: "#0d1117", borderRadius: "6px" }}>
              <h3 style={{ color: "#8b949e", fontSize: "0.9rem", marginBottom: "0.5rem" }}>Response</h3>
              <pre style={{ margin: 0, color: "#c9d1d9", whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: "0.85rem" }}>
                {result.response}
              </pre>
            </div>

            <div style={{ marginTop: "1rem", color: "#8b949e", fontSize: "0.8rem" }}>
              Tokens: {result.totals.input} in, {result.totals.output} out
            </div>
          </div>
        )}

        {!result && !loading && !error && (
          <div className="empty-state">
            <h2>Foundry Hosted Agent</h2>
            <p>Submit a prompt to invoke the orchestrator. It will plan, execute steps, and return artifacts.</p>
            <p style={{ marginTop: "1rem", color: "#8b949e", fontSize: "0.85rem" }}>
              Click the chat icon to see the conversation, or the activity icon to see the orchestrator's thinking.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
