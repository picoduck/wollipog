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
  const requests = pendingRequests(current);
  const { additionalRequests: _rest, ...single } = next;
  if (!single.ownerToolUseId && !requests.some((request) => request.ownerToolUseId)) return single;
  return packRequests([...requests.filter((request) => request.requestId !== next.requestId), single])!;
}

export function removePendingRequest(current: PendingApproval | null | undefined, requestId: string): PendingApproval | null {
  return packRequests(pendingRequests(current).filter((request) => request.requestId !== requestId));
}

