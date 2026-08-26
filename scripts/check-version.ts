import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity";
import "dotenv/config";

const endpoint = process.env["AZURE_AI_PROJECT_ENDPOINT"] ?? "https://forecastingmodule.services.ai.azure.com/api/projects/proj-default";
const agent = process.env["AGENT_NAME"] ?? "orchestrator";
const token = getBearerTokenProvider(new DefaultAzureCredential(), "https://ai.azure.com/.default");

for (const apiVersion of ["v1", "2025-11-15-preview"]) {
  const res = await fetch(`${endpoint}/agents/${agent}/versions?api-version=${apiVersion}`, {
    headers: { Authorization: `Bearer ${await token()}` },
  });
  if (!res.ok) { console.log(apiVersion, "HTTP", res.status); continue; }
  const data = (await res.json()) as { data?: any[] };
  for (const v of data.data ?? []) {
    console.log(apiVersion, "version", v.version, "| image:", JSON.stringify(v.container_configuration ?? v.containerConfiguration ?? v.definition ?? "(no image field shown)").slice(0, 300));
  }
  break;
}
