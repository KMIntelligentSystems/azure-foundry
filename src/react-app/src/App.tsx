import { useState, useEffect } from "react";
import { ThinkingPanel } from "./components/ThinkingPanel";
import { ConversationPanel } from "./components/ConversationPanel";
import { SimpleCatalogTree } from "./components/SimpleCatalogTree";
import "./App.css";

const ARTIFACT_SERVICE = "https://artifact-service.bravesea-f16a8310.eastus.azurecontainerapps.io";

/**
 * Fetches artifact content WITH the X-User-Id header (iframes can't send
 * headers, and the service 401s without it), then displays it: HTML via a
 * blob: URL iframe, everything else as text.
 */
function ArtifactViewer({ artifact, userId }: { artifact: CatalogArtifact; userId: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    setBlobUrl(null);
    setText(null);
    setErr(null);
    const src = artifact.url.startsWith("http") ? artifact.url : `${ARTIFACT_SERVICE}${artifact.url}`;
    fetch(src, { headers: { "X-User-Id": userId } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.text();
        if (cancelled) return;
        if (artifact.mime_type === "text/html") {
          revoked = URL.createObjectURL(new Blob([body], { type: "text/html" }));
          setBlobUrl(revoked);
        } else {
          setText(body);
        }
      })
      .catch((e) => !cancelled && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [artifact.id, artifact.url, artifact.mime_type, userId]);

  if (err) return <p style={{ color: "#f78166" }}>Failed to load artifact: {err}</p>;
  if (blobUrl) {
    return (
      <iframe
        src={blobUrl}
        style={{ width: "100%", height: "70vh", border: "1px solid #30363d", borderRadius: "6px", background: "#fff" }}
        sandbox="allow-scripts"
      />
    );
  }
  if (text !== null) {
    return (
      <pre style={{ padding: "1rem", background: "#0d1117", borderRadius: "6px", overflow: "auto", color: "#c9d1d9" }}>
        {text}
      </pre>
    );
  }
  return <p style={{ color: "#8b949e" }}>Loading artifact…</p>;
}

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
  
  // Auth state. `userId` is the CONFIRMED identity (set only on login);
  // the login form edits drafts so typing the first character doesn't flip
  // the `if (!userId)` gate and unmount the form mid-entry.
  // User IDs are compared case-sensitively by the artifact service
  // (`Admin` ≠ `admin` → empty catalog), so normalize to lowercase at the
  // identity boundary — both the sessionStorage restore and login.
  const [userId, setUserId] = useState((sessionStorage.getItem("foundry_user") ?? "").trim().toLowerCase());
  const [userRole, setUserRole] = useState<"admin" | "user">((sessionStorage.getItem("foundry_role") as "admin" | "user") ?? "user");
  const [loginId, setLoginId] = useState("");
  const [loginRole, setLoginRole] = useState<"admin" | "user">("user");
  const [selectedArtifact, setSelectedArtifact] = useState<CatalogArtifact | null>(null);
  // Bumped after every completed orchestrator turn so the catalog tree
  // re-fetches — a prompt like "fetch the artifacts" then visibly updates
  // the Documents panel instead of only answering in the conversation.
  const [catalogRefreshKey, setCatalogRefreshKey] = useState(0);

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
        body: JSON.stringify({ conversation_id: conversationId, promptText: prompt, user_id: userId }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }

      const data = (await res.json()) as OrchestratorResult;
      setResult(data);
      setCatalogRefreshKey((k) => k + 1);

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
    if (!loginId.trim()) return;
    const normalizedId = loginId.trim().toLowerCase();
    sessionStorage.setItem("foundry_user", normalizedId);
    sessionStorage.setItem("foundry_role", loginRole);
    setUserId(normalizedId);
    setUserRole(loginRole);
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
                value={loginId}
                onChange={(e) => setLoginId(e.target.value)}
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
                value={loginRole}
                onChange={(e) => setLoginRole(e.target.value as "admin" | "user")}
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
              disabled={!loginId.trim()}
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
          refreshKey={catalogRefreshKey}
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

            <div style={{ marginTop: "1rem", color: "#8b949e", fontSize: "0.8rem" }}>
              Tokens: {result.totals.input} in, {result.totals.output} out
              {result.artifacts && result.artifacts.length > 0 && (
                <span style={{ marginLeft: "1rem", color: "#58a6ff" }}>
                  💡 To save artifacts, ask the orchestrator: "save [chart] to catalog [category]/[subject]"
                </span>
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
            <ArtifactViewer artifact={selectedArtifact} userId={userId} />
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
