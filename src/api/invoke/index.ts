/**
 * Azure Function: POST /api/invoke
 *
 * Thin proxy from React → Foundry hosted agent. Auth order:
 *   1. AZURE_AI_PROJECT_API_KEY (api-key header) — required on Free-SKU SWA,
 *      which cannot have a managed identity.
 *   2. DefaultAzureCredential (managed identity / az login locally).
 * Calls the orchestrator's /invocations endpoint, returns the JSON.
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { DefaultAzureCredential } from "@azure/identity";

const PROJECT_ENDPOINT =
  process.env["AZURE_AI_PROJECT_ENDPOINT"] ??
  "https://forecastingmodule.services.ai.azure.com/api/projects/proj-default";
const AGENT_NAME = process.env["AGENT_NAME"] ?? "orchestrator";
const SCOPE = "https://ai.azure.com/.default";
const API_VERSION = "v1";
const API_KEY = process.env["AZURE_AI_PROJECT_API_KEY"];

const credential = new DefaultAzureCredential();
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const t = await credential.getToken(SCOPE);
  cachedToken = { token: t.token, expiresAt: t.expiresOnTimestamp };
  return t.token;
}

async function authHeaders(): Promise<Record<string, string>> {
  if (API_KEY) {
    return { "api-key": API_KEY };
  }
  return { Authorization: `Bearer ${await getToken()}` };
}

// Resolve the highest published version of the agent. The "latest" alias is
// rejected by the service while a version is still provisioning
// (agent_version_not_ready), so pin to a concrete version number.
async function resolveLatestVersion(headers: Record<string, string>): Promise<string> {
  const res = await fetch(`${PROJECT_ENDPOINT}/agents/${AGENT_NAME}/versions?api-version=${API_VERSION}`, {
    headers,
  });
  if (!res.ok) {
    throw new Error(`Failed to list agent versions: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { data?: Array<{ version?: string }> };
  const versions = (data.data ?? []).map((v) => Number(v.version)).filter((n) => Number.isFinite(n));
  if (versions.length === 0) {
    throw new Error(`No published versions of agent "${AGENT_NAME}"`);
  }
  return String(Math.max(...versions));
}

export async function invoke(req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const body = (await req.json()) as { conversation_id?: string; promptText?: string; user_id?: string };

    if (!body.promptText) {
      return {
        status: 400,
        jsonBody: { error: "promptText is required" },
      };
    }

    // Create a session (endpoint-scoped path; /agents/{name}/sessions 404s)
    const headers = await authHeaders();
    const agentVersion = await resolveLatestVersion(headers);
    const sessionUrl = `${PROJECT_ENDPOINT}/agents/${AGENT_NAME}/endpoint/sessions?api-version=${API_VERSION}`;
    const sessionRes = await fetch(sessionUrl, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ version_indicator: { type: "version_ref", agent_version: agentVersion } }),
    });

    if (!sessionRes.ok) {
      throw new Error(`Failed to create session: HTTP ${sessionRes.status}`);
    }

    const session = (await sessionRes.json()) as { agent_session_id: string };
    const sessionId = session.agent_session_id;

    try {
      // Invoke the agent
      const invokeUrl = `${PROJECT_ENDPOINT}/agents/${AGENT_NAME}/endpoint/protocols/invocations?api-version=${API_VERSION}`;
      const invokeRes = await fetch(invokeUrl, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_session_id: sessionId,
          conversation_id: body.conversation_id,
          promptText: body.promptText,
          user_id: body.user_id,
        }),
      });

      if (!invokeRes.ok) {
        throw new Error(`Agent invocation failed: HTTP ${invokeRes.status}`);
      }

      const result = await invokeRes.json();
      return { status: 200, jsonBody: result };
    } finally {
      // Clean up the session
      await fetch(`${PROJECT_ENDPOINT}/agents/${AGENT_NAME}/endpoint/sessions/${sessionId}?api-version=${API_VERSION}`, {
        method: "DELETE",
        headers,
      }).catch(() => {
        /* best effort */
      });
    }
  } catch (err) {
    context.error("Invoke failed:", err);
    return {
      status: 500,
      jsonBody: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

app.http("invoke", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "invoke",
  handler: invoke,
});
