import assert from "node:assert/strict";
import { test } from "node:test";
import type { ControlPlaneToUi, PodView, SessionEvent, SessionView, SteeringAttemptView } from "@wollipog/protocol";
import { Store } from "./store.js";
import { ACTIVITY_BUCKET_MS, activitySeries } from "./activity.js";

const session = (id: string, eventEpoch = 0): SessionView => ({ id, eventEpoch } as SessionView);
const event = (sessionId: string, seq: number): SessionEvent => ({
  id: seq,
  sessionId,
  seq,
  ts: seq,
  payload: { kind: "agent_message", text: `${sessionId}:${seq}` },
});
const pod = (members: string[]): PodView => ({
  id: "pod-1",
  members: members.map((sessionId) => ({ sessionId })),
} as PodView);

function message(store: Store, msg: ControlPlaneToUi, now?: number): void {
  store.dispatch({ type: "msg", msg, now });
}

test("session upserts retain and clear the projected interruption queue hold", () => {
  const store = new Store();
  message(store, {
    type: "snapshot", runners: [], boxes: [], sessions: [session("s1")], runs: [], pods: [],
  });
  message(store, {
    type: "session_upsert",
    session: { ...session("s1"), queued: [{ id: "prompt-b", text: "B" }], queueHeld: true },
  });
  assert.equal(store.getState().sessions.get("s1")?.queueHeld, true);
  assert.deepEqual(store.getState().sessions.get("s1")?.queued, [{ id: "prompt-b", text: "B" }]);

  message(store, {
    type: "session_upsert",
    session: { ...session("s1"), queued: [{ id: "prompt-b", text: "B" }] },
  });
  assert.equal(store.getState().sessions.get("s1")?.queueHeld, undefined);
});

test("authoritative snapshots replace durable steering receipts and queue reservation state without duplication", () => {
  const store = new Store();
  const pending: SteeringAttemptView = {
    submissionId: "submission-1",
    turnId: "turn-1",
    source: "queued",
    sourceQueueId: "queue-1",
    text: "Steer the active turn",
    state: "pending",
    createdAt: 1,
    updatedAt: 1,
  };
  message(store, {
    type: "snapshot",
    runners: [],
    boxes: [],
    sessions: [{
      ...session("s1"),
      queued: [{ id: "queue-1", text: pending.text, steerable: true, steeringState: "promoting" }],
      steeringAttempts: [pending],
    }],
    runs: [],
    pods: [],
  });

  const accepted: SteeringAttemptView = { ...pending, state: "accepted", reason: "accepted", updatedAt: 2 };
  message(store, {
    type: "session_upsert",
    session: { ...session("s1"), queued: [], steeringAttempts: [accepted] },
  });
  assert.deepEqual(store.getState().sessions.get("s1")?.steeringAttempts, [accepted]);
  message(store, {
    type: "snapshot",
    runners: [],
    boxes: [],
    sessions: [{ ...session("s1"), queued: [], steeringAttempts: [accepted] }],
    runs: [],
    pods: [],
  });
  assert.deepEqual(store.getState().sessions.get("s1")?.steeringAttempts, [accepted]);

  const uncertain: SteeringAttemptView = {
    ...pending,
    state: "uncertain",
    reason: "transport_uncertain",
    updatedAt: 3,
  };
  const replacement: SessionView = {
    ...session("s1"),
    queued: [{ id: "queue-1", text: pending.text, steerable: false, steeringState: "uncertain" }],
    steeringAttempts: [uncertain],
  };
  message(store, {
    type: "snapshot", runners: [], boxes: [], sessions: [replacement], runs: [], pods: [],
  });
  message(store, {
    type: "snapshot", runners: [], boxes: [], sessions: [replacement], runs: [], pods: [],
  });

  assert.deepEqual(store.getState().sessions.get("s1")?.steeringAttempts, [uncertain]);
  assert.deepEqual(store.getState().sessions.get("s1")?.queued, replacement.queued);

  const resolutionPending: SteeringAttemptView = {
    ...uncertain,
    resolution: { action: "queue_again", state: "pending" },
    updatedAt: 4,
  };
  message(store, {
    type: "snapshot",
    runners: [],
    boxes: [],
    sessions: [{ ...replacement, steeringAttempts: [resolutionPending] }],
    runs: [],
    pods: [],
  });
  assert.deepEqual(store.getState().sessions.get("s1")?.steeringAttempts, [resolutionPending]);

  const resolutionApplied: SteeringAttemptView = {
    ...resolutionPending,
    resolution: { action: "queue_again", state: "applied", queuedPromptId: "queue-1" },
    updatedAt: 5,
  };
  message(store, {
    type: "snapshot",
    runners: [],
    boxes: [],
    sessions: [{ ...replacement, steeringAttempts: [resolutionApplied] }],
    runs: [],
    pods: [],
  });
  assert.deepEqual(store.getState().sessions.get("s1")?.steeringAttempts, [resolutionApplied]);

  message(store, {
    type: "snapshot",
    runners: [],
    boxes: [],
    sessions: [{ ...session("s1"), queued: [] }],
    runs: [],
    pods: [],
  });
  assert.equal(store.getState().sessions.get("s1")?.steeringAttempts, undefined);
});

test("subscription capabilities and applied acknowledgement form a reconnect recovery epoch", () => {
  const store = new Store();
  store.dispatch({ type: "conn", conn: "connecting" });
  message(store, {
    type: "snapshot",
    capabilities: { sessionSubscriptions: true, boundedDelivery: true },
    runners: [], boxes: [], sessions: [], runs: [], pods: [],
  });
  assert.equal(store.getState().streamSubscriptions.mode, "targeted");
  assert.equal(store.getState().streamSubscriptions.appliedRevision, 0);

  store.prepareSubscriptionRecovery(2, ["s2", "s1"]);
  message(store, {
    type: "session_subscriptions_applied",
    revision: 2,
    sessionIds: ["s2", "s1"],
    podIds: ["pod-1"],
  });
  assert.deepEqual(store.getState().streamSubscriptions, {
    mode: "targeted", requestedRevision: 2, appliedRevision: 2,
    sessionIds: ["s2", "s1"], podIds: ["pod-1"],
  });
  message(store, {
    type: "session_subscriptions_applied", revision: 1, sessionIds: ["stale"], podIds: [],
  });
  assert.equal(store.getState().streamSubscriptions.appliedRevision, 2, "stale ack cannot regress selection");

  store.dispatch({ type: "conn", conn: "offline" });
  assert.deepEqual(store.getState().streamSubscriptions, {
    mode: "unknown", requestedRevision: 0, appliedRevision: 0, sessionIds: [], podIds: [],
  });

  const legacy = new Store();
  message(legacy, { type: "snapshot", runners: [], boxes: [], sessions: [], runs: [], pods: [] });
  assert.deepEqual(legacy.getState().streamSubscriptions, {
    mode: "legacy", requestedRevision: 0, appliedRevision: 0, sessionIds: [], podIds: [],
  }, "an old control plane without capability metadata keeps immediate legacy recovery");
});

test("targeted recovery keeps the pre-subscription cursor when a newer live event wins the ack race", () => {
  const store = new Store();
  message(store, {
    type: "snapshot",
    capabilities: { sessionSubscriptions: true, boundedDelivery: true },
    runners: [], boxes: [], sessions: [session("s1")], runs: [], pods: [],
  });
  store.navigate({ name: "session", id: "s1" });
  store.loadEvents("s1", Array.from({ length: 10 }, (_, i) => event("s1", i + 1)));

  store.prepareSubscriptionRecovery(1, ["s1"]);
  message(store, {
    type: "session_subscriptions_applied", revision: 1, sessionIds: ["s1"], podIds: [],
  });
  store.beginEventHistoryLoad("s1", 0, 1);
  message(store, { type: "session_event", event: event("s1", 21) });

  assert.equal(store.eventHighWater("s1"), 21);
  assert.equal(store.recoveryAfter("s1"), 10, "live delivery cannot skip outage events 11-20");
  store.loadEvents("s1", Array.from({ length: 11 }, (_, i) => event("s1", i + 11)), 0, 1);
  assert.deepEqual(store.getState().events.get("s1")?.map((entry) => entry.seq),
    Array.from({ length: 21 }, (_, i) => i + 1));
  assert.equal(store.recoveryAfter("s1"), 21, "a completed recovery is consumed for later upserts");
});

test("bounded recovery consumes its frozen cursor only after the final contiguous page", () => {
  const store = new Store();
  message(store, {
    type: "snapshot",
    capabilities: { sessionSubscriptions: true, boundedDelivery: true },
    runners: [], boxes: [], sessions: [session("s1")], runs: [], pods: [],
  });
  store.navigate({ name: "session", id: "s1" });
  store.loadEvents("s1", Array.from({ length: 5 }, (_, i) => event("s1", i + 1)));
  store.prepareSubscriptionRecovery(1, ["s1"]);
  message(store, {
    type: "session_subscriptions_applied", revision: 1, sessionIds: ["s1"], podIds: [],
  });
  store.beginEventHistoryLoad("s1", 0, 1);
  message(store, { type: "session_event", event: event("s1", 9) });

  store.loadEvents("s1", [event("s1", 6), event("s1", 7)], 0, 1, false);
  assert.equal(store.recoveryAfter("s1"), 5, "an intermediate page cannot consume the frozen cursor");
  store.loadEvents("s1", [event("s1", 8)], 0, 1, true);
  assert.equal(store.recoveryAfter("s1"), 9, "the final page drains the now-contiguous live tail");
  assert.deepEqual(store.getState().events.get("s1")?.map((entry) => entry.seq),
    Array.from({ length: 9 }, (_, i) => i + 1));
});

test("REST and WebSocket copies deduplicate by per-session sequence rather than SQLite id", () => {
  const store = new Store();
  message(store, {
    type: "snapshot", runners: [], boxes: [], sessions: [session("s1")], runs: [], pods: [],
  });
  store.navigate({ name: "session", id: "s1" });
  const live = { ...event("s1", 1), id: 100 };
  const retried = { ...event("s1", 1), id: 200 };
  message(store, { type: "session_event", event: live });
  store.loadEvents("s1", [retried]);
  assert.deepEqual(store.getState().events.get("s1")?.map((entry) => [entry.seq, entry.id]), [[1, 200]]);
});

test("a legacy reconnect discards its bounded cache because older snapshots cannot signal resets", () => {
  const store = new Store();
  message(store, { type: "snapshot", runners: [], boxes: [], sessions: [session("s1")], runs: [], pods: [] });
  store.navigate({ name: "session", id: "s1" });
  const oldGeneration = store.getState().snapshotRevision;
  store.loadEvents("s1", [event("s1", 100)], 0, 0, true, oldGeneration);

  message(store, { type: "snapshot", runners: [], boxes: [], sessions: [session("s1")], runs: [], pods: [] });
  assert.equal(store.getState().streamSubscriptions.mode, "legacy");
  assert.equal(store.getState().events.has("s1"), false);
  assert.equal(store.getState().eventHistory.has("s1"), false,
    "discarding populated legacy cache also discards its authoritative-complete marker");
  store.loadEvents("s1", [event("s1", 101)], 0, 0, true, oldGeneration);
  assert.equal(store.getState().events.has("s1"), false,
    "a late page from the previous snapshot generation cannot repopulate discarded legacy cache");
  assert.equal(store.recoveryAfter("s1"), 0, "legacy recovery restarts at zero to cover a missed reset");
  store.loadEvents("s1", [event("s1", 1)], 0, 0);
  assert.equal(store.recoveryAfter("s1"), 1, "successful legacy recovery advances the next cursor");
});

test("a legacy reconnect can preserve a previously authoritative empty transcript while refreshing", () => {
  const store = new Store();
  message(store, { type: "snapshot", runners: [], boxes: [], sessions: [session("s1", 2)], runs: [], pods: [] });
  store.navigate({ name: "session", id: "s1" });
  store.loadEvents("s1", [], 2, 0, true);

  message(store, { type: "snapshot", runners: [], boxes: [], sessions: [session("s1", 2)], runs: [], pods: [] });
  assert.equal(store.getState().events.has("s1"), false);
  assert.equal(store.getState().eventHistory.get("s1")?.everComplete, true);
  assert.equal(store.getState().eventHistory.get("s1")?.refreshing, true);
});

test("a reconnect snapshot invalidates cursors and stale history from an older event epoch", () => {
  const store = new Store();
  message(store, {
    type: "snapshot",
    capabilities: { sessionSubscriptions: true, boundedDelivery: true },
    runners: [], boxes: [], sessions: [session("s1", 0)], runs: [], pods: [],
  });
  store.navigate({ name: "session", id: "s1" });
  store.loadEvents("s1", [event("s1", 8)], 0);

  message(store, {
    type: "snapshot",
    capabilities: { sessionSubscriptions: true, boundedDelivery: true },
    runners: [], boxes: [], sessions: [session("s1", 1)], runs: [], pods: [],
  });
  assert.equal(store.getState().events.has("s1"), false, "old-generation timeline is dropped");
  store.prepareSubscriptionRecovery(1, ["s1"]);
  message(store, {
    type: "session_subscriptions_applied", revision: 1, sessionIds: ["s1"], podIds: [],
  });
  assert.equal(store.recoveryAfter("s1"), 0, "the replacement log is recovered from its beginning");

  store.loadEvents("s1", [event("s1", 9)], 0);
  assert.equal(store.getState().events.has("s1"), false, "late old-generation response is ignored");
  store.loadEvents("s1", [event("s1", 1)], 1);
  assert.deepEqual(store.getState().events.get("s1")?.map((entry) => entry.seq), [1]);
});

test("a reset carries its epoch even when a coalesced session upsert is delivered later", () => {
  const store = new Store();
  message(store, {
    type: "snapshot", runners: [], boxes: [], sessions: [session("s1", 0)], runs: [], pods: [],
  });
  store.navigate({ name: "session", id: "s1" });
  store.loadEvents("s1", [event("s1", 8)], 0);

  message(store, { type: "session_events_reset", sessionId: "s1", eventEpoch: 1, events: [event("s1", 1)] });
  assert.deepEqual(store.getState().events.get("s1")?.map((entry) => entry.seq), [1]);
  assert.equal(store.getState().eventEpochs.get("s1"), 1);
  store.loadEvents("s1", [event("s1", 9)], 0);
  assert.deepEqual(store.getState().events.get("s1")?.map((entry) => entry.seq), [1],
    "an in-flight old-generation response is rejected before the metadata upsert arrives");
  message(store, { type: "session_upsert", session: session("s1", 1) });
  assert.deepEqual(store.getState().events.get("s1")?.map((entry) => entry.seq), [1],
    "late metadata for the same generation must retain the replacement timeline");
});

test("active pod membership changes prune departed event and shell caches", () => {
  const store = new Store();
  message(store, {
    type: "snapshot", runners: [], boxes: [],
    sessions: [session("s1"), session("s2")], runs: [], pods: [pod(["s1", "s2"])],
  });
  store.navigate({ name: "pod", id: "pod-1" });
  store.loadEvents("s1", [event("s1", 1)]);
  store.loadEvents("s2", [event("s2", 1)]);
  message(store, {
    type: "shell_output", sessionId: "s2", shellId: "shell-2", stream: "stdout", data: "tail",
  });
  assert.deepEqual([...store.getState().events.keys()].sort(), ["s1", "s2"]);
  assert.equal(store.getState().shellOutput.has("shell-2"), true);

  message(store, { type: "pod_upsert", pod: pod(["s1"]) });
  assert.deepEqual([...store.getState().events.keys()], ["s1"]);
  assert.equal(store.getState().shellOutput.has("shell-2"), false);
});

test("removing active sessions, runs, or pods releases their retained streams", () => {
  const sessionStore = new Store();
  message(sessionStore, {
    type: "snapshot", runners: [], boxes: [], sessions: [session("s1")], runs: [], pods: [],
  });
  sessionStore.navigate({ name: "session", id: "s1" });
  sessionStore.loadEvents("s1", [event("s1", 1)]);
  message(sessionStore, {
    type: "shell_output", sessionId: "s1", shellId: "shell-1", stream: "stdout", data: "tail",
  });
  message(sessionStore, { type: "session_removed", sessionId: "s1" });
  assert.equal(sessionStore.getState().events.size, 0);
  assert.equal(sessionStore.getState().shellOutput.size, 0);

  const runStore = new Store();
  message(runStore, {
    type: "snapshot", runners: [], boxes: [], sessions: [session("s1")],
    runs: [{ id: "run-1", sessionIds: ["s1"] } as never], pods: [],
  });
  runStore.navigate({ name: "run", id: "run-1" });
  runStore.loadEvents("s1", [event("s1", 1)]);
  message(runStore, { type: "run_removed", runId: "run-1" });
  assert.equal(runStore.getState().events.size, 0);

  const podStore = new Store();
  message(podStore, {
    type: "snapshot", runners: [], boxes: [], sessions: [session("s1")], runs: [], pods: [pod(["s1"])],
  });
  podStore.navigate({ name: "pod", id: "pod-1" });
  podStore.loadEvents("s1", [event("s1", 1)]);
  message(podStore, { type: "pod_removed", podId: "pod-1" });
  assert.equal(podStore.getState().events.size, 0);
});

test("unselected busy session events update heartbeat activity without retaining transcripts", () => {
  const store = new Store({ name: "inbox" });
  const busy = {
    ...session("busy"), status: "running", archived: false, updatedAt: 1, lastEventAt: null,
  } as SessionView;
  message(store, {
    type: "snapshot", capabilities: { sessionSubscriptions: true },
    runners: [], boxes: [], sessions: [busy], runs: [], pods: [],
  });
  const pulse = { ...event("busy", 1), ts: 5 * ACTIVITY_BUCKET_MS };
  message(store, { type: "session_event", event: pulse });

  assert.equal(store.getState().events.has("busy"), false, "heartbeat-only subscriptions stay lightweight");
  assert.equal(activitySeries(store.getState().activity.get("busy"), pulse.ts).at(-1), 1);

  store.setInboxSelection("busy");
  message(store, { type: "session_event", event: { ...event("busy", 2), ts: pulse.ts + 1 } });
  assert.equal(store.getState().events.get("busy")?.length, 1, "the selected preview still retains its raw timeline");
  assert.equal(activitySeries(store.getState().activity.get("busy"), pulse.ts).at(-1), 2);
});

test("activity lifecycle survives same-epoch snapshots and resets or removes authoritatively", () => {
  const store = new Store({ name: "board" });
  const busy = {
    ...session("busy", 2), status: "running", archived: false,
    updatedAt: ACTIVITY_BUCKET_MS, lastEventAt: 12 * ACTIVITY_BUCKET_MS,
  } as SessionView;
  message(store, {
    type: "snapshot", capabilities: { sessionSubscriptions: true },
    runners: [], boxes: [], sessions: [busy], runs: [], pods: [],
  });
  const seeded = store.getState().activity.get("busy");
  assert.equal(activitySeries(seeded, busy.lastEventAt!).at(-1), 1, "snapshot lastEventAt seeds one pulse");

  message(store, {
    type: "snapshot", capabilities: { sessionSubscriptions: true },
    runners: [], boxes: [], sessions: [busy], runs: [], pods: [],
  });
  assert.equal(activitySeries(store.getState().activity.get("busy"), busy.lastEventAt!).at(-1), 1,
    "reconnect metadata does not duplicate an already-observed timestamp");

  const replacement = { ...event("busy", 1), ts: 8 * ACTIVITY_BUCKET_MS };
  message(store, { type: "session_events_reset", sessionId: "busy", eventEpoch: 3, events: [replacement] });
  assert.equal(store.getState().events.has("busy"), false, "a nonvisible reset does not retain the replacement transcript");
  assert.equal(store.getState().sessions.get("busy")?.eventEpoch, 3);
  assert.equal(store.getState().activity.get("busy")?.eventEpoch, 3);
  assert.equal(activitySeries(store.getState().activity.get("busy"), replacement.ts).at(-1), 1);
  assert.equal(activitySeries(store.getState().activity.get("busy"), busy.lastEventAt!).reduce((sum, count) => sum + count, 0), 1,
    "reset activity contains only replacement-epoch timestamps, never stale metadata");

  message(store, { type: "session_removed", sessionId: "busy" });
  assert.equal(store.getState().activity.has("busy"), false);
  message(store, { type: "session_events_reset", sessionId: "busy", eventEpoch: 4, events: [replacement] });
  assert.equal(store.getState().activity.has("busy"), false, "a late reset cannot resurrect removed activity");
});

test("targeted observation starts at acknowledgement and blocks pre-ack false stalls", () => {
  const store = new Store({ name: "board" });
  store.tickActivity(0);
  store.dispatch({ type: "conn", conn: "online" });
  const busy = {
    ...session("busy"), status: "running", archived: false, updatedAt: 0, lastEventAt: 0,
  } as SessionView;
  message(store, {
    type: "snapshot", capabilities: { sessionSubscriptions: true },
    runners: [], boxes: [], sessions: [busy], runs: [], pods: [],
  }, 0);
  store.prepareSubscriptionRecovery(1, [busy.id]);
  store.tickActivity(600_000);
  assert.equal(store.getState().stalledCount, 0, "a requested stream is not observable before ack");

  message(store, {
    type: "session_subscriptions_applied", revision: 1, sessionIds: [busy.id], podIds: [],
  }, 600_000);
  assert.equal(store.getState().activityObservationStartedAt.get(busy.id), 600_000);
  assert.equal(store.getState().stalledCount, 0, "acknowledgement starts a fresh observation barrier");
  store.tickActivity(1_199_999);
  assert.equal(store.getState().stalledCount, 0);
  store.tickActivity(1_200_000);
  assert.equal(store.getState().stalledSessionIds.has(busy.id), true, "the exact ten-minute boundary stalls");
});

test("pending subscription replacements preserve old observation until the new ack", () => {
  const store = new Store({ name: "board" });
  store.tickActivity(0);
  store.dispatch({ type: "conn", conn: "online" });
  const sessions = ["old", "new"].map((id) => ({
    ...session(id), status: "running", archived: false, updatedAt: 0, lastEventAt: 0,
  } as SessionView));
  message(store, {
    type: "snapshot", capabilities: { sessionSubscriptions: true },
    runners: [], boxes: [], sessions, runs: [], pods: [],
  }, 0);
  store.prepareSubscriptionRecovery(1, ["old"]);
  message(store, {
    type: "session_subscriptions_applied", revision: 1, sessionIds: ["old"], podIds: [],
  }, 0);
  store.prepareSubscriptionRecovery(2, ["new"]);
  store.tickActivity(600_000);
  assert.equal(store.getState().stalledSessionIds.has("old"), true);
  assert.equal(store.getState().stalledSessionIds.has("new"), false);

  message(store, {
    type: "session_subscriptions_applied", revision: 2, sessionIds: ["new"], podIds: [],
  }, 600_000);
  assert.equal(store.getState().stalledSessionIds.has("old"), false);
  assert.equal(store.getState().activityObservationStartedAt.get("new"), 600_000);
});

test("session-event hot path keeps the activity registry stable and updates only one entry", () => {
  const store = new Store({ name: "board" });
  store.tickActivity(0);
  const sessions = ["s1", "s2"].map((id) => ({
    ...session(id), status: "running", archived: false, updatedAt: 0, lastEventAt: null,
  } as SessionView));
  message(store, {
    type: "snapshot", capabilities: { sessionSubscriptions: true },
    runners: [], boxes: [], sessions, runs: [], pods: [],
  }, 0);
  const registry = store.getState().activity;
  const firstBefore = registry.get("s1");
  const secondBefore = registry.get("s2");
  const stalledRevision = store.getState().stalledRevision;
  message(store, { type: "session_event", event: { ...event("s1", 1), ts: 1 } }, 1);

  assert.equal(store.getState().activity, registry);
  assert.notEqual(registry.get("s1"), firstBefore);
  assert.equal(registry.get("s2"), secondBefore);
  assert.equal(store.getState().stalledRevision, stalledRevision,
    "an unrelated nonstalled pulse does not publish a global stall revision");
});

test("an expired delayed event cannot clear a real stall", () => {
  const store = new Store({ name: "board" });
  store.tickActivity(0);
  store.dispatch({ type: "conn", conn: "online" });
  const busy = {
    ...session("busy"), status: "running", archived: false, updatedAt: 0, lastEventAt: 0,
  } as SessionView;
  message(store, {
    type: "snapshot", runners: [], boxes: [], sessions: [busy], runs: [], pods: [],
  }, 0);
  store.tickActivity(600_000);
  assert.equal(store.getState().stalledSessionIds.has(busy.id), true,
    "legacy snapshot metadata may classify a preexisting stall immediately");
  const revision = store.getState().stalledRevision;
  message(store, { type: "session_event", event: { ...event(busy.id, 1), ts: 0 } }, 600_000);
  assert.equal(store.getState().stalledSessionIds.has(busy.id), true);
  assert.equal(store.getState().stalledRevision, revision);
});

test("stale async history and pod-context responses cannot repopulate caches after navigation", () => {
  const store = new Store();
  message(store, {
    type: "snapshot", runners: [], boxes: [], sessions: [session("s1")], runs: [], pods: [pod(["s1"])],
  });
  store.navigate({ name: "pod", id: "pod-1" });
  store.navigate({ name: "board" });

  store.loadEvents("s1", [event("s1", 1)]);
  store.loadPodContext("pod-1", [{ id: "ctx-1", podId: "pod-1", seq: 1 } as never]);
  assert.equal(store.getState().events.size, 0);
  assert.equal(store.getState().podContext.size, 0);
});

test("a reconnect snapshot prunes context for a pod deleted during the outage", () => {
  const store = new Store();
  message(store, {
    type: "snapshot", runners: [], boxes: [], sessions: [session("s1")], runs: [], pods: [pod(["s1"])],
  });
  store.navigate({ name: "pod", id: "pod-1" });
  store.loadPodContext("pod-1", [{ id: "ctx-1", podId: "pod-1", seq: 1 } as never]);
  assert.equal(store.getState().podContext.has("pod-1"), true);

  message(store, { type: "snapshot", runners: [], boxes: [], sessions: [session("s1")], runs: [], pods: [] });
  assert.equal(store.getState().podContext.size, 0);
});

test("authoritative shell reconciliation and explicit close prune dead scrollback", () => {
  const store = new Store();
  message(store, {
    type: "snapshot", runners: [], boxes: [], sessions: [session("s1")], runs: [], pods: [],
  });
  store.navigate({ name: "session", id: "s1" });
  for (const shellId of ["kept", "gone"]) {
    message(store, { type: "shell_output", sessionId: "s1", shellId, stream: "stdout", data: shellId });
  }
  store.reconcileShellOutputs("s1", ["kept"]);
  assert.deepEqual([...store.getState().shellOutput.keys()], ["kept"]);
  store.removeShellOutput("kept");
  assert.equal(store.getState().shellOutput.size, 0);
});

test("durable shell history prepends live output without duplicates and inventory triggers refresh", () => {
  const store = new Store();
  message(store, {
    type: "snapshot", runners: [], boxes: [], sessions: [session("s1")], runs: [], pods: [],
  });
  store.navigate({ name: "session", id: "s1" });
  message(store, {
    type: "shell_output", sessionId: "s1", shellId: "shell-1", stream: "stdout", data: "two", seq: 2,
  });
  store.loadShellHistory("s1", "shell-1", [
    { seq: 1, stream: "stdout", data: "one" },
    { seq: 2, stream: "stdout", data: "two" },
  ], "running", null, false);
  assert.equal(store.getState().shellOutput.get("shell-1")?.text, "onetwo");
  assert.deepEqual(store.getState().shellOutput.get("shell-1")?.chunks.map((chunk) => chunk.seq), [1, 2]);
  message(store, {
    type: "shell_output", sessionId: "s1", shellId: "shell-1", stream: "stderr", data: "three", seq: 3,
  });
  message(store, {
    type: "shell_output", sessionId: "s1", shellId: "shell-1", stream: "stderr", data: "duplicate", seq: 3,
  });
  assert.equal(store.getState().shellOutput.get("shell-1")?.text, "onetwothree");

  message(store, { type: "shell_registry_reconciled", runnerId: "runner-1", sessionIds: ["s1"] });
  assert.equal(store.getState().shellRegistryRevision.get("s1"), 1);
});

test("late durable shell history cannot repopulate scrollback after navigation", () => {
  const store = new Store();
  message(store, {
    type: "snapshot", runners: [], boxes: [], sessions: [session("s1")], runs: [], pods: [],
  });
  store.navigate({ name: "session", id: "s1" });
  store.navigate({ name: "board" });

  store.loadShellHistory("s1", "shell-1", [
    { seq: 1, stream: "stdout", data: "stale" },
  ], "running", null, false);

  assert.equal(store.getState().shellOutput.size, 0);
});

test("event-history state distinguishes incomplete, complete, refresh, and failure", () => {
  const store = new Store();
  message(store, {
    type: "snapshot", capabilities: { sessionSubscriptions: true, boundedDelivery: true },
    runners: [], boxes: [], sessions: [session("s1", 2)], runs: [], pods: [],
  });
  store.navigate({ name: "session", id: "s1" });

  store.beginEventHistoryLoad("s1", 2);
  assert.deepEqual(store.getState().eventHistory.get("s1"), {
    eventEpoch: 2, recoveryGeneration: 1, recoveryRevision: -1,
    everComplete: false, refreshing: true, error: null,
  });
  store.loadEvents("s1", [], 2, undefined, false);
  assert.equal(store.getState().eventHistory.get("s1")?.everComplete, false);
  store.loadEvents("s1", [], 2, undefined, true);
  assert.deepEqual(store.getState().eventHistory.get("s1"), {
    eventEpoch: 2, recoveryGeneration: 1, recoveryRevision: -1,
    everComplete: true, refreshing: false, error: null,
  });

  store.beginEventHistoryLoad("s1", 2);
  assert.equal(store.getState().eventHistory.get("s1")?.everComplete, true, "refresh preserves authoritative empty/content");
  store.failEventHistoryLoad("s1", "network failed", 2);
  assert.deepEqual(store.getState().eventHistory.get("s1"), {
    eventEpoch: 2, recoveryGeneration: 1, recoveryRevision: -1,
    everComplete: true, refreshing: false, error: "network failed",
  });
});

test("event-history state is fenced by epoch and pruned with its timeline", () => {
  const store = new Store();
  message(store, {
    type: "snapshot", capabilities: { sessionSubscriptions: true, boundedDelivery: true },
    runners: [], boxes: [], sessions: [session("s1", 0)], runs: [], pods: [],
  });
  store.navigate({ name: "session", id: "s1" });
  store.loadEvents("s1", [], 0, undefined, true);

  message(store, { type: "session_upsert", session: session("s1", 1) });
  assert.equal(store.getState().eventHistory.has("s1"), false);
  store.failEventHistoryLoad("s1", "stale", 0);
  assert.equal(store.getState().eventHistory.has("s1"), false, "late old-generation failure is ignored");

  store.beginEventHistoryLoad("s1", 1);
  store.navigate({ name: "board" });
  assert.equal(store.getState().eventHistory.has("s1"), false);
});

test("a superseded recovery revision cannot merge pages or overwrite current loading state", () => {
  const store = new Store();
  message(store, {
    type: "snapshot", capabilities: { sessionSubscriptions: true, boundedDelivery: true },
    runners: [], boxes: [], sessions: [session("s1", 0)], runs: [], pods: [],
  });
  store.navigate({ name: "session", id: "s1" });
  const generation = store.getState().snapshotRevision;
  store.beginEventHistoryLoad("s1", 0, 1, generation);
  store.beginEventHistoryLoad("s1", 0, 2, generation);

  store.loadEvents("s1", [event("s1", 1)], 0, 1, true, generation);
  store.failEventHistoryLoad("s1", "obsolete", 0, 1, generation);
  assert.equal(store.getState().events.has("s1"), false);
  assert.deepEqual(store.getState().eventHistory.get("s1"), {
    eventEpoch: 0,
    recoveryGeneration: generation,
    recoveryRevision: 2,
    everComplete: false,
    refreshing: true,
    error: null,
  });
});
