import assert from "node:assert/strict";
import test from "node:test";
import type { SessionView } from "@wollipog/protocol";
import { sessionStatusSignal, sessionStatusSummary } from "./status-meta.js";
import { sessionRowStatus } from "./session-row-status.js";
import { Store } from "./store.js";

const session = (extra: Partial<SessionView> = {}): SessionView => ({
  id: "session", runnerId: "machine", status: "running", pendingApproval: null,
  updatedAt: 0, lastEventAt: 0, ...extra,
}) as SessionView;

test("lifecycle keeps its label and tone through requests, background work and disconnection", () => {
  const running = session();
  const approval = session({ pendingApproval: { requestId: "request", title: "Run?", options: [] } });
  for (const [record, online, secondary] of [
    [running, true, undefined],
    [session({ backgroundWorkState: "running" }), true, "Waiting on External Job"],
    [approval, true, "Approval Required"],
    [running, false, "Disconnected"],
  ] as const) {
    const summary = sessionStatusSummary(record, { runnerOnline: online });
    assert.equal(summary.primary.meta.label, "Running");
    assert.equal(summary.primary.meta.tone, "info");
    assert.equal(summary.secondary?.meta.label, secondary);
    assert.equal(sessionRowStatus(record, { runnerOnline: online }).lifecycle.meta.label, "Running");
    if (!online) {
      assert.equal(summary.primary.meta.pulse, false);
      assert.equal(summary.secondary?.meta.pulse, false);
      assert.match(summary.secondary!.description, /status may not be current/);
    }
  }
});

test("requests outrank disconnection and passive jobs without counting passive context", () => {
  const record = session({ backgroundWorkState: "running", pendingApproval: {
    requestId: "request", title: "Run?", options: [],
  } });
  const summary = sessionStatusSummary(record, { runnerOnline: false, descendantRequests: 2 });
  assert.equal(summary.secondary?.meta.label, "Approval Required");
  assert.equal(summary.more, 1);
  assert.ok(summary.conditions.some((condition) => condition.kind === "disconnected"));
  assert.ok(summary.conditions.some((condition) => condition.kind === "background_work"));
  const resolved = sessionStatusSummary({ ...record, pendingApproval: null }, { runnerOnline: false });
  assert.equal(resolved.secondary?.meta.label, "Disconnected");
  assert.equal(resolved.more, 0);
  const reconnected = sessionStatusSummary({ ...record, pendingApproval: null });
  assert.equal(reconnected.secondary?.meta.label, "Waiting on External Job");
});

test("Awaiting Prompt is always visible and equivalent generic input is not repeated", () => {
  assert.equal(sessionRowStatus(session({ status: "idle" })).lifecycle.meta.label, "Awaiting Prompt");
  const summary = sessionStatusSummary(session({ status: "input_required" }));
  assert.equal(summary.primary.meta.label, "Awaiting Input");
  assert.equal(summary.secondary, null);
  assert.equal(summary.more, 0);
});

test("compact member signals preserve requests and disconnected staleness", () => {
  const offline = sessionStatusSignal(session(), { runnerOnline: false });
  assert.equal(offline.meta.label, "Disconnected");
  assert.equal(offline.meta.tone, "danger");
  assert.match(offline.description, /status may not be current/);
  assert.equal(sessionStatusSignal(session({ pendingApproval: {
    requestId: "approval", title: "Run?", options: [],
  } })).meta.label, "Approval Required");
  assert.equal(sessionStatusSignal(session({ backgroundWorkState: "running" })).meta.label, "Running",
    "passive background work does not replace an executing turn in a compact signal");
});

test("family input outranks the parent's own review result and keeps that result discoverable", () => {
  const ready = session({ status: "idle", attention: {
    version: 1, humanActions: [], meaningfulAt: 1,
    result: { revision: "result", at: 1, owner: "human" }, acknowledgedRevision: null,
  } });
  assert.equal(sessionStatusSignal(ready).meta.label, "Ready for Review");
  const row = sessionRowStatus(ready, { familyFollowUpLabel: "Needs Your Input", familyWorking: false });
  assert.equal(row.lifecycle.meta.label, "Awaiting Prompt");
  assert.equal(row.badge?.meta.label, "Needs Your Input");
  assert.deepEqual(row.others, ["Ready for Review"]);
});

test("arbitrarily long healthy waits never create a session stall or an attention count", () => {
  const store = new Store({ name: "inbox" });
  store.dispatch({ type: "conn", conn: "online" });
  store.dispatch({ type: "msg", now: 0, msg: {
    type: "snapshot", runners: [], boxes: [], runs: [], pods: [], sessions: [session()],
  } });
  for (const now of [600_000, 3_600_000, 86_400_000, 365 * 86_400_000]) {
    store.tickActivity(now);
    const summary = sessionStatusSummary(store.getState().sessions.get("session")!);
    assert.equal(summary.primary.meta.label, "Running");
    assert.equal(summary.secondary, null);
    assert.equal(summary.more, 0);
    assert.ok(!("stalledSessionIds" in store.getState()));
  }
});
