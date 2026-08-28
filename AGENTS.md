# AGENTS.md

This project was built with the microsoft-foundry skill. Before working on or answering questions about Foundry agents, read the microsoft-foundry skill first.

## Architecture invariants

- `src/hosted-agent/agents/*.md` define the deployed application's stable role behavior and tool grants.
- `src/hosted-agent/skills/*/SKILL.md` define the deployed application's behavioral methods. Skills are read and interpreted by agents; do not replace them with deterministic statistical pipelines.
- These runtime catalogs are application-owned resources. They are not pi-harness paths and are not automatically discovered or executed by Microsoft Foundry.
- For indicator-panel statistics, the statistician calls the generic `execute_python` tool with `stage_indicator_panel`. The runtime stages raw observations into the conversation workspace before Python starts. Raw observations are not placed in LLM context.
- The interactive browser turn is synchronous over the ACA WebSocket gateway (`/ws/agent`). Do not replace it with a job/polling workflow or route long turns through an SWA managed Function.
- Orchestration is iterative: discovery plans set `continuePlanning=true`; their outputs return to the planner before downstream roles are selected.
- Flow-1 interactive tools are a toolbox, not the flow-2 refresh airlock.
- Foundational leading-indicator access, staged JSON parsing, cutoff filtering, and common transforms are defined in `src/hosted-agent/skills/leading-indicator-panel/SKILL.md`; modeling skills build on that contract.
- Any machinery change must update this file, `src/hosted-agent/README.md`, the relevant `src/hosted-agent/skills/` document, and architecture documentation in the same change.
