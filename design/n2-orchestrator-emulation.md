# N2 — Orchestrator emulation on Foundry hosted agents (planner/executor)

**Goal:** reproduce the http_proxy interactive flow in Azure — one user prompt
(e.g. `/prompts/aug-2026-ADL.md`, produced by the React frontend) → orchestrating
LLM → sub-agents → Python statistics → D3 charts + Playwright validation →
pending-tree text. No deference to pi/azd; code-first, /invocations surface.

**Decisions locked so far:**
- Hosted agent (`kind:"hosted"`) for the orchestrator container; daemons stay in ACA.
- Invocations protocol hand-rolled in TS (no Py/.NET agentserver libs).
- Core LLM interaction: stateless Responses calls; the CONTAINER owns all context
  assembly (AGENTS.md/MEMORY.md distilled per call — the model sees nothing else).
- Orchestrator routing is deliberately non-deterministic; determinism lives in the
  sub-agent tool catalogs, budgets, and validators (LLM proposes, broker disposes).
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
models come ONLY from the broker's deployment allowlist.

### 2. Deterministic modules (TypeScript, all in-container)
```
src/hosted-agent/
  server.ts        # /readiness + POST /invocations (exists, hello-grade)
  session.ts       # conversation_id → session state (persist in $HOME/files)
  imports.ts       # role catalogue loader: roles/*.md → {name, defaultDeployment,
                   #   instructions, toolSchemas[]} compiled at startup
  planner.ts       # callPlanner + tool schema for emit_plan
  validate_plan.ts # THE GATE (below)
  broker.ts        # dispatch(toolCall) → execute in-container (closed catalogs)
  executor.ts      # the delegate loop: validate → callRole over Responses →
                   #   broker its tools → collect outputs → return to orchestrator
  orchestrator.ts  # outer loop: planner → validate_plan → executor → finish
  respond.ts       # response formatter (pending tree)
validator & budgetinvariants:
  - DeploymentAllowlist: [{ name, roles:[*]|roles-limited, kind: planner|worker }]
      * planner-marked deployments cannot run worker steps
      * allowlist enforced in validate_plan BEFORE any worker token is spent
  - StepBudget: per-step { maxToolCalls, wallClockSecs, tokenCeiling, costCeiling }
    plus plan-level ceilings (maxSteps, totalCost) — same numbers discipline
    as airlock config.toml [budget]
  - validate_plan(plan, allowlist, roles, ceilings) → {ok, errors[], plan' clamped}
  - dispatch() gates every tool call into the broker; roles never touch
    FS/network/db except through it (airlock property, in-process)
```

### 3. Tool catalogs per role (closed, as today)
| Role | Tools | Notes |
|---|---|---|
| statistician | read, execute_python, write | python3 + pinned numpy/pandas/statsmodels/sklearn in image |
| coder | read, write, playwright | chromium binaries baked in; validation inside dispatch |
| research | web_search, fetch_page, read | closed egress; hosts allowlist per broker |
| narrator/stylist | read, write | |

### 4. Context assembly per call (what the model actually sees)
```
instructions  = role.instructions (from roles/*.md frontmatter/body)
input         = [ task, upstream artifact contents (full <3KB / excerpted),
                  relevant memory artifacts, current state summary ]
tools         = role.toolSchemas (+ delegate/finish for orchestrator)
catalog (planner only) = roles + deployment zoo + cost hints, so the planner's
                         allocation is an informed LLM choice, not guessing
```

### 5. Artifacts & the React contract
```
prompt arrives    = POST /invocations body: { conversation_id, promptText } |
                    { conversation_id, promptRef }
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
