import type { ManagedBackgroundJobView, SessionView } from "@wollipog/protocol";
import { pendingRequests } from "@wollipog/protocol";
import type { SubagentDescriptor } from "./subagents.js";

export type WorkerState = "working" | "waiting" | "input_required" | "completed" | "failed" | "stopped" | "unverified";
export type WorkerTarget = { kind: "subagent"; id: string } | { kind: "background"; id: string } | { kind: "session"; id: string };
export interface WorkerMemberMetadata {
  type?: "Workflow Member" | "Pod Member";
  role?: string;
  phase?: string;
  activations?: number;
  terminalState?: "completed" | "failed" | "stopped";
  completedAt?: number;
}
export interface WorkerRow {
  id: string;
  name: string;
  type: string;
  state: WorkerState;
  target: WorkerTarget;
  depth: number;
  startedAt?: number;
  lastActivityAt?: number;
  completedAt?: number;
  model?: string;
  effort?: string;
  tokens?: number;
  inclusiveTokens?: number;
  role?: string;
  phase?: string;
  activations?: number;
  toolCount?: number;
  latestTool?: { title: string; active: boolean };
}

export function backgroundWorkerState(job: ManagedBackgroundJobView, session: SessionView, online: boolean): WorkerState {
  if (job.terminalStatus) return job.terminalStatus === "killed" ? "stopped" : job.terminalStatus;
  return online && job.sourcePresent && (session.backgroundWorkState === "running" || session.backgroundWorkState === "continuation_pending")
    ? "working" : "unverified";
}

/** This is a presentation over authorized records, never a new worker or action store. */
export function workerRoster(
  session: SessionView,
  subagents: readonly SubagentDescriptor[],
  members: readonly SessionView[],
  online: (runnerId: string) => boolean,
  metadata: ReadonlyMap<string, WorkerMemberMetadata> = new Map(),
): WorkerRow[] {
  const waitingOwners = new Set(pendingRequests(session.pendingApproval)
    .filter((request) => !request.recoveryReason).map((request) => request.ownerToolUseId));
  const rows: WorkerRow[] = subagents.map((agent) => ({
    id: `subagent:${agent.id}`,
    name: agent.title,
    type: "Subagent",
    state: waitingOwners.has(agent.id) && online(session.runnerId) && ["starting", "running", "waiting"].includes(agent.lifecycle) ? "input_required" : agent.availability === "recorded" && ["starting", "running", "waiting"].includes(agent.lifecycle)
      ? "unverified"
      : agent.lifecycle === "starting" || agent.lifecycle === "running" ? "working"
      : agent.lifecycle === "interrupted" ? "stopped"
      : agent.lifecycle === "unreachable" || agent.lifecycle === "unknown" ? "unverified"
      : agent.lifecycle,
    target: { kind: "subagent", id: agent.id },
    depth: agent.depth,
    startedAt: agent.startedAt,
    completedAt: agent.completedAt,
    lastActivityAt: agent.lastActivityAt,
    ...(agent.directUsage?.inputTokens != null || agent.directUsage?.outputTokens != null
      ? { tokens: (agent.directUsage.inputTokens ?? 0) + (agent.directUsage.outputTokens ?? 0) } : {}),
    ...(agent.inclusiveUsage?.inputTokens != null || agent.inclusiveUsage?.outputTokens != null
      ? { inclusiveTokens: (agent.inclusiveUsage.inputTokens ?? 0) + (agent.inclusiveUsage.outputTokens ?? 0) } : {}),
    ...(agent.toolCount == null ? {} : { toolCount: agent.toolCount }),
    ...(agent.latestTool == null ? {} : { latestTool: {
      ...agent.latestTool,
      active: agent.latestTool.active && agent.availability === "live" &&
        ["starting", "running", "waiting"].includes(agent.lifecycle),
    } }),
  }));
  for (const job of session.backgroundJobs ?? []) rows.push({
    id: `background:${job.id}`,
    name: `Background ${job.launchType === "unknown" ? "Job" : job.launchType.charAt(0).toUpperCase() + job.launchType.slice(1)}`,
    type: "Managed Background Job",
    state: backgroundWorkerState(job, session, online(session.runnerId)),
    target: { kind: "background", id: job.id },
    depth: 0,
    startedAt: job.registeredAt,
    lastActivityAt: job.lastObservedAt,
    completedAt: job.terminalObservedAt,
  });
  const seen = new Set<string>();
  for (const member of members) {
    if (member.id === session.id || seen.has(member.id)) continue;
    seen.add(member.id);
    const workflow = metadata.get(member.id);
    const terminalState = member.status === "completed" || member.status === "failed" || member.status === "stopped"
      ? member.status : member.status === "idle" ? workflow?.terminalState : undefined;
    const settled = terminalState != null;
    rows.push({
      id: `session:${member.id}`, name: member.title, type: workflow?.type ?? "Run Member",
      ...(workflow?.role ? { role: workflow.role } : {}),
      ...(workflow?.phase ? { phase: workflow.phase } : {}),
      ...(workflow?.activations != null ? { activations: workflow.activations } : {}),
      state: terminalState ?? (!online(member.runnerId) ? "unverified"
        : member.pendingApproval || member.status === "input_required" ? "input_required"
        : member.status === "running" || member.status === "starting" ? "working"
        : member.status === "idle" || member.status === "queued" ? "waiting" : member.status),
      target: { kind: "session", id: member.id }, depth: 0,
      startedAt: member.createdAt, lastActivityAt: member.lastEventAt ?? undefined,
      ...(settled ? { completedAt: workflow?.completedAt ?? member.updatedAt } : {}),
      ...(member.resolvedModel || member.model ? { model: member.resolvedModel || member.model! } : {}),
      ...(member.effort ? { effort: member.effort } : {}),
      tokens: member.tokensIn + member.tokensOut,
    });
  }
  return rows;
}

export function isCurrentWorker(row: WorkerRow): boolean {
  return row.state === "working" || row.state === "waiting" || row.state === "input_required";
}
