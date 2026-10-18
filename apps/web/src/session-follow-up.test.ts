import assert from "node:assert/strict";
import test from "node:test";
import type { OrchestratorCampaignProjection, SessionReminderView, SessionView } from "@wollipog/protocol";
import { activeFullControlCampaign, completedFullControlCampaign, outstandingSessionResult, sessionFollowUp } from "./session-follow-up.js";
import { sortSessionsForReminders } from "./session-reminders.js";

const FULL_CONTROL = { mode: "full_control", boundary: { version: 1, revision: 3, issueScopeRevision: 1, repository: "owner/repo",
  objective: "Deliver #12", authorizedByUserId: "user", authorizedAt: 1, operations: ["pr_merge"], delegatablePolicyIds: [] } } as const;

const campaign = (status: OrchestratorCampaignProjection["status"], control: unknown = FULL_CONTROL) =>
  ({ status, policyRevision: 3, ...(control ? { control } : {}) }) as unknown as OrchestratorCampaignProjection;

const attention = { version: 1 as const, humanActions: [], meaningfulAt: 1,
  result: { revision: "r1", at: 1, owner: "human" as const }, acknowledgedRevision: null };

const root = (extra: Partial<SessionView> = {}): SessionView =>
  ({ id: "root", status: "idle", pendingApproval: null, attention, orchestratorCampaign: campaign("verified_complete"), ...extra }) as unknown as SessionView;

test("a verified-complete Full Control root's result is informational, not outstanding (#2940)", () => {
  assert.equal(completedFullControlCampaign(root()), true);
  assert.equal(outstandingSessionResult(root()), null);
  assert.equal(sessionFollowUp(root()).group, "quiet", "it sorts with quiet sessions, not Ready for Review");
  // The root's own stored control counts when the projection omits it for this viewer.
  const ownPolicy = root({ orchestratorCampaign: campaign("verified_complete", null),
    orchestratorPolicy: { control: FULL_CONTROL } as unknown as SessionView["orchestratorPolicy"] });
  assert.equal(completedFullControlCampaign(ownPolicy), true);
});

test("every other state keeps its Ready for Review result", () => {
  const cases: Array<[string, SessionView]> = [
    ["Custom campaign", root({ orchestratorCampaign: campaign("verified_complete", { mode: "custom" }) })],
    ["no control reported", root({ orchestratorCampaign: campaign("verified_complete", null) })],
    ["blocked", root({ orchestratorCampaign: campaign("blocked") })],
    ["waiting for a person", root({ orchestratorCampaign: campaign("waiting_human") })],
    ["no campaign projection", root({ orchestratorCampaign: undefined })],
    ["a descendant", root({ parentSessionId: "parent" })],
  ];
  for (const [name, session] of cases) {
    assert.equal(completedFullControlCampaign(session), false, name);
    assert.deepEqual(outstandingSessionResult(session), attention.result, name);
    assert.equal(sessionFollowUp(session).group, "ready_for_review", name);
  }
});

test("a human action on a completed campaign still needs input", () => {
  const question = { requestId: "q", kind: "question" as const, title: "Choose", options: [] };
  const session = root({ pendingApproval: question, attention: { ...attention, humanActions: [{ requestId: "q", rank: 3, requestedAt: 1 }] } });
  assert.equal(sessionFollowUp(session).group, "needs_input");
});

test("a summary row, which carries no campaign projection, reads the server's Full Control status (#2940)", () => {
  // The shape a list snapshot sends: no `orchestratorCampaign`, only the root's status.
  const summary = (status: OrchestratorCampaignProjection["status"]) =>
    ({ id: "root", projection: "summary", status: "idle", pendingApproval: null, attention, fullControlCampaignStatus: status }) as unknown as SessionView;
  assert.equal(completedFullControlCampaign(summary("verified_complete")), true);
  assert.equal(outstandingSessionResult(summary("verified_complete")), null);
  assert.equal(sessionFollowUp(summary("verified_complete")).group, "quiet");
  for (const status of ["blocked", "waiting_human"] as const) {
    assert.equal(completedFullControlCampaign(summary(status)), false, status);
    assert.equal(sessionFollowUp(summary(status)).group, "ready_for_review", status);
  }
  assert.equal(completedFullControlCampaign(summary("active")), false, "active is informational, not complete");
  // The row's own status wins over a projection retained from an earlier detail read, both ways.
  assert.equal(completedFullControlCampaign({ ...summary("active"), orchestratorCampaign: campaign("verified_complete") }), false);
  assert.equal(completedFullControlCampaign({ ...summary("verified_complete"), orchestratorCampaign: campaign("active") }), true);
});

test("an at-rest root of an active Full Control campaign has informational intermediate results (#2938)", () => {
  const active = root({ orchestratorCampaign: campaign("active") });
  assert.equal(activeFullControlCampaign(active), true);
  assert.equal(completedFullControlCampaign(active), false);
  assert.equal(outstandingSessionResult(active), null, "no Mark Reviewed for an intermediate result");
  assert.equal(sessionFollowUp(active).group, "quiet", "it leaves Ready for Review");
  // A summary row carries only the server's status; the root's own stored control also counts.
  const summary = { id: "root", projection: "summary", status: "idle", pendingApproval: null, attention,
    fullControlCampaignStatus: "active" } as unknown as SessionView;
  assert.equal(activeFullControlCampaign(summary), true);
  assert.equal(sessionFollowUp(summary).group, "quiet");
  assert.equal(activeFullControlCampaign(root({ orchestratorCampaign: campaign("active", null),
    orchestratorPolicy: { control: FULL_CONTROL } as unknown as SessionView["orchestratorPolicy"] })), true);
});

test("an active campaign keeps the ordinary follow-up whenever a person is owed anything", () => {
  const question = { requestId: "q", kind: "question" as const, title: "Choose", options: [] };
  const cases: Array<[string, SessionView, "needs_input" | "ready_for_review"]> = [
    ["a failed root", root({ status: "failed", orchestratorCampaign: campaign("active") }), "ready_for_review"],
    ["a stopped root", root({ status: "stopped", orchestratorCampaign: campaign("active") }), "ready_for_review"],
    ["the root's own human action", root({ orchestratorCampaign: campaign("active"), pendingApproval: question,
      attention: { ...attention, humanActions: [{ requestId: "q", rank: 3, requestedAt: 1 }] } }), "needs_input"],
    // A child request routed to the Human surfaces at the root even before the server's status moves.
    ["a child request routed to the Human", root({ orchestratorCampaign: campaign("active"),
      campaignRequests: { human: 1, orchestrator: 0 } } as Partial<SessionView>), "needs_input"],
    ["waiting for a person", root({ orchestratorCampaign: campaign("waiting_human") }), "ready_for_review"],
    ["blocked", root({ orchestratorCampaign: campaign("blocked") }), "ready_for_review"],
    ["a Custom campaign", root({ orchestratorCampaign: campaign("active", { mode: "custom" }) }), "ready_for_review"],
    ["the root's own Custom policy", root({ orchestratorCampaign: campaign("active"),
      orchestratorPolicy: { control: { mode: "custom" } } as unknown as SessionView["orchestratorPolicy"] }), "ready_for_review"],
    ["a descendant", root({ orchestratorCampaign: campaign("active"), parentSessionId: "parent" }), "ready_for_review"],
  ];
  for (const [name, session, group] of cases) {
    assert.equal(activeFullControlCampaign(session), false, name);
    assert.deepEqual(outstandingSessionResult(session), attention.result, name);
    assert.equal(sessionFollowUp(session).group, group, name);
  }
});

test("an active campaign's result becomes complete, or reviewable again, as the server's status moves", () => {
  const active = root({ orchestratorCampaign: campaign("active") });
  assert.equal(outstandingSessionResult(active), null);
  const complete = { ...active, orchestratorCampaign: campaign("verified_complete") };
  assert.deepEqual([completedFullControlCampaign(complete), activeFullControlCampaign(complete), outstandingSessionResult(complete)],
    [true, false, null], "Active becomes Campaign Complete");
  const waiting = { ...active, orchestratorCampaign: campaign("waiting_human") };
  assert.deepEqual([activeFullControlCampaign(waiting), outstandingSessionResult(waiting), sessionFollowUp(waiting).group],
    [false, attention.result, "ready_for_review"], "a human item brings the unacknowledged result back to Ready for Review");
  // A fired reminder is the person's own follow-up, whatever the campaign's state.
  const fired = root({ orchestratorCampaign: campaign("active"),
    attention: { ...attention, result: { revision: "reminder", at: 2, owner: "human" } } });
  assert.notEqual(outstandingSessionResult(fired), null);
});

test("a fired reminder on a completed Full Control root still sorts ahead of ordinary work", () => {
  const reminder = { reminderId: "r", sessionId: "root", scheduledFor: 1_000, timeZone: "UTC", originalExpression: "later",
    wakePolicy: "regardless", state: "fired", firedAt: 900, revision: 1, createdAt: 1, updatedAt: 1 } as unknown as SessionReminderView;
  const running = { id: "running", status: "running", pendingApproval: null, createdAt: 5, updatedAt: 5_000, lastEventAt: 5_000,
    attention: { ...attention, result: null, meaningfulAt: 5_000 } } as unknown as SessionView;
  // Acknowledged: only the fired reminder makes the completed root a follow-up.
  const completed = root({ attention: { ...attention, acknowledgedRevision: "r1" }, createdAt: 1, updatedAt: 10, lastEventAt: 10 });
  assert.deepEqual(sortSessionsForReminders([running, completed], new Map([["root", reminder]]), "ordinary").map((session) => session.id),
    ["root", "running"], "the reminder's priority is kept");
  assert.deepEqual(sortSessionsForReminders([running, completed], new Map(), "ordinary").map((session) => session.id),
    ["running", "root"], "without the reminder the completed root is quiet");
});
