# hosted-agent (code-first, no azd)

Minimal hand-rolled Foundry **hosted agent**: a container you package yourself,
registered via the SDK, invoked over the Invocations protocol.

> **Dynamic orchestrator:** The ACA gateway uses the concurrent iterative model
> loop, isolated specialist workspaces, and conversation-scoped pending artifact
> handoff. Every delegate action declares bounded OUTPUT CLAIMS; specialists map
> produced paths to those claims, and the executor returns claim-to-pending-ID
> mappings. The runtime no longer infers a whole-ADL or fixed-gallery contract
> from task wording. See `design/dynamic-orchestrator-redesign.md`.

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

`planner → validate_plan → execute steps → response` — no tools, no tool runtime yet.

| Module | Role |
|---|---|
| `foundry.ts` | the ONLY LLM caller; agent-identity token cached; stateless `store:false` |
| `imports.ts` | agents/*.md → compiled catalogue (researcher.md, writer.md — echo-class) |
| `planner.ts` | call 1: structured `emit_plan`; planner/worker deployment allowlist |
| `validate_plan.ts` | pure gate: role existence, planner-deployments-can't-work, ≤5 steps, non-empty self-contained tasks; no arbitrary task-length ceiling |
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

## Chunk 3 — the tool runtime (2026-08-19, WORKS; renamed broker→toolbox 2026-08-26)

> **Architecture correction (2026-08-26):** this chunk was originally framed as
> "the deterministic broker / in-process airlock". That misapplied the flow-2
> oracle/airlock trust split to this flow-1 interactive container. In the
> source app (http_proxy) the interactive flow (React → host → orchestrator
> agent) has an OPEN tool set and NO broker; the airlock lives only in flow 2
> (source oracle = Rust daemon `daemon-airlock` in ACA; target oracle =
> http_proxy's `src/refresh`). The module is now **`toolbox.ts`**: per-role
> tool lists remain as least-privilege scoping (LLM proposes, runtime disposes),
> but the catalog is an orchestrator toolbox
> that grows with ordinary capabilities without airlock justification — it
> holds no signing keys or secrets. The SWA does not depend on the airlock.

| Module | Role |
|---|---|
| `toolbox.ts` (was `broker.ts`) | per-role tool lists (`read_file`/`write_file`/`list_files` in a per-conversation workspace, path-escape proof), path-type guards that convert directory read/write/upload/render/staging targets to structured `not_file` errors, `dispatch()` scoping gate, `runRole` tool loop bounded by model/tool-call counts; scientific Python owns CPU/wall limits. `execute_python` → chunk 4, `playwright` → chunk 5. |
| `agents/reader.md` | first tools-bearing role |
| orchestrator | executeStep → `runRole` (real tool loops, not single calls) |

**Proven:** `scripts/smoke-chunk3.ts` — reader wrote `notes/hello.txt` then re-read and
confirmed it across two steps sharing the workspace. `scripts/smoke-chunk3b.ts` — four
gates pass: unknown_tool, catalog gate, path_escape, unpriced-deployment refusal.
**Wire fix:** Responses API requires raw `function_call` items echoed into `input` before
`function_call_output` items (`foundry.ts` now returns `rawOutput`; the runtime echoes it).

## Chunk 4 — execute_python + statistician (2026-08-19, WORKS)

| Module | Role |
|---|---|
| `toolbox.ts` | `execute_python` tool: scrubbed env, cwd=workspace, asynchronous `python -I` child (so gateway heartbeats continue), configurable CPU/wall limits, ACA cgroup memory, stdout contract; full ADL uses one staged Python computation/write pass |
| `foundry.ts` | single Responses API boundary; retries network errors and HTTP 408/409/429/5xx using Retry-After/Azure rate-reset headers, bounded exponential backoff, and jitter |
| `agents/statistician.md` | defaultDeployment gpt-4.1-mini, tools incl. execute_python |
| `Dockerfile.agent` | python3 + pinned numpy/pandas/statsmodels/scikit-learn (full-bookworm base) |
| `validate_plan.ts` | partial rejection is non-fatal: surviving steps proceed, dropped steps reported as validationErrors |

**Proven** (`scripts/smoke-chunk4b.ts`, direct role run): real OLS in Python —
slope b=1.9873, 95% CI (1.924, 2.050), R²=0.9985, `notes/card.json` written and
verified on disk. Planner routing to statistician from natural language is a
prompt-tuning item (gpt-4.1 planner over-genericizes); roles work when invoked.

## Chunk 5 — coder + render_validate (2026-08-19, WORKS)

| Module | Role |
|---|---|
| `toolbox.ts` | `render_validate` tool: Playwright Chromium loads a workspace HTML file, counts SVG children, collects console/page errors, returns `valid`. Async dispatch. |
| `agents/coder.md` | D3 chart role: dark theme, embedded data, validate-after-write protocol |
| `Dockerfile.agent` | `npx playwright install --with-deps chromium` (browser baked into image) |

**Proven** (`scripts/smoke-chunk5.ts`): coder wrote `charts/line.html` (D3 line
chart, dark theme), self-validated via render_validate — 5 SVG children, zero
console errors, valid=true. Playwright browsers are version-pinned to the npm
package: a fresh `npm i playwright` needs `npx playwright install chromium`
(the local cache had r1194/1217, the package wanted r1234).

## Chunk 6 — artifacts + pending tree; full pipeline (2026-08-19, WORKS)

| Module | Role |
|---|---|
| `artifacts.ts` | workspace → classified manifest (chart/data/notes/other), pending-file upload to artifact-service (not catalog publication), URL-bearing pending tree; generic turn failure returns this partial manifest |
| planner/worker seats | both are real deployments: `gpt-4.1` plans and runs statistician/coder steps; `gpt-4.1-mini` runs reader/operator/routine steps |
| response contract | `OrchestratorResult.artifacts[]` + pending tree appended to finish text; explicit `persist_artifacts` saves verified taxonomy rows and emits `catalog_updated` for immediate Documents refresh |

**Proven** (`scripts/smoke-chunk6.ts`, the ADL flow in miniature, one conversation):
reader wrote CSV → statistician ran real OLS (R²=0.9995) + wrote notes/model.json
→ coder produced validated D3 chart with fitted-line overlay → pending tree with
all 3 artifacts. Planner/executor split end-to-end.

**Deviation from design doc:** gpt-5.6-sol has zero quota in this subscription
(deployment → InsufficientQuota, 2026-08-19); planner is **gpt-4.1** until a quota
request lands. Deployed: gpt-4.1 (planner) + gpt-4.1-mini (worker).

## Chunk 8 — backbone sync → azure refresh.db (2026-08-24, WORKS)

Closes the two-item gap between http_proxy and azure-foundry:
(1) get the catalog's backbone CSVs into the azure refresh daemon's
indicator_history; (2) let the orchestrator invoke the same
`sync_indicator_history` tool http_proxy has.

| Module | Role |
|---|---|
| artifact-service `POST /refresh-sync` (daemon repo) | server-side bridge: tagged text/csv catalog rows → baked-in `data/series-map.json` allowlist → YYYY-MM normalization → HMAC-signed POST to `$REFRESH_DAEMON_URL/refresh/bootstrap`. Admin-role gated. |
| toolbox `sync_indicator_history` | thin wrapper in the toolbox's CATALOG; only ever sees the SyncReport — the LLM cannot author bytes for the refresh target. Same trust shape as http_proxy's orchestrator tool. The actual gate is server-side at the artifact-service (admin role + HMAC), not in this file. |
| `agents/operator.md` | system-operator role with catalog limited to `sync_indicator_history`; routes "sync the backbone" prompts. |
| `scripts/smoke-refresh-sync.ts` | stub artifact-service gate test: dispatch passes dryRun + admin header, non-listed roles rejected, non-OK → sync_failed. |

Deployment wiring: the artifact-service ACA app needs `REFRESH_DAEMON_URL`
(+ `DAEMON_HMAC_KEY` from secrets). The baked series-map.json is a checked-in
copy of http_proxy's `data/series-map.json`; when hub series are added, sync
both.

**Proven:** daemon repo `artifact-service npm test` (12/12 — stub refresh-daemon
verifies HMAC + YYYY-MM normalization); azure repo `npx tsx scripts/smoke-refresh-sync.ts`
(6/6 — dispatch gates + role registration).

## Chunk 9 — fetch_url: the reader's web plane (2026-08-26, WORKS)

Motivation: a user pasted a SAS-signed Azure blob URL
(`daemonstore.blob.core.windows.net/prompts/...`) and asked the SWA app to
fetch it; the reader had no network verb and correctly answered "I am unable
to fetch files from external URLs". Closed catalog = closed world.

| Module | Role |
|---|---|
| toolbox `fetch_url` | GET one external URL, streamed body capped at 256KB (100k chars to the model), 30s timeout. Guards: http(s) only, loopback/private hosts refused (incl. IMDS 169.254.169.254), optional `FETCH_URL_ALLOWLIST` env (comma-separated host suffixes) tightens further. Redirect targets are not re-checked (documented gap). |
| `agents/reader.md` | tools += `fetch_url`; protocol gains THE WEB plane — fetch the FULL URL including the SAS query string; never claim a URL is unfetchable without trying the tool. |
| `scripts/smoke-fetch.ts` | dispatch-level gates: real SAS blob fetch, IMDS refused, non-http(s) refused, catalog gate for unlisted roles, allowlist refusal. |

Deploy: rebuild the image (`az acr build`) + register a new version
(`AGENT_NAME=orchestrator AGENT_IMAGE=...:0.2.0 npx tsx src/agents/register.ts`);
the SWA API function resolves the highest published version, so no SWA
redeploy is needed.

## State of play

Versions 1–3 registered; provisioning reached `ImageError` (registry auth);
AcrPull assigned to the project MI afterwards; a re-register is the untested
next step. All of it optional — this directory is for reading.

## Chunk 10 — end-to-end deploy hardened (2026-08-26, WORKS)

Deployed `foundry-agent-orchestrator:1.1.1` as agent version 7; SWA path
verified 2/2 on the SAS-blob fetch prompt. Hardenings from the deploy:

- `.dockerignore`: `**/node_modules`, `**/dist`, `src/api`, `src/react-app`,
  `.git`, `.env`, `design`, `scripts` — the upload was stalling for 10+ min
  because it packed every nested node_modules (hundreds of MB).
- `tsconfig.agent.json`: extends root, excludes `src/api` + `src/react-app`
  (`@azure/functions`/`react`/`vite` aren't in root package.json);
  `Dockerfile.agent` runs `npx tsc -p tsconfig.agent.json`.
- `register.ts` defaults now match live (`AGENT_NAME=orchestrator`,
  image `foundry-agent-orchestrator:latest`); `AGENT_CPU`/`AGENT_MEMORY`
  env-overrideable, defaults 1cpu/2Gi (the 0.5cpu/1Gi sample tier → ImageError
  "too large for CPU tier" on our ~1GB image).
- planner: verbatim-data rule (URLs incl. full SAS query strings, artifact
  ids, paths copied INTO the task text) — the worker sees task text only, and
  "fetch the provided URL" without the URL is a failed plan.
- server banner: `orchestrator v${FOUNDRY_AGENT_VERSION}` so callers can
  verify which version answered (the stale "chunk 1-2" banner burned an hour
  of debugging).
- Windows az CLI note: `az acr build` may crash printing the log tail
  (cp1252 UnicodeEncodeError) while the remote build succeeds — check
  `az acr repository show-tags`, don't re-run.

## Chunk 12 — behavioral skills + Python staging + iterative planning + ACA sync transport (2026-08-26)

The full interactive architecture now preserves the source agent/skill split:

| Layer | Contract |
|---|---|
| `src/hosted-agent/agents` | application-owned role prompts and tool grants; copied into both runtime images |
| `src/hosted-agent/skills` | application-owned behavioral method documents; the statistician calls `list_skills` + `read_skill` before authoring Python; not pi or Foundry-native resources |
| `execute_python(stage_indicator_panel=...)` | fetches `/refresh-panel`, atomically stages raw rows in the conversation workspace, then starts agent-authored Python; tool output exposes only hash/count/range metadata + stdout |
| iterative planner | plans carry `continuePlanning`; prompt/artifact discovery executes first and returns to the planner before substantive role selection; `continue`/`retry` reuses the fullest previous task instead of a narrowed retry |
| ACA gateway | `/ws/agent` keeps one synchronous browser turn open and streams planning/step events plus the final result; it is not a polling job and does not use `invocations_ws` |

Architecture smoke: `npm run test:architecture`. ACA source and deployment contract:
`src/aca-gateway/server.ts`, `Dockerfile.gateway`, and
`design/aca-synchronous-orchestrator.md`.

The old summary-only `read_indicator_panel` verb remains for reader/diagnostic
compatibility, but it is no longer granted to the statistician. Statistical
panel work must enter through the Python staging argument. The foundational
`skills/leading-indicator-panel/SKILL.md` now fixes the exact staged JSON shape,
canonical 13-series dictionary, cutoff/release distinction, common level and
YoY-log transformations, and the no-escalation contract for simple tests.
Modeling skills such as `adl-monthly-nowcast` reference that foundation. The
ADL method additionally fixes the long-to-wide boundary: validate all 13
`series_id` values and duplicate series-month keys, pivot to date-indexed series
columns, then construct transformations/features from the wide frame. This
prevents treating a valid nested panel as though series IDs were already DataFrame
columns.

## Chunk 11 — read_indicator_panel: the azure parity loop closes (2026-08-26, WORKS)

The ADL nowcast prompt assumed the http_proxy ambient-file idiom
"statistician reads data/refresh.db". Azure's closed toolbox has no SQLite
read — "upload refresh.db" was the worker's only imagined source. Fixed:

| Layer | Trust |
|---|---|
| artifact-service `/refresh-panel` (daemon repo, admin-gated) | read-only open of the SHARED Azure-Files volume (`REFRESH_DB_PATH=/data/refresh.db`). SELECT → deterministic ordering + `sha256` panelHash. The refresh-daemon owns writes; the artifact-service is the only read surface. |
| azure-foundry `read_indicator_panel` verb | forwards subject+series to artifact-service; returns SHAPED summary (series, ranges, obs counts, hash) — never raw rows |
| agents/statistician + agents/reader | grant the verb; protocol says call it BEFORE execute_python, never say "upload refresh.db" |
| planner | explicit rule: indicator-panel + statistics → route to statistician |

Verified through the SWA on version 9: 13-series ADL panel summary, panels
cited by hash slice (`1780814428…`), csv artifact written. prompt executed
without upload asks.
