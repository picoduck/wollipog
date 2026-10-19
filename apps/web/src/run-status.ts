import {
  sessionAttentionBreakdown,
  type RunView,
  type SessionView,
  type WorkflowDefinition,
  type WorkflowInstanceView,
} from "@wollipog/protocol";
import { statusMeta, type StatusValue } from "./status-meta.js";

/**
 * What a Multi-Agent Run is and whether it needs the person (#2974): the Runs list row's icon, type
 * and one badge. Pure, so the run page and the Pods rows can reuse the same rollup.
 */

/** The most instances one `GET /api/workflow-instances` page returns (the server's default limit). */
export const WORKFLOW_INSTANCE_PAGE = 100;

/** The workflow facts the Runs list loaded, indexed for its rows. */
export interface RunWorkflows {
  /** The newest workflow instance of each run that has one, by run id. */
  instances: ReadonlyMap<string, WorkflowInstanceView>;
  /** Each workflow's name, by workflow id, from its latest version. */
  names: ReadonlyMap<string, string>;
  /** The runs the load answered for. A run that arrived after it is not known yet. */
  runIds: ReadonlySet<string>;
  /** A run created before this may have an instance past the page the server returned, so its type
   * is unknown rather than Comparison. `-Infinity` when the page held every instance. */
  completeSince: number;
}

export function indexRunWorkflows(
  instances: readonly WorkflowInstanceView[],
  definitions: readonly WorkflowDefinition[],
  runIds: Iterable<string>,
  pageLimit = WORKFLOW_INSTANCE_PAGE,
): RunWorkflows {
  const byRun = new Map<string, WorkflowInstanceView>();
  for (const instance of instances) {
    const known = byRun.get(instance.runId);
    if (!known || instance.createdAt > known.createdAt) byRun.set(instance.runId, instance);
  }
  return {
    instances: byRun,
    names: new Map(definitions.map((definition) => [definition.workflowId, definition.name])),
    runIds: new Set(runIds),
    completeSince: instances.length >= pageLimit
      ? Math.min(...instances.map((instance) => instance.createdAt))
      : Number.NEGATIVE_INFINITY,
  };
}

export type RunType =
  | { kind: "comparison" }
  | { kind: "workflow"; name: string; instance: WorkflowInstanceView }
  /** Not loaded yet, the load failed, or the run is older than the loaded page. */
  | { kind: "unknown" };

export function runType(run: Pick<RunView, "id" | "createdAt">, workflows: RunWorkflows | null): RunType {
  if (!workflows) return { kind: "unknown" };
  const instance = workflows.instances.get(run.id);
  if (instance) return { kind: "workflow", name: workflows.names.get(instance.workflowId) ?? "Workflow", instance };
  if (!workflows.runIds.has(run.id) || run.createdAt < workflows.completeSince) return { kind: "unknown" };
  return { kind: "comparison" };
}

/** The type's words on the row's meta line: "Comparison" or the workflow's name. */
export function runTypeLabel(type: RunType): string | null {
  return type.kind === "comparison" ? "Comparison" : type.kind === "workflow" ? type.name : null;
}

export type RunStatus = StatusValue<"run">;

/**
 * The one status a run's row shows, or none (§11.1). The first that applies:
 * 1. Awaiting Decision: a workflow node waits at a gate.
 * 2. Approval Required: a member needs the person, for an approval, an answer or any other request.
 * 3. Running: a member's agent or a workflow node is working.
 * 4. Failed: the workflow failed.
 * Otherwise nothing: every member is idle, or the run finished.
 *
 * `sessions` is any lookup holding the members; a member it does not have is skipped.
 */
export function runStatus(
  run: Pick<RunView, "sessionIds">,
  sessions: ReadonlyMap<string, SessionView>,
  workflow: WorkflowInstanceView | null | undefined,
): RunStatus | null {
  const members = run.sessionIds.flatMap((id) => sessions.get(id) ?? []);
  const nodes = workflow?.nodeStates ?? [];
  if (workflow?.status === "waiting_gate" || nodes.some((node) => node.status === "waiting_gate")) return "awaiting_decision";
  if (members.some((member) => sessionAttentionBreakdown(member).length > 0)) return "approval_required";
  if (members.some((member) => statusMeta("session", member.status).pulse) || nodes.some((node) => node.status === "running")) {
    return "running";
  }
  if (workflow?.status === "failed") return "failed";
  return null;
}
