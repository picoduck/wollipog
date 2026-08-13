import type { SessionEvent, SessionStatus, SessionView } from "@wollipog/protocol";

export const ACTIVITY_BUCKET_COUNT = 30;
export const ACTIVITY_BUCKET_MS = 60_000;
export const STALL_THRESHOLD_MS = 600_000;

interface ActivityBucket {
  /** Absolute minute tag. Tags make modulo-slot reuse safe for delayed events. */
  minute: number;
  count: number;
}

export interface SessionActivity {
  eventEpoch: number;
  latestMinute: number | null;
  buckets: readonly ActivityBucket[];
  lastEventAt: number | null;
  /** Start of the current uninterrupted busy period; null while not busy. */
  busySince: number | null;
}

const HEARTBEAT_BUSY_STATUSES = new Set<SessionStatus>([
  "queued",
  "starting",
  "running",
  "input_required",
]);

function emptyBuckets(): ActivityBucket[] {
  return Array.from({ length: ACTIVITY_BUCKET_COUNT }, () => ({ minute: -1, count: 0 }));
}

export function emptySessionActivity(eventEpoch = 0, busySince: number | null = null): SessionActivity {
  return {
    eventEpoch,
    latestMinute: null,
    buckets: emptyBuckets(),
    lastEventAt: null,
    busySince,
  };
}

export function isHeartbeatBusy(status: SessionStatus): boolean {
  return HEARTBEAT_BUSY_STATUSES.has(status);
}

function validTimestamp(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function slotForMinute(minute: number): number {
  return minute % ACTIVITY_BUCKET_COUNT;
}

/**
 * Record one event in a fixed tagged ring. The hot path reads and replaces one slot; delayed
 * events inside the visible window are accepted, while older events cannot overwrite a reused
 * modulo slot. The fixed-size array copy is constant work independent of session/event history.
 */
export function recordSessionActivity(
  existing: SessionActivity | undefined,
  ts: number,
  eventEpoch = existing?.eventEpoch ?? 0,
  busySince = existing?.busySince ?? null,
): SessionActivity {
  const base = existing?.eventEpoch === eventEpoch
    ? existing
    : emptySessionActivity(eventEpoch, busySince);
  if (!validTimestamp(ts)) return base;

  const minute = Math.floor(ts / ACTIVITY_BUCKET_MS);
  const latestMinute = base.latestMinute;
  if (latestMinute !== null && minute < latestMinute - ACTIVITY_BUCKET_COUNT + 1) {
    return base;
  }

  const slot = slotForMinute(minute);
  const prior = base.buckets[slot]!;
  // A delayed event exactly one or more complete windows behind shares a slot with newer data.
  // The window check above normally catches it; this tag guard keeps the invariant explicit.
  if (prior.minute > minute) return base;

  const buckets = base.buckets.slice();
  buckets[slot] = prior.minute === minute
    ? { minute, count: prior.count + 1 }
    : { minute, count: 1 };
  return {
    eventEpoch,
    latestMinute: latestMinute === null ? minute : Math.max(latestMinute, minute),
    buckets,
    lastEventAt: base.lastEventAt === null ? ts : Math.max(base.lastEventAt, ts),
    busySince,
  };
}

export function rebuildSessionActivity(
  events: readonly SessionEvent[],
  eventEpoch: number,
  busySince: number | null = null,
): SessionActivity {
  let activity = emptySessionActivity(eventEpoch, busySince);
  for (const event of events) {
    activity = recordSessionActivity(activity, event.ts, eventEpoch, busySince);
  }
  return activity;
}

/** Reconcile authoritative session metadata, compressing missed activity to one tagged pulse. */
export function reconcileSessionActivity(
  existing: SessionActivity | undefined,
  previous: SessionView | undefined,
  next: SessionView,
): SessionActivity {
  const eventEpoch = next.eventEpoch ?? 0;
  const sameEpoch = existing?.eventEpoch === eventEpoch;
  let base = sameEpoch ? existing : emptySessionActivity(eventEpoch);
  const metadataLastEventAt = validTimestamp(next.lastEventAt) ? next.lastEventAt : null;
  // A snapshot can cover activity missed while disconnected. It cannot reconstruct exact counts,
  // but one tagged pulse keeps a running strip from appearing blank and makes the approximation
  // explicit without double-counting a timestamp already seen live.
  if (metadataLastEventAt !== null &&
      (base.lastEventAt === null || metadataLastEventAt > base.lastEventAt)) {
    base = recordSessionActivity(base, metadataLastEventAt, eventEpoch, base.busySince);
  }
  const nextBusy = isHeartbeatBusy(next.status);
  const wasBusy = previous ? isHeartbeatBusy(previous.status) : false;
  const busySince = nextBusy
    ? (wasBusy && base.busySince !== null
        ? base.busySince
        : validTimestamp(next.updatedAt) ? next.updatedAt : null)
    : null;
  const lastEventAt = base.lastEventAt;

  if (base.busySince === busySince && base.lastEventAt === lastEventAt) return base;
  return { ...base, busySince, lastEventAt };
}

/** Oldest-to-newest counts for the thirty one-minute buckets ending at `now`. */
export function activitySeries(activity: SessionActivity | undefined, now: number): readonly number[] {
  if (!activity || !validTimestamp(now)) return Array(ACTIVITY_BUCKET_COUNT).fill(0) as number[];
  const currentMinute = Math.floor(now / ACTIVITY_BUCKET_MS);
  return Array.from({ length: ACTIVITY_BUCKET_COUNT }, (_, index) => {
    const minute = currentMinute - ACTIVITY_BUCKET_COUNT + 1 + index;
    const bucket = activity.buckets[slotForMinute(Math.max(0, minute))];
    return minute >= 0 && bucket?.minute === minute ? bucket.count : 0;
  });
}

export function isSessionStalled(
  session: Pick<SessionView, "status" | "lastEventAt" | "updatedAt">,
  activity: SessionActivity | undefined,
  now: number,
  observable = true,
  observationStartedAt?: number | null,
): boolean {
  if (!observable || !isHeartbeatBusy(session.status) || !validTimestamp(now)) return false;
  const anchors = [
    activity?.lastEventAt,
    session.lastEventAt,
    activity?.busySince ?? session.updatedAt,
    observationStartedAt,
  ]
    .filter(validTimestamp);
  if (anchors.length === 0) return false;
  return now - Math.max(...anchors) >= STALL_THRESHOLD_MS;
}
