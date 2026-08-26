import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity";
import "dotenv/config";
const endpoint = process.env["AZURE_AI_PROJECT_ENDPOINT"] ?? "https://forecastingmodule.services.ai.azure.com/api/projects/proj-default";
const token = getBearerTokenProvider(new DefaultAzureCredential(), "https://ai.azure.com/.default");
const auth = async () => ({ Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" });

const versions = await (await fetch(`${endpoint}/agents/orchestrator/versions?api-version=v1`, { headers: await auth() })).json() as any;
const latest = String(Math.max(...versions.data.map((v: any) => Number(v.version))));
console.log("latest version:", latest);

const s = await (await fetch(`${endpoint}/agents/orchestrator/endpoint/sessions?api-version=v1`, {
  method: "POST", headers: await auth(),
  body: JSON.stringify({ version_indicator: { type: "version_ref", agent_version: latest } }),
})).json() as any;
console.log("session:", s.agent_session_id);
try {
  const r = await fetch(`${endpoint}/agents/orchestrator/endpoint/protocols/invocations?api-version=v1`, {
    method: "POST", headers: await auth(),
    body: JSON.stringify({
      agent_session_id: s.agent_session_id,
      conversation_id: `e2e-fetch-${Date.now()}`,
      promptText: "Fetch this file and summarize what it asks for in 3 sentences: https://daemonstore.blob.core.windows.net/prompts/aug-2026-ADL.md?sp=r&st=2026-08-25T07:23:10Z&se=2027-10-31T14:38:10Z&spr=https&sv=2026-02-06&sr=b&sig=gqZ0DD%2BG0UxtSV%2B1qE8CpduMWLeWnpt7uBtDa7kehGo%3D",
    }),
  });
  console.log("HTTP", r.status);
  const body = await r.json() as any;
  console.log(String(body.response ?? JSON.stringify(body)).slice(0, 1500));
} finally {
  await fetch(`${endpoint}/agents/orchestrator/endpoint/sessions/${s.agent_session_id}?api-version=v1`, { method: "DELETE", headers: await auth() }).catch(() => {});
}
