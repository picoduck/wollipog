import assert from "node:assert/strict";
import test from "node:test";
import type { SessionReminderView, SessionView } from "@wollipog/protocol";
import { sessionHeaderStatusSummary, sessionRowStatus } from "./session-row-status.js";
import { sessionStatusSummary } from "./status-meta.js";

const session = (extra: Partial<SessionView> = {}): SessionView =>
  ({ id: "s", status: "idle", pendingApproval: null, ...extra }) as unknown as SessionView;

const reminder = (extra: Partial<SessionReminderView>): SessionReminderView => ({
  reminderId: "r", sessionId: "s", scheduledFor: 1_000, timeZone: "UTC", originalExpression: "later",
  wakePolicy: "regardless", state: "pending", revision: 1, createdAt: 1, updatedAt: 1, ...extra,
}) as SessionReminderView;

const label = (status: ReturnType<typeof sessionRowStatus>) => status.badge?.meta.label ?? (status.lifecycle.meta.label === "Awaiting Prompt" ? null : status.lifecycle.meta.label);

test("outstanding human results use the single row badge without overriding human input", () => {
  const attention = { version: 1 as const, humanActions: [], meaningfulAt: 1,
    result: { revision: "r1", at: 1, owner: "human" as const }, acknowledgedRevision: null };
  assert.equal(label(sessionRowStatus(session({ status: "idle", attention }))), "Ready for Review");
  assert.equal(label(sessionRowStatus(session({ status: "completed", attention }))), "Ready for Review");
  assert.equal(sessionRowStatus(session({ status: "idle", attention: { ...attention, acknowledgedRevision: "r1" } })).badge, null);
  assert.equal(label(sessionRowStatus(session({ status: "idle", attention: { ...attention,
    result: { ...attention.result, owner: "orchestrator" } } }))), null);
  const question = { requestId: "q", kind: "question" as const, title: "Choose", options: [] };
  assert.equal(label(sessionRowStatus(session({ status: "idle", pendingApproval: question,
    attention: { ...attention, humanActions: [{ requestId: "q", rank: 3, requestedAt: 1 }] } }))), "Answer Required");
});

test("a row switching worktrees says so instead of reading idle or ready for review (#3810)", () => {
  const worktreeSwitch = { phase: "relaunching" as const, branch: "fix/issue-3810", since: 1 };
  const attention = { version: 1 as const, humanActions: [], meaningfulAt: 1,
    result: { revision: "r1", at: 1, owner: "human" as const }, acknowledgedRevision: null };
  for (const status of ["idle", "starting"] as const) {
    const row = sessionRowStatus(session({ status, worktreeSwitch, attention }));
    assert.equal(label(row), "Switching Worktree", status);
    assert.equal(row.badge?.ariaLabel, "Status: Switching Worktree");
    assert.equal(row.badge?.title, "The session is relaunching in worktree fix/issue-3810.");
  }
});

test("a verified-complete Full Control root shows an informational Campaign Complete, not Ready for Review (#2940)", () => {
  const attention = { version: 1 as const, humanActions: [], meaningfulAt: 1,
    result: { revision: "r1", at: 1, owner: "human" as const }, acknowledgedRevision: null };
  const fullControl = { mode: "full_control", boundary: { version: 1, revision: 3, issueScopeRevision: 1, repository: "owner/repo",
    objective: "Deliver", authorizedByUserId: "user", authorizedAt: 1, operations: [], delegatablePolicyIds: [] } };
  const campaign = (status: string, control: unknown = fullControl) =>
    ({ status, policyRevision: 3, control }) as unknown as NonNullable<SessionView["orchestratorCampaign"]>;
  const complete = session({ status: "idle", attention, orchestratorCampaign: campaign("verified_complete") });
  const status = sessionRowStatus(complete);
  assert.equal(label(status), "Campaign Complete");
  assert.equal(status.lifecycle.meta.tone, "success");
  assert.equal(status.lifecycle.ariaLabel, "Status: Campaign Complete");
  assert.equal(status.lifecycle.title, "This Full Control campaign finished and the server verified it. Its result is informational.");
  assert.equal(status.badge, null, "the campaign state takes the place of Awaiting Prompt (#4369)");
  // Shown whether or not the result was ever marked reviewed, and in place of Completed.
  assert.equal(label(sessionRowStatus({ ...complete, attention: { ...attention, acknowledgedRevision: "r1" } })), "Campaign Complete");
  assert.equal(label(sessionRowStatus({ ...complete, status: "completed" })), "Campaign Complete");

  // Exclusions keep their own status.
  assert.equal(label(sessionRowStatus(session({ status: "idle", attention,
    orchestratorCampaign: campaign("verified_complete", { mode: "custom" }) }))), "Ready for Review", "Custom");
  for (const pending of ["blocked", "waiting_human"]) {
    assert.equal(label(sessionRowStatus(session({ status: "idle", attention, orchestratorCampaign: campaign(pending) }))), "Ready for Review", pending);
  }
  assert.equal(label(sessionRowStatus({ ...complete, parentSessionId: "parent" })), "Ready for Review", "a descendant");
  assert.equal(label(sessionRowStatus({ ...complete, status: "running" })), "Running", "still working");
  assert.equal(label(sessionRowStatus({ ...complete, status: "failed" })), "Failed");
  assert.equal(label(sessionRowStatus({ ...complete, status: "stopped" })), "Stopped");
  assert.equal(label(sessionRowStatus(complete, { runnerOnline: false })), "Disconnected");
  assert.equal(label(sessionRowStatus(complete, { familyWorking: true })), "Children Working");
  const question = { requestId: "q", kind: "question" as const, title: "Choose", options: [] };
  assert.equal(label(sessionRowStatus({ ...complete, pendingApproval: question,
    attention: { ...attention, humanActions: [{ requestId: "q", rank: 3, requestedAt: 1 }] } })), "Answer Required");
  const fired = reminder({ state: "fired" });
  assert.equal(label(sessionRowStatus(complete, { reminder: fired })), label(sessionRowStatus(session(), { reminder: fired })), "a fired reminder");
});

test("an idle Full Control root reads Complete, Needs Cleanup or Campaign Stuck, never Campaign Active (#4146)", () => {
  const attention = { version: 1 as const, humanActions: [], meaningfulAt: 1,
    result: { revision: "r1", at: 1, owner: "human" as const }, acknowledgedRevision: null };
  const fullControl = { mode: "full_control", boundary: { version: 1, revision: 3, issueScopeRevision: 1, repository: "owner/repo",
    objective: "Deliver", authorizedByUserId: "user", authorizedAt: 1, operations: [], delegatablePolicyIds: [] } };
  const campaign = (status: string) =>
    ({ status, policyRevision: 3, control: fullControl }) as unknown as NonNullable<SessionView["orchestratorCampaign"]>;

  const cleanup = sessionRowStatus(session({ status: "idle", attention, orchestratorCampaign: campaign("complete_needs_cleanup") }));
  assert.equal(label(cleanup), "Complete, Needs Cleanup");
  assert.equal(cleanup.lifecycle.meta.tone, "info", "it reads as complete, with an informational tone");
  assert.equal(cleanup.lifecycle.ariaLabel, "Status: Complete, Needs Cleanup");
  assert.match(cleanup.lifecycle.title ?? "", /Campaign Status lists each item/u);
  assert.equal(cleanup.badge, null, "the campaign state takes the place of Awaiting Prompt (#4369)");
  assert.equal(label(sessionRowStatus(session({ status: "idle", attention: undefined,
    fullControlCampaignStatus: "complete_needs_cleanup", orchestratorPolicy: { control: fullControl } as unknown as SessionView["orchestratorPolicy"] }))),
  "Complete, Needs Cleanup", "a summary row carries the status without a projection");

  const stuck = sessionRowStatus(session({ status: "idle", attention, orchestratorCampaign: campaign("stuck") }));
  assert.equal(label(stuck), "Campaign Stuck", "the warning wins over Ready for Review");
  assert.equal(stuck.badge?.meta.tone, "warning");
  assert.equal(stuck.badge?.ariaLabel, "Status: Campaign Stuck");
  assert.notEqual(label(sessionRowStatus(session({ status: "running", attention, orchestratorCampaign: campaign("stuck") }))), "Campaign Stuck",
    "a running root is working, whatever the last status said");
  const question = { requestId: "q", kind: "question" as const, title: "Choose", options: [] };
  assert.equal(label(sessionRowStatus(session({ status: "idle", pendingApproval: question, orchestratorCampaign: campaign("stuck"),
    attention: { ...attention, humanActions: [{ requestId: "q", rank: 3, requestedAt: 1 }] } }))), "Answer Required",
  "a request for the person still comes first");
});

test("an at-rest root of an active Full Control campaign shows an informational Campaign Active (#2938)", () => {
  const attention = { version: 1 as const, humanActions: [], meaningfulAt: 1,
    result: { revision: "r1", at: 1, owner: "human" as const }, acknowledgedRevision: null };
  const fullControl = { mode: "full_control", boundary: { version: 1, revision: 3, issueScopeRevision: 1, repository: "owner/repo",
    objective: "Deliver", authorizedByUserId: "user", authorizedAt: 1, operations: [], delegatablePolicyIds: [] } };
  // The live facts readiness reads (#2940): owners for the decisions this boundary leaves out stay the
  // Human's, so the ready fixture's boundary holds every operation.
  const ready = { fullControlHumanRequired: [], uiEvidenceReview: { status: "available", effectiveOwner: "orchestrator" },
    recovery: { unattendedReady: true, automation: { state: "available" }, automatic: 0, waitingHuman: 0, blocked: 0, records: [], truncated: false },
    decisionOwners: { implementation_question: "orchestrator", pr_merge: "orchestrator", merged_branch_deletion: "orchestrator",
      follow_up_issue_publication: "orchestrator", ui_evidence_approval: "orchestrator", review_round_extension: "orchestrator" } };
  const everyOperation = { ...fullControl, boundary: { ...fullControl.boundary, operations: ["implementation_question", "pr_merge",
    "merged_branch_deletion", "follow_up_issue_publication", "ui_evidence_approval", "issue_closure", "campaign_issue_scope",
    "question", "tool_approval", "policy_ask"],
  issueAuthority: { epics: [], relatedFollowUps: true, maxIssues: 3, closureReasons: ["completed"] } } };
  const campaign = (status: string, control: unknown = everyOperation, facts: object = ready) =>
    ({ status, policyRevision: 3, control, ...facts }) as unknown as NonNullable<SessionView["orchestratorCampaign"]>;
  const active = session({ status: "idle", attention, orchestratorCampaign: campaign("active") });
  const status = sessionRowStatus(active);
  assert.equal(label(status), "Campaign Active");
  assert.deepEqual([status.lifecycle.meta.tone, Boolean(status.lifecycle.meta.pulse)], ["info", false]);
  assert.equal(status.lifecycle.ariaLabel, "Status: Campaign Active");
  assert.equal(status.lifecycle.title, "This Full Control campaign continues automatically. Its intermediate results are informational.");
  // Readiness the facts don't prove is never claimed (#2940 criterion 8).
  assert.equal(sessionRowStatus(session({ status: "idle", attention, orchestratorCampaign: campaign("active", everyOperation,
    { ...ready, fullControlHumanRequired: ["human_required_rules"] }) })).lifecycle.title,
  "This Full Control campaign continues automatically, except the decisions and limits Campaign Status lists under Full Control. Its intermediate results are informational.");
  assert.equal(sessionRowStatus(session({ status: "idle", attention, orchestratorCampaign: campaign("active", fullControl) })).lifecycle.title,
    "This Full Control campaign continues automatically, except the decisions and limits Campaign Status lists under Full Control. Its intermediate results are informational.",
    "decisions the boundary leaves out come to the person");
  assert.equal(sessionRowStatus(session({ status: "idle", attention, orchestratorCampaign: campaign("active", everyOperation, {}) })).lifecycle.title,
    "This Full Control campaign continues automatically where it can; Campaign Status shows anything it still needs from you. Its intermediate results are informational.",
    "a projection without readiness facts claims none");
  assert.equal(label(sessionRowStatus({ ...active, attention: { ...attention, result: null } })), "Campaign Active",
    "an at-rest active root never reads as awaiting a prompt");
  assert.equal(label(sessionRowStatus({ ...active, status: "completed" })), "Campaign Active");
  // The server's status moving changes the badge in both directions.
  assert.equal(label(sessionRowStatus({ ...active, orchestratorCampaign: campaign("verified_complete") })), "Campaign Complete");
  assert.equal(label(sessionRowStatus({ ...active, orchestratorCampaign: campaign("waiting_human") })), "Ready for Review");
  assert.equal(label(sessionRowStatus({ ...active, orchestratorCampaign: campaign("blocked") })), "Ready for Review");
  // Exclusions keep their own status.
  assert.equal(label(sessionRowStatus({ ...active, orchestratorCampaign: campaign("active", { mode: "custom" }) })), "Ready for Review", "Custom");
  assert.equal(label(sessionRowStatus({ ...active, parentSessionId: "parent" })), "Ready for Review", "a descendant");
  assert.equal(label(sessionRowStatus({ ...active, status: "running" })), "Running", "still working");
  assert.equal(label(sessionRowStatus({ ...active, status: "failed" })), "Failed");
  assert.equal(label(sessionRowStatus({ ...active, status: "stopped" })), "Ready for Review",
    "a stopped root is not continuing, so its result is the person's again");
  assert.equal(label(sessionRowStatus(active, { runnerOnline: false })), "Disconnected");
  assert.equal(label(sessionRowStatus(active, { familyWorking: true })), "Children Working");
  // A child's request routed to the Human surfaces at the root over the informational badge.
  const family = sessionRowStatus(active, { familyFollowUpLabel: "Needs Your Input" });
  assert.equal(label(family), "Needs Your Input");
  const question = { requestId: "q", kind: "question" as const, title: "Choose", options: [] };
  assert.equal(label(sessionRowStatus({ ...active, pendingApproval: question,
    attention: { ...attention, humanActions: [{ requestId: "q", rank: 3, requestedAt: 1 }] } })), "Answer Required");
  const fired = reminder({ state: "fired" });
  assert.equal(label(sessionRowStatus(active, { reminder: fired })), label(sessionRowStatus(session(), { reminder: fired })), "a fired reminder");
});

test("a working session shows its working status, never Ready for Review, until its turn ends (#3074)", () => {
  const attention = { version: 1 as const, humanActions: [], meaningfulAt: 1,
    result: { revision: "r1", at: 1, owner: "human" as const }, acknowledgedRevision: null };
  for (const [status, expected] of [["running", "Running"], ["starting", "Starting"], ["queued", "Queued"]] as const) {
    assert.equal(label(sessionRowStatus(session({ status, attention }))), expected, status);
  }
  assert.equal(label(sessionRowStatus(session({ status: "idle", attention, stopOperation: {
    operationId: "stop", status: "stop_pending", requestedAt: 1, lastAttemptAt: 1, attemptCount: 1, capacityReleased: false } }))), "Stop Pending");
  // The same unacknowledged result is ready once the turn ends.
  assert.equal(label(sessionRowStatus(session({ status: "idle", attention }))), "Ready for Review");
  // A request that needs the person still ranks above the working status.
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
  assert.equal(sessionRowStatus(session()).lifecycle.meta.label, "Awaiting Prompt");
  for (const [status, expected] of [
    ["running", "Running"], ["starting", "Starting"], ["queued", "Queued"], ["input_required", "Awaiting Input"],
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
    assert.equal(label(sessionRowStatus(record)), (sessionStatusSummary(record).secondary ?? sessionStatusSummary(record).primary).meta.label, JSON.stringify(extra));
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
  assert.equal(sessionRowStatus(watched).badge?.meta.label, "Result Pending");
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
  assert.equal(label(sessionRowStatus(session({ status: "idle" }), {
    familyFollowUpLabel: "Ready for Review" })), "Ready for Review");
  // A working parent shows its working status, not its family's Ready for Review (#3074).
  for (const [status, expected] of [["running", "Running"], ["starting", "Starting"], ["queued", "Queued"]] as const) {
    assert.equal(label(sessionRowStatus(session({ status }), { familyFollowUpLabel: "Ready for Review" })), expected, status);
  }
  const disconnected = sessionRowStatus(session({ status: "idle" }), {
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
  const ownResult = session({ status: "idle", attention: { version: 1, meaningfulAt: 10, humanActions: [],
    result: { revision: "own", at: 10, owner: "human" }, acknowledgedRevision: null } });
  assert.equal(sessionRowStatus(ownResult, { familyFollowUpLabel: "Ready for Review" }).badge?.title,
    sessionRowStatus(ownResult).badge?.title, "an identical family reason preserves the parent's own result description");
  assert.equal(label(sessionRowStatus(session({ status: "running" }))), "Running",
    "controller-owned descendants have no human family reason to promote");
});


test("available results use a review badge while required answers keep warning priority", () => {
  const attention = { version: 1 as const, humanActions: [], meaningfulAt: 1,
    result: { revision: "r1", at: 1, owner: "human" as const }, acknowledgedRevision: null };
  const result = sessionRowStatus(session({ status: "idle", attention }));
  assert.equal(result.badge?.meta.label, "Ready for Review");
  assert.equal(result.badge?.meta.tone, "review");
  assert.equal(result.badge?.ariaLabel, "Status: Ready for Review");
  assert.match(result.badge?.title ?? "", /assessment or next instructions/);
  const family = sessionRowStatus(session(), { familyFollowUpLabel: "Ready for Review" });
  assert.equal(family.badge?.meta.tone, "review");
  assert.equal(family.badge?.ariaLabel, "Status: Ready for Review");
  assert.match(family.badge?.title ?? "", /in this family/);
  const question = sessionRowStatus(session({ status: "running", attention: { ...attention,
    humanActions: [{ requestId: "q", rank: 3, requestedAt: 2 }] },
    pendingApproval: { requestId: "q", kind: "question", title: "Choose", options: [] } }), {
    familyFollowUpLabel: "Ready for Review" });
  assert.equal(question.badge?.meta.label, "Answer Required");
  assert.equal(question.badge?.meta.tone, "warning");
});


test("family work suppresses review readiness without hiding requests or recovery (#3328)", () => {
  const attention = { version: 1 as const, humanActions: [], meaningfulAt: 1,
    result: { revision: "r1", at: 1, owner: "human" as const }, acknowledgedRevision: null };
  assert.equal(label(sessionRowStatus(session({ attention }), { familyWorking: true,
    familyFollowUpLabel: "Ready for Review" })), "Children Working");
  assert.equal(label(sessionRowStatus(session({ attention }), { familyWorking: true,
    familyFollowUpLabel: "Needs Your Input" })), "Needs Your Input");
  assert.equal(label(sessionRowStatus(session({ status: "failed", attention }), { familyWorking: true })), "Failed");
  for (const [backgroundWorkState, expected] of [["running", "Waiting on External Job"],
    ["continuation_pending", "Follow-Up Pending"]] as const) {
    assert.equal(label(sessionRowStatus(session({ attention, backgroundWorkState }))), expected);
  }
});

test("the header's Campaign Active claims continuing automatically only when the server's facts prove it (#2940)", () => {
  const attention = { version: 1 as const, humanActions: [], meaningfulAt: 1,
    result: { revision: "r1", at: 1, owner: "human" as const }, acknowledgedRevision: null };
  const owners = { implementation_question: "orchestrator", pr_merge: "orchestrator", merged_branch_deletion: "orchestrator",
    follow_up_issue_publication: "orchestrator", ui_evidence_approval: "orchestrator", review_round_extension: "orchestrator" };
  const control = { mode: "full_control", boundary: { version: 1, revision: 3, issueScopeRevision: 1, repository: "owner/repo",
    objective: "Deliver", authorizedByUserId: "user", authorizedAt: 1, delegatablePolicyIds: [],
    operations: ["implementation_question", "pr_merge", "merged_branch_deletion", "follow_up_issue_publication", "ui_evidence_approval",
      "issue_closure", "campaign_issue_scope", "question", "tool_approval", "policy_ask"],
    issueAuthority: { epics: [], relatedFollowUps: true, maxIssues: 3, closureReasons: ["completed"] } } };
  const ready = { status: "active", policyRevision: 3, control, decisionOwners: owners, fullControlHumanRequired: [],
    uiEvidenceReview: { status: "available", effectiveOwner: "orchestrator" },
    recovery: { unattendedReady: true, automation: { state: "available" }, automatic: 0, waitingHuman: 0, blocked: 0, records: [], truncated: false } };
  const describe = (campaign: object) => sessionHeaderStatusSummary(session({ status: "idle", attention,
    orchestratorCampaign: campaign as unknown as NonNullable<SessionView["orchestratorCampaign"]> })).primary.description;
  assert.equal(describe(ready), "This Full Control campaign continues automatically. Its intermediate results are informational.");
  assert.equal(describe({ ...ready, fullControlHumanRequired: ["human_required_rules"] }),
    "This Full Control campaign continues automatically, except the decisions and limits Campaign Status lists under Full Control. Its intermediate results are informational.");
  assert.equal(describe({ status: "active", policyRevision: 3, control }),
    "This Full Control campaign continues automatically where it can; Campaign Status shows anything it still needs from you. Its intermediate results are informational.");
});

test("an active or complete Full Control root's header shows the campaign state instead of Awaiting Prompt (#2938)", () => {
  const attention = { version: 1 as const, humanActions: [], meaningfulAt: 1,
    result: { revision: "r1", at: 1, owner: "human" as const }, acknowledgedRevision: null };
  const fullControl = { mode: "full_control", boundary: { version: 1, revision: 3, issueScopeRevision: 1, repository: "owner/repo",
    objective: "Deliver", authorizedByUserId: "user", authorizedAt: 1, operations: [], delegatablePolicyIds: [] } };
  const campaign = (status: string, control: unknown = fullControl) =>
    ({ status, policyRevision: 3, control }) as unknown as NonNullable<SessionView["orchestratorCampaign"]>;
  const root = (status: string, extra: Partial<SessionView> = {}) =>
    session({ status: "idle", attention, orchestratorCampaign: campaign(status), ...extra });
  const header = (value: SessionView, context = {}) => {
    const summary = sessionHeaderStatusSummary(value, context);
    return [summary.primary.meta.label, summary.secondary?.meta.label ?? null, summary.more];
  };

  for (const [status, label, tone] of [["active", "Campaign Active", "info"], ["verified_complete", "Campaign Complete", "success"],
    ["complete_needs_cleanup", "Complete, Needs Cleanup", "info"]] as const) {
    const summary = sessionHeaderStatusSummary(root(status));
    assert.deepEqual(header(root(status)), [label, null, 0], status);
    assert.equal(summary.primary.meta.tone, tone, status);
    assert.equal(summary.primary.meta.pulse, false, `${status} never reads as running`);
    // The popover lists the campaign state in place of the lifecycle, so nothing says it waits for a prompt.
    assert.equal(summary.conditions.some((condition) => condition.meta.label === "Awaiting Prompt"), false, status);
    assert.deepEqual(summary.conditions.map((condition) => condition.kind).filter((kind) => kind === "lifecycle" || kind === "campaign"), ["campaign"], status);
    // The header and the root's row read the same campaign state, in the same place (#4369).
    assert.equal(sessionRowStatus(root(status)).lifecycle.meta.label, label, status);
    assert.equal(sessionRowStatus(root(status)).badge, null, status);
    // A Completed root keeps its lifecycle and shows the campaign state beside it, as its row does.
    assert.deepEqual(header(root(status, { status: "completed" })), ["Completed", label, 0], `${status}, completed`);
    // Each popover row has its own identity: the campaign state is never a second lifecycle row.
    const completedKinds = sessionHeaderStatusSummary(root(status, { status: "completed" })).conditions.map((condition) => condition.kind);
    assert.equal(new Set(completedKinds).size, completedKinds.length, `${status}, completed`);
  }
  // A summary row carries only the server's status and the root's own stored control.
  assert.deepEqual(header(session({ status: "idle", attention, fullControlCampaignStatus: "active",
    orchestratorPolicy: { control: fullControl } as unknown as SessionView["orchestratorPolicy"] })), ["Campaign Active", null, 0]);

  // A stuck campaign needs a person: Awaiting Prompt stays and Campaign Stuck leads Ready for Review.
  const stuck = sessionHeaderStatusSummary(root("stuck"));
  assert.deepEqual(header(root("stuck")), ["Awaiting Prompt", "Campaign Stuck", 1]);
  assert.equal(stuck.secondary?.meta.tone, "warning");
  assert.equal(stuck.secondary?.needsYou, true);
  assert.deepEqual(stuck.conditions.map((condition) => condition.kind), ["campaign", "lifecycle", "follow_up"],
    "Campaign Stuck is its own popover row beside the lifecycle");
  assert.equal(sessionRowStatus(root("stuck")).badge?.meta.label, "Campaign Stuck", "the row agrees");
  assert.deepEqual(header(root("stuck", { attention: { ...attention, result: null } })), ["Awaiting Prompt", "Campaign Stuck", 0]);

  // Everything else keeps today's header.
  const question = { requestId: "q", kind: "question" as const, title: "Choose", options: [] };
  const asked = { pendingApproval: question, attention: { ...attention, humanActions: [{ requestId: "q", rank: 3, requestedAt: 1 }] } };
  for (const status of ["active", "verified_complete", "complete_needs_cleanup", "stuck"]) {
    assert.deepEqual(header(root(status, asked)), header(session({ status: "idle", ...asked })), `${status}: a request for the person`);
    assert.equal(header(root(status, { status: "running" }))[0], "Running", `${status}: a running root`);
    assert.equal(header(root(status, { status: "failed" }))[0], "Failed", `${status}: a failed root`);
    assert.equal(header(root(status, { parentSessionId: "parent" }))[0], "Awaiting Prompt", `${status}: a descendant`);
    assert.equal(header(root(status, { orchestratorCampaign: campaign(status, { mode: "custom" }) }))[0], "Awaiting Prompt", `${status}: Custom`);
    assert.equal(header(root(status), { runnerOnline: false })[0], "Awaiting Prompt", `${status}: a lost machine`);
    assert.equal(header(root(status), { activeWorkers: 1 })[0], "Awaiting Prompt", `${status}: live workers`);
    assert.equal(header(root(status, { backgroundWorkState: "running" }))[0], "Awaiting Prompt", `${status}: background work`);
    assert.equal(header(root(status, { stopOperation: { status: "stop_pending" } as SessionView["stopOperation"] }))[0], "Stop Pending",
      `${status}: a pending Stop`);
  }
  for (const status of ["waiting_human", "blocked", "complete_with_handoffs"]) {
    assert.deepEqual(header(root(status)), ["Awaiting Prompt", "Ready for Review", 0], status);
  }
  assert.deepEqual(header(root("active", { campaignRequests: { human: 1, orchestrator: 0, humanRequestTokens: [] } })),
    ["Awaiting Prompt", "1 Child Request", 0], "a human-owned campaign request");
  // Older control planes send no campaign status: the header reads as it always has.
  assert.deepEqual(header(session({ status: "idle", attention })), ["Awaiting Prompt", "Ready for Review", 0]);
  assert.deepEqual(header(session({ status: "idle", attention, orchestratorCampaign: undefined })),
    [sessionStatusSummary(session({ status: "idle", attention })).primary.meta.label, "Ready for Review", 0]);
});

test("an at-rest Full Control root's row and card name its campaign state where the header does (#4369)", () => {
  const attention = { version: 1 as const, humanActions: [], meaningfulAt: 1,
    result: { revision: "r1", at: 1, owner: "human" as const }, acknowledgedRevision: null };
  const fullControl = { mode: "full_control", boundary: { version: 1, revision: 3, issueScopeRevision: 1, repository: "owner/repo",
    objective: "Deliver", authorizedByUserId: "user", authorizedAt: 1, operations: [], delegatablePolicyIds: [] } };
  // The shape a list snapshot sends: the server's campaign status and the root's stored control.
  const root = (status: string | undefined, extra: Partial<SessionView> = {}) => session({ status: "idle", attention,
    ...(status ? { fullControlCampaignStatus: status } : {}),
    orchestratorPolicy: { control: fullControl }, ...extra } as unknown as Partial<SessionView>);
  const row = (value: SessionView, context = {}) => {
    const status = sessionRowStatus(value, context);
    return [status.lifecycle.meta.label, status.badge?.meta.label ?? null];
  };

  for (const [status, label] of [["active", "Campaign Active"], ["verified_complete", "Campaign Complete"],
    ["complete_needs_cleanup", "Complete, Needs Cleanup"]] as const) {
    assert.deepEqual(row(root(status)), [label, null], status);
    assert.equal(row(root(status))[0], sessionHeaderStatusSummary(root(status)).primary.meta.label, `${status}: the header agrees`);
    const shown = sessionRowStatus(root(status));
    assert.equal(shown.lifecycle.ariaLabel, `Status: ${label}`, status);
    assert.doesNotMatch(shown.details, /Awaiting Prompt/u, `${status}: the tooltip never says the agent waits for a prompt`);
    // A Completed root keeps Completed, with the campaign state beside it.
    assert.deepEqual(row(root(status, { status: "completed" })), ["Completed", label], `${status}, completed`);
    // Children still working stay the secondary, beside the campaign state.
    assert.deepEqual(row(root(status), { familyWorking: true }), [label, "Children Working"], `${status}, children working`);
    assert.deepEqual(row(root(status), { familyWorking: true, familyProgressing: false }), [label, "Child Work Pending"],
      `${status}, child work pending`);
  }
  // Campaign Stuck needs a person: Awaiting Prompt stays, with Campaign Stuck beside it.
  assert.deepEqual(row(root("stuck")), ["Awaiting Prompt", "Campaign Stuck"]);
  assert.deepEqual(row(root("stuck"), { familyWorking: true }), ["Awaiting Prompt", "Children Working"]);

  // Everything else keeps its lifecycle as today: the projection never replaces it.
  const question = { requestId: "q", kind: "question" as const, title: "Choose", options: [] };
  const asked = { pendingApproval: question, attention: { ...attention, humanActions: [{ requestId: "q", rank: 3, requestedAt: 1 }] } };
  for (const status of ["active", "verified_complete", "complete_needs_cleanup"]) {
    const unchanged: Array<[string, SessionView, { runnerOnline?: boolean; reminder?: SessionReminderView;
      familyFollowUpLabel?: "Needs Your Input" }]> = [
      ["a request for the person", root(status, asked), {}],
      ["a human-owned campaign request", root(status, { campaignRequests: { human: 1, orchestrator: 0, humanRequestTokens: [] } }), {}],
      ["a pending Stop", root(status, { stopOperation: { status: "stop_pending" } as SessionView["stopOperation"] }), {}],
      ["a running root", root(status, { status: "running" }), {}],
      ["background work", root(status, { backgroundWorkState: "running" }), {}],
      ["a lost machine", root(status), { runnerOnline: false }],
      ["a fired reminder", root(status), { reminder: reminder({ state: "fired" }) }],
      ["a family request for the person", root(status), { familyFollowUpLabel: "Needs Your Input" }],
      ["a descendant", root(status, { parentSessionId: "parent" }), {}],
      ["a Custom campaign", root(status, { orchestratorPolicy: { control: { mode: "custom" } } as unknown as SessionView["orchestratorPolicy"] }), {}],
    ];
    for (const [name, value, context] of unchanged) {
      const lifecycle = sessionStatusSummary(value, { runnerOnline: context.runnerOnline }).primary.meta.label;
      assert.equal(row(value, context)[0], lifecycle, `${status}: ${name}`);
    }
    assert.equal(row(root(status), { reminder: reminder({ state: "fired" }) })[0], "Awaiting Prompt", `${status}: a fired reminder`);
    assert.equal(row(root(status), { runnerOnline: false })[0], "Awaiting Prompt", `${status}: a lost machine`);
  }
  for (const status of ["waiting_human", "blocked", "complete_with_handoffs"]) {
    assert.deepEqual(row(root(status)), ["Awaiting Prompt", "Ready for Review"], status);
  }
  // A control plane that sends no campaign status reads as it always has.
  assert.deepEqual(row(root(undefined)), ["Awaiting Prompt", "Ready for Review"]);
  assert.deepEqual(row(root(undefined), { familyWorking: true }), ["Awaiting Prompt", "Children Working"]);
});
