# AGENTS.md

This project was built with the microsoft-foundry skill. Before working on or answering questions about Foundry agents, read the microsoft-foundry skill first.

## Architecture invariants

- `src/hosted-agent/agents/*.md` define the deployed application's stable role behavior and tool grants.
- `src/hosted-agent/skills/*/SKILL.md` define the deployed application's behavioral methods. Skills are read and interpreted by agents; do not replace them with deterministic statistical pipelines.
- These runtime catalogs are application-owned resources. They are not pi-harness paths and are not automatically discovered or executed by Microsoft Foundry.
- For indicator-panel statistics, the statistician calls the generic `execute_python` tool with `stage_indicator_panel`. The runtime stages raw observations into the conversation workspace before Python starts. Raw observations are not placed in LLM context.
- Workspace tools treat paths as typed capabilities: read/upload/render inputs accept regular files only, and write/staging targets cannot be directories. Directory paths return a structured `not_file` result (use `list_files` for inspection) and must never escape dispatch as filesystem exceptions such as `EISDIR`.
- The interactive browser turn is synchronous over the ACA WebSocket gateway (`/ws/agent`). Do not replace it with a job/polling workflow or route long turns through an SWA managed Function. The gateway sends ping + JSON heartbeat frames, and Python execution must remain asynchronous so CPU-heavy child work never blocks those heartbeats. The browser may retry a failed handshake only before it receives `ready` and sends the prompt; never retry after prompt submission because that could duplicate a costly run.
- Orchestration is iterative: discovery plans set `continuePlanning=true`; their outputs return to the planner before downstream roles are selected.
- Flow-1 interactive tools are a toolbox, not the flow-2 refresh airlock.
- Foundational leading-indicator access, staged JSON parsing, cutoff filtering, and common transforms are defined in `src/hosted-agent/skills/leading-indicator-panel/SKILL.md`; modeling skills build on that contract. The ADL skill requires validating all 13 long-form series and explicitly pivoting `series_id` into columns before any column-based transformation or feature construction.
- There is no application cost/budget-ceiling module. Worker loops retain fixed safety bounds only. Scientific Python uses ACA cgroup memory, configurable CPU/wall limits, and asynchronous child-process execution.
- Workspaces are per conversation. The browser persists its active conversation id across reloads; a new conversation may recover an explicitly named prior-run file only through `import_run_file`, with same-user/admin authorization. Terminal collection uploads pending files to artifact-service storage without catalog publication, and failures return partial results rather than stranding completed files.
- Any machinery change must update this file, `src/hosted-agent/README.md`, the relevant `src/hosted-agent/skills/` document, and architecture documentation in the same change.
