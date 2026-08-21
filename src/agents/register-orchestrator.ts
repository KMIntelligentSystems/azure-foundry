/**
 * Register the orchestrator as a hosted agent (chunk 1-6 image).
 *   npx tsx src/agents/register-orchestrator.ts
 */
import type { HostedAgentDefinition, ProtocolVersionRecord } from "@azure/ai-projects";
import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";
import "dotenv/config";

const projectEndpoint =
  process.env["AZURE_AI_PROJECT_ENDPOINT"] ??
  "https://forecastingmodule.services.ai.azure.com/api/projects/proj-default";
const image = process.env["AGENT_IMAGE"] ?? "daemonairlock.azurecr.io/foundry-agent-orchestrator:1.0.0";
const agentName = process.env["AGENT_NAME"] ?? "orchestrator";

const project = new AIProjectClient(projectEndpoint, new DefaultAzureCredential());

const agent = await project.agents.createVersion(
  agentName,
  {
    kind: "hosted",
    cpu: "1",
    memory: "2Gi", // python + chromium inside
    container_configuration: { image },
    protocol_versions: [{ protocol: "invocations", version: "1.0.0" } as ProtocolVersionRecord],
  } as unknown as HostedAgentDefinition,
  { metadata: { enableVnextExperience: "true" } },
);
console.log(`created: ${agent.name}:${agent.version}`);

for (let attempt = 0; attempt < 100; attempt++) {
  await new Promise((r) => setTimeout(r, 3_000));
  const v = await project.agents.getVersion(agentName, agent.version);
  process.stdout.write(`\rstatus: ${v.status} (${attempt + 1})   `);
  if (v.status === "active") { console.log("\nACTIVE"); process.exit(0); }
  if (v.status === "failed") { console.error("\nFAILED:", JSON.stringify(v, null, 1).slice(0, 800)); process.exit(1); }
}
console.error("\ntimed out");
process.exit(1);
