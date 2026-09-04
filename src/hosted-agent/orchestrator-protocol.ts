import type { FunctionCall, ToolSpec } from "./foundry.js";

/**
 * The dynamic orchestrator's action protocol.
 *
 * An orchestrator response may either:
 * - emit one or more delegate calls, which the runtime may execute concurrently; or
 * - emit one finish call.
 *
 * It does not declare a workflow graph. Later delegation rounds emerge from the
 * orchestrator inspecting the returned summaries and artifact references.
 */

export interface OutputClaim {
  name: string;
  description: string;
  mimeType: string;
  minimumCount: number;
}

export interface DelegateAction {
  type: "delegate";
  callId: string;
  agent: string;
  task: string;
  deployment: string;
  inputArtifactIds: string[];
  outputClaims: OutputClaim[];
}

export interface ParallelDelegateTask {
  taskId: string;
  agent: string;
  task: string;
  deployment: string;
  inputArtifactIds: string[];
  outputClaims: OutputClaim[];
}

export interface ParallelDelegateAction {
  type: "delegate_parallel";
  callId: string;
  tasks: ParallelDelegateTask[];
}

export interface FinishAction {
  type: "finish";
  callId: string;
  response: string;
}

export type OrchestratorAction = DelegateAction | ParallelDelegateAction | FinishAction;

export interface OrchestratorActionCatalogue {
  agentNames: readonly string[];
  workerDeployments: readonly string[];
}

export interface OrchestratorActionVerdict {
  ok: boolean;
  actions: OrchestratorAction[];
  errors: string[];
}

export const DELEGATE_TOOL: ToolSpec = {
  type: "function",
  name: "delegate",
  description:
    "Delegate one self-contained task to a specialist agent. Emit multiple delegate calls in one response when work can proceed independently; the runtime may execute them concurrently. Returned artifacts can be supplied to later delegations by id.",
  strict: true,
  parameters: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description: "Specialist agent name from the runtime catalogue.",
      },
      task: {
        type: "string",
        description: "Complete, self-contained task for this specialist.",
      },
      deployment: {
        type: "string",
        description: "Real worker-capable Foundry deployment from the runtime catalogue.",
      },
      inputArtifactIds: {
        type: "array",
        items: { type: "string" },
        description: "Existing artifact ids to stage as inputs. Use an empty array when no artifacts are required.",
      },
      outputClaims: {
        type: "array",
        description: "Artifacts this bounded delegation promises to produce. Use an empty array only when no file output is required.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Unique semantic output name within this delegation." },
            description: { type: "string", description: "What evidence the output must contain." },
            mimeType: { type: "string", description: "Required MIME type, e.g. text/csv, application/json, text/markdown, text/html." },
            minimumCount: { type: "integer", minimum: 1, description: "Minimum number of artifacts required for this claim." },
          },
          required: ["name", "description", "mimeType", "minimumCount"],
          additionalProperties: false,
        },
      },
    },
    required: ["agent", "task", "deployment", "inputArtifactIds", "outputClaims"],
    additionalProperties: false,
  },
};

export const DELEGATE_PARALLEL_TOOL: ToolSpec = {
  type: "function",
  name: "delegate_parallel",
  description:
    "Delegate two or more independent bounded specialist tasks as one explicit parallel batch. The runtime executes the tasks concurrently subject to shared deployment limits and returns one result per task.",
  strict: true,
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        minItems: 2,
        items: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "Unique short task id within this batch." },
            agent: { type: "string", description: "Specialist agent name." },
            task: { type: "string", description: "One bounded, self-contained specialist outcome." },
            deployment: { type: "string", description: "Real worker-capable Foundry deployment." },
            inputArtifactIds: { type: "array", items: { type: "string" } },
            outputClaims: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  description: { type: "string" },
                  mimeType: { type: "string" },
                  minimumCount: { type: "integer", minimum: 1 },
                },
                required: ["name", "description", "mimeType", "minimumCount"],
                additionalProperties: false,
              },
            },
          },
          required: ["taskId", "agent", "task", "deployment", "inputArtifactIds", "outputClaims"],
          additionalProperties: false,
        },
      },
    },
    required: ["tasks"],
    additionalProperties: false,
  },
};

export const ORCHESTRATOR_FINISH_TOOL: ToolSpec = {
  type: "function",
  name: "finish",
  description: "Finish the user turn after reviewing delegation results and artifacts.",
  strict: true,
  parameters: {
    type: "object",
    properties: {
      response: {
        type: "string",
        description: "Final response to the user.",
      },
    },
    required: ["response"],
    additionalProperties: false,
  },
};

export const ORCHESTRATOR_TOOLS: readonly ToolSpec[] = [
  DELEGATE_TOOL,
  DELEGATE_PARALLEL_TOOL,
  ORCHESTRATOR_FINISH_TOOL,
];

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const ALLOWED_OUTPUT_MIME_TYPES = new Set([
  "text/csv", "application/json", "text/markdown", "text/plain", "text/html", "image/svg+xml",
]);

function parseClaims(rawClaims: unknown, label: string, errors: string[]): OutputClaim[] | undefined {
  if (!Array.isArray(rawClaims)) {
    errors.push(`${label} has invalid outputClaims`);
    return undefined;
  }
  const claims: OutputClaim[] = [];
  const names = new Set<string>();
  let valid = true;
  for (const raw of rawClaims as Array<Record<string, unknown>>) {
    const name = raw?.["name"];
    const description = raw?.["description"];
    const mimeType = raw?.["mimeType"];
    const minimumCount = raw?.["minimumCount"];
    if (!nonEmptyString(name) || !nonEmptyString(description) || !nonEmptyString(mimeType) ||
        !ALLOWED_OUTPUT_MIME_TYPES.has(mimeType) || !Number.isInteger(minimumCount) || Number(minimumCount) < 1) {
      errors.push(`${label} has malformed output claim '${String(name ?? "")}'`);
      valid = false;
      continue;
    }
    if (names.has(name)) {
      errors.push(`${label} has duplicate output claim '${name}'`);
      valid = false;
      continue;
    }
    names.add(name);
    claims.push({ name, description, mimeType, minimumCount: Number(minimumCount) });
  }
  return valid ? claims : undefined;
}

function parseDelegateFields(
  raw: Record<string, unknown>,
  label: string,
  agents: Set<string>,
  workers: Set<string>,
  errors: string[],
): Omit<DelegateAction, "type" | "callId"> | undefined {
  const agent = raw["agent"];
  const task = raw["task"];
  const deployment = raw["deployment"];
  const rawArtifacts = raw["inputArtifactIds"];
  if (!nonEmptyString(agent) || !agents.has(agent)) errors.push(`${label} targets unknown agent '${String(agent ?? "")}'`);
  if (!nonEmptyString(task)) errors.push(`${label} has an empty task`);
  if (!nonEmptyString(deployment) || !workers.has(deployment)) errors.push(`${label} targets non-worker deployment '${String(deployment ?? "")}'`);
  if (!Array.isArray(rawArtifacts) || rawArtifacts.some((id) => !nonEmptyString(id))) errors.push(`${label} has invalid inputArtifactIds`);
  const claims = parseClaims(raw["outputClaims"], label, errors);
  if (!nonEmptyString(agent) || !agents.has(agent) || !nonEmptyString(task) ||
      !nonEmptyString(deployment) || !workers.has(deployment) ||
      !Array.isArray(rawArtifacts) || rawArtifacts.some((id) => !nonEmptyString(id)) || !claims) return undefined;
  return { agent, task, deployment, inputArtifactIds: [...new Set(rawArtifacts as string[])], outputClaims: claims };
}

/**
 * Validate a complete orchestrator response before any delegation executes.
 * A partially invalid batch is rejected as a whole, preventing half-executed
 * model-authored actions.
 */
export function validateOrchestratorCalls(
  calls: readonly FunctionCall[],
  catalogue: OrchestratorActionCatalogue,
): OrchestratorActionVerdict {
  const errors: string[] = [];
  const actions: OrchestratorAction[] = [];
  const agents = new Set(catalogue.agentNames);
  const workers = new Set(catalogue.workerDeployments);

  if (calls.length === 0) {
    return { ok: false, actions: [], errors: ["orchestrator emitted no delegate or finish call"] };
  }

  for (const call of calls) {
    if (!nonEmptyString(call.callId)) {
      errors.push(`${call.name || "unknown"} call has no call id`);
      continue;
    }

    if (call.name === "delegate") {
      const parsed = parseDelegateFields(call.args, "delegate", agents, workers, errors);
      if (parsed) actions.push({ type: "delegate", callId: call.callId, ...parsed });
      continue;
    }

    if (call.name === "delegate_parallel") {
      const rawTasks = call.args["tasks"];
      if (!Array.isArray(rawTasks) || rawTasks.length < 2) {
        errors.push("delegate_parallel requires at least two tasks");
        continue;
      }
      const taskIds = new Set<string>();
      const tasks: ParallelDelegateTask[] = [];
      let valid = true;
      for (const raw of rawTasks as Array<Record<string, unknown>>) {
        const taskId = raw?.["taskId"];
        if (!nonEmptyString(taskId) || taskIds.has(taskId)) {
          errors.push(`delegate_parallel has invalid or duplicate taskId '${String(taskId ?? "")}'`);
          valid = false;
          continue;
        }
        taskIds.add(taskId);
        const parsed = parseDelegateFields(raw, `delegate_parallel task '${taskId}'`, agents, workers, errors);
        if (!parsed) {
          valid = false;
          continue;
        }
        tasks.push({ taskId, ...parsed });
      }
      if (valid && tasks.length === rawTasks.length) {
        actions.push({ type: "delegate_parallel", callId: call.callId, tasks });
      }
      continue;
    }

    if (call.name === "finish") {
      const response = call.args["response"];
      if (!nonEmptyString(response)) {
        errors.push("finish response is empty");
        continue;
      }
      actions.push({ type: "finish", callId: call.callId, response });
      continue;
    }

    errors.push(`orchestrator emitted unknown action '${call.name}'`);
  }

  const scalarCount = actions.filter((action) => action.type === "delegate").length;
  const parallelCount = actions.filter((action) => action.type === "delegate_parallel").length;
  const delegationCount = scalarCount + parallelCount;
  const finishCount = actions.filter((action) => action.type === "finish").length;
  if (parallelCount > 1 || (parallelCount > 0 && scalarCount > 0)) {
    errors.push("orchestrator must emit either scalar delegate calls or one delegate_parallel call, not both");
  }
  if (finishCount > 1) errors.push("orchestrator emitted more than one finish call");
  if (finishCount > 0 && delegationCount > 0) {
    errors.push("orchestrator cannot delegate and finish in the same response");
  }

  return {
    ok: errors.length === 0 && actions.length > 0,
    actions: errors.length === 0 ? actions : [],
    errors,
  };
}
