import type { ManagedBackgroundJobView, PendingApproval, SessionAttentionKind, SessionStatus, SessionView } from "@wollipog/protocol";
import { plainTextPreview, prioritizedPendingRequests, sessionAttentionStatus } from "@wollipog/protocol";
import { statusMeta, statusValues, type StatusMeta } from "./status-meta.js";
import type { SubagentDescriptor } from "./subagents.js";
import { splitStepTitle } from "./work-steps.js";

/**
 * The one word a worker shows (docs/design-system.md §11.2, #2857): the Subagent / background job
 * vocabulary for work in flight or settled, the Session vocabulary for a member session waiting on
 * its next prompt or for capacity, and the attention vocabulary for a worker that needs the user.
 */
export type WorkerState =
  | "running"
  | "queued"
  | "awaiting_prompt"
  | "attention"
  | "completed"
  | "failed"
  | "stopped"
  | "unverified"
  | "lost";
export type WorkerTarget = { kind: "subagent"; id: string } | { kind: "background"; id: string } | { kind: "session"; id: string };
/** The heading a row sits under: Subagents, Background Jobs, or the pod's or run's own title. */
export interface WorkerGroup { id: string; name: string }
export const SUBAGENT_GROUP: WorkerGroup = { id: "subagents", name: "Subagents" };
export const BACKGROUND_GROUP: WorkerGroup = { id: "background", name: "Background Jobs" };
export interface WorkerMemberMetadata {
  group?: WorkerGroup;
  /** The run's title, which a run member's own title repeats ahead of its agent. */
  runTitle?: string;
  role?: string;
  phase?: string;
  activations?: number;
  terminalState?: "completed" | "failed" | "stopped";
  completedAt?: number;
}
export interface WorkerRow {
  id: string;
  name: string;
  group: WorkerGroup;
  state: WorkerState;
  /** What the worker needs from the user, while `state` is `attention`. */
  attention?: SessionAttentionKind;
  /** What the worker is doing now, as one sentence: line 2 of its row. */
  activity: string;
  target: WorkerTarget;
  /** The row this one nests under: a subagent's spawning subagent. */
  parentId?: string;
  depth: number;
  startedAt?: number;
  lastActivityAt?: number;
  completedAt?: number;
  // The facts below are for the worker's own page (#2860); its row does not show them.
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

const ATTENTION_KINDS: ReadonlySet<string> = new Set(statusValues("attention"));

/** The worker's one status badge. The roster row, the transcript's agent row and a worker's page all
 * read it here, so one worker carries one word everywhere. */
export function workerStatusMeta(worker: Pick<WorkerRow, "state" | "attention">): StatusMeta {
  switch (worker.state) {
    case "attention": {
      const kind = worker.attention && ATTENTION_KINDS.has(worker.attention) ? worker.attention : "input_required";
      return statusMeta("attention", kind);
    }
    case "awaiting_prompt": return statusMeta("session", "idle");
    case "queued": return statusMeta("session", "queued");
    default: return statusMeta("job", worker.state);
  }
}

/** The attention kind one request carries on its own ("Approval Required", "Answer Required"). */
export function requestAttentionKind(request: PendingApproval): SessionAttentionKind {
  return sessionAttentionStatus({ status: "input_required",
    pendingApproval: { ...request, ownerToolUseId: undefined, additionalRequests: undefined } })?.kind ?? "input_required";
}

/** Each subagent's most urgent pending request, by owner. A request preserved across a runner
 * restart is the session's to recover, not the worker's to answer. */
export function pendingRequestsByOwner(pendingApproval: SessionView["pendingApproval"]): Map<string, PendingApproval> {
  const owners = new Map<string, PendingApproval>();
  for (const request of prioritizedPendingRequests(pendingApproval)) {
    if (request.recoveryReason || !request.ownerToolUseId || owners.has(request.ownerToolUseId)) continue;
    owners.set(request.ownerToolUseId, request);
  }
  return owners;
}

/** What a transcript's agent row reads its worker word from, so it matches the Agents roster. */
export interface SubagentStatusContextValue {
  sessionStatus: SessionStatus;
  runnerOnline: boolean;
  /** Each subagent's most urgent pending request, as an attention kind, by its tool-call id. */
  attention: ReadonlyMap<string, SessionAttentionKind>;
}

/**
 * A request is attributed to an agent row only when its owner names exactly one agent: never to an
 * owner the control plane reports unresolved (a reused provider tool-call id), nor to one the local
 * projection found ambiguous, since the roster cannot list that worker either.
 */
export function subagentStatusContext(
  session: Pick<SessionView, "status" | "pendingApproval" | "attentionOwners">,
  runnerOnline: boolean,
  ambiguousIds: ReadonlySet<string> = new Set(),
): SubagentStatusContextValue {
  const unresolved = new Set((session.attentionOwners ?? []).filter((owner) => !owner.resolved).map((owner) => owner.toolCallId));
  const attention = new Map<string, SessionAttentionKind>();
  for (const [owner, request] of pendingRequestsByOwner(session.pendingApproval)) {
    if (!unresolved.has(owner) && !ambiguousIds.has(owner)) attention.set(owner, requestAttentionKind(request));
  }
  return { sessionStatus: session.status, runnerOnline, attention };
}

const ACTIVE_LIFECYCLES: ReadonlySet<string> = new Set(["starting", "running", "waiting"]);

/**
 * A subagent's worker state. Work in flight reads Running; its pending request outranks that; a
 * runner that is offline cannot vouch for it (Unverified). A subagent the provider reports as
 * unreachable while its runner is online is Lost.
 */
export function subagentWorkerStatus(
  agent: Pick<SubagentDescriptor, "lifecycle" | "availability">,
  attention?: SessionAttentionKind,
): Pick<WorkerRow, "state" | "attention"> {
  if (ACTIVE_LIFECYCLES.has(agent.lifecycle)) {
    if (agent.availability === "recorded") return { state: "unverified" };
    return attention ? { state: "attention", attention } : { state: "running" };
  }
  switch (agent.lifecycle) {
    case "completed": return { state: "completed" };
    case "failed": return { state: "failed" };
    case "interrupted": return { state: "stopped" };
    case "unreachable": return { state: agent.availability === "recorded" ? "unverified" : "lost" };
    default: return { state: "unverified" };
  }
}

export function backgroundWorkerState(job: ManagedBackgroundJobView, session: SessionView, online: boolean): WorkerState {
  if (job.terminalStatus) return job.terminalStatus === "killed" ? "stopped" : job.terminalStatus;
  return online && job.sourcePresent && (session.backgroundWorkState === "running" || session.backgroundWorkState === "continuation_pending")
    ? "running" : "unverified";
}

/** A member session's worker state, on the Session vocabulary: idle is Awaiting Prompt. */
export function memberWorkerStatus(
  member: Pick<SessionView, "status" | "pendingApproval">,
  online: boolean,
  terminalState?: WorkerMemberMetadata["terminalState"],
): Pick<WorkerRow, "state" | "attention"> {
  if (member.status === "completed" || member.status === "failed" || member.status === "stopped") return { state: member.status };
  if (member.status === "idle" && terminalState) return { state: terminalState };
  if (!online) return { state: "unverified" };
  const request = prioritizedPendingRequests(member.pendingApproval)[0];
  if (request || member.status === "input_required") {
    return { state: "attention", attention: request ? requestAttentionKind(request) : "input_required" };
  }
  if (member.status === "running" || member.status === "starting") return { state: "running" };
  if (member.status === "queued") return { state: "queued" };
  return { state: "awaiting_prompt" };
}

/** Provider verbs (after `splitStepTitle`) as what a worker is doing, did, or waits to do. */
const STEP_PHRASES: Record<string, { now: string; done: string; wait: string }> = {
  Run: { now: "Running", done: "Ran", wait: "run" },
  Read: { now: "Reading", done: "Read", wait: "read" },
  Edit: { now: "Editing", done: "Edited", wait: "edit" },
  Write: { now: "Writing", done: "Wrote", wait: "write" },
  Delete: { now: "Deleting", done: "Deleted", wait: "delete" },
  Move: { now: "Moving", done: "Moved", wait: "move" },
  Find: { now: "Finding", done: "Found", wait: "find" },
  Search: { now: "Searching for", done: "Searched for", wait: "search for" },
  Fetch: { now: "Fetching", done: "Fetched", wait: "fetch" },
  "Search Web": { now: "Searching the web for", done: "Searched the web for", wait: "search the web for" },
  // A worker that spawned another waits on it.
  Agent: { now: "Waiting on", done: "Delegated to", wait: "start" },
  Task: { now: "Waiting on", done: "Delegated to", wait: "start" },
};

/**
 * One step as a sentence: "Running npm test", "Ran npm test", "Waiting to edit src/a.ts", or, for a
 * step that was in flight when its runner stopped answering, "Last seen running npm test". A title
 * whose verb is not one of these reads as the provider wrote it.
 */
export function stepActivity(title: string, mode: "now" | "done" | "wait" | "seen", workspaceRoot?: string): string {
  const { verb, object } = splitStepTitle(title, workspaceRoot);
  const phrase = object ? STEP_PHRASES[verb] : undefined;
  if (!phrase) return mode === "seen" ? `Last seen: ${title}` : title;
  if (mode === "wait") return `Waiting to ${phrase.wait} ${object}`;
  if (mode === "seen") return `Last seen ${phrase.now.charAt(0).toLowerCase()}${phrase.now.slice(1)} ${object}`;
  return `${phrase[mode]} ${object}`;
}

const LAUNCH_NOUNS: Record<ManagedBackgroundJobView["launchType"], string> = {
  agent: "An agent",
  shell: "A shell command",
  monitor: "A monitor",
  workflow: "A workflow",
  unknown: "A job",
};

/** This is a presentation over authorized records, never a new worker or action store. */
export function workerRoster(
  session: SessionView,
  subagents: readonly SubagentDescriptor[],
  members: readonly SessionView[],
  online: (runnerId: string) => boolean,
  metadata: ReadonlyMap<string, WorkerMemberMetadata> = new Map(),
): WorkerRow[] {
  const root = session.worktreePath ?? undefined;
  const owners = pendingRequestsByOwner(session.pendingApproval);
  const subagentIds = new Set(subagents.map((agent) => agent.id));
  const rows: WorkerRow[] = subagents.map((agent) => {
    const request = owners.get(agent.id);
    const status = subagentWorkerStatus(agent, request ? requestAttentionKind(request) : undefined);
    const latest = agent.latestTool;
    const latestActive = latest?.active === true && agent.availability === "live" && ACTIVE_LIFECYCLES.has(agent.lifecycle);
    return {
      id: `subagent:${agent.id}`,
      name: agent.title,
      group: SUBAGENT_GROUP,
      ...status,
      // An Unverified worker's step may still be running, so it reads as last seen, never as done.
      activity: status.state === "attention" && request ? stepActivity(request.title, "wait", root)
        : latest ? stepActivity(latest.title, latestActive ? "now"
          : latest.active && status.state === "unverified" ? "seen" : "done", root)
        : status.state === "running" ? "Starting its first step" : "No steps recorded",
      ...(agent.role ? { role: agent.role } : {}),
      target: { kind: "subagent", id: agent.id },
      ...(agent.parentId && subagentIds.has(agent.parentId) ? { parentId: `subagent:${agent.parentId}` } : {}),
      depth: agent.depth,
      startedAt: agent.startedAt,
      completedAt: agent.completedAt,
      lastActivityAt: agent.lastActivityAt,
      ...(agent.directUsage?.inputTokens != null || agent.directUsage?.outputTokens != null
        ? { tokens: (agent.directUsage.inputTokens ?? 0) + (agent.directUsage.outputTokens ?? 0) } : {}),
      ...(agent.inclusiveUsage?.inputTokens != null || agent.inclusiveUsage?.outputTokens != null
        ? { inclusiveTokens: (agent.inclusiveUsage.inputTokens ?? 0) + (agent.inclusiveUsage.outputTokens ?? 0) } : {}),
      ...(agent.toolCount == null ? {} : { toolCount: agent.toolCount }),
      ...(latest == null ? {} : { latestTool: { ...latest, active: latestActive } }),
    };
  });
  for (const job of session.backgroundJobs ?? []) rows.push({
    id: `background:${job.id}`,
    name: `Background ${job.launchType === "unknown" ? "Job" : job.launchType.charAt(0).toUpperCase() + job.launchType.slice(1)}`,
    group: BACKGROUND_GROUP,
    state: backgroundWorkerState(job, session, online(session.runnerId)),
    activity: `${LAUNCH_NOUNS[job.launchType] ?? LAUNCH_NOUNS.unknown} the agent started in the background`,
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
    const facts = metadata.get(member.id);
    const status = memberWorkerStatus(member, online(member.runnerId), facts?.terminalState);
    const settled = status.state === "completed" || status.state === "failed" || status.state === "stopped";
    const request = status.state === "attention" ? prioritizedPendingRequests(member.pendingApproval)[0] : undefined;
    rows.push({
      id: `session:${member.id}`,
      name: memberName(member, facts?.runTitle),
      group: facts?.group ?? { id: "run", name: "Workflow" },
      ...status,
      activity: request ? stepActivity(request.title, "wait", member.worktreePath ?? undefined)
        : plainTextPreview(member.preview) || "No messages yet",
      ...(facts?.role ? { role: facts.role } : {}),
      ...(facts?.phase ? { phase: facts.phase } : {}),
      ...(facts?.activations != null ? { activations: facts.activations } : {}),
      target: { kind: "session", id: member.id }, depth: 0,
      startedAt: member.createdAt, lastActivityAt: member.lastEventAt ?? undefined,
      ...(settled ? { completedAt: facts?.completedAt ?? member.updatedAt } : {}),
      ...(member.resolvedModel || member.model ? { model: member.resolvedModel || member.model! } : {}),
      ...(member.effort ? { effort: member.effort } : {}),
      tokens: member.tokensIn + member.tokensOut,
    });
  }
  return rows;
}

/**
 * A member's name, leading with what tells it apart. A run titles its members "<Run Title> · <agent>",
 * so truncation hid the agent, the only part that differs; under the run's own heading the row leads
 * with the agent instead.
 */
export function memberName(member: Pick<SessionView, "title" | "agentName">, runTitle?: string): string {
  if (!runTitle) return member.title;
  const prefix = `${runTitle} · `;
  if (member.title.startsWith(prefix) && member.title.length > prefix.length) return member.title.slice(prefix.length);
  if (member.agentName && member.title !== runTitle && !member.title.startsWith(member.agentName)) return `${member.agentName} · ${member.title}`;
  return member.agentName && member.title === runTitle ? member.agentName : member.title;
}

/** Whether a worker belongs under Active: still working, waiting, or not verifiably settled. A worker
 * whose runner went offline stays here as Unverified rather than emptying the list. */
export function isCurrentWorker(row: Pick<WorkerRow, "state">): boolean {
  return row.state === "running" || row.state === "queued" || row.state === "awaiting_prompt" ||
    row.state === "attention" || row.state === "unverified";
}

/** Whether a worker is verifiably working or waiting: its elapsed time counts to now, and the session
 * header counts it. An Unverified worker is current but not live. */
export function isLiveWorker(row: Pick<WorkerRow, "state">): boolean {
  return row.state === "running" || row.state === "queued" || row.state === "awaiting_prompt" || row.state === "attention";
}
