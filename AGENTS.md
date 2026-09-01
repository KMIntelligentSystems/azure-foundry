# AGENTS.md

This project was built with the microsoft-foundry skill. Before working on or answering questions about Foundry agents, read the microsoft-foundry skill first.

## Architecture invariants

- `src/hosted-agent/agents/*.md` define the deployed application's stable role behavior and tool grants.
- `src/hosted-agent/skills/*/SKILL.md` define the deployed application's behavioral methods. Skills are read and interpreted by agents; do not replace them with deterministic statistical pipelines.
- These runtime catalogs are application-owned resources. They are not pi-harness paths and are not automatically discovered or executed by Microsoft Foundry.
- For indicator-panel statistics, the statistician calls the generic `execute_python` tool with `stage_indicator_panel`. The runtime stages raw observations into the conversation workspace before Python starts. Raw observations are not placed in LLM context.
- Workspace tools treat paths as typed capabilities: read/upload/render inputs accept regular files only, and write/staging targets cannot be directories. Directory paths return a structured `not_file` result (use `list_files` for inspection) and must never escape dispatch as filesystem exceptions such as `EISDIR`.
- The interactive browser turn is synchronous over the ACA WebSocket gateway (`/ws/agent`). Do not replace it with a job/polling workflow or route long turns through an SWA managed Function.
- Orchestration is iterative: discovery plans set `continuePlanning=true`; their outputs return to the planner before downstream roles are selected.
- Flow-1 interactive tools are a toolbox, not the flow-2 refresh airlock.
- Foundational leading-indicator access, staged JSON parsing, cutoff filtering, and common transforms are defined in `src/hosted-agent/skills/leading-indicator-panel/SKILL.md`; modeling skills build on that contract.
- Cost policy is centralized in `src/hosted-agent/budgets.ts`. The planner emits only a named workload profile; `validate_plan.ts` enforces role compatibility and clamps it to a maximum derived from the original user prompt. Trusted code owns dollar/token/time limits, alias-aware prices, pre-call reservations, planner + worker accounting, and the shared turn ceiling. Unknown prices fail closed. Browser dollars are labeled estimated application cost; Azure quota/Cost Management remains the billing backstop.
- Any machinery change must update this file, `src/hosted-agent/README.md`, the relevant `src/hosted-agent/skills/` document, and architecture documentation in the same change.
