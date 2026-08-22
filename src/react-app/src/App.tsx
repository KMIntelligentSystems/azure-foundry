import { useState, useEffect } from "react";
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

export function App() {
  return <FoundryApp />;
}

function FoundryApp() {
  const [prompt, setPrompt] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OrchestratorResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!conversationId) {
      setConversationId(`conv-${Date.now()}`);
    }
  }, [conversationId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || loading) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/invoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId, promptText: prompt }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }

      const data = await res.json();
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleNewConversation = () => {
    setConversationId(`conv-${Date.now()}`);
    setResult(null);
    setError(null);
    setPrompt("");
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
          </div>
        )}
      </main>
    </div>
  );
}
