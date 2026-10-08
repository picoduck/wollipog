import assert from "node:assert/strict";
import test from "node:test";
import type { SessionReminderView, SessionView } from "@wollipog/protocol";
import { sessionRowStatus, silenceDuration } from "./session-row-status.js";
import { sessionStatusSummary } from "./status-meta.js";

const session = (extra: Partial<SessionView> = {}): SessionView =>
  ({ id: "s", status: "idle", pendingApproval: null, ...extra }) as unknown as SessionView;

const reminder = (extra: Partial<SessionReminderView>): SessionReminderView => ({
  reminderId: "r", sessionId: "s", scheduledFor: 1_000, timeZone: "UTC", originalExpression: "later",
  wakePolicy: "regardless", state: "pending", revision: 1, createdAt: 1, updatedAt: 1, ...extra,
}) as SessionReminderView;

const label = (status: ReturnType<typeof sessionRowStatus>) => status.badge?.meta.label ?? null;

test("outstanding human results use the single row badge without overriding human input", () => {
  const attention = { version: 1 as const, humanActions: [], meaningfulAt: 1,
    result: { revision: "r1", at: 1, owner: "human" as const }, acknowledgedRevision: null };
  assert.equal(label(sessionRowStatus(session({ status: "running", attention }))), "Ready for Review");
  assert.equal(label(sessionRowStatus(session({ status: "idle", attention }))), "Ready for Review");
  assert.equal(label(sessionRowStatus(session({ status: "running", attention: { ...attention, acknowledgedRevision: "r1" } }))), "Running");
  assert.equal(label(sessionRowStatus(session({ status: "running", attention: { ...attention,
    result: { ...attention.result, owner: "orchestrator" } } }))), "Running");
  const question = { requestId: "q", kind: "question" as const, title: "Choose", options: [] };
  assert.equal(label(sessionRowStatus(session({ status: "running", pendingApproval: question,
    attention: { ...attention, humanActions: [{ requestId: "q", rank: 3, requestedAt: 1 }] } }))), "Answer Required");
});

test("result readiness does not hide disconnection, failure, Stop, or a blocked delivery", () => {
  const attention = { version: 1 as const, humanActions: [], meaningfulAt: 1,
    result: { revision: "r1", at: 1, owner: "human" as const }, acknowledgedRevision: null };
  assert.equal(label(sessionRowStatus(session({ status: "running", attention }), { runnerOnline: false })), "Disconnected");
  assert.equal(label(sessionRowStatus(session({ status: "failed", attention }))), "Failed");
  assert.equal(label(sessionRowStatus(session({ status: "running", attention, stopOperation: {
    operationId: "stop", status: "stop_pending", requestedAt: 1, lastAttemptAt: 1, attemptCount: 1, capacityReleased: false } }))), "Stop Pending");
  const delivery = { parentTurnId: "turn", watchdogState: "continuation_blocked", queuedAt: 1 } as NonNullable<SessionView["backgroundDeliveries"]>[number];
  assert.equal(label(sessionRowStatus(session({ status: "running", attention, backgroundDeliveries: [delivery] }))), "Result Blocked");
});

test("Awaiting Prompt shows no badge; every other lifecycle shows its own", () => {
  assert.deepEqual(sessionRowStatus(session()), { badge: null, others: [] });
  for (const [status, expected] of [
    ["running", "Running"], ["starting", "Starting"], ["queued", "Queued"], ["input_required", "Input Required"],
    ["failed", "Failed"], ["completed", "Completed"], ["stopped", "Stopped"],
  ] as const) {
    assert.equal(label(sessionRowStatus(session({ status }))), expected, status);
  }
});

test("the row's badge is the session bar's primary condition, so the two agree (#2182)", () => {
  const cases: Partial<SessionView>[] = [
    { status: "running" },
    { status: "running", backgroundWorkState: "running" },
    { status: "idle", backgroundWorkState: "running" },
    { status: "idle", backgroundWorkState: "orphaned" },
    { status: "input_required", pendingApproval: { requestId: "a", options: [], title: "Run it?" } } as Partial<SessionView>,
    { status: "failed" },
  ];
  for (const extra of cases) {
    const record = session(extra);
    assert.equal(label(sessionRowStatus(record)), sessionStatusSummary(record).primary.meta.label, JSON.stringify(extra));
  }
  // Disconnected outranks the lifecycle, as in the bar.
  assert.equal(label(sessionRowStatus(session({ status: "running" }), { runnerOnline: false })), "Disconnected");
});

test("other kinds that need the person become \"+N\", in rank order", () => {
  const status = sessionRowStatus(session({
    status: "input_required",
    pendingApproval: {
      requestId: "a", options: [], title: "Run it?",
      additionalRequests: [{ requestId: "q", options: [], title: "Which?", kind: "question" }],
    },
  } as unknown as Partial<SessionView>));
  assert.equal(label(status), "Answer Required");
  assert.deepEqual(status.others, ["Approval Required"]);
  assert.equal(status.badge?.ariaLabel, "Status: Answer Required");
});

test("a fired reminder says Returned only where the lifecycle would otherwise speak", () => {
  const fired = reminder({ state: "fired", firedAt: 2, wakeReason: "scheduled" });
  assert.equal(label(sessionRowStatus(session(), { reminder: fired })), "Returned from Snooze");
  assert.equal(label(sessionRowStatus(session({ status: "running" }), { reminder: fired })), "Returned from Snooze");
  assert.equal(label(sessionRowStatus(session({ backgroundWorkState: "running" }), { reminder: fired })),
    "Waiting on External Job", "background work outranks Returned");
  assert.equal(sessionRowStatus(session(), { reminder: reminder({}) }).badge, null, "a pending reminder is not a badge");
});

test("a snoozed session's background result counts toward its one status", () => {
  const pending = reminder({});
  const delivery = { deliveryId: "d", watchdogState: "terminal_without_continuation" } as never;
  const watched = session({ backgroundDeliveries: [delivery] } as Partial<SessionView>);
  // Unsnoozed, a result on its way back is passive and an idle session shows nothing.
  assert.equal(sessionRowStatus(watched).badge, null);
  // Snoozed, it is the reason the session stays visible, so it is the one status.
  const snoozed = sessionRowStatus(watched, { reminder: pending });
  assert.equal(label(snoozed), "Result Pending");
  assert.equal(snoozed.badge?.meta.tone, "info", "a result on its way back reads as working");
  assert.equal(snoozed.badge?.ariaLabel, "Status: Result Pending");
  // A blocked snoozed session's reason is its request, which the ranking already holds.
  const blocked = session({
    status: "input_required",
    pendingApproval: { requestId: "a", options: [], title: "Run it?" },
    backgroundDeliveries: [delivery],
  } as unknown as Partial<SessionView>);
  const withAttention = sessionRowStatus(blocked, { reminder: pending });
  assert.equal(label(withAttention), "Approval Required");
  assert.deepEqual(withAttention.others, []);
});

test("phone family reasons use one badge while preserving warnings and stronger own input", () => {
  assert.equal(label(sessionRowStatus(session({ status: "running" }), {
    familyFollowUpLabel: "Needs Your Input" })), "Needs Your Input");
  assert.equal(label(sessionRowStatus(session({ status: "running" }), {
    familyFollowUpLabel: "Ready for Review" })), "Ready for Review");
  const disconnected = sessionRowStatus(session({ status: "running" }), {
    runnerOnline: false, familyFollowUpLabel: "Ready for Review" });
  assert.equal(label(disconnected), "Ready for Review");
  assert.deepEqual(disconnected.others, [], "passive warnings never inflate the actionable +N count");
  assert.equal(disconnected.badge?.meta.tone, "danger");
  assert.match(disconnected.badge?.title ?? "", /disconnected|offline|not connected/i);
  const ownQuestion = sessionRowStatus(session({ status: "input_required",
    pendingApproval: { requestId: "q", kind: "question", title: "Choose", options: [] } }), {
    familyFollowUpLabel: "Ready for Review" });
  assert.equal(label(ownQuestion), "Answer Required");
  const returned = sessionRowStatus(session({ status: "running" }), {
    reminder: reminder({ state: "fired" }), familyFollowUpLabel: "Needs Your Input" });
  assert.equal(label(returned), "Needs Your Input");
  assert.deepEqual(returned.others, []);
  assert.match(returned.badge?.title ?? "", /returned|reminder/i);
  const ownResult = session({ status: "running", attention: { version: 1, meaningfulAt: 10, humanActions: [],
    result: { revision: "own", at: 10, owner: "human" }, acknowledgedRevision: null } });
  assert.equal(sessionRowStatus(ownResult, { familyFollowUpLabel: "Ready for Review" }).badge?.title,
    sessionRowStatus(ownResult).badge?.title, "an identical family reason preserves the parent's own result description");
  assert.equal(label(sessionRowStatus(session({ status: "running" }))), "Running",
    "controller-owned descendants have no human family reason to promote");
});

test("a stalled session's badge turns danger, stops pulsing, and says how long it has been silent", () => {
  // A busy lifecycle says Stalled in words (#2215), so the stall survives forced colors.
  for (const [status, was] of [["running", "Running"], ["starting", "Starting"], ["queued", "Queued"]] as const) {
    const stalled = sessionRowStatus(session({ status }), { stalledForMs: 14 * 60_000 });
    assert.equal(label(stalled), "Stalled", status);
    assert.equal(stalled.badge?.meta.tone, "danger");
    assert.ok(!stalled.badge?.meta.pulse, "a stalled badge does not pulse");
    assert.equal(stalled.badge?.ariaLabel, `Status: Stalled, ${was}`);
    assert.equal(stalled.badge?.title, `${was}, but no activity for 14 minutes.`);
  }
  // An attention badge outranks the lifecycle (#2182) and keeps its own label, in the danger tone.
  const blocked = sessionRowStatus(session({ status: "input_required",
    pendingApproval: { requestId: "a", options: [], title: "Run it?" } } as unknown as Partial<SessionView>),
  { stalledForMs: 14 * 60_000 });
  assert.equal(label(blocked), "Approval Required");
  assert.equal(blocked.badge?.meta.tone, "danger");
  assert.equal(blocked.badge?.ariaLabel, "Status: Approval Required, Stalled");
  assert.match(blocked.badge?.title ?? "", /Stalled: no activity for 14 minutes\.$/);
  // Awaiting Input with no request behind it ranks as Input Required, an attention kind.
  const awaiting = sessionRowStatus(session({ status: "input_required" }), { stalledForMs: 14 * 60_000 });
  assert.equal(label(awaiting), "Input Required");
  assert.equal(awaiting.badge?.ariaLabel, "Status: Input Required, Stalled");
  // Not stalled: the lifecycle as it is.
  assert.equal(label(sessionRowStatus(session({ status: "running" }))), "Running");
  assert.equal(silenceDuration(60_000), "1 minute");
  assert.equal(silenceDuration(10 * 60_000), "10 minutes");
  assert.equal(silenceDuration(125 * 60_000), "2 hours");
  assert.equal(silenceDuration(61 * 60_000), "1 hour");
});
