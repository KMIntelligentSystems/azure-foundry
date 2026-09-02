import assert from "node:assert/strict";
import {
  executeDelegationBatch,
  runDynamicOrchestrator,
  type DelegationRunner,
} from "../src/hosted-agent/dynamic-orchestrator.js";
import type { DelegationResult } from "../src/hosted-agent/delegate-executor.js";
import type { CallOpts, LlmResult } from "../src/hosted-agent/foundry.js";
import type { Role } from "../src/hosted-agent/imports.js";
import type { DelegateAction } from "../src/hosted-agent/orchestrator-protocol.js";

const roles: Role[] = [
  { name: "statistician", description: "Applied statistics", defaultDeployment: "gpt-4.1", toolNames: [], instructions: "stats" },
  { name: "coder", description: "Chart coding", defaultDeployment: "gpt-4.1", toolNames: [], instructions: "code" },
  { name: "writer", description: "Narrative writing", defaultDeployment: "gpt-4.1-mini", toolNames: [], instructions: "write" },
];

function llm(functionCalls: LlmResult["functionCalls"], rawOutput: unknown[], input = 10, output = 5): LlmResult {
  return { functionCalls, rawOutput, usage: { input, output }, text: "" };
}

function delegate(callId: string, agent: string, task: string, deployment = "gpt-4.1", inputArtifactIds: string[] = []): DelegateAction {
  return { type: "delegate", callId, agent, task, deployment, inputArtifactIds };
}

function result(runId: string, action: DelegateAction): DelegationResult {
  return {
    runId,
    callId: action.callId,
    agent: action.agent,
    deployment: action.deployment,
    task: action.task,
    workspaceId: `${runId}--${action.callId}`,
    status: "succeeded",
    summary: `completed ${action.task}`,
    usage: { input: 4, output: 2 },
    modelCalls: 1,
    toolExecutions: 1,
    inputArtifacts: action.inputArtifactIds.map((artifactId) => ({ artifactId, path: `inputs/${artifactId}`, bytes: 10 })),
    artifacts: [{
      id: `pending-${action.callId}`,
      runId,
      callId: action.callId,
      agent: action.agent,
      workspaceId: `${runId}--${action.callId}`,
      path: `outputs/${action.callId}.json`,
      kind: "data",
      bytes: 20,
      mimeType: "application/json",
    }],
    catalogUpdated: false,
  } as DelegationResult & { catalogUpdated: boolean };
}

// Batch-level proof: same-deployment actions overlap, but never exceed the
// configured per-deployment limit.
let active = 0;
let maxActive = 0;
const batchRunner: DelegationRunner = async (runId, action) => {
  active++;
  maxActive = Math.max(maxActive, active);
  await new Promise((resolve) => setTimeout(resolve, 50));
  active--;
  return result(runId, action);
};
const batchActions = [
  delegate("b1", "statistician", "model one"),
  delegate("b2", "statistician", "model two"),
  delegate("b3", "statistician", "model three"),
  delegate("b4", "statistician", "model four"),
];
const batchResults = await executeDelegationBatch("batch-run", batchActions, {
  globalConcurrency: 4,
  perDeploymentConcurrency: 2,
}, batchRunner);
assert.equal(batchResults.length, 4);
assert.equal(maxActive, 2);
assert.equal(batchResults.every((item) => item.status === "succeeded"), true);

const partialBatch = await executeDelegationBatch("partial-run", batchActions.slice(0, 3), {
  globalConcurrency: 3,
  perDeploymentConcurrency: 2,
}, async (runId, action) => {
  if (action.callId === "b2") throw new Error("specialist failed");
  return result(runId, action);
});
assert.deepEqual(partialBatch.map((item) => item.status), ["succeeded", "failed", "succeeded"]);
assert.match(partialBatch[1]?.error ?? "", /specialist failed/);
assert.equal(partialBatch.filter((item) => item.status === "succeeded").length, 2);

// Full loop proof: two delegates in round 1, returned evidence used to create a
// dependent round-2 delegation, then a separate finish response.
let modelRound = 0;
let roundTwoInput: unknown[] = [];
const modelCaller = async (options: CallOpts): Promise<LlmResult> => {
  modelRound++;
  if (modelRound === 1) {
    assert.equal(options.tools?.map((tool) => tool.name).join(","), "delegate,finish");
    return llm([
      { callId: "d1", name: "delegate", args: { agent: "statistician", task: "fit model A", deployment: "gpt-4.1", inputArtifactIds: [] } },
      { callId: "d2", name: "delegate", args: { agent: "statistician", task: "fit model B", deployment: "gpt-4.1", inputArtifactIds: [] } },
    ], [
      { type: "function_call", call_id: "d1", name: "delegate", arguments: "{}" },
      { type: "function_call", call_id: "d2", name: "delegate", arguments: "{}" },
    ]);
  }
  if (modelRound === 2) {
    roundTwoInput = options.input;
    const outputs = options.input.filter((item) => (item as { type?: string }).type === "function_call_output");
    assert.equal(outputs.length, 2);
    assert.match(JSON.stringify(outputs), /pending-d1/);
    assert.match(JSON.stringify(outputs), /pending-d2/);
    return llm([
      { callId: "d3", name: "delegate", args: { agent: "writer", task: "compare the returned model evidence", deployment: "gpt-4.1-mini", inputArtifactIds: ["pending-d1", "pending-d2"] } },
    ], [{ type: "function_call", call_id: "d3", name: "delegate", arguments: "{}" }]);
  }
  return llm([
    { callId: "f1", name: "finish", args: { response: "Dynamic orchestration completed." } },
  ], [{ type: "function_call", call_id: "f1", name: "finish", arguments: "{}" }]);
};

let loopActive = 0;
let loopMaxActive = 0;
const loopRunner: DelegationRunner = async (runId, action) => {
  loopActive++;
  loopMaxActive = Math.max(loopMaxActive, loopActive);
  await new Promise((resolve) => setTimeout(resolve, 40));
  loopActive--;
  return result(runId, action);
};
const events: string[] = [];
const run = await runDynamicOrchestrator("Analyze this request dynamically.", {
  runId: "dynamic-run",
  userId: "admin",
  globalConcurrency: 3,
  perDeploymentConcurrency: 2,
  eventSink: (event) => { events.push(event.type); },
}, {
  roles,
  workerDeployments: ["gpt-4.1", "gpt-4.1-mini"],
  modelCaller,
  delegationRunner: loopRunner,
});
assert.equal(run.ok, true);
assert.equal(run.response, "Dynamic orchestration completed.");
assert.equal(run.rounds.length, 3);
assert.equal(run.delegations.length, 3);
assert.equal(run.artifacts.length, 3);
assert.equal(loopMaxActive, 2);
assert.equal(modelRound, 3);
assert.equal(roundTwoInput.length > 0, true);
assert.equal(events.filter((event) => event === "delegation_start").length, 3);
assert.equal(events.filter((event) => event === "delegation_end").length, 3);
assert.equal(events.at(-1), "orchestrator_finish");

// Invalid orchestrator output must fail before any specialist is invoked.
let invalidRunnerCalled = false;
const invalid = await runDynamicOrchestrator("Do something.", { runId: "invalid-run" }, {
  roles,
  workerDeployments: ["gpt-4.1", "gpt-4.1-mini"],
  modelCaller: async () => llm([
    { callId: "bad", name: "delegate", args: { agent: "invented", task: "bad", deployment: "gpt-4.1", inputArtifactIds: [] } },
  ], [{ type: "function_call", call_id: "bad", name: "delegate", arguments: "{}" }]),
  delegationRunner: async (runId, action) => {
    invalidRunnerCalled = true;
    return result(runId, action);
  },
});
assert.equal(invalid.ok, false);
assert.equal(invalidRunnerCalled, false);
assert.match(invalid.error ?? "", /invalid orchestrator action batch/);

console.log("PASS dynamic orchestrator: concurrent batches, iterative delegation, evidence return, finish, and invalid-batch abort");
