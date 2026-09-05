import crypto from "node:crypto";
import { executeDelegation, type DelegationArtifactStager, type DelegationResult } from "./delegate-executor.js";
import { ORCHESTRATOR_DEPLOYMENT } from "./deployments.js";
import { callLlm, type CallOpts, type LlmResult } from "./foundry.js";
import { loadRoles, type Role } from "./imports.js";
import { orchestratorInstructions } from "./orchestrator-instructions.js";
import {
  ORCHESTRATOR_TOOLS,
  validateOrchestratorCalls,
  type DelegateAction,
  type FinishAction,
  type OrchestratorAction,
  type ParallelDelegateAction,
} from "./orchestrator-protocol.js";
import { PendingArtifactRegistry, type PendingArtifactRecord } from "./pending-artifact-registry.js";
import { listSkills } from "./skills.js";

export interface DynamicOrchestratorEvent {
  type:
    | "orchestrator_start"
    | "orchestrator_round_start"
    | "orchestrator_actions"
    | "delegation_start"
    | "delegation_end"
    | "orchestrator_finish"
    | "orchestrator_error";
  runId: string;
  round?: number;
  action?: DelegateAction;
  actions?: OrchestratorAction[];
  result?: DelegationResult;
  response?: string;
  error?: string;
}

export type DynamicOrchestratorEventSink = (
  event: DynamicOrchestratorEvent,
) => void | Promise<void>;

export interface DynamicOrchestratorRound {
  round: number;
  actions: OrchestratorAction[];
  delegations: DelegationResult[];
  usage: { input: number; output: number };
}

export interface DynamicOrchestratorResult {
  ok: boolean;
  runId: string;
  response: string;
  rounds: DynamicOrchestratorRound[];
  delegations: DelegationResult[];
  artifacts: DelegationResult["artifacts"];
  pendingArtifacts: PendingArtifactRecord[];
  usage: { input: number; output: number };
  error?: string;
}

export interface DynamicOrchestratorOptions {
  runId?: string;
  userId?: string;
  maxRounds?: number;
  globalConcurrency?: number;
  perDeploymentConcurrency?: number;
  orchestratorDeployment?: string;
  stageArtifacts?: DelegationArtifactStager;
  eventSink?: DynamicOrchestratorEventSink;
}

export type DelegationRunner = (
  runId: string,
  action: DelegateAction,
  userId?: string,
  stageArtifacts?: DelegationArtifactStager,
) => Promise<DelegationResult>;

export interface PendingArtifactRegistryLike {
  register(artifacts: readonly DelegationResult["artifacts"][number][]): PendingArtifactRecord[];
  list(): PendingArtifactRecord[];
  stageArtifacts: DelegationArtifactStager;
}

export interface DynamicOrchestratorDependencies {
  modelCaller?: (options: CallOpts) => Promise<LlmResult>;
  delegationRunner?: DelegationRunner;
  roles?: Role[];
  pendingRegistryFactory?: (runId: string) => PendingArtifactRegistryLike;
  skillCatalogue?: () => Array<{ name: string; description: string }>;
}

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`semaphore capacity must be a positive integer, got ${capacity}`);
    }
  }

  async use<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.capacity) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }
}

const DEFAULT_MAX_ROUNDS = 12;
const DEFAULT_GLOBAL_CONCURRENCY = 3;
const DEFAULT_PER_DEPLOYMENT_CONCURRENCY = 2;
const MAX_SUMMARY_CHARS = 6_000;
const SHARED_GLOBAL_SEMAPHORES = new Map<number, Semaphore>();
const SHARED_DEPLOYMENT_SEMAPHORES = new Map<string, Semaphore>();

function sharedGlobalSemaphore(capacity: number): Semaphore {
  let semaphore = SHARED_GLOBAL_SEMAPHORES.get(capacity);
  if (!semaphore) {
    semaphore = new Semaphore(capacity);
    SHARED_GLOBAL_SEMAPHORES.set(capacity, semaphore);
  }
  return semaphore;
}

function sharedDeploymentSemaphore(deployment: string, capacity: number): Semaphore {
  const key = `${deployment}:${capacity}`;
  let semaphore = SHARED_DEPLOYMENT_SEMAPHORES.get(key);
  if (!semaphore) {
    semaphore = new Semaphore(capacity);
    SHARED_DEPLOYMENT_SEMAPHORES.set(key, semaphore);
  }
  return semaphore;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer, got ${resolved}`);
  }
  return resolved;
}

/** The orchestration manual lives in orchestrator-instructions.ts; this
 * wrapper keeps the historical export name used by callers and tests. */
export function dynamicOrchestratorInstructions(
  roles: readonly Role[],
  skills: readonly { name: string; description: string }[] = [],
): string {
  return orchestratorInstructions(roles, skills);
}

interface ExpandedDelegationBatch {
  delegates: DelegateAction[];
  parallel?: ParallelDelegateAction;
}

function expandDelegations(actions: readonly OrchestratorAction[]): ExpandedDelegationBatch {
  const parallel = actions.find((action): action is ParallelDelegateAction => action.type === "delegate_parallel");
  const scalar = actions.filter((action): action is DelegateAction => action.type === "delegate");
  if (parallel) {
    return {
      parallel,
      delegates: [
        ...parallel.tasks.map((task, index): DelegateAction => ({
          type: "delegate",
          callId: `${parallel.callId}:${index}`,
          agent: task.agent,
          task: task.task,
          deployment: task.deployment,
          inputArtifactIds: task.inputArtifactIds,
        })),
        ...scalar,
      ],
    };
  }
  return { delegates: scalar };
}

function compactDelegationResult(result: DelegationResult): Record<string, unknown> {
  return {
    status: result.status,
    agent: result.agent,
    summary: result.summary.slice(0, MAX_SUMMARY_CHARS),
    error: result.error,
    catalogUpdated: result.catalogUpdated,
    artifacts: result.artifacts.map((artifact) => ({
      id: artifact.id,
      path: artifact.path,
      mimeType: artifact.mimeType,
      kind: artifact.kind,
      bytes: artifact.bytes,
    })),
  };
}

function failedDelegation(runId: string, action: DelegateAction, error: unknown): DelegationResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    runId,
    callId: action.callId,
    agent: action.agent,
    deployment: action.deployment,
    task: action.task,
    workspaceId: "",
    status: "failed",
    summary: message,
    usage: { input: 0, output: 0 },
    modelCalls: 0,
    toolExecutions: 0,
    catalogUpdated: false,
    inputArtifacts: [],
    artifacts: [],
    error: message,
  };
}

async function emit(
  sink: DynamicOrchestratorEventSink | undefined,
  event: DynamicOrchestratorEvent,
): Promise<void> {
  await sink?.(event);
}

async function defaultDelegationRunner(
  runId: string,
  action: DelegateAction,
  userId?: string,
  stageArtifacts?: DelegationArtifactStager,
): Promise<DelegationResult> {
  return executeDelegation(runId, action, userId, { stageArtifacts });
}

/** Execute one same-response delegation batch with bounded concurrency. */
export async function executeDelegationBatch(
  runId: string,
  actions: readonly DelegateAction[],
  options: Pick<DynamicOrchestratorOptions, "userId" | "globalConcurrency" | "perDeploymentConcurrency" | "stageArtifacts" | "eventSink"> = {},
  runner: DelegationRunner = defaultDelegationRunner,
): Promise<DelegationResult[]> {
  const globalLimit = positiveInteger(options.globalConcurrency, DEFAULT_GLOBAL_CONCURRENCY, "globalConcurrency");
  const deploymentLimit = positiveInteger(
    options.perDeploymentConcurrency,
    DEFAULT_PER_DEPLOYMENT_CONCURRENCY,
    "perDeploymentConcurrency",
  );
  const globalSemaphore = sharedGlobalSemaphore(globalLimit);
  const forDeployment = (deployment: string) => sharedDeploymentSemaphore(deployment, deploymentLimit);

  const settled = await Promise.allSettled(actions.map((action) =>
    forDeployment(action.deployment).use(() => globalSemaphore.use(async () => {
      await emit(options.eventSink, { type: "delegation_start", runId, action });
      const result = await runner(runId, action, options.userId, options.stageArtifacts);
      await emit(options.eventSink, { type: "delegation_end", runId, action, result });
      return result;
    })),
  ));

  return settled.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : failedDelegation(runId, actions[index], result.reason),
  );
}

/**
 * Run the dynamic orchestration loop.
 *
 * The model decides everything about decomposition, parallelism contents,
 * corrections, and completion. The runtime is deterministic only at
 * infrastructure boundaries: per-call validation with error feedback,
 * bounded concurrency, workspace isolation, artifact identity, and a
 * maximum round count.
 */
export async function runDynamicOrchestrator(
  userPrompt: string,
  options: DynamicOrchestratorOptions = {},
  dependencies: DynamicOrchestratorDependencies = {},
): Promise<DynamicOrchestratorResult> {
  if (!userPrompt.trim()) throw new Error("user prompt is required");
  const runId = options.runId?.trim() || `run-${crypto.randomUUID()}`;
  const roles = dependencies.roles ?? loadRoles();
  const roleDeployments = new Map(roles.map((role) => [role.name, role.defaultDeployment]));
  const orchestratorDeployment = options.orchestratorDeployment ?? ORCHESTRATOR_DEPLOYMENT;
  const maxRounds = positiveInteger(options.maxRounds, DEFAULT_MAX_ROUNDS, "maxRounds");

  const modelCaller = dependencies.modelCaller ?? callLlm;
  const runner = dependencies.delegationRunner ?? defaultDelegationRunner;
  const registry = dependencies.pendingRegistryFactory?.(runId) ?? new PendingArtifactRegistry(runId);
  const stageArtifacts = options.stageArtifacts ?? registry.stageArtifacts;
  const skills = (() => {
    try {
      return (dependencies.skillCatalogue ?? listSkills)();
    } catch {
      return [];
    }
  })();
  const instructions = orchestratorInstructions(roles, skills);
  const available = registry.list();
  const pendingContext = available.length === 0
    ? ""
    : `\n\nPENDING ARTIFACTS AVAILABLE FROM EARLIER TURNS IN THIS CONVERSATION:\n${available.map((artifact) => `- ${artifact.id}: ${artifact.title} [${artifact.mimeType}, ${artifact.bytes} bytes]`).join("\n")}`;
  const input: unknown[] = [{ role: "user", content: `${userPrompt}${pendingContext}` }];
  const rounds: DynamicOrchestratorRound[] = [];
  const allDelegations: DelegationResult[] = [];
  const usage = { input: 0, output: 0 };

  await emit(options.eventSink, { type: "orchestrator_start", runId });

  try {
    for (let round = 1; round <= maxRounds; round++) {
      await emit(options.eventSink, { type: "orchestrator_round_start", runId, round });
      const response = await modelCaller({
        model: orchestratorDeployment,
        instructions,
        input,
        tools: [...ORCHESTRATOR_TOOLS],
        maxOutputTokens: 4_096,
      });
      usage.input += response.usage.input;
      usage.output += response.usage.output;
      input.push(...response.rawOutput);

      // Model produced no tool calls: nudge once per occurrence and continue.
      if (response.functionCalls.length === 0) {
        input.push({
          role: "user",
          content: "You produced no tool call. Respond with delegate, delegate_parallel, or finish.",
        });
        rounds.push({ round, actions: [], delegations: [], usage: response.usage });
        continue;
      }

      const verdict = validateOrchestratorCalls(response.functionCalls, { roleDeployments });

      // Per-call rejection feedback: the model sees each error and decides.
      for (const rejection of verdict.rejections) {
        input.push({
          type: "function_call_output",
          call_id: rejection.callId,
          output: JSON.stringify({ ok: false, error: rejection.error }),
        });
      }
      await emit(options.eventSink, { type: "orchestrator_actions", runId, round, actions: verdict.actions });

      const finish = verdict.actions.find((action): action is FinishAction => action.type === "finish");
      if (finish) {
        rounds.push({ round, actions: verdict.actions, delegations: [], usage: response.usage });
        await emit(options.eventSink, { type: "orchestrator_finish", runId, round, response: finish.response });
        return {
          ok: true,
          runId,
          response: finish.response,
          rounds,
          delegations: allDelegations,
          artifacts: allDelegations.flatMap((result) => result.artifacts),
          pendingArtifacts: registry.list(),
          usage,
        };
      }

      const expanded = expandDelegations(verdict.actions);
      const delegates = expanded.delegates;
      if (delegates.length === 0) {
        // Nothing valid to execute this round; rejections above carry the reasons.
        rounds.push({ round, actions: verdict.actions, delegations: [], usage: response.usage });
        continue;
      }

      const results = await executeDelegationBatch(runId, delegates, {
        userId: options.userId,
        globalConcurrency: options.globalConcurrency,
        perDeploymentConcurrency: options.perDeploymentConcurrency,
        stageArtifacts,
        eventSink: options.eventSink,
      }, runner);
      registry.register(results.flatMap((result) => result.artifacts));
      allDelegations.push(...results);
      rounds.push({ round, actions: verdict.actions, delegations: results, usage: response.usage });

      if (expanded.parallel) {
        const parallelCount = expanded.parallel.tasks.length;
        input.push({
          type: "function_call_output",
          call_id: expanded.parallel.callId,
          output: JSON.stringify({
            results: results.slice(0, parallelCount).map((result, index) => ({
              task: index,
              ...compactDelegationResult(result),
            })),
          }),
        });
        for (let index = parallelCount; index < delegates.length; index++) {
          input.push({
            type: "function_call_output",
            call_id: delegates[index].callId,
            output: JSON.stringify(compactDelegationResult(results[index])),
          });
        }
      } else {
        for (let index = 0; index < delegates.length; index++) {
          input.push({
            type: "function_call_output",
            call_id: delegates[index].callId,
            output: JSON.stringify(compactDelegationResult(results[index])),
          });
        }
      }
    }
    throw new Error(`dynamic orchestrator exceeded ${maxRounds} rounds without finish`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await emit(options.eventSink, { type: "orchestrator_error", runId, error: message });
    return {
      ok: false,
      runId,
      response: message,
      rounds,
      delegations: allDelegations,
      artifacts: allDelegations.flatMap((result) => result.artifacts),
      pendingArtifacts: registry.list(),
      usage,
      error: message,
    };
  }
}
