import assert from "node:assert/strict";
import test from "node:test";
import type { OrchestratorCampaignProjection, SessionReminderView, SessionView } from "@wollipog/protocol";
import { completedFullControlCampaign, outstandingSessionResult, sessionFollowUp } from "./session-follow-up.js";
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
    ["active (including cleanup pending)", root({ orchestratorCampaign: campaign("active") })],
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
  for (const status of ["active", "blocked", "waiting_human"] as const) {
    assert.equal(completedFullControlCampaign(summary(status)), false, status);
    assert.equal(sessionFollowUp(summary(status)).group, "ready_for_review", status);
  }
  // The row's own status wins over a projection retained from an earlier detail read, both ways.
  assert.equal(completedFullControlCampaign({ ...summary("active"), orchestratorCampaign: campaign("verified_complete") }), false);
  assert.equal(completedFullControlCampaign({ ...summary("verified_complete"), orchestratorCampaign: campaign("active") }), true);
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
