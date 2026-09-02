import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeDelegation, type DelegationArtifactStager } from "../src/hosted-agent/delegate-executor.js";
import type { LlmResult } from "../src/hosted-agent/foundry.js";
import type { DelegateAction } from "../src/hosted-agent/orchestrator-protocol.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "azure-foundry-delegations-"));
process.env["WORKSPACE_ROOT"] = root;

const fixtureContent = "month,value\n2026-05,42\n";
const stager: DelegationArtifactStager = async (artifactIds, workspace) => {
  return artifactIds.map((artifactId) => {
    const relative = `inputs/${artifactId}.csv`;
    const full = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, fixtureContent);
    return { artifactId, path: relative, bytes: Buffer.byteLength(fixtureContent), title: "Selected input", mimeType: "text/csv" };
  });
};

function scriptedCaller(outputPath: string, outputContent: string) {
  let callNumber = 0;
  return async (): Promise<LlmResult> => {
    callNumber++;
    if (callNumber === 1) {
      return {
        text: "",
        usage: { input: 10, output: 5 },
        functionCalls: [
          { callId: "read-1", name: "read_file", args: { path: "inputs/panel.csv" } },
          { callId: "write-1", name: "write_file", args: { path: outputPath, content: outputContent } },
        ],
        rawOutput: [
          { type: "function_call", call_id: "read-1", name: "read_file", arguments: '{"path":"inputs/panel.csv"}' },
          { type: "function_call", call_id: "write-1", name: "write_file", arguments: JSON.stringify({ path: outputPath, content: outputContent }) },
        ],
      };
    }
    return {
      text: "",
      usage: { input: 8, output: 3 },
      functionCalls: [{ callId: "finish-1", name: "finish", args: { output: `wrote ${outputPath}` } }],
      rawOutput: [{ type: "function_call", call_id: "finish-1", name: "finish", arguments: JSON.stringify({ output: `wrote ${outputPath}` }) }],
    };
  };
}

const actionA: DelegateAction = {
  type: "delegate",
  callId: "call-a",
  agent: "reader",
  task: "Read the selected input and write a concise note.",
  deployment: "gpt-4.1-mini",
  inputArtifactIds: ["panel"],
};
const resultA = await executeDelegation("run-1", actionA, "admin", {
  stageArtifacts: stager,
  modelCaller: scriptedCaller("outputs/result.md", "result from A"),
});
assert.equal(resultA.status, "succeeded");
assert.equal(resultA.inputArtifacts.length, 1);
assert.equal(resultA.inputArtifacts[0]?.artifactId, "panel");
assert.equal(resultA.artifacts.length, 1);
assert.equal(resultA.artifacts[0]?.path, "outputs/result.md");
assert.equal(resultA.artifacts.some((artifact) => artifact.path.includes("inputs/panel.csv")), false);
assert.equal(fs.readFileSync(path.join(root, resultA.workspaceId, "outputs/result.md"), "utf8"), "result from A");

const actionB: DelegateAction = { ...actionA, callId: "call-b" };
const resultB = await executeDelegation("run-1", actionB, "admin", {
  stageArtifacts: stager,
  modelCaller: scriptedCaller("outputs/result.md", "result from B"),
});
assert.equal(resultB.status, "succeeded");
assert.notEqual(resultA.workspaceId, resultB.workspaceId);
assert.notEqual(resultA.artifacts[0]?.id, resultB.artifacts[0]?.id);
assert.equal(fs.readFileSync(path.join(root, resultA.workspaceId, "outputs/result.md"), "utf8"), "result from A");
assert.equal(fs.readFileSync(path.join(root, resultB.workspaceId, "outputs/result.md"), "utf8"), "result from B");

let modelCalled = false;
const failedStage = await executeDelegation("run-1", { ...actionA, callId: "call-c", inputArtifactIds: ["missing"] }, "admin", {
  stageArtifacts: async () => [],
  modelCaller: async () => {
    modelCalled = true;
    throw new Error("must not be called");
  },
});
assert.equal(failedStage.status, "failed");
assert.equal(modelCalled, false);
assert.match(failedStage.error ?? "", /artifact staging mismatch/);

fs.rmSync(root, { recursive: true, force: true });
console.log("PASS delegate executor: selected inputs, isolated workspaces, output artifacts, and staging failure");
