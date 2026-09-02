import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DelegationArtifactRef } from "../src/hosted-agent/delegate-executor.js";
import { PendingArtifactRegistry } from "../src/hosted-agent/pending-artifact-registry.js";
import { workspaceRoot } from "../src/hosted-agent/toolbox.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "azure-foundry-pending-registry-"));
process.env["WORKSPACE_ROOT"] = root;

function hash(content: Buffer | string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

const runId = "run-registry-test";
const sourceWorkspaceId = `${runId}--delegate-stats-1`;
const sourceWorkspace = workspaceRoot(sourceWorkspaceId);
const sourceRelative = "outputs/backtest.csv";
const sourcePath = path.join(sourceWorkspace, sourceRelative);
const content = "origin,actual,prediction\n2015-01,0.1,0.09\n";
fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
fs.writeFileSync(sourcePath, content);

const artifact: DelegationArtifactRef = {
  id: "pending-test-artifact",
  runId,
  callId: "stats-1",
  agent: "statistician",
  workspaceId: sourceWorkspaceId,
  path: sourceRelative,
  kind: "data",
  bytes: Buffer.byteLength(content),
  mimeType: "text/csv",
  sha256: hash(content),
};

const registry = new PendingArtifactRegistry(runId);
const registered = registry.register([artifact]);
assert.equal(registered.length, 1);
assert.equal(registry.has(artifact.id), true);
assert.equal(registry.get(artifact.id)?.sha256, artifact.sha256);
assert.equal(registry.list().length, 1);
assert.equal(fs.existsSync(registry.manifestPath), true);

// Idempotent re-registration of the exact same immutable artifact.
assert.equal(registry.register([artifact]).length, 1);
assert.equal(registry.list().length, 1);

// The manifest can be reloaded by a new registry instance in a later round.
const reloaded = new PendingArtifactRegistry(runId);
assert.equal(reloaded.list().length, 1);
assert.equal(reloaded.get(artifact.id)?.sourcePath, sourceRelative);

const destination = workspaceRoot(`${runId}--delegate-coder-1`);
const staged = await reloaded.stageArtifacts([artifact.id], destination);
assert.equal(staged.length, 1);
assert.equal(staged[0]?.artifactId, artifact.id);
assert.equal(staged[0]?.mimeType, "text/csv");
assert.equal(fs.readFileSync(path.join(destination, staged[0]!.path), "utf8"), content);
assert.equal(staged[0]?.path.startsWith(`inputs/${artifact.id}/`), true);

await assert.rejects(
  () => reloaded.stageArtifacts(["pending-unknown"], destination),
  /is not registered for run/,
);
await assert.rejects(
  () => reloaded.stageArtifacts([artifact.id, artifact.id], destination),
  /duplicate ids/,
);
assert.throws(
  () => registry.register([{ ...artifact, runId: "another-run" }]),
  /belongs to run/,
);
assert.throws(
  () => registry.register([{ ...artifact, id: "pending-escape", path: "../../outside.csv" }]),
  /source is not a regular file inside|invalid source path/,
);

// Source mutation after registration is detected before copying downstream.
fs.appendFileSync(sourcePath, "2015-02,0.2,0.18\n");
await assert.rejects(
  () => reloaded.stageArtifacts([artifact.id], workspaceRoot(`${runId}--delegate-coder-2`)),
  /failed integrity verification before staging/,
);

fs.rmSync(root, { recursive: true, force: true });
console.log("PASS pending artifact registry: registration, reload, staging, run isolation, paths, and integrity");
