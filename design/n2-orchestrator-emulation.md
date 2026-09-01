# N2 — Orchestrator emulation on Foundry hosted agents (planner/executor)

**Goal:** reproduce the http_proxy interactive flow in Azure — one user prompt
(e.g. `/prompts/aug-2026-ADL.md`, produced by the React frontend) → orchestrating
LLM → sub-agents → Python statistics → D3 charts + Playwright validation →
pending-tree text. No deference to pi/azd; code-first, /invocations surface.

**Implementation update — 2026-08-26:**
- Runtime role documents now ship from `src/hosted-agent/agents`; application-owned behavioral method documents ship from `src/hosted-agent/skills`. These are container resources, not pi-harness paths or Foundry-native skill resources.
- The statistician discovers/reads `SKILL.md` and calls generic `execute_python` with `stage_indicator_panel`; raw observations are written into the workspace before Python starts and are not echoed into LLM context.
- Planning is iterative (Option B): discovery rounds set `continuePlanning=true`; their outputs return to the planner before downstream roles are selected.
- The synchronous browser transport is the ACA WebSocket gateway in `src/aca-gateway/server.ts` / `Dockerfile.gateway`, not the SWA managed Function and not Foundry `invocations_ws`. See `design/aca-synchronous-orchestrator.md`.

**Decisions locked so far:**
- Hosted agent (`kind:"hosted"`) for the orchestrator container; daemons stay in ACA.
- Invocations protocol hand-rolled in TS (no Py/.NET agentserver libs).
- Core LLM interaction: stateless Responses calls; the CONTAINER owns all context
  assembly (AGENTS.md/MEMORY.md distilled per call — the model sees nothing else).
- Orchestrator routing is deliberately non-deterministic; determinism lives in the
  sub-agent tool catalogs, budgets, and validators (LLM proposes, runtime disposes).

> **Correction (2026-08-26):** the original draft of this doc said "dispatch()
> gates every tool call into the broker; roles never touch FS/network/db except
> through it (airlock property, in-process)" and named the module `broker.ts`.
> That misapplied the flow-2 oracle/airlock trust split to this flow-1
> interactive container. In the source app, flow 1 (React → host → orchestrator
> agent) has an OPEN tool set (fetch_page, web_search, query_artifacts,
> execute_python, playwright) with NO broker; the airlock lives only in flow 2
> (the source oracle = Rust daemon `daemon-airlock`, the target oracle =
> http_proxy's `src/refresh`). The module is renamed **`toolbox.ts`**: per-role
> tool lists remain as least-privilege scoping + cost discipline, but the
> catalog is an orchestrator toolbox that grows with ordinary capabilities
> (fetch_url, workspace files, catalog read/save, python, render_validate)
> without airlock justification. The SWA must not depend on the airlock; the
> refresh airlock stays where it is — in the daemon.
- **Planner/executor model selection (preferred over static role pins):**
  call 1 runs on the planner deployment (e.g. gpt-5.6-sol) and emits a structured
  plan — role, task, target deployment per step; subsequent steps run on the
  planner-chosen deployments, validated before execution. Static role frontmatter
  pins remain as the fallback/default.

## Components and their exact shapes

### 1. LLM interaction (the only non-deterministic layer)
```
callPlanner(prompt, catalog)      → { steps: [{role, task, deployment, tools_hint}] }
callOrchestrator(state, plan)     → delegate(role, task, ctx) | finish(text)
callRole(role, task, upstream)    → tool_call | final_artifacts
```
Every call = `{ model, instructions, input, tools, store:false }`. Allowed
models come ONLY from the runtime's deployment allowlist.

### 2. Deterministic modules (TypeScript, all in-container)
```
src/hosted-agent/
  server.ts        # /readiness + POST /invocations (exists, hello-grade)
  session.ts       # conversation_id → session state (persist in $HOME/files)
  imports.ts       # role catalogue loader: agents/*.md → {name, defaultDeployment,
                   #   instructions, toolSchemas[]} compiled at startup
  planner.ts       # callPlanner + tool schema for emit_plan
  validate_plan.ts # THE GATE (below)
  toolbox.ts       # dispatch(toolCall) → execute in-container (per-role tool lists;
                   # file reads/uploads/renders and write/staging targets return
                   # structured not_file errors for directories, never EISDIR)
  executor.ts      # the delegate loop: validate → callRole over Responses →
                   #   route its tools through dispatch() → collect outputs → return to orchestrator
  orchestrator.ts  # iterative outer loop: planner → validate → execute → replan|finish
  respond.ts       # response formatter (pending tree)
validator & budgetinvariants:
  - DeploymentAllowlist: [{ name, roles:[*]|roles-limited, kind: planner|worker }]
      * planner-marked deployments cannot run worker steps
      * allowlist enforced in validate_plan BEFORE any worker token is spent
  - Named profiles in budgets.ts resolve to per-step { maxModelCalls,
    maxToolExecutions, wallClockSecs, maxOutputTokensPerCall, costCeilingDollars }
    plus one shared turn ceiling. The planner emits only the profile name;
    trusted code owns money and clamps against original-prompt intent.
  - Every planner and worker response is charged to the turn ledger; admission
    reserves estimated input + maximum output before each call. Unknown prices
    fail closed and deployment aliases charge as their actual model.
  - Indicator-panel modeling keeps its data-shape boundary in the behavioral
    skill: staged nested JSON → validated long frame → explicit date × series
    pivot → transformations and features. Series IDs are never assumed to be
    DataFrame columns before that pivot.
  - validate_plan(plan, allowlist, roles, ceilings) → {ok, errors[], plan' clamped}
  - dispatch() scopes each role to the tools its .md grants (least-privilege
    hygiene + budget enforcement) — NOT a trust boundary; this is the
    orchestrator's toolbox, open to ordinary capabilities as needed
```

### 3. Tool catalogs per role (closed, as today)
| Role | Tools | Notes |
|---|---|---|
| statistician | read, execute_python, write | python3 + pinned numpy/pandas/statsmodels/sklearn in image |
| coder | read, write, playwright | chromium binaries baked in; validation inside dispatch |
| research | web_search, fetch_page, read | http(s)-only egress with loopback/private-host and IMDS refusal (same guards as fetch_url) |
| narrator/stylist | read, write | |

### 4. Context assembly per call (what the model actually sees)
```
instructions  = role.instructions (from agents/*.md frontmatter/body)
input         = [ task, upstream artifact contents (full <3KB / excerpted),
                  relevant memory artifacts, current state summary ]
tools         = role.toolSchemas (+ delegate/finish for orchestrator)
catalog (planner only) = roles + deployment zoo + cost hints, so the planner's
                         allocation is an informed LLM choice, not guessing
```

### 5. Artifacts & the React contract
```
prompt arrives    = ACA WebSocket /ws/agent message:
                    { type:"prompt", conversation_id, promptText, user_id }
                    (Foundry POST /invocations remains a direct agent/test surface)
charts/datasets   = uploaded to existing artifact service (host /ui/api/artifacts,
                    HMAC'd) — React app unchanged; response carries artifact ids
pending tree      = plain-text in the finish() response (Parts A–E groupings)
session state     = conversation + role outputs in $HOME/session/<id>/
```

### 6. Termination (any one ends the loop)
finish(response) · plan-validation failure (safe abort, nothing executed) ·
step/plan budget ceiling (forced finish) · no-tool-call text (adopted response) ·
caller abort (re-invocation with abort:true)

## Open items (verification before build)
- Measure hosted-agent session cold start on hello image (multi-GB image risk:
  node + python + chromium + scipy stack).
- Decide ask_user emulation (deferred per user; likely early-return
  `clarification_needed` + re-invocation with the answer bound to conversation_id).
- Choose initial deployment zoo: planner(gpt-5.6-sol) + worker cheap (gpt-4.1-mini)
  + worker strong (gpt-4.1). Role frontmatter pins map onto these as defaults.
- Confirm plan-logging as a first-class audit artifact (explains cost of each run;
  cheap observability).
