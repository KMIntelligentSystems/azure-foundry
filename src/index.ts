import { createProjectClient, deploymentName } from "./client.js";

/**
 * Smoke test: confirms auth works, lists what the project has deployed, and
 * makes one Responses API call against the configured deployment.
 */
async function main(): Promise<void> {
  const project = createProjectClient();
  console.log(`Connected to ${project.endpoint}\n`);

  console.log("Model deployments:");
  for await (const deployment of project.deployments.list()) {
    console.log(`  - ${deployment.name} (${deployment.type})`);
  }

  console.log(`\nCalling deployment "${deploymentName}"...`);
  const openai = project.getOpenAIClient();
  const response = await openai.responses.create({
    model: deploymentName,
    input: "Reply with exactly: Azure AI Foundry SDK is wired up.",
  });

  console.log(`Response: ${response.output_text}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
