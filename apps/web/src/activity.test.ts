import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent, SessionView } from "@wollipog/protocol";
import {
  ACTIVITY_BUCKET_COUNT,
  ACTIVITY_BUCKET_MS,
  activitySeries,
  emptySessionActivity,
  hasRecentActivity,
  isHeartbeatBusy,
  rebuildSessionActivity,
  reconcileSessionActivity,
  recordSessionActivity,
  showsActivityStrip,
} from "./activity.js";

const event = (seq: number, ts: number): SessionEvent => ({
  id: seq,
  sessionId: "s1",
  seq,
  ts,
  payload: { kind: "agent_message", text: String(seq) },
});

const session = (overrides: Partial<SessionView> = {}): SessionView => ({
  id: "s1",
  status: "running",
  updatedAt: 0,
  lastEventAt: null,
  eventEpoch: 0,
  ...overrides,
} as SessionView);

test("activity ring aggregates one-minute buckets and wraps without retaining expired counts", () => {
  let activity = recordSessionActivity(undefined, 10, 0);
  activity = recordSessionActivity(activity, ACTIVITY_BUCKET_MS - 1);
  activity = recordSessionActivity(activity, ACTIVITY_BUCKET_MS + 1);
  assert.deepEqual(activitySeries(activity, ACTIVITY_BUCKET_MS + 1).slice(-2), [2, 1]);

  const wrappedAt = ACTIVITY_BUCKET_COUNT * ACTIVITY_BUCKET_MS;
  activity = recordSessionActivity(activity, wrappedAt);
  const series = activitySeries(activity, wrappedAt);
  assert.equal(series.length, ACTIVITY_BUCKET_COUNT);
  assert.equal(series[0], 1, "minute one remains at the start of the new window");
  assert.equal(series.at(-1), 1, "the reused minute-zero slot contains only minute thirty");
  assert.equal(series.reduce((sum, count) => sum + count, 0), 2);
});

test("activity ring accepts delayed events inside its window and rejects older collisions", () => {
  const latestTs = 40 * ACTIVITY_BUCKET_MS;
  let activity = recordSessionActivity(undefined, latestTs);
  activity = recordSessionActivity(activity, 20 * ACTIVITY_BUCKET_MS);
  assert.equal(activitySeries(activity, latestTs)[9], 1);
  const retained = activity;
  activity = recordSessionActivity(activity, 10 * ACTIVITY_BUCKET_MS);
  assert.equal(activity, retained, "an event outside the thirty-minute window is ignored");
  assert.equal(activity.lastEventAt, latestTs);
});

test("rebuild is order-independent within the retained window and epoch changes clear old slots", () => {
  const rebuilt = rebuildSessionActivity([
    event(2, 12 * ACTIVITY_BUCKET_MS),
    event(1, 11 * ACTIVITY_BUCKET_MS),
  ], 3);
  assert.deepEqual(activitySeries(rebuilt, 12 * ACTIVITY_BUCKET_MS).slice(-2), [1, 1]);
  const reset = recordSessionActivity(rebuilt, 20 * ACTIVITY_BUCKET_MS, 4);
  assert.equal(reset.eventEpoch, 4);
  assert.equal(activitySeries(reset, 20 * ACTIVITY_BUCKET_MS).reduce((sum, count) => sum + count, 0), 1);
});

test("snapshot reconciliation seeds one pulse and does not duplicate an already-seen timestamp", () => {
  const snapshot = session({ updatedAt: 1_000, lastEventAt: 5 * ACTIVITY_BUCKET_MS });
  const seeded = reconcileSessionActivity(undefined, undefined, snapshot);
  assert.equal(activitySeries(seeded, snapshot.lastEventAt!).at(-1), 1);
  const repeated = reconcileSessionActivity(seeded, snapshot, snapshot);
  assert.equal(activitySeries(repeated, snapshot.lastEventAt!).at(-1), 1);
});

test("heartbeat busy status taxonomy is explicit", () => {
  for (const status of ["queued", "starting", "running", "input_required"] as const) {
    assert.equal(isHeartbeatBusy(status), true);
  }
  for (const status of ["idle", "completed", "failed", "stopped"] as const) {
    assert.equal(isHeartbeatBusy(status), false);
  }
});

test("the activity strip shows while Running or Starting, or for ten minutes after tool activity (#2209)", () => {
  const now = 1_000 * ACTIVITY_BUCKET_MS + 30_000;
  const minutesAgo = (minutes: number) => recordSessionActivity(undefined, now - minutes * ACTIVITY_BUCKET_MS);
  for (const status of ["running", "starting"] as const) {
    assert.equal(showsActivityStrip(status, undefined, now), true, `${status} always shows the strip`);
  }
  for (const status of ["queued", "input_required", "idle", "completed", "failed", "stopped"] as const) {
    assert.equal(showsActivityStrip(status, undefined, now), false, `${status} with no activity shows none`);
    assert.equal(showsActivityStrip(status, minutesAgo(11), now), false, `${status} 11 minutes after activity shows none`);
    assert.equal(showsActivityStrip(status, minutesAgo(9), now), true, `${status} 9 minutes after activity shows it`);
  }
  // The newest ten one-minute buckets: the current minute counts, ten whole minutes back does not.
  assert.equal(hasRecentActivity(minutesAgo(0), now), true);
  assert.equal(hasRecentActivity(minutesAgo(9), now), true);
  assert.equal(hasRecentActivity(minutesAgo(9), now + ACTIVITY_BUCKET_MS), false, "it lapses once ten minutes pass");
  assert.equal(hasRecentActivity(minutesAgo(10), now), false);
  assert.equal(hasRecentActivity(undefined, now), false);
  // A row that does not read the clock passes 0: an event in the first minute of 1970 is not recent.
  assert.equal(hasRecentActivity(recordSessionActivity(undefined, 10), 0), false);
  assert.equal(showsActivityStrip("idle", recordSessionActivity(undefined, 10), 0), false);
});
