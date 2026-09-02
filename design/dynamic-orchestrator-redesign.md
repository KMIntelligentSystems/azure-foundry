# Dynamic orchestrator redesign

This redesign replaces the linear `emit_plan → sequential role steps` control
model with an orchestrator model tool loop. The model—not a hard-coded ADL
workflow—decides which specialist agents to invoke, what can run concurrently,
what results require revision, and when the user's request is complete.

The runtime remains deterministic only at infrastructure boundaries: action
validation, concurrency limits, workspace isolation, artifact identity,
persistence verification, security, and browser event delivery.

## Logical implementation steps

1. **Action protocol (complete, dormant).** Define `delegate` and `finish`
   tools plus all-or-nothing validation of an orchestrator response. One
   response may contain multiple independent delegate calls.
2. **Sub-agent executor (complete, dormant).** Execute one validated delegation
   in an isolated workspace and return a summary plus artifact references.
3. **Concurrent orchestration loop (complete, dormant).** Add iterative
   orchestrator Responses calls; execute same-response delegates concurrently
   with bounded global/per-deployment concurrency; return results to the
   orchestrator.
4. **Artifact handoff (complete, dormant).** Register sub-agent outputs as
   run-scoped pending artifacts and stage selected artifact IDs for later
   delegations without pasting large file contents into model context.
5. **Durable run state and reconnect (next).** Journal orchestrator rounds,
   delegations, results, pending artifacts, and event sequence numbers so a
   browser can reconnect without resubmitting work.
6. **Verified save/catalog lifecycle.** Preserve the template behavior:
   explicit user save → verified DB IDs; requested taxonomy → catalog update;
   Documents refresh immediately. Persistence success never comes from model
   prose.
7. **UI and acceptance validation.** Display concurrent agents and individual
   artifacts, then validate end-to-end behavior against representative prompts
   including—but not hard-coded to—the ADL nowcast.

## Mapping to the original minimal redesign

- Original item 1, “replace `emit_plan` with an orchestrator tool loop,” is
  represented by Steps 1 and 3, but is not live-switched yet.
- Original item 2, “give the orchestrator delegate, artifact, and persistence
  tools,” begins with Step 1 (`delegate`/`finish`) and Step 4 (artifact-ID
  resolution); persistence remains a later explicit-user-action step.
- Original item 3, “execute simultaneous delegate calls concurrently,” is
  Step 3.
- Original item 4, “run every delegated agent in an isolated context,” is Step
  2.
- Original item 5, “return artifact IDs—not shared-workspace prose—as results,”
  spans Steps 2–4 and is completed by Step 4's registry and staging path.
- Original item 6, “let the orchestrator review and revise dynamically,” is
  Step 3's iterative result-return loop.
- **Original item 7, “persist run/event state so browser reconnection does not
  restart work,” is current redesign Step 5 and is the next implementation
  step.**
- Original item 8 describes cross-cutting deterministic integrity boundaries,
  not a separate workflow stage.

## Step 4 contract

`src/hosted-agent/pending-artifact-registry.ts` supplies the concrete
run-scoped artifact-ID handoff that Steps 2–3 previously accepted only through
an injected interface:

- every produced file reference includes a SHA-256 content hash;
- completed delegation outputs register under their pending artifact IDs before
  the next orchestrator round;
- registry entries bind ID to run, call, agent, workspace, relative path, MIME
  type, size, and hash;
- registration rejects cross-run artifacts, path escapes, missing files, size
  mismatches, hash mismatches, and pending-ID collisions;
- a selected pending ID resolves only within its owning run;
- source integrity is verified before staging and destination integrity after
  staging;
- downstream copies land under `inputs/<pending-id>/<filename>` in the new
  delegation's isolated workspace;
- the orchestrator receives only compact summaries plus pending IDs and file
  metadata—not file contents or sibling workspace paths;
- the registry manifest is atomically stored under the run's workspace-backed
  registry directory.

This registry is still an intermediate execution mechanism, not artifacts.db.
It remains container-local in Step 4; Step 5 will persist the run journal and
pending metadata/file location so reconnect and replica recovery do not restart
completed work.

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
