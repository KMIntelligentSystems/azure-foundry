/**
 * Register the hello hosted agent (kind:"hosted") against the Foundry project,
 * poll until the version is active. Code-first: no azd, no portal.
 *
 *   npx tsx src/agents/register.ts
 */
import type { HostedAgentDefinition, ProtocolVersionRecord } from "@azure/ai-projects";
import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";
import "dotenv/config";

const projectEndpoint =
  process.env["AZURE_AI_PROJECT_ENDPOINT"] ??
  "https://forecastingmodule.services.ai.azure.com/api/projects/proj-default";
// Defaults match the LIVE deployment the SWA invokes (see src/api/invoke:
// AGENT_NAME=orchestrator). `foundry-agent-hello` was the chunk-0 smoke
// agent — registering it does nothing for the app. Always pass AGENT_IMAGE
// explicitly with the tag you just built.
const image = process.env["AGENT_IMAGE"] ?? "daemonairlock.azurecr.io/foundry-agent-orchestrator:latest";
const agentName = process.env["AGENT_NAME"] ?? "orchestrator";

const project = new AIProjectClient(projectEndpoint, new DefaultAzureCredential());

const agent = await project.agents.createVersion(
  agentName,
  {
    // Tier must match the live orchestrator versions (1cpu/2Gi): the image
    // (~1GB: node + python/scipy + Chromium) fails provisioning with
    // ImageError on the 0.5cpu/1Gi tier.
    kind: "hosted",
    cpu: process.env["AGENT_CPU"] ?? "1",
    memory: process.env["AGENT_MEMORY"] ?? "2Gi",
    // REST wire shape (manage-hosted-agent doc): container_configuration.image
    // + protocol_versions. The SDK sample's flat image/container_protocol_versions
    // cast is stale against this API version.
    container_configuration: { image },
    protocol_versions: [
      { protocol: "invocations", version: "1.0.0" } as ProtocolVersionRecord,
    ],
  } as unknown as HostedAgentDefinition,
  { metadata: { enableVnextExperience: "true" } },
);
console.log(`created: name=${agent.name} version=${agent.version}`);

for (let attempt = 0; attempt < 80; attempt++) {
  await new Promise((r) => setTimeout(r, 3_000));
  const v = await project.agents.getVersion(agentName, agent.version);
  console.log(`status: ${v.status} (attempt ${attempt + 1})`);
  if (v.status === "active") {
    console.log("ACTIVE");
    process.exit(0);
  }
  if (v.status === "failed") {
    console.error("FAILED:", JSON.stringify(v));
    process.exit(1);
  }
}
console.error("timed out waiting for active");
process.exit(1);
