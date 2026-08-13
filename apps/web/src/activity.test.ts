import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent, SessionView } from "@wollipog/protocol";
import {
  ACTIVITY_BUCKET_COUNT,
  ACTIVITY_BUCKET_MS,
  STALL_THRESHOLD_MS,
  activitySeries,
  emptySessionActivity,
  isHeartbeatBusy,
  isSessionStalled,
  rebuildSessionActivity,
  reconcileSessionActivity,
  recordSessionActivity,
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
  let activity = recordSessionActivity(undefined, 10, 0, 0);
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
  ], 3, 100);
  assert.deepEqual(activitySeries(rebuilt, 12 * ACTIVITY_BUCKET_MS).slice(-2), [1, 1]);
  const reset = recordSessionActivity(rebuilt, 20 * ACTIVITY_BUCKET_MS, 4, 200);
  assert.equal(reset.eventEpoch, 4);
  assert.equal(activitySeries(reset, 20 * ACTIVITY_BUCKET_MS).reduce((sum, count) => sum + count, 0), 1);
});

test("busy reconciliation preserves one busy period and starts a fresh one after idle", () => {
  const started = reconcileSessionActivity(undefined, undefined, session({ updatedAt: 1_000 }));
  assert.equal(started.busySince, 1_000);
  const metadata = reconcileSessionActivity(started, session({ updatedAt: 1_000 }), session({ updatedAt: 2_000 }));
  assert.equal(metadata.busySince, 1_000, "busy metadata updates do not postpone stall detection");
  const idle = reconcileSessionActivity(metadata, session({ status: "running" }), session({ status: "idle", updatedAt: 3_000 }));
  assert.equal(idle.busySince, null);
  const restarted = reconcileSessionActivity(idle, session({ status: "idle" }), session({ status: "queued", updatedAt: 4_000 }));
  assert.equal(restarted.busySince, 4_000);
});

test("snapshot reconciliation seeds one pulse and does not duplicate an already-seen timestamp", () => {
  const snapshot = session({ updatedAt: 1_000, lastEventAt: 5 * ACTIVITY_BUCKET_MS });
  const seeded = reconcileSessionActivity(undefined, undefined, snapshot);
  assert.equal(activitySeries(seeded, snapshot.lastEventAt!).at(-1), 1);
  const repeated = reconcileSessionActivity(seeded, snapshot, snapshot);
  assert.equal(activitySeries(repeated, snapshot.lastEventAt!).at(-1), 1);
});

test("stall detection uses the exact threshold, resets on activity, and requires observability", () => {
  const busy = session({ updatedAt: 1_000 });
  const activity = reconcileSessionActivity(emptySessionActivity(), undefined, busy);
  assert.equal(isSessionStalled(busy, activity, 1_000 + STALL_THRESHOLD_MS - 1), false);
  assert.equal(isSessionStalled(busy, activity, 1_000 + STALL_THRESHOLD_MS), true);
  const active = recordSessionActivity(activity, 1_000 + STALL_THRESHOLD_MS - 10);
  assert.equal(isSessionStalled(busy, active, 1_000 + STALL_THRESHOLD_MS), false);
  assert.equal(isSessionStalled(busy, activity, 1_000 + STALL_THRESHOLD_MS, false), false);
  assert.equal(isSessionStalled(session({ status: "idle" }), activity, 99_000_000), false);
  assert.equal(isSessionStalled(session({ status: "input_required" }), activity, 1_000 + STALL_THRESHOLD_MS), true);
  const metadataDuringBusy = session({ updatedAt: 1_000 + STALL_THRESHOLD_MS - 1 });
  assert.equal(isSessionStalled(metadataDuringBusy, activity, 1_000 + STALL_THRESHOLD_MS), true,
    "a busy-to-busy metadata update cannot postpone the original busy period");
  assert.equal(isSessionStalled(busy, activity, 1_000 + STALL_THRESHOLD_MS, true, 1_001), false,
    "a newly observable stream gets a full threshold before it may be called stalled");
  assert.equal(isSessionStalled(busy, activity, 1_001 + STALL_THRESHOLD_MS, true, 1_001), true);
});

test("heartbeat busy status taxonomy is explicit", () => {
  for (const status of ["queued", "starting", "running", "input_required"] as const) {
    assert.equal(isHeartbeatBusy(status), true);
  }
  for (const status of ["idle", "completed", "failed", "stopped"] as const) {
    assert.equal(isHeartbeatBusy(status), false);
  }
});
