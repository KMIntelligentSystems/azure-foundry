import { ContainerAppsAPIClient } from "@azure/arm-appcontainers";
import { DefaultAzureCredential } from "@azure/identity";
import { required } from "./env.js";

/**
 * Creates an Azure Container Apps management client.
 *
 * This is the ARM *management* plane — creating and updating container apps and
 * cron jobs. It is unrelated to the Foundry data plane in `client.ts`, and only
 * shares the credential type. Kept separate so the inference samples don't drag
 * ARM in.
 */
export function createContainerAppsClient(): ContainerAppsAPIClient {
  return new ContainerAppsAPIClient(new DefaultAzureCredential(), required("AZURE_SUBSCRIPTION_ID"));
}
