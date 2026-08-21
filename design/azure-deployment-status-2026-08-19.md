# Azure deployment status — 2026-08-19 (end of day)

## What's live in Azure (RG `nowcasting`, eastus)

| Resource | Purpose | State |
|---|---|---|
| ACR `daemonairlock` | Images: daemon-airlock:1.0.3, daemon-refresh:0.1.0, daemon-bridge-seed:0.1.0 | admin user ON (best-practice fix: MI+AcrPull) |
| Env `nowcasting-env` | Source zone | |
| App `daemon-airlock` :8791 | Source airlock + scripted runner; Foundry-repointed oracle (1.0.3) | healthy; DAEMON_MAIN_URL → refresh-daemon FQDN |
| Jobs wake-{fred-capacity, census-orders, census-shipments} | Cron wakes (16–20th / 5–9th) | proven end-to-end |
| Env `target-env` | Target zone (separate network, same RG) | |
| App `refresh-daemon` :8792 | Target daemon; refresh.db on `refresh-data` share | healthy; 3,730 obs seeded; produces signed candidates |
| Job `bridge-seed` (manual) | artifacts.db snapshot → /refresh/bootstrap | re-run to refresh backbone |
| Storage `daemonstore` | airlock-data + refresh-data shares | |
| Foundry `ForecastingModule/proj-default` | deployment **gpt-4.1-mini** (gpt-4o-mini was deprecated) | SP 'Daemon' has Foundry User @ account scope |
| Entra app 'Daemon' | SP for Foundry tokens (secret minted 2026-08-18, expires 2027-08-18) | local-dev use; Azure should go managed-identity later |

## Proven loops today
- Source: cron → emit → /run → fetch → store → signed broadcast (SQLite-on-Azure-Files fixed via `nolock=1` + DB_LOCK mutex — applies to refresh.db too).
- Cross-env delivery: broadcast → HMAC verify → pull → ingest → fan-out 3 contracts.
- Candidates: post-seed, all three contracts reach **candidate** (skill ✓, signed artifact ✓).
- Oracle §3 repoint: `run-oracle` loop against Foundry Responses API, status=stored, $0.0042.

## Open items (tomorrow+)
1. **N2 orchestrator proposal** (under your review): Foundry agent definitions + TS broker harness in azure-foundry; agent-as-tools delegation; roles from md files. Contenders for richer orchestration: Agent Framework (B) vs LangGraph (C); broker pattern (A) stays as trust layer.
2. Best-practice register: disable ACR admin → managed identities + AcrPull; Key Vault secret refs; tags; **Bicep codification** (the learning vehicle).
3. serve-http still runs the scripted runner — LLM oracle wiring into the HTTP service = Phase 3.
4. Target oracle (refresh/oracle.ts) still on OpenRouter — second repoint, patterns proven.
5. `local-openrouter/` swap dir in c:/repos/daemon holds pre-Foundry file set (README inside).
6. http_proxy working tree has pre-existing uncommitted changes (not ours) — review before discard.

## Key gotchas logged in design doc
- SQLite on Azure Files: nolock + in-process serializer (WAL dropped).
- Foundry data-plane RBAC: Foundry User at ACCOUNT scope; audience https://ai.azure.com/.default.
- az acr build on Windows: .dockerignore unreliable → staged context .build-refresh; pnpm → generated package-lock.json.
- Responses strict mode: all properties required w/ nullable optionals, recursive; max_output_tokens must fit store_dataset payload.
