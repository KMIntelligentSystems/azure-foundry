# hosted-agent (code-first, no azd)

Minimal hand-rolled Foundry **hosted agent**: a container you package yourself,
registered via the SDK, invoked over the Invocations protocol.

## Files

| File | Role |
|---|---|
| `server.ts` | The container. `GET /health` + `/readiness` (platform probes), `POST /invocations` (arbitrary JSON in/out). Calls `gpt-4.1-mini` via the sandbox's auto-provisioned agent identity (`DefaultAzureCredential`, scope `https://ai.azure.com/.default`) — no stored secret. |
| `../agents/register.ts` | `createVersion({kind:"hosted", container_configuration:{image}, cpu, memory, protocol_versions:[invocations]})` → poll until `active`/`failed`. |
| `../agents/invoke.ts` | `createSession` → POST `{project}/agents/{name}/endpoint/protocols/invocations` with `agent_session_id` → `deleteSession`. |
| `../../Dockerfile.agent` | node:24, tsc build stage, slim runtime. amd64 via `az acr build`. |

## Container contract (learned the hard way)

- **Port 8088** — the gateway routes there, not 8080.
- **`/readiness`** — the platform's probe path (the Py/.NET protocol libraries
  expose it automatically; hand-rolled containers must implement it).
- **REST wire shape**: `container_configuration.image` + `protocol_versions`
  (the SDK sample's flat `image`/`container_protocol_versions` cast is stale
  and gets a 400).
- **Registry auth**: the project's system-assigned managed identity needs
  **AcrPull** on the ACR ("Container Registry Repository Reader" is NOT enough —
  ImageError at provisioning).
- **Platform-injected env**: `FOUNDRY_PROJECT_ENDPOINT`, `FOUNDRY_AGENT_NAME`,
  `FOUNDRY_AGENT_VERSION`, `FOUNDRY_AGENT_SESSION_ID`,
  `APPLICATIONINSIGHTS_CONNECTION_STRING`.
- Images must be `linux/amd64`.
- Preview: sessions work only with hosted agents; api-version
  `2025-11-15-preview` returns `error.code` details (e.g. `ImageError`) that
  `getVersion` hides.

## Chunk 1 — the LLM spine (2026-08-19, WORKS)

`planner → validate_plan → execute steps → response` — no tools, no broker yet.

| Module | Role |
|---|---|
| `foundry.ts` | the ONLY LLM caller; agent-identity token cached; stateless `store:false` |
| `imports.ts` | roles/*.md → compiled catalogue (researcher.md, writer.md — echo-class) |
| `planner.ts` | call 1: structured `emit_plan`; planner/worker deployment allowlist |
| `validate_plan.ts` | pure gate: role existence, planner-deployments-can't-work, ≤5 steps |
| `orchestrator.ts` | sequential step execution (chain passes upstream outputs forward) |
| `server.ts` | /invocations routes `{promptText}` → orchestrate; `{hello:true}` keeps chunk-0 smoke |

**Proven locally** (`npx tsx scripts/smoke-chunk1.ts`): planner (gpt-4.1) → 2 steps
on gpt-4.1-mini → composed response, 316 tokens total. Validator smoke: planner-
deployment-as-worker + unknown role rejected, legitimate step survives.

## Chunk 2 — session ledger + planner context (2026-08-19, WORKS)

| Module | Role |
|---|---|
| `session.ts` | `conversation_id` → step ledger as JSON (turns, steps, outputs, usage). Root: `$HOME/session` (sandbox-persistent) else `/tmp/session`. sanitize conversation_id (no path escapes). |
| planner input | now `PRIOR CONVERSATION:` = last 3 turns with 300-char step outputs |
| orchestrator | `orchestrate(prompt, conversationId?)`; every turn (incl. rejected plans) recorded |

**Proven** (`scripts/smoke-chunk2.ts`): turn 2 ("headline from the previous summary")
inherits turn 1's findings. First pass failed ("No data was provided") — summarizePrior
described steps but not outputs; fixed by including compact outputs (the packing rule:
planner gets state, steps get upstream).

## Chunk 3 — the deterministic broker (2026-08-19, WORKS)

| Module | Role |
|---|---|
| `broker.ts` | the in-process airlock. Closed tool catalog (`read_file`/`write_file`/`list_files` in a per-conversation workspace, path-escape proof), `dispatch()` gate, `runRole` tool loop with budgets (maxToolCalls, wallClock, $ cost ceiling via per-deployment prices). `execute_python` → chunk 4, `playwright` → chunk 5. |
| `roles/reader.md` | first tools-bearing role |
| orchestrator | executeStep → `runRole` (real tool loops, not single calls) |

**Proven:** `scripts/smoke-chunk3.ts` — reader wrote `notes/hello.txt` then re-read and
confirmed it across two steps sharing the workspace. `scripts/smoke-chunk3b.ts` — four
gates pass: unknown_tool, catalog gate, path_escape, unpriced-deployment refusal.
**Wire fix:** Responses API requires raw `function_call` items echoed into `input` before
`function_call_output` items (`foundry.ts` now returns `rawOutput`; broker echoes it).

## Chunk 4 — execute_python + statistician (2026-08-19, WORKS)

| Module | Role |
|---|---|
| `broker.ts` | `execute_python` tool: scrubbed env, cwd=workspace, 60s kill, `py -I` (Linux adds rlimits), stdout contract |
| `roles/statistician.md` | defaultDeployment gpt-4.1, tools incl. execute_python |
| `Dockerfile.agent` | python3 + pinned numpy/pandas/statsmodels/scikit-learn (full-bookworm base) |
| `validate_plan.ts` | partial rejection is non-fatal: surviving steps proceed, dropped steps reported as validationErrors |

**Proven** (`scripts/smoke-chunk4b.ts`, direct role run): real OLS in Python —
slope b=1.9873, 95% CI (1.924, 2.050), R²=0.9985, `notes/card.json` written and
verified on disk. Planner routing to statistician from natural language is a
prompt-tuning item (gpt-4.1 planner over-genericizes); roles work when invoked.

## Chunk 5 — coder + render_validate (2026-08-19, WORKS)

| Module | Role |
|---|---|
| `broker.ts` | `render_validate` tool: Playwright Chromium loads a workspace HTML file, counts SVG children, collects console/page errors, returns `valid`. Async dispatch. |
| `roles/coder.md` | D3 chart role: dark theme, embedded data, validate-after-write protocol |
| `Dockerfile.agent` | `npx playwright install --with-deps chromium` (browser baked into image) |

**Proven** (`scripts/smoke-chunk5.ts`): coder wrote `charts/line.html` (D3 line
chart, dark theme), self-validated via render_validate — 5 SVG children, zero
console errors, valid=true. Playwright browsers are version-pinned to the npm
package: a fresh `npm i playwright` needs `npx playwright install chromium`
(the local cache had r1194/1217, the package wanted r1234).

## Chunk 6 — artifacts + pending tree; full pipeline (2026-08-19, WORKS)

| Module | Role |
|---|---|
| `artifacts.ts` | workspace → classified manifest (chart/data/notes/other) + pending-tree render; the single seam for a future upload protocol |
| planner/worker seats | `gpt-4.1-strong` alias: planner seat vs strong-worker seat WITHOUT doubling quota (validator sees distinct names; executor maps alias → real deployment) |
| response contract | `OrchestratorResult.artifacts[]` + pending tree appended to finish text |

**Proven** (`scripts/smoke-chunk6.ts`, the ADL flow in miniature, one conversation):
reader wrote CSV → statistician ran real OLS (R²=0.9995) + wrote notes/model.json
→ coder produced validated D3 chart with fitted-line overlay → pending tree with
all 3 artifacts. Planner/executor split end-to-end.

**Deviation from design doc:** gpt-5.6-sol has zero quota in this subscription
(deployment → InsufficientQuota, 2026-08-19); planner is **gpt-4.1** until a quota
request lands. Deployed: gpt-4.1 (planner) + gpt-4.1-mini (worker).

## State of play

Versions 1–3 registered; provisioning reached `ImageError` (registry auth);
AcrPull assigned to the project MI afterwards; a re-register is the untested
next step. All of it optional — this directory is for reading.
