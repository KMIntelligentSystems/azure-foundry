/**
 * Invoke the hello hosted agent over the Invocations protocol.
 * (Code to read — run it when you feel like it.)
 *
 *   npx tsx src/agents/invoke.ts
 *
 * Flow: createSession → POST the agent's /invocations endpoint with the
 * agent_session_id → read the JSON our container returned → deleteSession.
 */
import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity";
import "dotenv/config";

const projectEndpoint =
  process.env["AZURE_AI_PROJECT_ENDPOINT"] ??
  "https://forecastingmodule.services.ai.azure.com/api/projects/proj-default";
const agentName = process.env["AGENT_NAME"] ?? "hello-hosted";

const project = new AIProjectClient(projectEndpoint, new DefaultAzureCredential());

// Latest version of the agent.
let version: string | undefined;
for await (const v of project.agents.listVersions(agentName)) version = v.version;
if (!version) throw new Error(`no versions of ${agentName}`);
console.log(`using ${agentName}:${version}`);

// A session = an activated sandbox instance of our container.
const session = await project.agents.createSession(agentName, {
  type: "version_ref",
  agent_version: version,
} as never);
const sessionId = (session as { agent_session_id: string }).agent_session_id;
console.log(`session: ${sessionId}`);

try {
  // The dedicated agent endpoint. The gateway forwards the body to our
  // container's POST /invocations verbatim — arbitrary JSON in, JSON out.
  const tokenProvider = getBearerTokenProvider(
    new DefaultAzureCredential(),
    "https://ai.azure.com/.default",
  );
  const url = `${projectEndpoint}/agents/${agentName}/endpoint/protocols/invocations`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await tokenProvider()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agent_session_id: sessionId,
      input: "In one sentence, what does this container prove?",
    }),
  });
  console.log(`HTTP ${res.status}`);
  console.log(JSON.stringify(await res.json(), null, 2));
} finally {
  await project.agents.deleteSession(agentName, sessionId);
  console.log("session deleted");
}
