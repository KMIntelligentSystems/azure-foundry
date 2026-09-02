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

export interface DelegateAction {
  type: "delegate";
  callId: string;
  agent: string;
  task: string;
  deployment: string;
  inputArtifactIds: string[];
}

export interface FinishAction {
  type: "finish";
  callId: string;
  response: string;
}

export type OrchestratorAction = DelegateAction | FinishAction;

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
    },
    required: ["agent", "task", "deployment", "inputArtifactIds"],
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
  ORCHESTRATOR_FINISH_TOOL,
];

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
      const agent = call.args["agent"];
      const task = call.args["task"];
      const deployment = call.args["deployment"];
      const rawArtifacts = call.args["inputArtifactIds"];

      if (!nonEmptyString(agent) || !agents.has(agent)) {
        errors.push(`delegate targets unknown agent '${String(agent ?? "")}'`);
        continue;
      }
      if (!nonEmptyString(task)) {
        errors.push(`delegate for '${agent}' has an empty task`);
        continue;
      }
      if (!nonEmptyString(deployment) || !workers.has(deployment)) {
        errors.push(`delegate for '${agent}' targets non-worker deployment '${String(deployment ?? "")}'`);
        continue;
      }
      if (!Array.isArray(rawArtifacts) || rawArtifacts.some((id) => !nonEmptyString(id))) {
        errors.push(`delegate for '${agent}' has invalid inputArtifactIds`);
        continue;
      }

      actions.push({
        type: "delegate",
        callId: call.callId,
        agent,
        task,
        deployment,
        inputArtifactIds: [...new Set(rawArtifacts as string[])],
      });
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

  const delegateCount = actions.filter((action) => action.type === "delegate").length;
  const finishCount = actions.filter((action) => action.type === "finish").length;
  if (finishCount > 1) errors.push("orchestrator emitted more than one finish call");
  if (finishCount > 0 && delegateCount > 0) {
    errors.push("orchestrator cannot delegate and finish in the same response");
  }

  return {
    ok: errors.length === 0 && actions.length > 0,
    actions: errors.length === 0 ? actions : [],
    errors,
  };
}
