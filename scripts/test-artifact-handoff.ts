import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeDelegation } from "../src/hosted-agent/delegate-executor.js";
import { runDynamicOrchestrator, type DelegationRunner } from "../src/hosted-agent/dynamic-orchestrator.js";
import type { CallOpts, LlmResult } from "../src/hosted-agent/foundry.js";
import type { Role } from "../src/hosted-agent/imports.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "azure-foundry-handoff-"));
process.env["WORKSPACE_ROOT"] = root;

const roles: Role[] = [
  { name: "reader", description: "Produces a source file", defaultDeployment: "gpt-4.1-mini", toolNames: ["write_file"], instructions: "Write the requested file, then finish." },
  { name: "writer", description: "Consumes a selected artifact", defaultDeployment: "gpt-4.1-mini", toolNames: ["read_file", "write_file"], instructions: "Read only the selected input, write the requested output, then finish." },
];

function response(functionCalls: LlmResult["functionCalls"], rawOutput: unknown[]): LlmResult {
  return { functionCalls, rawOutput, usage: { input: 5, output: 3 }, text: "" };
}

let orchestratorRound = 0;
let producedPendingId = "";
const modelCaller = async (options: CallOpts): Promise<LlmResult> => {
  orchestratorRound++;
  if (orchestratorRound === 1) {
    return response([
      { callId: "produce", name: "delegate", args: { agent: "reader", task: "Create outputs/source.md containing source evidence.", deployment: "gpt-4.1-mini", inputArtifactIds: [] } },
    ], [{ type: "function_call", call_id: "produce", name: "delegate", arguments: "{}" }]);
  }
  if (orchestratorRound === 2) {
    const outputs = options.input.filter((item) => (item as { type?: string }).type === "function_call_output") as Array<{ output: string }>;
    const producer = JSON.parse(outputs.at(-1)!.output) as { artifacts: Array<{ id: string }> };
    producedPendingId = producer.artifacts[0].id;
    return response([
      { callId: "consume", name: "delegate", args: { agent: "writer", task: "Read the selected source artifact and create outputs/summary.md.", deployment: "gpt-4.1-mini", inputArtifactIds: [producedPendingId] } },
    ], [{ type: "function_call", call_id: "consume", name: "delegate", arguments: "{}" }]);
  }
  return response([
    { callId: "finish", name: "finish", args: { response: "Artifact handoff complete." } },
  ], [{ type: "function_call", call_id: "finish", name: "finish", arguments: "{}" }]);
};

const roleCalls = new Map<string, number>();
const specialistModelCaller = async (options: CallOpts): Promise<LlmResult> => {
  const task = String((options.input[0] as { content?: string })?.content ?? "");
  const key = task.includes("Create outputs/source.md") ? "produce" : "consume";
  const count = (roleCalls.get(key) ?? 0) + 1;
  roleCalls.set(key, count);
  if (key === "produce" && count === 1) {
    return response([
      { callId: "write-source", name: "write_file", args: { path: "outputs/source.md", content: "verified source evidence" } },
    ], [{ type: "function_call", call_id: "write-source", name: "write_file", arguments: "{}" }]);
  }
  if (key === "consume" && count === 1) {
    const match = task.match(/- (pending-[^:]+): ([^ ]+)/);
    assert.ok(match, "consumer receives staged input manifest with pending id and local path");
    assert.equal(match[1], producedPendingId);
    const stagedPath = match[2];
    return response([
      { callId: "read-source", name: "read_file", args: { path: stagedPath } },
      { callId: "write-summary", name: "write_file", args: { path: "outputs/summary.md", content: `summary from ${producedPendingId}` } },
    ], [
      { type: "function_call", call_id: "read-source", name: "read_file", arguments: "{}" },
      { type: "function_call", call_id: "write-summary", name: "write_file", arguments: "{}" },
    ]);
  }
  return response([
    { callId: `finish-${key}`, name: "finish", args: { output: `${key} complete` } },
  ], [{ type: "function_call", call_id: `finish-${key}`, name: "finish", arguments: "{}" }]);
};

const delegationRunner: DelegationRunner = (runId, action, userId, stageArtifacts) =>
  executeDelegation(runId, action, userId, {
    stageArtifacts,
    resolveRole: (name) => roles.find((role) => role.name === name),
    modelCaller: specialistModelCaller,
  });

const run = await runDynamicOrchestrator("Create evidence, then summarize it.", {
  runId: "handoff-run",
  userId: "admin",
  orchestratorDeployment: "gpt-4.1-mini",
}, {
  roles,
  workerDeployments: ["gpt-4.1-mini"],
  modelCaller,
  delegationRunner,
});

assert.equal(run.ok, true);
assert.equal(run.response, "Artifact handoff complete.");
assert.equal(run.delegations.length, 2);
assert.equal(run.pendingArtifacts.length, 2);
const producer = run.delegations.find((item) => item.callId === "produce")!;
const consumer = run.delegations.find((item) => item.callId === "consume")!;
assert.notEqual(producer.workspaceId, consumer.workspaceId);
assert.equal(consumer.inputArtifacts[0]?.artifactId, producedPendingId);
assert.equal(consumer.inputArtifacts[0]?.path.startsWith(`inputs/${producedPendingId}/`), true);
assert.equal(fs.readFileSync(path.join(root, consumer.workspaceId, consumer.inputArtifacts[0]!.path), "utf8"), "verified source evidence");
assert.equal(consumer.artifacts.some((artifact) => artifact.path === "outputs/summary.md"), true);

// A different run cannot resolve this run's pending ID even though the source
// file still exists under the common WORKSPACE_ROOT.
let crossRunRound = 0;
const crossRun = await runDynamicOrchestrator("Try to consume a foreign pending artifact.", {
  runId: "other-run",
  userId: "admin",
  orchestratorDeployment: "gpt-4.1-mini",
  maxRounds: 2,
}, {
  roles,
  workerDeployments: ["gpt-4.1-mini"],
  modelCaller: async () => {
    crossRunRound++;
    if (crossRunRound === 1) {
      return response([
        { callId: "foreign", name: "delegate", args: { agent: "writer", task: "Read selected input.", deployment: "gpt-4.1-mini", inputArtifactIds: [producedPendingId] } },
      ], [{ type: "function_call", call_id: "foreign", name: "delegate", arguments: "{}" }]);
    }
    return response([
      { callId: "done", name: "finish", args: { response: "Foreign input was unavailable." } },
    ], [{ type: "function_call", call_id: "done", name: "finish", arguments: "{}" }]);
  },
  delegationRunner,
});
assert.equal(crossRun.ok, true);
assert.equal(crossRun.delegations[0]?.status, "failed");
assert.match(crossRun.delegations[0]?.error ?? "", /not registered for run 'other-run'/);
assert.equal(crossRun.pendingArtifacts.length, 0);

fs.rmSync(root, { recursive: true, force: true });
console.log("PASS artifact handoff: pending ID registered, resolved, integrity-checked, and staged across isolated workspaces");
