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
2. **Sub-agent executor (current step).** Execute one validated delegation in
   an isolated workspace and return a summary plus artifact references.
3. **Concurrent orchestration loop (current step).** Add iterative orchestrator
   Responses calls; execute same-response delegates concurrently with bounded
   global/per-deployment concurrency; return results to the orchestrator. It
   remains dormant until the live-switch step is explicitly reviewed.
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

## Step 3 contract

`src/hosted-agent/dynamic-orchestrator.ts` implements the dormant dynamic model
loop:

- the Foundry orchestrator model receives only `delegate` and `finish` tools;
- it authors every specialist task dynamically from the user request and prior
  delegation evidence;
- multiple delegate calls emitted in one response execute concurrently;
- neutral semaphores bound global and per-deployment concurrency but do not
  prescribe workflow shape;
- `Promise.allSettled` preserves successful sibling results when one fails;
- specialist summaries and artifact references return to the next model round
  as correlated `function_call_output` items;
- the model may delegate again after inspecting results or issue `finish` in a
  later response;
- invalid action batches execute no specialists;
- repeated call IDs, excessive delegates per round, and non-terminating rounds
  fail safely;
- events expose orchestrator rounds plus delegation start/end activity.

Step 3 does not replace the live `orchestrator.ts` entry point or deploy an ACA
revision. The old planner/sequential runtime stays active until a later switch
is reviewed.

## Step 2 contract

`src/hosted-agent/delegate-executor.ts` executes one already validated
`DelegateAction`. It deliberately has no orchestration-round or concurrency
logic; Step 3 will decide which actions run together.

For each delegation it:

- derives an isolated workspace from `runId + delegate callId`;
- resolves the requested specialist role and real deployment;
- stages only explicitly selected artifact IDs through an injected stager;
- rejects missing, unexpected, duplicate, or outside-workspace staged inputs;
- runs the existing role tool loop inside that isolated workspace;
- fingerprints files before and after execution;
- returns only new/changed output files as typed pending artifact references;
- attaches run, call, agent, and workspace provenance to every artifact;
- returns structured failure state and any partial outputs when staging or the
  specialist run fails.

The artifact stager is dependency-injected in Step 2. Step 4 will connect it to
the pending artifact registry and catalog. Input file contents never enter the
orchestrator context.

Step 2 remains dormant: the live planner/sequential orchestrator does not call
`executeDelegation` yet.

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
