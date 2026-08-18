# azure-foundry

TypeScript starter for the Azure AI Foundry SDK ([`@azure/ai-projects`](https://www.npmjs.com/package/@azure/ai-projects) v2).

## Setup

1. Copy the env template and fill in your values:

   ```powershell
   Copy-Item .env.example .env
   ```

   - `AZURE_AI_PROJECT_ENDPOINT` — from the Foundry portal: your project > **Overview** > *Azure AI Foundry project endpoint*. Looks like `https://<resource>.services.ai.azure.com/api/projects/<project>`.
   - `MODEL_DEPLOYMENT_NAME` — the **deployment** name from **Models + endpoints** (not the model name).

2. Sign in. The SDK uses Entra ID via `DefaultAzureCredential`, which falls back to your Azure CLI session locally:

   ```powershell
   az login
   ```

   Your identity needs the **Azure AI User** role (or higher) on the Foundry project.

## Run

```powershell
npm start                  # smoke test: list deployments + one Responses call
npm run sample:streaming   # streamed response
npm run sample:agent       # create a prompt agent, two-turn conversation, cleanup
npm run typecheck          # tsc --noEmit
npm run build              # emit to dist/
```

## Layout

- [src/client.ts](src/client.ts) — client factory, env validation, shared deployment name
- [src/index.ts](src/index.ts) — entry point / connectivity check
- [src/samples/streaming.ts](src/samples/streaming.ts) — streaming via the Responses API
- [src/samples/agent.ts](src/samples/agent.ts) — persistent agent + conversation lifecycle

## How the v2 SDK fits together

`AIProjectClient` handles *project resources* — `deployments`, `connections`, `agents`, `datasets`, `indexes`, `toolboxes`, plus preview features under `beta`.

Actual inference goes through an OpenAI client you get from the project:

```ts
const openai = project.getOpenAIClient();
await openai.responses.create({ model: deploymentName, input: "..." });
```

Agents are created via `project.agents` but *invoked* through that same OpenAI client, by passing an agent reference in the request body:

```ts
await openai.responses.create(
  { conversation: conversation.id },
  { body: { agent: { name: agent.name, type: "agent_reference" } } },
);
```

## Links

- [Package samples](https://github.com/Azure/azure-sdk-for-js/tree/main/sdk/ai/ai-projects/samples)
- [API reference](https://learn.microsoft.com/javascript/api/overview/azure/ai-projects-readme)
