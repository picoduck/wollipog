import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionAttentionBreakdown, type PendingApproval } from "@wollipog/protocol";
import { sessionArchivedAtRest, sessionStatusSummary, type SessionStatusSource } from "./status-meta.js";

/**
 * `sessionStatusSummary()` is the one ranking every session surface uses to choose its badge
 * (#2182). Each rule is asserted on its own here; the Session bar's rendering of it is in
 * SessionStatusButton.dom.test.tsx.
 */

const approval: PendingApproval = { requestId: "approval-1", title: "Run the tests", options: [], kind: "permission" };
const question: PendingApproval = { requestId: "question-1", title: "Which branch?", options: [], kind: "question" };
const signIn: PendingApproval = { requestId: "auth-1", title: "Sign in", options: [], kind: "authentication" };

function session(overrides: Partial<SessionStatusSource> = {}): SessionStatusSource {
  return { status: "idle", pendingApproval: null, attentionOwners: undefined, ...overrides };
}

const labels = (source: SessionStatusSource, context = {}) =>
  sessionStatusSummary(source, context).conditions.map((condition) => condition.meta.label);

test("rule 1: the first attention kind in the breakdown's order leads, and +N counts the other kinds", () => {
  const source = session({ status: "input_required", pendingApproval: { ...question, additionalRequests: [approval] } });
  const summary = sessionStatusSummary(source);
  assert.equal(summary.primary.meta.label, sessionAttentionBreakdown(source)[0]!.label);
  assert.equal(summary.primary.kind, "attention");
  assert.equal(summary.more, 1);
  // The lifecycle is not listed while something needs the person, so "Awaiting Input" is not said twice.
  assert.deepEqual(labels(source), sessionAttentionBreakdown(source).map((group) => group.label));
});

test("rule 1: two requests of one kind are one condition with a count, not +1", () => {
  const summary = sessionStatusSummary(session({
    status: "input_required",
    pendingApproval: { ...approval, additionalRequests: [{ ...approval, requestId: "approval-2" }] },
  }));
  assert.equal(summary.primary.meta.label, "Approval Required");
  assert.equal(summary.primary.count, 2);
  assert.equal(summary.more, 0);
});

test("rule 1: a worker's request keeps the kind as its badge and names the worker in its sentence", () => {
  const owned = { ...approval, ownerToolUseId: "tool-audit" };
  const resolved = sessionStatusSummary(session({
    status: "input_required",
    pendingApproval: owned,
    attentionOwners: [{ requestId: owned.requestId, toolCallId: "tool-audit", resolved: true, name: "Audit", role: "reviewer" }],
  }));
  assert.equal(resolved.primary.meta.label, "Approval Required");
  assert.match(resolved.primary.description, /^Audit · Reviewer owns this request\./);
  // A child whose identity is unavailable is still named as a child, in the sentence.
  const unresolved = sessionStatusSummary(session({ status: "input_required", pendingApproval: owned }));
  assert.equal(unresolved.primary.meta.label, "Approval Required");
  assert.match(unresolved.primary.description, /^A child agent owns this request\./);
});

test("rule 1: authentication needs the person like any other request", () => {
  const summary = sessionStatusSummary(session({ status: "input_required", pendingApproval: signIn }));
  assert.equal(summary.primary.meta.label, "Authentication Required");
  assert.equal(summary.primary.attentionKind, "authentication_required");
  assert.equal(summary.primary.needsYou, true);
});

test("rule 1: human campaign requests follow the session's own requests, then descendant requests", () => {
  const campaign = { pendingRequests: { human: 2, orchestrator: 0 } } as SessionStatusSource["orchestratorCampaign"];
  const withRequest = sessionStatusSummary(session({
    status: "input_required",
    pendingApproval: approval,
    orchestratorCampaign: campaign,
  }));
  assert.deepEqual(withRequest.conditions.map((condition) => condition.kind), ["attention", "campaign_requests"]);
  assert.equal(withRequest.conditions[1]!.count, 2);
  assert.equal(withRequest.more, 1);

  // With no request of its own, the campaign's requests are the badge, named for what they need.
  const campaignOnly = sessionStatusSummary(session({ orchestratorCampaign: campaign }));
  assert.equal(campaignOnly.primary.kind, "campaign_requests");
  assert.equal(campaignOnly.primary.meta.label, "Needs Your Input");
  assert.equal(campaignOnly.more, 0);

  const descendants = sessionStatusSummary(session({ status: "input_required", pendingApproval: approval }), {
    descendantRequests: 3,
  });
  assert.deepEqual(descendants.conditions.map((condition) => condition.kind), ["attention", "descendant_requests"]);
  assert.equal(descendants.more, 1);
  // A campaign's request counts already include its descendants', so they are not counted twice.
  assert.equal(sessionStatusSummary(session({ orchestratorCampaign: campaign }), { descendantRequests: 3 })
    .conditions.some((condition) => condition.kind === "descendant_requests"), false);
});

test("rule 2: an idle session with lost background work and no attention shows Background Work Lost", () => {
  const summary = sessionStatusSummary(session({ backgroundWorkState: "orphaned" }), { runnerOnline: false });
  assert.equal(summary.primary.meta.label, "Background Work Lost");
  assert.equal(summary.more, 0, "a passive state is never counted in +N");
  assert.deepEqual(labels(session({ backgroundWorkState: "orphaned" }), { runnerOnline: false }),
    ["Background Work Lost", "Disconnected", "Awaiting Prompt"]);
});

test("rule 3: an offline machine with no attention shows Disconnected", () => {
  const summary = sessionStatusSummary(session({ status: "running" }), { runnerOnline: false });
  assert.equal(summary.primary.meta.label, "Disconnected");
  assert.equal(summary.more, 0);
  // An unknown runner is not offline.
  assert.equal(sessionStatusSummary(session({ status: "running" })).primary.meta.label, "Running");
});

test("rule 4: an idle session with running background work shows Waiting on External Job", () => {
  const summary = sessionStatusSummary(session({ backgroundWorkState: "running" }));
  assert.equal(summary.primary.meta.label, "Waiting on External Job");
  assert.deepEqual(labels(session({ backgroundWorkState: "running" })), ["Waiting on External Job", "Awaiting Prompt"]);
  assert.equal(sessionStatusSummary(session({ backgroundWorkState: "continuation_pending" })).primary.meta.label,
    "Continuation Pending");
  // While the agent is busy its lifecycle leads, and background work is a row in the popover.
  assert.deepEqual(labels(session({ status: "running", backgroundWorkState: "running" })),
    ["Running", "Waiting on External Job"]);
  // A retired terminal sentinel from an older control plane is not background work.
  assert.equal(sessionStatusSummary(session({ backgroundWorkState: "resumed" })).primary.meta.label, "Awaiting Prompt");
});

test("rule 5: with nothing else, the lifecycle shows, including the Stop states", () => {
  assert.equal(sessionStatusSummary(session()).primary.meta.label, "Awaiting Prompt");
  assert.equal(sessionStatusSummary(session({ status: "running" })).primary.meta.label, "Running");
  const stopPending = { stopOperation: { status: "stop_pending" } } as Partial<SessionStatusSource>;
  assert.equal(sessionStatusSummary(session({ status: "running", ...stopPending })).primary.meta.label, "Stop Pending");
  const stopFailed = { stopOperation: { status: "stop_failed" } } as Partial<SessionStatusSource>;
  assert.equal(sessionStatusSummary(session({ status: "running", ...stopFailed })).primary.meta.label, "Stop Failed");
  // A Stop on an offline machine is Disconnected first; the popover still lists what the Stop is doing.
  assert.deepEqual(labels(session({ status: "running", ...stopPending }), { runnerOnline: false }),
    ["Disconnected", "Stop Waiting for Runner"]);
});

test("rule 5: an archived session that has stopped reads Archived, never Stopped (#2202)", () => {
  for (const status of ["stopped", "completed", "failed"] as const) {
    const summary = sessionStatusSummary(session({ status, archived: true }));
    assert.equal(summary.primary.meta.label, "Archived");
    assert.equal(summary.primary.kind, "lifecycle");
    assert.equal(summary.primary.description, "This session is archived and stopped.");
  }
  assert.equal(sessionArchivedAtRest({ status: "stopped", archived: true }), true);
  // A Stop in progress, or one that failed, keeps its own status and recovery.
  for (const stop of [
    { archiveStatus: "stop_pending" },
    { archiveStatus: "stop_failed" },
    { stopOperation: { status: "stop_pending" } },
    { archiveOperation: { status: "stop_failed" } },
  ] as Partial<SessionStatusSource>[]) {
    assert.notEqual(sessionStatusSummary(session({ status: "running", archived: true, ...stop })).primary.meta.label, "Archived");
    assert.equal(sessionArchivedAtRest({ status: "stopped", archived: true, ...stop } as Parameters<typeof sessionArchivedAtRest>[0]), false);
  }
  // A running session an older control plane archived without stopping keeps showing that it runs.
  assert.equal(sessionStatusSummary(session({ status: "running", archived: true })).primary.meta.label, "Running");
  assert.equal(sessionStatusSummary(session({ status: "stopped", archived: false })).primary.meta.label, "Stopped");
  // What needs the person still comes first; Archived is the lifecycle, behind it.
  const asking = session({ status: "stopped", archived: true, pendingApproval: approval });
  assert.notEqual(sessionStatusSummary(asking).primary.meta.label, "Archived");
});

test("passive conditions are popover rows after the badge, never counted in +N", () => {
  const source = session({
    status: "queued",
    capacityWait: { kind: "runner_capacity", description: "Waiting for a free runner slot." },
    orchestratorCampaign: { pendingRequests: { human: 0, orchestrator: 2 } },
    backgroundDeliveries: [{ watchdogState: "accepted_without_result" }],
  } as Partial<SessionStatusSource>);
  const summary = sessionStatusSummary(source, { activeWorkers: 2 });
  assert.equal(summary.primary.meta.label, "Queued");
  assert.equal(summary.more, 0);
  assert.deepEqual(summary.conditions.map((condition) => condition.kind),
    ["lifecycle", "background_delivery", "workers", "orchestrator_requests", "queue_reason"]);
  assert.equal(summary.conditions.find((condition) => condition.kind === "workers")!.meta.label, "2 Workers");
  // A queue reason is a fact, listed as a row and never drawn as a badge.
  const queue = summary.conditions.at(-1)!;
  assert.equal(queue.fact, true);
  assert.equal(queue.meta.label, "Runner Capacity");
  assert.equal(queue.description, "Waiting for a free runner slot.");
});

test("every condition says what it means in one sentence", () => {
  const summary = sessionStatusSummary(session({
    status: "input_required",
    pendingApproval: { ...question, additionalRequests: [approval, signIn] },
    backgroundWorkState: "orphaned",
  }), { runnerOnline: false, activeWorkers: 1 });
  for (const condition of summary.conditions) {
    assert.match(condition.description, /^[A-Z0-9].*\.$/u, condition.meta.label);
  }
});
