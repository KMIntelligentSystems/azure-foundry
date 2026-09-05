import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ArtifactRef } from "./artifacts.js";
import { collectArtifacts } from "./artifacts.js";
import { callLlm } from "./foundry.js";
import { getRole, type Role } from "./imports.js";
import type { DelegateAction } from "./orchestrator-protocol.js";
import { runRole, workspaceRoot } from "./toolbox.js";

/** Metadata returned by an artifact stager after copying one selected artifact
 * into the isolated delegation workspace. The content itself never enters the
 * orchestrator model context. */
export interface StagedDelegationInput {
  artifactId: string;
  path: string;
  bytes: number;
  title?: string;
  mimeType?: string;
}

export type DelegationArtifactStager = (
  artifactIds: readonly string[],
  workspace: string,
) => Promise<StagedDelegationInput[]>;

export interface DelegationArtifactRef extends ArtifactRef {
  id: string;
  runId: string;
  callId: string;
  agent: string;
  workspaceId: string;
  sha256: string;
}

export interface DelegationResult {
  runId: string;
  callId: string;
  agent: string;
  deployment: string;
  task: string;
  workspaceId: string;
  status: "succeeded" | "failed";
  summary: string;
  usage: { input: number; output: number };
  modelCalls: number;
  toolExecutions: number;
  catalogUpdated: boolean;
  inputArtifacts: StagedDelegationInput[];
  artifacts: DelegationArtifactRef[];
  error?: string;
}

export interface DelegationExecutorDependencies {
  stageArtifacts?: DelegationArtifactStager;
  resolveRole?: (name: string) => Role | undefined;
  modelCaller?: typeof callLlm;
}

interface FileFingerprint {
  size: number;
  sha256: string;
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "unknown";
}

function delegationWorkspaceId(runId: string, action: DelegateAction): string {
  return `${safeId(runId)}--delegate-${safeId(action.callId)}`;
}

function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const walk = (directory: string): string[] =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(full) : [path.relative(root, full).replace(/\\/g, "/")];
    });
  return walk(root).filter((file) => !path.basename(file).startsWith(".exec-"));
}

function fingerprints(root: string): Map<string, FileFingerprint> {
  const result = new Map<string, FileFingerprint>();
  for (const relative of walkFiles(root)) {
    const full = path.join(root, relative);
    const content = fs.readFileSync(full);
    result.set(relative, {
      size: content.length,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
    });
  }
  return result;
}

function changedFiles(before: Map<string, FileFingerprint>, after: Map<string, FileFingerprint>): Set<string> {
  const changed = new Set<string>();
  for (const [relative, fingerprint] of after) {
    const prior = before.get(relative);
    if (!prior || prior.size !== fingerprint.size || prior.sha256 !== fingerprint.sha256) changed.add(relative);
  }
  return changed;
}

function pendingArtifactId(runId: string, action: DelegateAction, relativePath: string, fingerprint: FileFingerprint): string {
  const identity = `${runId}\n${action.callId}\n${action.agent}\n${relativePath}\n${fingerprint.sha256}`;
  return `pending-${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

function inputManifest(inputs: readonly StagedDelegationInput[]): string {
  if (inputs.length === 0) return "(no input artifacts selected)";
  return [
    "SELECTED INPUT ARTIFACTS (staged in this isolated workspace):",
    ...inputs.map((input) =>
      `- ${input.artifactId}: ${input.path} (${input.bytes} bytes${input.title ? `; ${input.title}` : ""})`,
    ),
    "Read only the files needed for the delegated task. Do not assume access to any parent or sibling workspace.",
  ].join("\n");
}

async function stageSelectedInputs(
  action: DelegateAction,
  workspace: string,
  stageArtifacts?: DelegationArtifactStager,
): Promise<StagedDelegationInput[]> {
  if (action.inputArtifactIds.length === 0) return [];
  if (!stageArtifacts) throw new Error("delegation selected input artifacts but no artifact stager is configured");

  const staged = await stageArtifacts(action.inputArtifactIds, workspace);
  const requested = new Set(action.inputArtifactIds);
  const received = new Set(staged.map((input) => input.artifactId));
  const missing = [...requested].filter((id) => !received.has(id));
  const unexpected = [...received].filter((id) => !requested.has(id));
  if (missing.length || unexpected.length || staged.length !== requested.size) {
    throw new Error(`artifact staging mismatch: missing=[${missing.join(", ")}], unexpected=[${unexpected.join(", ")}]`);
  }

  for (const input of staged) {
    if (!input.path || input.bytes < 0) throw new Error(`artifact '${input.artifactId}' returned invalid staging metadata`);
    const full = path.resolve(workspace, input.path);
    if (!isInside(workspace, full)) throw new Error(`artifact '${input.artifactId}' staged outside delegation workspace`);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      throw new Error(`artifact '${input.artifactId}' was not staged as a regular file at '${input.path}'`);
    }
  }
  return staged;
}

/**
 * Execute one already-validated delegate action.
 *
 * This function intentionally knows nothing about orchestration rounds or
 * concurrency. Step 3 will decide which validated actions run together. Each
 * call here owns a separate workspace derived from runId + delegate callId.
 */
export async function executeDelegation(
  runId: string,
  action: DelegateAction,
  userId?: string,
  dependencies: DelegationExecutorDependencies = {},
): Promise<DelegationResult> {
  const workspaceId = delegationWorkspaceId(runId, action);
  const workspace = workspaceRoot(workspaceId);
  const resolveRole = dependencies.resolveRole ?? getRole;
  const role = resolveRole(action.agent);
  if (!role) throw new Error(`delegated agent '${action.agent}' is not available`);

  let stagedInputs: StagedDelegationInput[] = [];
  let baseline = new Map<string, FileFingerprint>();
  try {
    stagedInputs = await stageSelectedInputs(action, workspace, dependencies.stageArtifacts);
    baseline = fingerprints(workspace);

    const run = await runRole(
      role,
      action.deployment,
      action.task,
      inputManifest(stagedInputs),
      workspaceId,
      { userId },
      1,
      dependencies.modelCaller ?? callLlm,
    );

    const after = fingerprints(workspace);
    const changed = changedFiles(baseline, after);
    const refs = (await collectArtifacts(workspaceId))
      .filter((artifact) => changed.has(artifact.path))
      .map((artifact): DelegationArtifactRef => ({
        ...artifact,
        id: pendingArtifactId(runId, action, artifact.path, after.get(artifact.path)!),
        runId,
        callId: action.callId,
        agent: action.agent,
        workspaceId,
        sha256: after.get(artifact.path)!.sha256,
      }));
    const succeeded = run.terminatedBy !== "limit";
    return {
      runId,
      callId: action.callId,
      agent: action.agent,
      deployment: action.deployment,
      task: action.task,
      workspaceId,
      status: succeeded ? "succeeded" : "failed",
      summary: run.output,
      usage: run.usage,
      modelCalls: run.modelCalls,
      toolExecutions: run.toolExecutions,
      catalogUpdated: run.catalogUpdated,
      inputArtifacts: stagedInputs,
      artifacts: refs,
      ...(!succeeded ? { error: run.output } : {}),
    };
  } catch (error) {
    const after = fingerprints(workspace);
    const changed = changedFiles(baseline, after);
    const refs = (await collectArtifacts(workspaceId))
      .filter((artifact) => changed.has(artifact.path))
      .map((artifact): DelegationArtifactRef => ({
        ...artifact,
        id: pendingArtifactId(runId, action, artifact.path, after.get(artifact.path)!),
        runId,
        callId: action.callId,
        agent: action.agent,
        workspaceId,
        sha256: after.get(artifact.path)!.sha256,
      }));
    const message = error instanceof Error ? error.message : String(error);
    return {
      runId,
      callId: action.callId,
      agent: action.agent,
      deployment: action.deployment,
      task: action.task,
      workspaceId,
      status: "failed",
      summary: message,
      usage: { input: 0, output: 0 },
      modelCalls: 0,
      toolExecutions: 0,
      catalogUpdated: false,
      inputArtifacts: stagedInputs,
      artifacts: refs,
      error: message,
    };
  }
}
