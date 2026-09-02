import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  DelegationArtifactRef,
  DelegationArtifactStager,
  StagedDelegationInput,
} from "./delegate-executor.js";
import { workspaceRoot } from "./toolbox.js";

export interface PendingArtifactRecord {
  id: string;
  runId: string;
  callId: string;
  agent: string;
  workspaceId: string;
  sourcePath: string;
  title: string;
  kind: DelegationArtifactRef["kind"];
  mimeType: string;
  bytes: number;
  sha256: string;
  createdAt: string;
  state: "pending";
}

interface RegistryManifest {
  schemaVersion: 1;
  runId: string;
  artifacts: PendingArtifactRecord[];
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "unknown";
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function resolveInside(root: string, relative: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`)
    ? resolved
    : null;
}

function fileHash(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}

function atomicCopy(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  fs.copyFileSync(source, temporary);
  fs.renameSync(temporary, destination);
}

/**
 * Run-scoped registry for intermediate artifacts.
 *
 * Records point to delegation files under /root/workspace (or WORKSPACE_ROOT).
 * They are not artifacts.db rows and are not catalog-visible. Step 5 will make
 * run state durable beyond the current container-local workspace lifecycle.
 */
export class PendingArtifactRegistry {
  readonly runId: string;
  readonly registryWorkspaceId: string;
  readonly manifestPath: string;
  private readonly records = new Map<string, PendingArtifactRecord>();

  constructor(runId: string) {
    if (!runId.trim()) throw new Error("pending artifact registry requires a run id");
    this.runId = runId;
    this.registryWorkspaceId = `${safeId(runId)}--pending-registry`;
    this.manifestPath = path.join(workspaceRoot(this.registryWorkspaceId), "pending-artifacts.json");
    this.load();
  }

  has(artifactId: string): boolean {
    return this.records.has(artifactId);
  }

  get(artifactId: string): PendingArtifactRecord | undefined {
    const record = this.records.get(artifactId);
    return record ? { ...record } : undefined;
  }

  list(): PendingArtifactRecord[] {
    return [...this.records.values()]
      .map((record) => ({ ...record }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  register(artifacts: readonly DelegationArtifactRef[]): PendingArtifactRecord[] {
    const registered: PendingArtifactRecord[] = [];
    for (const artifact of artifacts) {
      if (artifact.runId !== this.runId) {
        throw new Error(`artifact '${artifact.id}' belongs to run '${artifact.runId}', not '${this.runId}'`);
      }
      if (!artifact.id.startsWith("pending-") || !artifact.id.trim()) {
        throw new Error(`artifact has invalid pending id '${artifact.id}'`);
      }
      const relative = normalizeRelative(artifact.path);
      if (!relative || path.isAbsolute(relative)) {
        throw new Error(`artifact '${artifact.id}' has invalid source path '${artifact.path}'`);
      }
      const sourceRoot = workspaceRoot(artifact.workspaceId);
      const source = resolveInside(sourceRoot, relative);
      if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
        throw new Error(`artifact '${artifact.id}' source is not a regular file inside its delegation workspace`);
      }
      const stat = fs.statSync(source);
      const sha256 = fileHash(source);
      if (stat.size !== artifact.bytes) {
        throw new Error(`artifact '${artifact.id}' size mismatch: reference=${artifact.bytes}, source=${stat.size}`);
      }
      if (sha256 !== artifact.sha256) {
        throw new Error(`artifact '${artifact.id}' hash mismatch during registration`);
      }

      const record: PendingArtifactRecord = {
        id: artifact.id,
        runId: artifact.runId,
        callId: artifact.callId,
        agent: artifact.agent,
        workspaceId: artifact.workspaceId,
        sourcePath: relative,
        title: path.basename(relative),
        kind: artifact.kind,
        mimeType: artifact.mimeType,
        bytes: artifact.bytes,
        sha256,
        createdAt: new Date().toISOString(),
        state: "pending",
      };
      const existing = this.records.get(record.id);
      if (existing) {
        const immutableFieldsMatch = existing.runId === record.runId &&
          existing.callId === record.callId &&
          existing.agent === record.agent &&
          existing.workspaceId === record.workspaceId &&
          existing.sourcePath === record.sourcePath &&
          existing.mimeType === record.mimeType &&
          existing.bytes === record.bytes &&
          existing.sha256 === record.sha256;
        if (!immutableFieldsMatch) {
          throw new Error(`pending artifact id collision for '${record.id}'`);
        }
        registered.push({ ...existing });
        continue;
      }
      this.records.set(record.id, record);
      registered.push({ ...record });
    }
    if (registered.length > 0) this.persist();
    return registered;
  }

  /** Copy selected pending artifacts into one downstream delegation workspace. */
  readonly stageArtifacts: DelegationArtifactStager = async (
    artifactIds: readonly string[],
    destinationWorkspace: string,
  ): Promise<StagedDelegationInput[]> => {
    const uniqueIds = [...new Set(artifactIds)];
    if (uniqueIds.length !== artifactIds.length) {
      throw new Error("pending artifact staging request contains duplicate ids");
    }
    const destinationRoot = path.resolve(destinationWorkspace);
    fs.mkdirSync(destinationRoot, { recursive: true });

    return uniqueIds.map((artifactId) => {
      const record = this.records.get(artifactId);
      if (!record) throw new Error(`pending artifact '${artifactId}' is not registered for run '${this.runId}'`);
      const sourceRoot = workspaceRoot(record.workspaceId);
      const source = resolveInside(sourceRoot, record.sourcePath);
      if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
        throw new Error(`pending artifact '${artifactId}' source file is unavailable`);
      }
      const stat = fs.statSync(source);
      const sha256 = fileHash(source);
      if (stat.size !== record.bytes || sha256 !== record.sha256) {
        throw new Error(`pending artifact '${artifactId}' failed integrity verification before staging`);
      }

      const relativeDestination = path.posix.join(
        "inputs",
        safeId(artifactId),
        path.basename(record.sourcePath),
      );
      const destination = resolveInside(destinationRoot, relativeDestination);
      if (!destination) throw new Error(`pending artifact '${artifactId}' destination escapes delegation workspace`);
      atomicCopy(source, destination);
      if (fs.statSync(destination).size !== record.bytes || fileHash(destination) !== record.sha256) {
        throw new Error(`pending artifact '${artifactId}' failed integrity verification after staging`);
      }
      return {
        artifactId,
        path: relativeDestination,
        bytes: record.bytes,
        title: record.title,
        mimeType: record.mimeType,
      };
    });
  };

  private load(): void {
    if (!fs.existsSync(this.manifestPath)) return;
    const parsed = JSON.parse(fs.readFileSync(this.manifestPath, "utf8")) as RegistryManifest;
    if (parsed.schemaVersion !== 1 || parsed.runId !== this.runId || !Array.isArray(parsed.artifacts)) {
      throw new Error(`invalid pending artifact manifest for run '${this.runId}'`);
    }
    for (const record of parsed.artifacts) {
      if (record.runId !== this.runId || !record.id?.startsWith("pending-")) {
        throw new Error(`invalid pending artifact record '${record.id ?? "unknown"}'`);
      }
      if (this.records.has(record.id)) throw new Error(`duplicate pending artifact id '${record.id}' in manifest`);
      this.records.set(record.id, record);
    }
  }

  private persist(): void {
    const manifest: RegistryManifest = {
      schemaVersion: 1,
      runId: this.runId,
      artifacts: this.list(),
    };
    atomicWriteJson(this.manifestPath, manifest);
  }
}
