import assert from "node:assert/strict";
import {
  ORCHESTRATOR_TOOLS,
  validateOrchestratorCalls,
} from "../src/hosted-agent/orchestrator-protocol.js";
import type { FunctionCall } from "../src/hosted-agent/foundry.js";

const catalogue = {
  agentNames: ["reader", "statistician", "coder", "operator"],
  workerDeployments: ["gpt-4.1", "gpt-4.1-mini"],
};

function call(callId: string, name: string, args: Record<string, unknown>): FunctionCall {
  return { callId, name, args };
}

assert.deepEqual(ORCHESTRATOR_TOOLS.map((tool) => tool.name), ["delegate", "finish"]);

const parallel = validateOrchestratorCalls([
  call("d1", "delegate", {
    agent: "statistician",
    task: "Fit and evaluate one statistical model.",
    deployment: "gpt-4.1",
    inputArtifactIds: ["panel-1", "panel-1"],
  }),
  call("d2", "delegate", {
    agent: "coder",
    task: "Create an independent chart from the supplied feed.",
    deployment: "gpt-4.1",
    inputArtifactIds: ["feed-1"],
  }),
], catalogue);
assert.equal(parallel.ok, true);
assert.equal(parallel.actions.length, 2);
assert.equal(parallel.actions.every((action) => action.type === "delegate"), true);
assert.deepEqual(parallel.actions[0]?.type === "delegate" ? parallel.actions[0].inputArtifactIds : [], ["panel-1"]);

const finish = validateOrchestratorCalls([
  call("f1", "finish", { response: "The requested work is complete." }),
], catalogue);
assert.equal(finish.ok, true);
assert.deepEqual(finish.actions, [{ type: "finish", callId: "f1", response: "The requested work is complete." }]);

const mixed = validateOrchestratorCalls([
  call("d1", "delegate", {
    agent: "reader", task: "Inspect an artifact.", deployment: "gpt-4.1-mini", inputArtifactIds: [],
  }),
  call("f1", "finish", { response: "Done." }),
], catalogue);
assert.equal(mixed.ok, false);
assert.deepEqual(mixed.actions, []);
assert.equal(mixed.errors.some((error) => error.includes("cannot delegate and finish")), true);

const invalidBatch = validateOrchestratorCalls([
  call("d1", "delegate", {
    agent: "statistician", task: "Valid task.", deployment: "gpt-4.1", inputArtifactIds: [],
  }),
  call("d2", "delegate", {
    agent: "invented-agent", task: "Invalid task.", deployment: "gpt-4.1", inputArtifactIds: [],
  }),
], catalogue);
assert.equal(invalidBatch.ok, false);
assert.deepEqual(invalidBatch.actions, []);
assert.equal(invalidBatch.errors.some((error) => error.includes("unknown agent")), true);

const invalidDeployment = validateOrchestratorCalls([
  call("d1", "delegate", {
    agent: "coder", task: "Create a chart.", deployment: "not-deployed", inputArtifactIds: [],
  }),
], catalogue);
assert.equal(invalidDeployment.ok, false);
assert.deepEqual(invalidDeployment.actions, []);
assert.equal(invalidDeployment.errors.some((error) => error.includes("non-worker deployment")), true);

console.log("PASS orchestrator protocol: parallel delegates, finish, and all-or-nothing validation");
