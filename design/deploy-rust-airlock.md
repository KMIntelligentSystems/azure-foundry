# Deploying the Rust airlock + oracle to Azure

**Source:** `c:/repos/daemon/daemon` — `airlock/` (Rust) + `oracle/` (Node)
**Subscription:** `39fe074b-81bc-4f93-8837-f06bea491181`

## 0. Two findings that shape the plan

**Foundry's scheduler cannot wake your daemon.** `project.beta.schedules` accepts
`ScheduleTaskType = "Evaluation" | "Insight"` only. Triggers are rich (`Cron`,
`Recurrence`, `OneTime`), but the *task* can only be a Foundry evaluation or insight run —
there is no "invoke this agent" task type. So Foundry replaces Railway cron for nothing.
Scheduling goes to Azure Container Apps Jobs (§4).

**A Foundry hosted agent is session-scoped compute, not a stateful service.** The lifecycle
is `createSession` / `stopSession` / `deleteSession` / `getSessionLogStream`, with per-session
file upload/download. Your airlock needs the opposite: an always-on listener, a
`broadcast_outbox` that survives restarts, a dispatcher thread polling every 5 s, and a
`datasets` table that must never be lost. Those don't fit a session.

**So: deploy to Azure Container Apps. Use Foundry for the oracle's inference only.**
Optionally register the airlock as `kind:"external"` (`otel_agent_id`) so Foundry still
gives you traces and evals over it — that's a metadata-only registration, no hosting.

If you want it under `kind:"hosted"` anyway, §7 covers what would have to change.

## 1. What you're deploying

```
ACA Job (cron, one per source release window)
  │  emit-run-request --source X --month auto  →  POST /run  (HMAC RunRequest)
  ▼
ACA App: daemon-airlock  (min=1, max=1)
  ├─ tiny_http on 0.0.0.0:$PORT — POST /run, GET /health, GET /datasets/:id
  ├─ outbox dispatcher thread (5 s poll, backoff 1→64 s capped 3600)
  ├─ capability broker: fetch_series · read_prior_vintage · store_dataset · finish
  └─ spawns Node oracle per job (TaskContext on argv[2], ToolCall/ToolResult over stdio)
        └─ LLM call  ──►  Foundry model deployment      [CHANGED: was OpenRouter]
  ▼
broadcast_outbox → POST $DAEMON_MAIN_URL/ui/api/daemon/broadcast → BroadcastResponse
```

`maxReplicas: 1` is not a simplification — it's required. The scheduler's `fired` set is
in-memory, the outbox claims rows with a best-effort single-owner `UPDATE`, and
`rusqlite::Connection` is per-thread. Two replicas would double-fire and double-deliver.

## 2. The container

One image, two runtimes. Rust for the airlock, Node for the oracle it spawns
(`--oracle-script ../oracle/dist/main.js`). `code_configuration` can't do this even if you
wanted a hosted agent — it's `python_3_14`.

```dockerfile
# --- oracle build ---
FROM node:22-bookworm AS oracle
WORKDIR /src
COPY daemon/oracle/package*.json ./
RUN npm ci
COPY daemon/oracle/ ./
RUN npm run build                      # → dist/main.js

# --- airlock build ---
FROM rust:1-bookworm AS airlock
WORKDIR /src
COPY daemon/airlock/Cargo.* ./
COPY daemon/airlock/src ./src
RUN cargo build --release              # libsqlite3-sys bundled → needs the C toolchain (present here)

# --- runtime ---
FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=airlock /src/target/release/daemon-airlock /usr/local/bin/
COPY --from=oracle  /src/dist ./oracle/dist
COPY --from=oracle  /src/node_modules ./oracle/node_modules
COPY daemon/airlock/config.toml ./config.toml
ENV PORT=8791
EXPOSE 8791
CMD ["daemon-airlock", "serve-http", "--port", "8791", \
     "--config", "/app/config.toml", "--db", "/data/sandbox.db"]
```

Note: **drop `--schedule`.** Scheduling moves out (§4).

Base the runtime on the Node image rather than `debian-slim` — the oracle needs a real Node,
and the Rust binary is static enough to drop in beside it.

### 2.1 `lockdown.rs` gets better in a container

Today on Windows only the env strip applies. On Linux the ulimits activate: RSS 512 MiB,
CPU 60 s, NPROC 1, NOFILE 16. Worth knowing:

- **chroot stays a no-op.** It needs root/`CAP_SYS_CHROOT`, which an ACA container won't
  have. Same posture as the Railway comment already in the file.
- **`NPROC = 1` and `NOFILE = 16` still hold** after the Foundry repoint, because the token
  is handed in rather than acquired (§3.2) — no IMDS round-trip, no credential-chain
  subprocesses, one TLS socket as before.
- Seccomp remains the documented next step.

## 3. Repointing the oracle at Foundry

### 3.1 The call

`oracle/src/llm.ts` `chatCompletion()` hits
`https://openrouter.ai/api/v1/chat/completions`. Replace with the Responses API. Wire
differences from what's there now:

| Now | Foundry |
|---|---|
| `messages[]`, `{role:"system"}` | `input[]`, `instructions` param |
| `tools:[{type,function:{name,…}}]` | `tools:[{type:"function", name, …, strict:true}]` |
| `choice.message.tool_calls[].id` / `.function.arguments` | `output` items `{type:"function_call", call_id, name, arguments}` |
| `{role:"tool", tool_call_id, content}` | `{type:"function_call_output", call_id, output}` |
| `data.usage.prompt_tokens` / `completion_tokens` | `usage.input_tokens` / `output_tokens` |

`buildToolCatalog(ctx.series)` needs the flat rename; the catalog *contents* (the closed
`fetch_series` / `read_prior_vintage` / `store_dataset` / `finish` set, series enum
injected per source) are unchanged. `temperature: 0` carries over.

The bridge protocol (`ToolCall` out on stdout, `ToolResult` in on stdin), the `finish`
short-circuit, and the whole `Budget` tracker are provider-independent — no change.

### 3.2 Credentials: hand the oracle a token, not an identity

`harden_child()` currently clears the env and injects exactly `OPENROUTER_API_KEY`. Don't
replace that with managed identity in the child — that would give the untrusted process an
Azure identity, which is a strictly larger capability than an API key scoped to one vendor.

Instead: the **airlock** (trusted, already holds the HMAC key and the data-source keys)
acquires an Entra token and passes it down as a short-lived bearer:

```rust
// lockdown.rs
new_env.insert("AZURE_AI_PROJECT_ENDPOINT".into(), endpoint);
new_env.insert("FOUNDRY_ACCESS_TOKEN".into(), token);   // expiring, scoped, not an identity
```

The oracle sends `Authorization: Bearer $FOUNDRY_ACCESS_TOKEN`. It cannot mint another
token, cannot reach IMDS meaningfully under `NOFILE=16`, and the credential dies with the
job. This preserves the airlock property the whole design rests on.

### 3.3 Config changes

```toml
[models]
# OpenRouter ids → Foundry DEPLOYMENT names
allowlist = ["gpt-4o-mini", "gpt-4o"]
default = "gpt-4o-mini"
```

`validate()` gates `req.model` against this allowlist, so the RunRequest contract is
unaffected — only the string space changes.

`[hosts] allowlist` needs **no** change. It gates `fetch_series` (the airlock's own egress
to `api.stlouisfed.org`, `api.census.gov`, `api.bls.gov`); the oracle's LLM egress was never
covered by it. Asymmetry worth knowing, not a bug.

`COST_PER_1K_INPUT` / `COST_PER_1K_OUTPUT` / `COST_CEILING_DOLLARS` in `schemas.ts` are
OpenRouter prices. Azure per-1K rates differ — update them or the cost ceiling silently
stops meaning what it says.

## 4. Scheduling the leading indicators

Foundry can't do this (§0). Use **ACA Jobs** in cron mode — one job per source release
window, which is exactly the shape `scripts/register-tasks.ps1` and Railway cron already
have. Each job does what `run-source.ps1` does: emit a signed RunRequest with
`--month auto` and POST it to `/run`.

```bash
az containerapp job create \
  --name wake-census-m3 --resource-group <rg> --environment <env> \
  --trigger-type Schedule --cron-expression "0 14 5-9 * *" \
  --image <acr>.azurecr.io/daemon-airlock:1.0.0 \
  --command daemon-airlock --args "emit-run-request,--source,census,--month,auto" \
  --replica-timeout 300
```

The job image is the same image — it already contains `emit-run-request`. Pipe its stdout
to `/run`; a tiny entrypoint script is cleaner than trying to do it in `--args`.

### 4.1 Why this works without a precise calendar

Three properties already in the code make over-firing free:

1. **`reference_month_for()`** = `as_of_month − max(reference_lag_months)` across the
   request's series. So a fire date never has to know the reference month.
2. **The abstain guard** in `run_job()` requires the requested month to actually appear in
   the fetched observations. Fire early → `status: "abstain"`, nothing stored, nothing
   broadcast, HTTP 200.
3. **Idempotent delivery** — a duplicate broadcast returns `reject: duplicate`, which
   `classify_decision()` maps to `accepted`.

So the cron only has to fire *somewhere after* the release, repeatedly. Cheap.

### 4.2 One job per entry

From `config.toml [[schedule.entries]]`, with the lags from `[[series]]`:

| Job | Source | Series | lag | Fires for | Suggested cron |
|---|---|---|---|---|---|
| `wake-fred-capacity` | fred | `fred_mcumfn` (default) | 1 | month−1 | `0 14 16-20 * *` (G.17 mid-month) |
| `wake-census-orders` | census | `m3_new_orders`, `m3_unfilled_orders` | 2 | month−2 | `0 14 5-9 * *` (M3 full report) |
| `wake-census-shipments` | census | `m3_total_shipments_nsa` | 2 | month−2 | `0 14 5-9 * *` |

The authoritative calendar is `data/lookups/leading_indicators.json` (per-source rule, lag,
confirmed 2026 dates); `config.toml` carries the operational `reference_lag_months`. Set
crons from the former, and let retry cover slippage.

The lag-0 regional Fed surveys (`fred_empire_state_mfg`, `fred_philly_fed_mfg`,
`fred_dallas_fed_mfg`) and the BLS series have no `[[schedule.entries]]` yet — they're
configured but unscheduled. Add entries before adding jobs.

### 4.3 The in-memory `fired` set

`scheduler_loop`'s `fired: HashSet<(source, month)>` is process-local. It only ever
suppressed duplicate fetches within one process lifetime — the README says as much
("scheduling is pluggable and outside the trust boundary").

Moving the schedule to ACA Jobs makes this moot: Azure holds the schedule durably, and each
job is a fresh process that fires once by construction. **This is the main reason to prefer
ACA Jobs over keeping `--schedule`** — the alternative is adding a durable `fired` table,
which is real work for no gain.

## 5. State

`sandbox.db` holds `datasets` (pulled by the target via `GET /datasets/:id`) and
`broadcast_outbox` (undelivered broadcasts). Both must survive restarts.

Mount **Azure Files** at `/data` and keep SQLite. With `maxReplicas: 1` this is correct and
needs zero code change.

Do not reach for Postgres here. The single-replica constraint comes from the outbox claim
and the connection model, not from SQLite, so a bigger database buys nothing until those are
reworked.

## 6. Secrets and setup

| Secret | Used by |
|---|---|
| `FRED_API_KEY`, `CENSUS_API_KEY`, `BLS_API_KEY` | `fetch_series` (airlock only — never in the child env) |
| `DAEMON_HMAC_KEY` | RunRequest verify, broadcast sign, `/datasets/:id` pull auth |
| `DAEMON_MAIN_URL` | outbox dispatcher target |
| `AZURE_AI_PROJECT_ENDPOINT` | airlock → token acquisition, passed to child |

Key Vault, referenced as ACA secrets, with the app's managed identity granted `get` on
secrets. Note the airlock already fails loudly on a missing `DAEMON_HMAC_KEY` but falls back
to `dev-insecure-hmac-key-change-me` rather than refusing to start — worth making that fatal
before this is reachable from anywhere.

Steps:

1. ACR in the resource group; ACA environment; managed identity with `AcrPull`.
2. Build/push the image (§2).
3. Create the ACA app: `minReplicas: 1`, `maxReplicas: 1`, Azure Files volume at `/data`,
   ingress internal unless the target daemon is outside the environment.
4. Create one ACA Job per schedule entry (§4.2).
5. Deploy a model in the Foundry project; put the **deployment** name in
   `config.toml [models]`.
6. Optional: `project.agents.createVersion("daemon-oracle", {kind:"external", otel_agent_id})`
   and emit OTel spans with `gen_ai.agent.id` to get Foundry traces over it.

## 7. If you insist on `kind:"hosted"`

What would have to change, so the trade is explicit:

- **State** — sessions are ephemeral. `datasets` and `broadcast_outbox` move to an external
  store (Postgres or Cosmos). That's a rewrite of `tools.rs` persistence and the dispatcher.
- **The outbox dispatcher** — a 5 s polling thread inside a session-scoped container has no
  guaranteed lifetime. Delivery becomes a separate always-on component anyway.
- **Ingress** — `POST /run` becomes whichever `protocol_versions` entry you pick
  (`invocations` is the closest fit to a plain signed POST; `responses` and `mcp` would mean
  reshaping the RunRequest contract).
- **Waking it** — still not Foundry's scheduler. Still ACA Jobs or equivalent.

You'd keep the container image and lose the parts of the design that depend on being
long-lived. The `external` registration in §6 step 6 gets you Foundry's observability
without any of that.
