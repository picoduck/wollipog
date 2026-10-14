import { RUNNER_CAPABILITY_MIN_PROTOCOL } from "@wollipog/protocol";

/** New clients opt into the new watchdog; legacy clients keep the existing history/log fallback.
 * This is a copy of public delivery projections, never a change to canonical acceptance or audit. */
export function projectBackgroundRetryExhaustionForUi<T>(payload: T, uiProtocolVersion: number | null | undefined, depth = 0): T {
  if ((uiProtocolVersion ?? 0) >= RUNNER_CAPABILITY_MIN_PROTOCOL.backgroundRetryExhaustion || depth > 3 ||
      payload == null || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) {
    const projected = payload.map((value) => projectBackgroundRetryExhaustionForUi(value, uiProtocolVersion, depth + 1));
    return (projected.some((value, index) => value !== payload[index]) ? projected : payload) as T;
  }
  const value = payload as Record<string, unknown>;
  let result: Record<string, unknown> | null = null;
  if (typeof value.id === "string" && "runnerId" in value && Array.isArray(value.backgroundDeliveries)) {
    const deliveries = value.backgroundDeliveries.map((delivery: unknown) => {
      if (!delivery || typeof delivery !== "object") return delivery;
      const record = delivery as Record<string, unknown>;
      if (!("retryExhaustedAt" in record) && !("retryExhaustionAcknowledgedAt" in record) &&
          record.watchdogState !== "capacity_retry_exhausted") return delivery;
      const { retryExhaustedAt: _exhausted, retryExhaustionAcknowledgedAt: _acknowledged, ...legacy } = record;
      if (legacy.watchdogState === "capacity_retry_exhausted") delete legacy.watchdogState;
      return legacy;
    });
    if (deliveries.some((delivery, index) => delivery !== (value.backgroundDeliveries as unknown[])[index])) {
      result = { ...value, backgroundDeliveries: deliveries };
    }
  }
  for (const key of ["session", "sessions", "items"]) {
    if (!(key in value)) continue;
    const child = projectBackgroundRetryExhaustionForUi(value[key], uiProtocolVersion, depth + 1);
    if (child !== value[key]) (result ??= { ...value })[key] = child;
  }
  return (result ?? payload) as T;
}
