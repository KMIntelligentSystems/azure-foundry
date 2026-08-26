import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity";
import "dotenv/config";
const endpoint = process.env["AZURE_AI_PROJECT_ENDPOINT"] ?? "https://forecastingmodule.services.ai.azure.com/api/projects/proj-default";
const token = getBearerTokenProvider(new DefaultAzureCredential(), "https://ai.azure.com/.default");
const res = await fetch(`${endpoint}/agents/orchestrator/versions/5?api-version=2025-11-15-preview`, {
  headers: { Authorization: `Bearer ${await token()}` },
});
const v = await res.json();
console.log("status:", v.status);
console.log("error:", JSON.stringify(v.error ?? v.provisioning_error ?? v.status_details ?? "(none shown)", null, 2));
