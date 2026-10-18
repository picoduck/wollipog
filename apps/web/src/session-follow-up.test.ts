import assert from "node:assert/strict";
import test from "node:test";
import type { OrchestratorCampaignProjection, SessionView } from "@wollipog/protocol";
import { completedFullControlCampaign, outstandingSessionResult, sessionFollowUp } from "./session-follow-up.js";

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
