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

> **Status: implemented 2026-08-18 (image 1.0.3).** `gpt-4o-mini` was deprecated —
> deployed **`gpt-4.1-mini`** (2025-04-14) instead; `config.toml [models]` allowlist
> carries that deployment name. §3.1 landed in `oracle/src/llm.ts` + `schemas.ts`
> (flat `strict:true` catalog — note strict mode requires *all* properties in
> `required` with nullable optionals, recursively; and `max_output_tokens` must fit a
> full inline `store_dataset` payload — 800 truncated arguments mid-JSON). §3.2 landed
> in `lockdown.rs`: the airlock mints an Entra token via the 'Daemon' SP
> (`https://ai.azure.com/.default` audience; `cognitiveservices.azure.com` is rejected
> with 401) and injects `FOUNDRY_ACCESS_TOKEN` + `AZURE_AI_PROJECT_ENDPOINT`.
> RBAC gotcha: the data plane honors **Foundry User at ACCOUNT scope** —
> project-scope assignment 403'd. Validated locally: full `run-oracle` loop against
> Foundry, census 2026-06, status=stored, $0.0042. Cost constants now Azure prices
> ($0.40/$1.60 per 1M for gpt-4.1-mini). serve-http still runs the scripted runner —
> wiring the LLM oracle into the HTTP service is the separate Phase-3 step.

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

## 4.5 Topology decision (2026-08-18): separate ACA environments, one RG

The target daemon (refresh-daemon, N1) gets its **own ACA environment**
(`target-env`) inside the same resource group (`nowcasting`) — network separation
between the source zone and target zone, while keeping one management/lifecycle
boundary. Consequences: in-env DNS does NOT cross environments, so both apps use
their external FQDNs for each other (TLS + HMAC as always); `DAEMON_MAIN_URL` /
`DAEMON_URL` carry full FQDNs, not short names. Chosen deliberately for a learning
deployment: the environment is the network boundary in ACA, not the resource group.

> **N1 status: implemented 2026-08-18 (image daemon-refresh:0.1.0).** refresh-daemon
> runs in `target-env` (external ingress :8792, refresh.db on the `refresh-data`
> share, Python 3.11 + pinned numpy/pandas/statsmodels for the frozen skills,
> PYTHON_BIN=python3). Code changes: openDb() opens `file:...?nolock=1` and drops
> WAL (single long-lived connection, sole writer — the CIFS locking lesson from §5).
> Verified end-to-end across the two environments: wake-census-shipments → fetch →
> store ds-9b4c5eb7 → broadcast bc-ad7a2538 → outbox retry→accept → target verify/
> ingest (16 obs m3_total_shipments_nsa) → 3 contracts fan-out (m3-forecast, m3-stl,
> productivity) → all abstained CORRECTLY (insufficient history — the Azure
> refresh.db lacks the backbone; sync it via /refresh/bootstrap for real candidates).
> Gotchas: az acr build on Windows doesn't reliably honor .dockerignore — build from
> a staged context (http_proxy/.build-refresh); pnpm project needs a generated
> package-lock.json for npm ci.
>
> **History bootstrap (2026-08-19):** ACA Job `bridge-seed` (manual trigger,
> `daemon-bridge-seed:0.1.0`, Node-only image, snapshot of artifacts.db baked in,
> `REFRESH_DAEMON_URL=http://refresh-daemon` in-env) seeded 3,730 observations /
> 13 series / 2002-01..2026-07 into the Azure refresh.db. Next wake-census-shipments
> run: all 3 contracts reached **candidate** (run_nowcast_skill ok=true,
> write_forecast_artifact ok=true). Re-run the job whenever the backbone snapshot
> needs refreshing.

## 5. State

`sandbox.db` holds `datasets` (pulled by the target via `GET /datasets/:id`) and
`broadcast_outbox` (undelivered broadcasts). Both must survive restarts.

Mount **Azure Files** at `/data` and keep SQLite. With `maxReplicas: 1` this is correct.
~~needs zero code change~~ **Correction (2026-08-18, first deploy):** SQLite's POSIX
byte-range lock protocol **does not work at all** on ACA's Azure Files (CIFS) mount —
every writer gets permanent `SQLITE_BUSY`, verified on a brand-new file with zero open
server-side handles (busy_timeout and locking_mode=EXCLUSIVE both failed). Final fix:
every connection opens with `nolock=1` (`tools::open_db`) and all DB access is
serialized in-process behind a global mutex (`tools::DB_LOCK`) — held for a job's
lifetime, per dispatcher iteration (bounded by the 30 s ureq timeout), and per
`/datasets` pull. Safe because `maxReplicas: 1` guarantees one process on the file and
ACA Jobs never mount `/data`. **Deploy-order caveat:** `az containerapp update`
overlaps old+new replicas briefly — with `nolock` that's a two-writer window. Scale to
0 before updating the app image, then back to 1.

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
