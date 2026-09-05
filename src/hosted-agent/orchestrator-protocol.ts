import type { FunctionCall, ToolSpec } from "./foundry.js";

/**
 * The dynamic orchestrator's action protocol (Phase-1 slim form —
 * design/new-foundry-design.md).
 *
 * The model sees three verbs:
 *   delegate(agent, task, inputArtifactIds?)   — one specialist task
 *   delegate_parallel(tasks[])                 — a batch executed concurrently
 *   finish(response)                           — end the turn
 *
 * Removed from model control: deployment selection, output claims, minimum
 * counts, task ids, workflow graphs. The runtime maps each role to its
 * deployment (agents/*.md frontmatter) at validation time.
 *
 * Validation is per-call, not all-or-nothing: an invalid call is returned to
 * the model as an error function_call_output; valid calls in the same
 * response still execute.
 */

export interface DelegateAction {
  type: "delegate";
  callId: string;
  agent: string;
  task: string;
  /** Resolved by the runtime from the role catalogue — never model-supplied. */
  deployment: string;
  inputArtifactIds: string[];
}

export interface ParallelDelegateTask {
  agent: string;
  task: string;
  deployment: string;
  inputArtifactIds: string[];
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

export interface OrchestratorCatalogue {
  /** role name → worker deployment (from agents/*.md frontmatter). */
  roleDeployments: ReadonlyMap<string, string>;
}

export interface CallRejection {
  callId: string;
  error: string;
}

export interface OrchestratorVerdict {
  /** Valid, deployment-resolved actions to execute. */
  actions: OrchestratorAction[];
  /** Invalid calls, each answered with an error function_call_output. */
  rejections: CallRejection[];
}

const ARTIFACT_IDS_SCHEMA = {
  type: "array",
  items: { type: "string" },
  description:
    "Existing pending artifact ids to stage as inputs. Use an empty array when no artifacts are required.",
};

export const DELEGATE_TOOL: ToolSpec = {
  type: "function",
  name: "delegate",
  description:
    "Delegate one self-contained task to a specialist agent. The agent runs in an isolated workspace; files it writes are returned to you as pending artifact ids that later delegations can receive as inputs.",
  strict: true,
  parameters: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description: "Specialist agent name from the catalogue.",
      },
      task: {
        type: "string",
        description: "Complete, self-contained task for this specialist.",
      },
      inputArtifactIds: ARTIFACT_IDS_SCHEMA,
    },
    required: ["agent", "task", "inputArtifactIds"],
    additionalProperties: false,
  },
};

export const DELEGATE_PARALLEL_TOOL: ToolSpec = {
  type: "function",
  name: "delegate_parallel",
  description:
    "Delegate two or more independent specialist tasks as one batch. The runtime executes them concurrently and returns one result per task. Use whenever independent work is ready — do not serialize independent tasks.",
  strict: true,
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            agent: { type: "string", description: "Specialist agent name." },
            task: { type: "string", description: "One self-contained specialist task." },
            inputArtifactIds: ARTIFACT_IDS_SCHEMA,
          },
          required: ["agent", "task", "inputArtifactIds"],
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

function parseTask(
  raw: Record<string, unknown>,
  catalogue: OrchestratorCatalogue,
): { task?: ParallelDelegateTask; error?: string } {
  const agent = raw["agent"];
  const task = raw["task"];
  const rawArtifacts = raw["inputArtifactIds"];
  if (!nonEmptyString(agent)) return { error: "missing agent name" };
  const deployment = catalogue.roleDeployments.get(agent);
  if (!deployment) {
    return {
      error: `unknown agent '${agent}'; available: ${[...catalogue.roleDeployments.keys()].join(", ")}`,
    };
  }
  if (!nonEmptyString(task)) return { error: "empty task" };
  if (!Array.isArray(rawArtifacts) || rawArtifacts.some((id) => !nonEmptyString(id))) {
    return { error: "inputArtifactIds must be an array of non-empty artifact id strings" };
  }
  return {
    task: {
      agent,
      task,
      deployment,
      inputArtifactIds: [...new Set(rawArtifacts as string[])],
    },
  };
}

/**
 * Validate one orchestrator response. Valid calls become executable actions
 * (deployments resolved from the role catalogue); invalid calls become
 * per-call rejections the loop reports back to the model. A finish call in
 * the same response as delegate calls is rejected — the model must review
 * delegation results before finishing.
 */
export function validateOrchestratorCalls(
  calls: readonly FunctionCall[],
  catalogue: OrchestratorCatalogue,
): OrchestratorVerdict {
  const actions: OrchestratorAction[] = [];
  const rejections: CallRejection[] = [];

  for (const call of calls) {
    if (!nonEmptyString(call.callId)) continue; // uncorrelatable; nothing to answer

    if (call.name === "delegate") {
      const parsed = parseTask(call.args, catalogue);
      if (parsed.task) {
        actions.push({ type: "delegate", callId: call.callId, ...parsed.task });
      } else {
        rejections.push({ callId: call.callId, error: `delegate rejected: ${parsed.error}` });
      }
      continue;
    }

    if (call.name === "delegate_parallel") {
      const rawTasks = call.args["tasks"];
      if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
        rejections.push({ callId: call.callId, error: "delegate_parallel rejected: tasks must be a non-empty array" });
        continue;
      }
      const tasks: ParallelDelegateTask[] = [];
      const errors: string[] = [];
      for (const [index, raw] of (rawTasks as Array<Record<string, unknown>>).entries()) {
        const parsed = parseTask(raw ?? {}, catalogue);
        if (parsed.task) tasks.push(parsed.task);
        else errors.push(`task ${index}: ${parsed.error}`);
      }
      if (errors.length > 0) {
        rejections.push({ callId: call.callId, error: `delegate_parallel rejected: ${errors.join("; ")}` });
      } else {
        actions.push({ type: "delegate_parallel", callId: call.callId, tasks });
      }
      continue;
    }

    if (call.name === "finish") {
      const response = call.args["response"];
      if (!nonEmptyString(response)) {
        rejections.push({ callId: call.callId, error: "finish rejected: response is empty" });
      } else {
        actions.push({ type: "finish", callId: call.callId, response });
      }
      continue;
    }

    rejections.push({ callId: call.callId, error: `unknown tool '${call.name}'` });
  }

  // finish alongside delegations: execute the delegations, reject the finish.
  const hasDelegation = actions.some((action) => action.type !== "finish");
  if (hasDelegation) {
    for (const action of actions.filter((a): a is FinishAction => a.type === "finish")) {
      rejections.push({
        callId: action.callId,
        error: "finish rejected: delegations from this response are executing; review their results, then finish",
      });
    }
    return { actions: actions.filter((action) => action.type !== "finish"), rejections };
  }

  // multiple finish calls: honor the first, reject the rest.
  const finishes = actions.filter((a): a is FinishAction => a.type === "finish");
  for (const extra of finishes.slice(1)) {
    rejections.push({ callId: extra.callId, error: "finish rejected: duplicate finish call" });
  }
  return { actions: finishes.length > 1 ? [finishes[0]] : actions, rejections };
}
