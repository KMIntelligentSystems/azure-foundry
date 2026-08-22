import { useState, useEffect } from "react";
import { ThinkingPanel } from "./components/ThinkingPanel";
import { ConversationPanel } from "./components/ConversationPanel";
import { SimpleCatalogTree } from "./components/SimpleCatalogTree";
import "./App.css";

interface Artifact {
  path: string;
  kind: string;
  bytes: number;
  valid?: boolean;
}

interface CatalogArtifact {
  id: string;
  user_id: string;
  category: string;
  subject: string;
  title: string;
  mime_type: string;
  url: string;
  created_at: string;
  tags: string | null;
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
  
  // Auth state
  const [userId, setUserId] = useState(sessionStorage.getItem("foundry_user") ?? "");
  const [userRole, setUserRole] = useState<"admin" | "user">((sessionStorage.getItem("foundry_role") as "admin" | "user") ?? "user");
  const [selectedArtifact, setSelectedArtifact] = useState<CatalogArtifact | null>(null);

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

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId.trim()) return;
    sessionStorage.setItem("foundry_user", userId);
    sessionStorage.setItem("foundry_role", userRole);
  };

  const handleLogout = () => {
    sessionStorage.removeItem("foundry_user");
    sessionStorage.removeItem("foundry_role");
    setUserId("");
    setUserRole("user");
    setSelectedArtifact(null);
  };

  const handleSelectArtifact = (artifact: CatalogArtifact) => {
    setSelectedArtifact(artifact);
  };

  const handleSaveArtifact = async () => {
    if (!result || !userId) return;
    // Save the first chart artifact (or prompt user to choose)
    const chart = result.artifacts?.find((a) => a.kind === "chart");
    if (!chart) {
      setError("No chart artifact to save");
      return;
    }
    // This is a stub — in production, upload the workspace file to a URL first
    const artifact = {
      category: "Economics",
      subject: "M3 Manufacturing",
      title: chart.path,
      mimeType: "text/html",
      url: `https://artifact-service.bravesea.../workspace/${chart.path}`, // placeholder
    };
    try {
      const res = await fetch("https://artifact-service.bravesea-f16a8310.eastus.azurecontainerapps.io/artifacts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-User-Id": userId,
          "X-User-Role": userRole,
        },
        body: JSON.stringify(artifact),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      addThinking("status", "Saved to catalog", chart.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Wire up save button when result is shown
  const showSaveButton = result && result.artifacts && result.artifacts.length > 0;

  if (!userId) {
    return (
      <div className="app-shell" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ padding: "2rem", background: "#161b22", borderRadius: "8px", maxWidth: "400px" }}>
          <h2 style={{ color: "#58a6ff", marginBottom: "1rem" }}>Login</h2>
          <form onSubmit={handleLogin}>
            <div style={{ marginBottom: "1rem" }}>
              <label style={{ display: "block", marginBottom: "0.5rem", color: "#8b949e" }}>User ID</label>
              <input
                type="text"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder="kim"
                style={{
                  width: "100%",
                  padding: "0.5rem",
                  background: "#0d1117",
                  border: "1px solid #30363d",
                  borderRadius: "4px",
                  color: "#c9d1d9",
                }}
              />
            </div>
            <div style={{ marginBottom: "1rem" }}>
              <label style={{ display: "block", marginBottom: "0.5rem", color: "#8b949e" }}>Role</label>
              <select
                value={userRole}
                onChange={(e) => setUserRole(e.target.value as "admin" | "user")}
                style={{
                  width: "100%",
                  padding: "0.5rem",
                  background: "#0d1117",
                  border: "1px solid #30363d",
                  borderRadius: "4px",
                  color: "#c9d1d9",
                }}
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={!userId.trim()}
              style={{
                width: "100%",
                padding: "0.75rem",
                background: "#238636",
                border: "none",
                borderRadius: "6px",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Login
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <nav className="navbar">
        <span className="brand">Foundry Orchestrator</span>
        <span className="user-pill" title={`Logged in as ${userId} (${userRole})`}>
          {userRole === "admin" ? "🔧" : "👤"} {userId}
        </span>
        <button
          onClick={handleLogout}
          style={{
            padding: "0.25rem 0.5rem",
            background: "#30363d",
            border: "1px solid #444c56",
            borderRadius: "4px",
            color: "#c9d1d9",
            cursor: "pointer",
            fontSize: "0.8rem",
          }}
        >
          Logout
        </button>
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

      <aside className="sidebar">
        <SimpleCatalogTree
          userId={userId}
          isAdmin={userRole === "admin"}
          onSelect={handleSelectArtifact}
        />
      </aside>

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

            <div style={{ marginTop: "1rem", color: "#8b949e", fontSize: "0.8rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Tokens: {result.totals.input} in, {result.totals.output} out</span>
              {showSaveButton && (
                <button
                  onClick={handleSaveArtifact}
                  style={{
                    padding: "0.5rem 1rem",
                    background: "#238636",
                    border: "none",
                    borderRadius: "6px",
                    color: "#fff",
                    cursor: "pointer",
                    fontSize: "0.85rem",
                  }}
                >
                  Save to Catalog
                </button>
              )}
            </div>
          </div>
        )}

        {selectedArtifact && (
          <div style={{ padding: "2rem" }}>
            <h2 style={{ color: "#58a6ff" }}>{selectedArtifact.title}</h2>
            <p style={{ color: "#8b949e", marginBottom: "1rem" }}>
              {selectedArtifact.category} / {selectedArtifact.subject} • {selectedArtifact.mime_type}
            </p>
            {selectedArtifact.mime_type === "text/html" ? (
              <iframe
                src={selectedArtifact.url}
                style={{ width: "100%", height: "70vh", border: "1px solid #30363d", borderRadius: "6px" }}
                sandbox="allow-scripts"
              />
            ) : (
              <pre style={{ padding: "1rem", background: "#0d1117", borderRadius: "6px", overflow: "auto" }}>
                {selectedArtifact.url}
              </pre>
            )}
          </div>
        )}

        {!selectedArtifact && !result && !loading && !error && (
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
