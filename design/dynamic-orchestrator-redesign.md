# Dynamic orchestrator redesign

This redesign replaces the linear `emit_plan → sequential role steps` control
model with an orchestrator model tool loop. The model—not a hard-coded ADL
workflow—decides which specialist agents to invoke, what can run concurrently,
what results require revision, and when the user's request is complete.

The runtime remains deterministic only at infrastructure boundaries: action
validation, concurrency limits, workspace isolation, artifact identity,
persistence verification, security, and browser event delivery.

## Logical implementation steps

1. **Action protocol (current step).** Define `delegate` and `finish` tools plus
   all-or-nothing validation of an orchestrator response. One response may
   contain multiple independent delegate calls. No execution behavior changes
   yet.
2. **Sub-agent executor.** Execute one validated delegation in an isolated
   workspace and return a summary plus artifact references.
3. **Concurrent orchestration loop.** Replace `emit_plan` with iterative
   orchestrator Responses calls; execute same-response delegates concurrently
   with bounded per-deployment concurrency; return results to the orchestrator.
4. **Artifact handoff.** Register sub-agent outputs as pending artifacts and
   stage selected artifact IDs for later delegations without pasting large file
   contents into model context.
5. **Durable run state and reconnect.** Journal orchestrator rounds,
   delegations, results, artifacts, and event sequence numbers so a browser can
   reconnect without resubmitting work.
6. **Verified save/catalog lifecycle.** Preserve the template behavior:
   explicit user save → verified DB IDs; requested taxonomy → catalog update;
   Documents refresh immediately. Persistence success never comes from model
   prose.
7. **UI and acceptance validation.** Display concurrent agents and individual
   artifacts, then validate end-to-end behavior against representative prompts
   including—but not hard-coded to—the ADL nowcast.

## Step 1 contract

`src/hosted-agent/orchestrator-protocol.ts` defines:

- `delegate(agent, task, deployment, inputArtifactIds[])`
- `finish(response)`
- typed actions produced from Foundry function calls
- catalogue validation for real agents and worker deployments
- non-empty task/response validation
- de-duplication of input artifact IDs
- rejection of unknown actions
- rejection of delegate and finish in the same response
- all-or-nothing batch validation

Step 1 deliberately does **not** modify the live orchestrator, planner,
execution order, workspace layout, WebSocket events, persistence, or deployed
ACA/SWA revisions. Those changes begin only after this protocol is reviewed.
