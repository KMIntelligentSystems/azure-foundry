import { createProjectClient, deploymentName } from "../client.js";

const AGENT_NAME = "sample-prompt-agent";

/**
 * Creates a prompt agent, holds a two-turn conversation with it, then cleans up.
 *
 * Agents extend the OpenAI Responses protocol: the agent itself is created
 * through `project.agents`, but you invoke it through the OpenAI client by
 * passing an `agent_reference` in the request body.
 */
async function main(): Promise<void> {
  const project = createProjectClient();
  const openai = project.getOpenAIClient();

  const agent = await project.agents.createVersion(AGENT_NAME, {
    kind: "prompt",
    model: deploymentName,
    instructions: "You are a concise assistant. Answer in one sentence.",
  });
  console.log(`Agent ${agent.name} version ${agent.version} created`);

  const conversation = await openai.conversations.create({
    items: [{ type: "message", role: "user", content: "What is the capital of Australia?" }],
  });

  const agentReference = { agent: { name: agent.name, type: "agent_reference" } };

  const first = await openai.responses.create({ conversation: conversation.id }, { body: agentReference });
  console.log(`Turn 1: ${first.output_text}`);

  await openai.conversations.items.create(conversation.id, {
    items: [{ type: "message", role: "user", content: "And roughly how many people live there?" }],
  });

  const second = await openai.responses.create({ conversation: conversation.id }, { body: agentReference });
  console.log(`Turn 2: ${second.output_text}`);

  await openai.conversations.delete(conversation.id);
  await project.agents.deleteVersion(agent.name, agent.version);
  console.log("Cleaned up conversation and agent version");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
