import type { SessionEvent, SessionStatus, SessionView } from "@wollipog/protocol";

export const ACTIVITY_BUCKET_COUNT = 30;
export const ACTIVITY_BUCKET_MS = 60_000;

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

export function emptySessionActivity(eventEpoch = 0): SessionActivity {
  return {
    eventEpoch,
    latestMinute: null,
    buckets: emptyBuckets(),
    lastEventAt: null,
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
): SessionActivity {
  const base = existing?.eventEpoch === eventEpoch
    ? existing
    : emptySessionActivity(eventEpoch);
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
  };
}

export function rebuildSessionActivity(
  events: readonly SessionEvent[],
  eventEpoch: number,
): SessionActivity {
  let activity = emptySessionActivity(eventEpoch);
  for (const event of events) {
    activity = recordSessionActivity(activity, event.ts, eventEpoch);
  }
  return activity;
}

/** Reconcile authoritative session metadata, compressing missed activity to one tagged pulse. */
export function reconcileSessionActivity(
  existing: SessionActivity | undefined,
  _previous: SessionView | undefined,
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
    base = recordSessionActivity(base, metadataLastEventAt, eventEpoch);
  }
  return base;
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

/** How many of the newest one-minute buckets count as recent tool activity (#2209). */
export const RECENT_ACTIVITY_BUCKETS = 10;

/**
 * Tool activity in the last ten minutes: a non-zero count in the newest ten buckets of `activitySeries()`.
 * A `now` of 0 is a row that does not read the clock (InboxList), never the first minute of 1970, so
 * an event stamped then is not recent.
 */
export function hasRecentActivity(activity: SessionActivity | undefined, now: number): boolean {
  if (now <= 0) return false;
  return activitySeries(activity, now).slice(-RECENT_ACTIVITY_BUCKETS).some((count) => count > 0);
}

/**
 * Whether a Sessions row or Board card draws the activity strip (#2209): while the session is Running
 * or Starting, or had tool activity in the last ten minutes. Every other session is idle and draws
 * none. Unlike `isHeartbeatBusy()`, Queued and Awaiting Input do not count on their own.
 */
export function showsActivityStrip(status: SessionStatus, activity: SessionActivity | undefined, now: number): boolean {
  return status === "running" || status === "starting" || hasRecentActivity(activity, now);
}
