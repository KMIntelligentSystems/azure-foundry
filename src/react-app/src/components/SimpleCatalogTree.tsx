import { useState, useEffect } from "react";

export interface Artifact {
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

interface CatalogTreeProps {
  userId: string;
  isAdmin: boolean;
  onSelect: (artifact: Artifact) => void;
  onDelete?: (id: string) => void;
}

const API_BASE = "https://artifact-service.bravesea-f16a8310.eastus.azurecontainerapps.io";

export function SimpleCatalogTree({ userId, isAdmin, onSelect, onDelete }: CatalogTreeProps) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchArtifacts = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/artifacts`, {
        headers: {
          "X-User-Id": userId,
          "X-User-Role": isAdmin ? "admin" : "user",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setArtifacts(data.artifacts ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (userId) fetchArtifacts();
  }, [userId, isAdmin]);

  // Group by category → subject
  const tree = artifacts.reduce<Record<string, Record<string, Artifact[]>>>((acc, a) => {
    if (!acc[a.category]) acc[a.category] = {};
    if (!acc[a.category][a.subject]) acc[a.category][a.subject] = [];
    acc[a.category][a.subject].push(a);
    return acc;
  }, {});

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Delete this artifact?")) return;
    try {
      const res = await fetch(`${API_BASE}/artifacts/${id}`, {
        method: "DELETE",
        headers: {
          "X-User-Id": userId,
          "X-User-Role": isAdmin ? "admin" : "user",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchArtifacts();
      onDelete?.(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={{ padding: "1rem", background: "#161b22", borderRadius: "8px", height: "100%", overflow: "auto" }}>
      <div style={{ marginBottom: "1rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0, color: "#58a6ff", fontSize: "1rem" }}>Documents</h3>
        <button
          onClick={fetchArtifacts}
          disabled={loading}
          style={{
            padding: "0.25rem 0.5rem",
            background: "#30363d",
            border: "1px solid #444c56",
            borderRadius: "4px",
            color: "#c9d1d9",
            cursor: "pointer",
            fontSize: "0.75rem",
          }}
        >
          {loading ? "…" : "↻"}
        </button>
      </div>

      {error && (
        <div style={{ padding: "0.5rem", background: "#f8514926", border: "1px solid #f85149", borderRadius: "4px", marginBottom: "1rem", color: "#ff7b72", fontSize: "0.85rem" }}>
          {error}
        </div>
      )}

      {artifacts.length === 0 && !loading && (
        <p style={{ color: "#8b949e", fontSize: "0.85rem" }}>No artifacts yet. Save results from the orchestrator to build your catalog.</p>
      )}

      {Object.entries(tree).map(([category, subjects]) => (
        <div key={category} style={{ marginBottom: "1rem" }}>
          <div style={{ color: "#58a6ff", fontSize: "0.9rem", fontWeight: 600, marginBottom: "0.25rem" }}>
            {category}
          </div>
          {Object.entries(subjects).map(([subject, items]) => (
            <div key={subject} style={{ marginLeft: "1rem", marginBottom: "0.5rem" }}>
              <div style={{ color: "#8b949e", fontSize: "0.85rem", marginBottom: "0.25rem" }}>
                {subject}
              </div>
              {items.map((a) => (
                <div
                  key={a.id}
                  onClick={() => onSelect(a)}
                  style={{
                    marginLeft: "1rem",
                    padding: "0.5rem",
                    background: "#0d1117",
                    borderRadius: "4px",
                    marginBottom: "0.25rem",
                    cursor: "pointer",
                    border: "1px solid transparent",
                    transition: "border-color 0.15s",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#30363d")}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = "transparent")}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ color: "#c9d1d9", fontSize: "0.85rem" }}>{a.title}</div>
                      <div style={{ color: "#8b949e", fontSize: "0.75rem" }}>
                        {a.mime_type} • {new Date(a.created_at).toLocaleDateString()}
                      </div>
                    </div>
                    <button
                      onClick={(e) => handleDelete(a.id, e)}
                      style={{
                        padding: "0.25rem",
                        background: "transparent",
                        border: "none",
                        color: "#f85149",
                        cursor: "pointer",
                        fontSize: "1rem",
                      }}
                      title="Delete"
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
