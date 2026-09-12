import type { PendingApproval } from "./index.js";

/** Flatten one level only: malformed recursive metadata can never expand the action inventory. */
export function pendingRequests(pending: PendingApproval | null | undefined): PendingApproval[] {
  if (!pending) return [];
  const seen = new Set<string>();
  return [pending, ...(Array.isArray(pending.additionalRequests) ? pending.additionalRequests : [])]
    .filter((request) => {
      if (!request || typeof request.requestId !== "string" || seen.has(request.requestId)) return false;
      seen.add(request.requestId);
      return true;
    })
    .map(({ additionalRequests: _rest, ...request }) => request);
}

function packRequests(requests: PendingApproval[]): PendingApproval | null {
  const [first, ...rest] = requests;
  return first ? { ...first, ...(rest.length ? { additionalRequests: rest } : {}) } : null;
}

/** Only provider-owned child requests may coexist; legacy parent replacement remains unchanged. */
export function addPendingRequest(current: PendingApproval | null | undefined, next: PendingApproval): PendingApproval {
  // CP-only policy cards keep their existing single-slot barrier/displacement semantics.
  const requests = pendingRequests(current).filter((request) =>
    request.kind == null || ["permission", "question", "authentication"].includes(request.kind));
  const { additionalRequests: _rest, ...single } = next;
  if (!single.ownerToolUseId && !requests.some((request) => request.ownerToolUseId)) return single;
  return packRequests([...requests.filter((request) =>
    request.requestId !== next.requestId && (single.ownerToolUseId || request.ownerToolUseId)), single])!;
}

/**
 * How much of the session a request blocks, as a rank the list can order by. Lower is more urgent:
 * a request that stops the whole session (a restart to recover from, a sign-in, a guardrail pause)
 * outranks a question, which outranks a single tool's permission. Arrival order breaks ties, so
 * two requests of one rank keep the oldest first.
 */
export function attentionRequestRank(request: Pick<PendingApproval, "kind" | "recoveryReason">): number {
  if (request.kind === "question" && request.recoveryReason === "provider_restart") return 0;
  if (request.kind === "authentication") return 1;
  if (request.kind === "cost_budget" || request.kind === "cost_checkpoint" || request.kind === "cost_unpriced" ||
      request.kind === "daily_budget" || request.kind === "max_tool_calls") return 2;
  if (request.kind === "question") return 3;
  return 4;
}

/** The flattened requests in priority order: rank first, then arrival, which is the array order. */
export function prioritizedPendingRequests(pending: PendingApproval | null | undefined): PendingApproval[] {
  return pendingRequests(pending)
    .map((request, index) => ({ request, index }))
    .sort((left, right) => attentionRequestRank(left.request) - attentionRequestRank(right.request) || left.index - right.index)
    .map(({ request }) => request);
}

export function removePendingRequest(current: PendingApproval | null | undefined, requestId: string): PendingApproval | null {
  return packRequests(pendingRequests(current).filter((request) => request.requestId !== requestId));
}
