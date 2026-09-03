import crypto from "node:crypto";
import { executeDelegation, type DelegationArtifactStager, type DelegationResult } from "./delegate-executor.js";
import { callLlm, type CallOpts, type LlmResult } from "./foundry.js";
import { loadRoles, type Role } from "./imports.js";
import {
  ORCHESTRATOR_TOOLS,
  validateOrchestratorCalls,
  type DelegateAction,
  type FinishAction,
  type OrchestratorAction,
} from "./orchestrator-protocol.js";
import { ALLOWLIST, PLANNER_DEPLOYMENT } from "./planner.js";
import { PendingArtifactRegistry, type PendingArtifactRecord } from "./pending-artifact-registry.js";

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
  maxDelegatesPerRound?: number;
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
  workerDeployments?: string[];
  pendingRegistryFactory?: (runId: string) => PendingArtifactRegistryLike;
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
const DEFAULT_MAX_DELEGATES_PER_ROUND = 12;
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

function availableWorkers(): string[] {
  return ALLOWLIST
    .filter((deployment) => deployment.kind === "worker" || deployment.kind === "both")
    .map((deployment) => deployment.name);
}

export function dynamicOrchestratorInstructions(
  roles: readonly Role[],
  workerDeployments: readonly string[],
): string {
  const agentCatalogue = roles
    .map((role) => `- ${role.name}: ${role.description} (default deployment: ${role.defaultDeployment})`)
    .join("\n");
  const deploymentCatalogue = workerDeployments.map((deployment) => `- ${deployment}`).join("\n");
  return `You are the dynamic orchestrator for a data-analysis and visualization application.
You decide how to satisfy the user's request by delegating self-contained work to specialist agents, reviewing their returned summaries and artifact references, and then delegating further work or finishing.

SPECIALIST AGENTS:
${agentCatalogue}

WORKER-CAPABLE FOUNDRY DEPLOYMENTS:
${deploymentCatalogue}

RULES:
- Respond only with function calls to delegate or finish.
- Create each delegated task yourself from the user's request and the returned delegation evidence.
- Do not emit a predetermined workflow graph. Decide the next actions after each round of results.
- Emit multiple delegate calls in the same response when their work is independent; the runtime executes them concurrently.
- If work depends on an earlier output, wait for that result and pass only the required artifact IDs in inputArtifactIds.
- A specialist sees its task and selected artifacts, not sibling workspaces or the full orchestrator transcript.
- Use real agent names and worker deployments from the catalogues above.
- Inspect failures and delegate a focused correction when appropriate; do not blindly repeat an entire successful task.
- Preserve the user's requested scope. Do not invent statistics, artifacts, persistence, or completion.
- Use finish only after the request is complete or when a clear blocker must be reported.
- Never delegate and finish in the same response.`;
}

function compactDelegationResult(result: DelegationResult): Record<string, unknown> {
  return {
    status: result.status,
    agent: result.agent,
    deployment: result.deployment,
    summary: result.summary.slice(0, MAX_SUMMARY_CHARS),
    error: result.error,
    artifacts: result.artifacts.map((artifact) => ({
      id: artifact.id,
      title: artifact.path,
      path: artifact.path,
      mimeType: artifact.mimeType,
      kind: artifact.kind,
      bytes: artifact.bytes,
      agent: artifact.agent,
      callId: artifact.callId,
    })),
    usage: result.usage,
    modelCalls: result.modelCalls,
    toolExecutions: result.toolExecutions,
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

/** Execute one same-response delegation batch with neutral bounded concurrency. */
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
 * Run the dormant dynamic orchestration loop.
 *
 * Same-response delegates execute concurrently. Their compact summaries and
 * artifact references are correlated back to the model by function call id.
 * The model then chooses the next delegation round or finish.
 */
export async function runDynamicOrchestrator(
  userPrompt: string,
  options: DynamicOrchestratorOptions = {},
  dependencies: DynamicOrchestratorDependencies = {},
): Promise<DynamicOrchestratorResult> {
  if (!userPrompt.trim()) throw new Error("user prompt is required");
  const runId = options.runId?.trim() || `run-${crypto.randomUUID()}`;
  const roles = dependencies.roles ?? loadRoles();
  const workerDeployments = dependencies.workerDeployments ?? availableWorkers();
  const orchestratorDeployment = options.orchestratorDeployment ?? PLANNER_DEPLOYMENT;
  const maxRounds = positiveInteger(options.maxRounds, DEFAULT_MAX_ROUNDS, "maxRounds");
  const maxDelegates = positiveInteger(
    options.maxDelegatesPerRound,
    DEFAULT_MAX_DELEGATES_PER_ROUND,
    "maxDelegatesPerRound",
  );
  if (!workerDeployments.includes(orchestratorDeployment)) {
    throw new Error(`orchestrator deployment '${orchestratorDeployment}' is not worker-capable`);
  }

  const modelCaller = dependencies.modelCaller ?? callLlm;
  const runner = dependencies.delegationRunner ?? defaultDelegationRunner;
  const registry = dependencies.pendingRegistryFactory?.(runId) ?? new PendingArtifactRegistry(runId);
  const stageArtifacts = options.stageArtifacts ?? registry.stageArtifacts;
  const instructions = dynamicOrchestratorInstructions(roles, workerDeployments);
  const available = registry.list();
  const pendingContext = available.length === 0
    ? ""
    : `\n\nPENDING ARTIFACTS AVAILABLE FROM EARLIER TURNS IN THIS CONVERSATION:\n${available.map((artifact) => `- ${artifact.id}: ${artifact.title} [${artifact.mimeType}, ${artifact.bytes} bytes]`).join("\n")}\nFor a save/catalogue follow-up, delegate the operator with the selected pending IDs. If no pending IDs are available, finish immediately with a clear explanation.`;
  const input: unknown[] = [{ role: "user", content: `${userPrompt}${pendingContext}` }];
  const saveRequest = /\b(save|persist|catalog(?:ue)?|artifacts?\s*db|documents)\b/i.test(userPrompt);
  if (saveRequest && available.length === 0) {
    return {
      ok: false,
      runId,
      response: "No pending artifacts are available in this conversation to save.",
      rounds: [], delegations: [], artifacts: [], pendingArtifacts: [],
      usage: { input: 0, output: 0 },
      error: "No pending artifacts are available in this conversation to save.",
    };
  }
  const rounds: DynamicOrchestratorRound[] = [];
  const allDelegations: DelegationResult[] = [];
  const usage = { input: 0, output: 0 };
  const seenCallIds = new Set<string>();
  let lastNoProgressSignature = "";
  let noProgressRepeats = 0;

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

      const verdict = validateOrchestratorCalls(response.functionCalls, {
        agentNames: roles.map((role) => role.name),
        workerDeployments,
      });
      if (!verdict.ok) {
        throw new Error(`invalid orchestrator action batch: ${verdict.errors.join("; ")}`);
      }
      const duplicateCallIds = verdict.actions
        .map((action) => action.callId)
        .filter((callId) => seenCallIds.has(callId));
      if (duplicateCallIds.length) {
        throw new Error(`orchestrator reused call id(s): ${[...new Set(duplicateCallIds)].join(", ")}`);
      }
      verdict.actions.forEach((action) => seenCallIds.add(action.callId));
      await emit(options.eventSink, { type: "orchestrator_actions", runId, round, actions: verdict.actions });

      const finish = verdict.actions[0]?.type === "finish"
        ? verdict.actions[0] as FinishAction
        : undefined;
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

      const delegates = verdict.actions as DelegateAction[];
      if (delegates.length > maxDelegates) {
        throw new Error(`orchestrator emitted ${delegates.length} delegates; maximum per round is ${maxDelegates}`);
      }

      input.push(...response.rawOutput);
      const results = await executeDelegationBatch(runId, delegates, {
        userId: options.userId,
        globalConcurrency: options.globalConcurrency,
        perDeploymentConcurrency: options.perDeploymentConcurrency,
        stageArtifacts,
        eventSink: options.eventSink,
      }, runner);
      const registered = registry.register(results.flatMap((result) => result.artifacts));
      const signature = JSON.stringify(delegates.map((action) => ({
        agent: action.agent,
        deployment: action.deployment,
        task: action.task.trim().replace(/\s+/g, " "),
        inputArtifactIds: [...action.inputArtifactIds].sort(),
      })));
      const verifiedPersistence = results.some((result) => result.catalogUpdated);
      if (saveRequest && delegates.some((action) => action.agent === "operator") && !verifiedPersistence) {
        throw new Error("artifact persistence failed: operator returned no verified catalog update");
      }
      const madeProgress = saveRequest ? verifiedPersistence : registered.length > 0 || verifiedPersistence;
      if (!madeProgress && signature === lastNoProgressSignature) noProgressRepeats++;
      else noProgressRepeats = madeProgress ? 0 : 1;
      lastNoProgressSignature = signature;
      if (noProgressRepeats >= 2) {
        throw new Error("orchestrator stopped: repeated delegation batch produced no new artifacts or verified side effects");
      }
      allDelegations.push(...results);
      rounds.push({ round, actions: verdict.actions, delegations: results, usage: response.usage });
      for (let index = 0; index < delegates.length; index++) {
        input.push({
          type: "function_call_output",
          call_id: delegates[index].callId,
          output: JSON.stringify(compactDelegationResult(results[index])),
        });
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
