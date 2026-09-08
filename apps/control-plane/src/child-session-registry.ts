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
  private readonly spawns = new Map<string, { count: number; sawAgent: boolean; firstAgent?: ToolCall }>();
  private readonly updates = new Map<string, ToolUpdate>();
  private readonly activity = new Map<string, number>();
  private readonly directTools = new Map<string, { count: number; latest: { seq: number; title: string; status: string } }>();

  append(events: readonly SessionEvent[]): void {
    for (const event of events) {
      const payload = event.payload;
      const parentId = "parentToolUseId" in payload && typeof payload.parentToolUseId === "string"
        ? payload.parentToolUseId : undefined;
      if (parentId) this.activity.set(parentId, Math.max(this.activity.get(parentId) ?? 0, event.ts));
      if (payload.kind === "tool_call") {
        const call: ToolCall | undefined = payload.toolKind === "agent" ? {
          toolCallId: payload.toolCallId,
          ...(payload.parentToolUseId ? { parentToolUseId: payload.parentToolUseId } : {}),
          toolKind: payload.toolKind,
          status: payload.status,
          ...(payload.subagentLifecycle ? { subagentLifecycle: payload.subagentLifecycle } : {}),
          ...(payload.subagentName ? { subagentName: payload.subagentName } : {}),
          ...(payload.subagentRole ? { subagentRole: payload.subagentRole } : {}),
          seq: event.seq,
          ts: event.ts,
        } : undefined;
        const existing = this.spawns.get(payload.toolCallId);
        if (existing) {
          existing.count += 1;
          existing.sawAgent ||= payload.toolKind === "agent";
          existing.firstAgent ??= call;
        } else {
          this.spawns.set(payload.toolCallId, { count: 1, sawAgent: payload.toolKind === "agent",
            ...(call ? { firstAgent: call } : {}) });
        }
        if (parentId) {
          const latest = { seq: event.seq, title: displayText(payload.title, 120) ?? "Tool", status: payload.status };
          const summary = this.directTools.get(parentId);
          if (summary) {
            summary.count += 1;
            if (latest.seq > summary.latest.seq) summary.latest = latest;
          } else {
            this.directTools.set(parentId, { count: 1, latest });
          }
        }
      } else if (payload.kind === "tool_call_update") {
        const update: ToolUpdate = { status: payload.status,
          ...(payload.subagentLifecycle ? { subagentLifecycle: payload.subagentLifecycle } : {}),
          seq: event.seq, ts: event.ts };
        if ((this.updates.get(payload.toolCallId)?.seq ?? -1) < event.seq) this.updates.set(payload.toolCallId, update);
      }
    }
  }

  page(pendingApproval: PendingApproval | null, eventEpoch: number, after: number, limit: number): ChildSessionRegistryPage {
    const nodes = new Map<string, ChildSessionRegistryEntry>();
    let unidentifiedChildren = 0;
    for (const [toolCallId, occurrence] of this.spawns) {
      if (occurrence.count !== 1) {
        if (occurrence.sawAgent) unidentifiedChildren += 1;
        continue;
      }
      const spawn = occurrence.firstAgent;
      if (!spawn) continue;
      const latest = this.updates.get(toolCallId);
      const status = latest?.status ?? spawn.status;
      const lifecycle = latest?.subagentLifecycle ?? spawn.subagentLifecycle;
      const tools = this.directTools.get(toolCallId);
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
        toolCount: tools?.count ?? 0,
        ...(tools ? { latestTool: {
          title: tools.latest.title,
          active: ACTIVE_TOOL_STATUSES.has(tools.latest.status.toLowerCase()),
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
  projector.append(events);
  return projector.page(pendingApproval, eventEpoch, after, limit);
}
