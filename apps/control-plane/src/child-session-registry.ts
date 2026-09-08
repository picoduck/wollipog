import {
  pendingRequests,
  type ChildSessionRegistryEntry,
  type ChildSessionRegistryPage,
  type PendingApproval,
  type SessionEvent,
} from "@wollipog/protocol";

const ACTIVE_TOOL_STATUSES = new Set(["pending", "starting", "in_progress", "running", "waiting"]);

function displayText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

/** Derive only from normalized structured events. No transcript text, process ids, provider thread
 * ids, or event proximity participates in child identity or ancestry. */
export function projectChildSessionRegistry(
  events: readonly SessionEvent[],
  pendingApproval: PendingApproval | null,
  eventEpoch: number,
  after: number,
  limit: number,
): ChildSessionRegistryPage {
  const spawns = new Map<string, Array<Extract<SessionEvent["payload"], { kind: "tool_call" }> & { seq: number; ts: number }>>();
  const updates = new Map<string, Array<Extract<SessionEvent["payload"], { kind: "tool_call_update" }> & { seq: number; ts: number }>>();
  const activity = new Map<string, number>();
  const directTools = new Map<string, Array<{ seq: number; ts: number; title: string; status: string }>>();

  for (const event of events) {
    const payload = event.payload;
    const parentId = "parentToolUseId" in payload && typeof payload.parentToolUseId === "string"
      ? payload.parentToolUseId : undefined;
    if (parentId) activity.set(parentId, Math.max(activity.get(parentId) ?? 0, event.ts));
    if (payload.kind === "tool_call") {
      const values = spawns.get(payload.toolCallId) ?? [];
      values.push({ ...payload, seq: event.seq, ts: event.ts });
      spawns.set(payload.toolCallId, values);
      if (parentId) {
        const tools = directTools.get(parentId) ?? [];
        tools.push({ seq: event.seq, ts: event.ts, title: displayText(payload.title, 120) ?? "Tool", status: payload.status });
        directTools.set(parentId, tools);
      }
    } else if (payload.kind === "tool_call_update") {
      const values = updates.get(payload.toolCallId) ?? [];
      values.push({ ...payload, seq: event.seq, ts: event.ts });
      updates.set(payload.toolCallId, values);
    }
  }

  const nodes = new Map<string, ChildSessionRegistryEntry>();
  for (const [toolCallId, occurrences] of spawns) {
    if (occurrences.length !== 1) continue;
    const spawn = occurrences[0]!;
    if (spawn.toolKind !== "agent") continue;
    const latest = [...(updates.get(toolCallId) ?? [])].sort((a, b) => a.seq - b.seq).at(-1);
    const status = latest?.status ?? spawn.status;
    const lifecycle = latest?.subagentLifecycle ?? spawn.subagentLifecycle;
    const tools = [...(directTools.get(toolCallId) ?? [])].sort((a, b) => a.seq - b.seq);
    const latestTool = tools.at(-1);
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
      lastActivityAt: Math.max(spawn.ts, latest?.ts ?? 0, activity.get(toolCallId) ?? 0),
      ...(terminal ? { completedAt: Math.max(latest?.ts ?? 0, activity.get(toolCallId) ?? 0, spawn.ts) } : {}),
      toolCount: tools.length,
      ...(latestTool ? { latestTool: {
        title: latestTool.title,
        active: ACTIVE_TOOL_STATUSES.has(latestTool.status.toLowerCase()),
      } } : {}),
    });
  }

  // Cyclic structured ancestry is malformed. Keep each exact child visible, but clear every
  // parent claim in the cycle so no row falsely owns another.
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
  const pageChildren = eligible.slice(0, limit);
  const truncated = eligible.length > pageChildren.length;
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
  const forcedIds = new Set(attentionOwners.filter((owner) => owner.resolved).map((owner) => owner.toolCallId));
  const forced = ordered.filter((child) => forcedIds.has(child.toolCallId));
  const children = [...forced, ...pageChildren.filter((child) => !forcedIds.has(child.toolCallId))];
  return {
    children,
    attentionOwners,
    eventEpoch,
    nextAfter: truncated ? pageChildren.at(-1)?.sourceSeq ?? after : null,
    truncated,
  };
}
