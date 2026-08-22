/**
 * Azure Function: POST /api/invoke
 *
 * Thin proxy from React → Foundry hosted agent. Gets an Entra token via
 * DefaultAzureCredential (managed identity in Azure, az login locally),
 * calls the orchestrator's /invocations endpoint, returns the JSON.
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { DefaultAzureCredential } from "@azure/identity";

const PROJECT_ENDPOINT =
  process.env["AZURE_AI_PROJECT_ENDPOINT"] ??
  "https://forecastingmodule.services.ai.azure.com/api/projects/proj-default";
const AGENT_NAME = process.env["AGENT_NAME"] ?? "orchestrator";
const SCOPE = "https://ai.azure.com/.default";

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

export async function invoke(req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const body = (await req.json()) as { conversation_id?: string; promptText?: string };

    if (!body.promptText) {
      return {
        status: 400,
        jsonBody: { error: "promptText is required" },
      };
    }

    // Create a session
    const token = await getToken();
    const sessionUrl = `${PROJECT_ENDPOINT}/agents/${AGENT_NAME}/sessions?api-version=2025-11-15-preview`;
    const sessionRes = await fetch(sessionUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "version_ref", agent_version: "latest" }),
    });

    if (!sessionRes.ok) {
      throw new Error(`Failed to create session: HTTP ${sessionRes.status}`);
    }

    const session = (await sessionRes.json()) as { agent_session_id: string };
    const sessionId = session.agent_session_id;

    try {
      // Invoke the agent
      const invokeUrl = `${PROJECT_ENDPOINT}/agents/${AGENT_NAME}/endpoint/protocols/invocations?api-version=2025-11-15-preview`;
      const invokeRes = await fetch(invokeUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agent_session_id: sessionId,
          conversation_id: body.conversation_id,
          promptText: body.promptText,
        }),
      });

      if (!invokeRes.ok) {
        throw new Error(`Agent invocation failed: HTTP ${invokeRes.status}`);
      }

      const result = await invokeRes.json();
      return { status: 200, jsonBody: result };
    } finally {
      // Clean up the session
      await fetch(`${PROJECT_ENDPOINT}/agents/${AGENT_NAME}/sessions/${sessionId}?api-version=2025-11-15-preview`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
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
