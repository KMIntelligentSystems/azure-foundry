import { createProjectClient, deploymentName } from "../client.js";

/** Streams a response token-by-token via the Responses API. */
async function main(): Promise<void> {
  const project = createProjectClient();
  const openai = project.getOpenAIClient();

  const stream = await openai.responses.create({
    model: deploymentName,
    input: "Explain what an Azure AI Foundry project is, in three sentences.",
    stream: true,
  });

  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      process.stdout.write(event.delta);
    }
  }
  process.stdout.write("\n");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
