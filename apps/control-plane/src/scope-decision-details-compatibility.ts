import { RUNNER_CAPABILITY_MIN_PROTOCOL } from "@wollipog/protocol";

/** A pre-change dashboard cannot interpret settledOutcome. Preserve its missing-detail fallback
 * rather than let it render a settled row's legacy approval/armed fields as live authority. */
export function projectScopeDecisionDetailsForUi<T>(payload: T, protocol: number | null | undefined, depth = 0): T {
  if ((protocol ?? 0) >= RUNNER_CAPABILITY_MIN_PROTOCOL.scopeSettledDecisionDetails || depth > 8 ||
      payload == null || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) {
    const next = payload.map(value => projectScopeDecisionDetailsForUi(value, protocol, depth + 1));
    return (next.some((value, index) => value !== payload[index]) ? next : payload) as T;
  }
  const record = payload as Record<string, unknown>;
  let result: Record<string, unknown> | null = null;
  if (Array.isArray(record.scopeDecisionDetails)) {
    const details = record.scopeDecisionDetails.filter(detail => !detail || typeof detail !== "object" || !("settledOutcome" in detail));
    if (details.length !== record.scopeDecisionDetails.length) result = { ...record, scopeDecisionDetails: details };
  }
  // Only delivery envelopes and request containers; never walk decision snapshots or user text.
  for (const key of ["session", "sessions", "items", "pendingApproval", "additionalRequests", "requests", "request"]) {
    if (!(key in record)) continue;
    const child = projectScopeDecisionDetailsForUi(record[key], protocol, depth + 1);
    if (child !== record[key]) (result ??= { ...record })[key] = child;
  }
  return (result ?? payload) as T;
}
