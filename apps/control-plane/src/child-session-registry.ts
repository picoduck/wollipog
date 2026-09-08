import {
  pendingRequests,
  type ChildSessionRegistryEntry,
  type ChildSessionRegistryPage,
  type PendingApproval,
  type SessionEvent,
} from "@wollipog/protocol";

const ACTIVE_TOOL_STATUSES = new Set(["pending", "starting", "in_progress", "running", "waiting"]);
type ToolCall = Pick<Extract<SessionEvent["payload"], { kind: "tool_call" }>,
  "toolCallId" | "parentToolUseId" | "toolKind" | "status" | "subagentLifecycle" | "subagentName" | "subagentRole"> &
  { seq: number; ts: number };
type ToolUpdate = Pick<Extract<SessionEvent["payload"], { kind: "tool_call_update" }>,
  "status" | "subagentLifecycle"> & { seq: number; ts: number };

function contentFreeToolLabel(toolKind: unknown): string {
  if (typeof toolKind !== "string") return "Tool";
  switch (toolKind.toLowerCase()) {
    case "read": return "Read";
    case "write":
    case "edit": return "File Change";
    case "bash":
    case "shell":
    case "command":
    case "execute": return "Command";
    case "agent": return "Subagent";
    default: return "Tool";
  }
}

export type StructuredAgentSpawnObservation = Pick<ToolCall,
  "toolCallId" | "parentToolUseId" | "toolKind" | "status" | "subagentLifecycle" | "subagentName" | "subagentRole">;

/** Claude's partial stream and full assistant record legitimately observe one spawn twice. Collapse
 * only compatible structured observations; conflicting identity metadata or a third observation
 * remains ambiguous and therefore cannot own a child or an attention response. */
export function collapseAgentSpawnObservations(
  observations: readonly StructuredAgentSpawnObservation[],
): StructuredAgentSpawnObservation | null {
  if (observations.length < 1 || observations.length > 2 || observations.some((value) => value.toolKind !== "agent")) return null;
  if (observations.length === 2) {
    const [partial, full] = observations;
    if (partial!.toolCallId !== full!.toolCallId || partial!.status !== "pending" || full!.status !== "in_progress" ||
        partial!.parentToolUseId !== full!.parentToolUseId ||
        partial!.subagentLifecycle !== undefined || partial!.subagentName !== undefined ||
        partial!.subagentRole !== undefined || full!.subagentLifecycle !== undefined ||
        full!.subagentName !== undefined) return null;
  }
  const unique = <K extends "parentToolUseId" | "subagentName" | "subagentRole">(key: K) =>
    new Set(observations.flatMap((value) => value[key] ? [value[key]!] : []));
  if (unique("parentToolUseId").size > 1 || unique("subagentName").size > 1 || unique("subagentRole").size > 1) return null;
  const latest = observations.at(-1)!;
  const first = observations[0]!;
  return {
    toolCallId: latest.toolCallId,
    toolKind: "agent",
    status: latest.status,
    ...(latest.parentToolUseId ?? first.parentToolUseId ? { parentToolUseId: latest.parentToolUseId ?? first.parentToolUseId } : {}),
    ...(latest.subagentLifecycle ?? first.subagentLifecycle ? { subagentLifecycle: latest.subagentLifecycle ?? first.subagentLifecycle } : {}),
    ...(latest.subagentName ?? first.subagentName ? { subagentName: latest.subagentName ?? first.subagentName } : {}),
    ...(latest.subagentRole ?? first.subagentRole ? { subagentRole: latest.subagentRole ?? first.subagentRole } : {}),
  };
}

function displayText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

/** Incremental, content-minimizing projection state. The control plane can retain one instance per
 * recently viewed session and append only newly hydrated events instead of re-reading full history
 * for every page. Memory scales with exact child identities, not transcript message/output size. */
export class ChildSessionRegistryProjector {
  private readonly spawns = new Map<string, ToolCall[]>();
  private readonly updates = new Map<string, ToolUpdate>();
  private readonly activity = new Map<string, number>();
  private readonly directTools = new Map<string, Map<string, { seq: number; label: string; status: string }>>();
  private readonly directToolParents = new Map<string, string | null>();

  append(events: readonly SessionEvent[], candidateAgentIds?: ReadonlySet<string>): void {
    const candidates = candidateAgentIds ?? new Set([
      ...this.spawns.keys(),
      ...events.flatMap((event) => event.payload.kind === "tool_call" && event.payload.toolKind === "agent"
        ? [event.payload.toolCallId] : []),
    ]);
    for (const event of events) {
      const payload = event.payload;
      const parentId = "parentToolUseId" in payload && typeof payload.parentToolUseId === "string"
        ? payload.parentToolUseId : undefined;
      if (parentId && candidates.has(parentId)) this.activity.set(parentId, Math.max(this.activity.get(parentId) ?? 0, event.ts));
      if (payload.kind === "tool_call") {
        const call: ToolCall = {
          toolCallId: payload.toolCallId,
          ...(payload.parentToolUseId ? { parentToolUseId: payload.parentToolUseId } : {}),
          toolKind: payload.toolKind,
          status: payload.status,
          ...(payload.subagentLifecycle ? { subagentLifecycle: payload.subagentLifecycle } : {}),
          ...(payload.subagentName ? { subagentName: payload.subagentName } : {}),
          ...(payload.subagentRole ? { subagentRole: payload.subagentRole } : {}),
          seq: event.seq,
          ts: event.ts,
        };
        if (candidates.has(payload.toolCallId)) {
          const observations = this.spawns.get(payload.toolCallId) ?? [];
          if (observations.length < 3) observations.push(call);
          this.spawns.set(payload.toolCallId, observations);
        }
        if (parentId && candidates.has(parentId)) {
          const latest = { seq: event.seq, label: contentFreeToolLabel(payload.toolKind), status: payload.status };
          if (!this.directToolParents.has(payload.toolCallId)) {
            this.directToolParents.set(payload.toolCallId, parentId);
            this.directTools.set(parentId, new Map([
              ...(this.directTools.get(parentId) ?? new Map()),
              [payload.toolCallId, latest],
            ]));
          } else {
            const knownParent = this.directToolParents.get(payload.toolCallId);
            if (knownParent === parentId) {
              const tools = this.directTools.get(parentId)!;
              if ((tools.get(payload.toolCallId)?.seq ?? -1) < event.seq) tools.set(payload.toolCallId, latest);
            } else if (typeof knownParent === "string") {
              this.directTools.get(knownParent)?.delete(payload.toolCallId);
              this.directToolParents.set(payload.toolCallId, null);
            }
          }
        }
      } else if (payload.kind === "tool_call_update") {
        const update: ToolUpdate = { status: payload.status,
          ...(payload.subagentLifecycle ? { subagentLifecycle: payload.subagentLifecycle } : {}),
          seq: event.seq, ts: event.ts };
        if (candidates.has(payload.toolCallId) && (this.updates.get(payload.toolCallId)?.seq ?? -1) < event.seq) {
          this.updates.set(payload.toolCallId, update);
        }
        if (parentId && candidates.has(parentId)) {
          const tools = this.directTools.get(parentId);
          const tool = tools?.get(payload.toolCallId);
          if (tool && tool.seq < event.seq) tools!.set(payload.toolCallId, { ...tool, seq: event.seq, status: payload.status });
        }
      }
    }
  }

  page(pendingApproval: PendingApproval | null, eventEpoch: number, after: number, limit: number): ChildSessionRegistryPage {
    const nodes = new Map<string, ChildSessionRegistryEntry>();
    let unidentifiedChildren = 0;
    for (const [toolCallId, observations] of this.spawns) {
      const identity = collapseAgentSpawnObservations(observations);
      if (!identity) {
        if (observations.some((observation) => observation.toolKind === "agent")) unidentifiedChildren += 1;
        continue;
      }
      const latestSpawn = observations.at(-1)!;
      const spawn = { ...identity, seq: observations[0]!.seq, ts: observations[0]!.ts };
      const latest = this.updates.get(toolCallId);
      const status = latest?.status ?? latestSpawn.status;
      const lifecycle = latest?.subagentLifecycle ?? latestSpawn.subagentLifecycle ?? spawn.subagentLifecycle;
      const tools = this.directTools.get(toolCallId);
      const latestTool = tools ? [...tools.values()].reduce((selected, candidate) =>
        !selected || candidate.seq > selected.seq ? candidate : selected, undefined as { seq: number; label: string; status: string } | undefined) : undefined;
      const terminal = lifecycle === "completed" || lifecycle === "failed" || lifecycle === "interrupted" ||
        ["completed", "success", "succeeded", "failed", "error", "rejected", "cancelled", "canceled"].includes(status.toLowerCase());
      nodes.set(toolCallId, {
        toolCallId,
        ...(spawn.parentToolUseId ? { parentToolUseId: spawn.parentToolUseId } : {}),
        name: displayText(spawn.subagentName, 80) ?? "Subagent",
        ...(displayText(spawn.subagentRole, 48) ? { role: displayText(spawn.subagentRole, 48) } : {}),
        status,
        ...(lifecycle ? { lifecycle } : {}),
        sourceSeq: spawn.seq,
        startedAt: spawn.ts,
        lastActivityAt: Math.max(spawn.ts, latest?.ts ?? 0, this.activity.get(toolCallId) ?? 0),
        ...(terminal ? { completedAt: Math.max(latest?.ts ?? 0, this.activity.get(toolCallId) ?? 0, spawn.ts) } : {}),
        toolCount: tools?.size ?? 0,
        ...(latestTool ? { latestTool: {
          title: latestTool.label,
          active: ACTIVE_TOOL_STATUSES.has(latestTool.status.toLowerCase()),
        } } : {}),
      });
    }

    const cyclic = new Set<string>();
    for (const id of nodes.keys()) {
      const path: string[] = [];
      let cursor: string | undefined = id;
      while (cursor && nodes.has(cursor)) {
        const at = path.indexOf(cursor);
        if (at >= 0) { for (const member of path.slice(at)) cyclic.add(member); break; }
        path.push(cursor);
        cursor = nodes.get(cursor)?.parentToolUseId;
      }
    }
    for (const id of cyclic) {
      const node = nodes.get(id);
      if (node) delete node.parentToolUseId;
    }

    const ordered = [...nodes.values()].sort((a, b) => a.sourceSeq - b.sourceSeq || a.toolCallId.localeCompare(b.toolCallId));
    const eligible = ordered.filter((child) => child.sourceSeq > after);
    const children = eligible.slice(0, limit);
    const truncated = eligible.length > children.length;
    const attentionOwners = pendingRequests(pendingApproval).flatMap((request) => {
      if (!request.ownerToolUseId) return [];
      const child = nodes.get(request.ownerToolUseId);
      return [{
        requestId: request.requestId,
        toolCallId: request.ownerToolUseId,
        resolved: child !== undefined,
        ...(child ? { name: child.name, ...(child.role ? { role: child.role } : {}) } : {}),
      }];
    });
    return {
      children,
      attentionOwners,
      unidentifiedChildren,
      eventEpoch,
      nextAfter: truncated ? children.at(-1)?.sourceSeq ?? after : null,
      truncated,
    };
  }
}

export function projectChildSessionRegistry(
  events: readonly SessionEvent[],
  pendingApproval: PendingApproval | null,
  eventEpoch: number,
  after: number,
  limit: number,
): ChildSessionRegistryPage {
  const projector = new ChildSessionRegistryProjector();
  const candidateAgentIds = new Set(events.flatMap((event) =>
    event.payload.kind === "tool_call" && event.payload.toolKind === "agent" ? [event.payload.toolCallId] : []));
  projector.append(events, candidateAgentIds);
  return projector.page(pendingApproval, eventEpoch, after, limit);
}
