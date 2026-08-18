# http_proxy → Azure AI Foundry: concept mapping

**Subscription:** `39fe074b-81bc-4f93-8837-f06bea491181`
**SDK:** `@azure/ai-projects` v2 + `openai` v7 (both already in `package.json`)

Mechanics only: for each thing in `http_proxy`, what the Azure SDK equivalent is.

## 1. The map

| http_proxy | Azure Foundry SDK | Notes |
|---|---|---|
| `OPENROUTER_API_KEY` | `DefaultAzureCredential()` | `client.ts` already does this. `az login` locally, managed identity deployed. |
| `https://openrouter.ai/api/v1` | `AZURE_AI_PROJECT_ENDPOINT` | `https://<resource>.services.ai.azure.com/api/projects/<project>` |
| `LLM_MODEL = "openai/gpt-4o-mini"` | a **deployment name** | Model → deployment is a portal step. `project.deployments.list()` to see them. |
| `fetch(".../chat/completions")` | `project.getOpenAIClient().responses.create()` | §2 |
| `messages[]` | `input[]` | Different item shapes. §3 |
| `{role:"system"}` message | `instructions` param | Top-level, not an input item. |
| `tools:[{type,function:{...}}]` | `tools:[{type,name,...}]` | Flattened. §4 |
| `msg.tool_calls[]` | `resp.output.filter(o => o.type === "function_call")` | §3 |
| `{role:"tool", tool_call_id, content}` | `{type:"function_call_output", call_id, output}` | §3 |
| `REFRESH_SYSTEM_PROMPT` const | `project.agents.createVersion()` | Optional. Makes prompt+tools+model a versioned server object. §5 |
| `.pi/agents/*.md` frontmatter | one agent version per role | `model`/`tools`/body → `model`/`tools`/`instructions`. §5 |
| `dispatch()` in `broker.ts` | **unchanged** — stays in your process | Foundry never executes your tools. §6 |
| `spawn("py", [run.py])` | **unchanged** | §6 |
| `data/refresh.db` (SQLite) | **unchanged** | §6 |
| `console.log("[oracle]")` | `project.telemetry` → App Insights | Optional. |

## 2. The client

`client.ts` already builds the project client. Inference goes through the OpenAI client it
hands you:

```ts
const project = createProjectClient();
const openai = project.getOpenAIClient();
await openai.responses.create({ model: deploymentName, input: "..." });
```

`deploymentName` is the **deployment** name from *Models + endpoints*, not the model name.

## 3. The tool loop

This is the only structural rewrite. `oracle.ts:118-160` becomes:

```ts
const input: any[] = [{ role: "user", content: JSON.stringify(ctx) }];

for (let i = 0; i < ctx.budget.max_tool_calls + 2; i++) {
  const resp = await openai.responses.create({
    model: oracleDeploymentName,
    instructions: REFRESH_SYSTEM_PROMPT,   // was messages[0]
    input,
    tools: REFRESH_TOOLS,
    tool_choice: "auto",
    temperature: 0,
    max_output_tokens: 800,
    store: false,
  });

  const calls = resp.output.filter((o: any) => o.type === "function_call");
  if (calls.length === 0) return session.skill ? "stored" : "abstain";

  input.push(...resp.output);              // echo the model's items back

  let terminal: string | undefined;
  for (const c of calls) {
    const call: ToolCall = {
      callId: c.call_id,
      tool: c.name,
      args: JSON.parse(c.arguments || "{}"),
    };
    const { result, terminal: t } = await dispatch(call, session, db);   // unchanged
    input.push({
      type: "function_call_output",
      call_id: c.call_id,
      output: JSON.stringify(result),
    });
    terminal = terminal ?? t;
    if (terminal) break;
  }
  if (terminal) return terminal;
}
```

Field-name gotchas: `call_id` not `tool_call_id`; `c.name` / `c.arguments` sit directly on
the item, not under `.function`; you push the model's `output` items back into `input`
verbatim before appending your outputs.

`store: false` keeps the exchange out of server-side state, so the request stays a pure
function of `input[]`. Drop it if you'd rather chain with `previous_response_id`.

## 4. Tool schemas

```ts
// http_proxy (chat/completions)
{ type: "function", function: { name, description, parameters } }

// Responses API
{ type: "function", name, description, parameters, strict: true }
```

A flat rename of the five entries in `REFRESH_TOOLS` (`oracle.ts:76-104`). `strict: true`
is worth taking — your schemas already use `additionalProperties: false`.

## 5. Agents (optional)

Only needed if you want the prompt versioned server-side instead of living in a TS const.
`PromptAgentDefinition` takes `kind`/`model`/`instructions`/`tools`/`temperature`:

```ts
const agent = await project.agents.createVersion("refresh-oracle", {
  kind: "prompt",
  model: oracleDeploymentName,
  instructions: REFRESH_SYSTEM_PROMPT,
  tools: REFRESH_TOOLS,
  temperature: 0,
});
```

Then invoke by reference instead of passing `instructions`/`tools` each call — see
[src/samples/agent.ts](../src/samples/agent.ts):

```ts
await openai.responses.create(
  { conversation: conversation.id },
  { body: { agent: { name: agent.name, type: "agent_reference" } } },
);
```

The `.pi/agents/*.md` roster maps onto this one-to-one: frontmatter `model`/`tools` and the
Markdown body → `model`/`tools`/`instructions`. Note each role would need its own
deployment if you keep the per-role model pins (the statistician is on Kimi K3, which is
not an Azure model — that role needs a substitute or stays on OpenRouter).

## 6. What doesn't change

Foundry does function calling **client-side**: it returns `function_call` items and waits
for you to send `function_call_output` back. It never executes anything.

So `dispatch()`, `RefreshSession`, budget enforcement, the verb ordering rules, the
digest check, `spawn("py")`, the signing key, and `refresh.db` all stay exactly where they
are and need no edits. The port touches `oracle.ts` and nothing else in the airlock.

## 7. Setup checklist

1. Portal → your resource group → create/open the Foundry project. Copy the endpoint from
   **Overview → Azure AI Foundry project endpoint** into `AZURE_AI_PROJECT_ENDPOINT`.
2. **Models + endpoints** → deploy a model → copy the *deployment* name into
   `MODEL_DEPLOYMENT_NAME` / `ORACLE_DEPLOYMENT_NAME`.
3. Grant yourself **Azure AI User** on the project.
4. `az login` (add `AZURE_TENANT_ID` if the wrong tenant is picked), then `az account set
   --subscription 39fe074b-81bc-4f93-8837-f06bea491181`.
5. `npm start` — lists deployments and makes one Responses call.
