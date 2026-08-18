import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";
import { required } from "./env.js";

/** The model deployment name from your Foundry project's "Models + endpoints" tab. */
export const deploymentName = process.env.MODEL_DEPLOYMENT_NAME ?? "gpt-4o-mini";

/**
 * Creates a Foundry project client authenticated with Entra ID.
 *
 * DefaultAzureCredential picks up, in order: environment variables, workload
 * identity, managed identity, then your local `az login` session. Run
 * `az login` once for local development.
 */
export function createProjectClient(): AIProjectClient {
  return new AIProjectClient(required("AZURE_AI_PROJECT_ENDPOINT"), new DefaultAzureCredential());
}
