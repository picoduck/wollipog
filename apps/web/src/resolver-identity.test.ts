import assert from "node:assert/strict";
import { test } from "node:test";
import type { GovernanceAuditEntry, IdentityAdministrationView } from "@wollipog/protocol";
import { humanQuestionAnswers, humanResolver, questionAnswerActorId, viewerIdentity } from "./resolver-identity.js";

function identity(userId: string, members: Array<[string, string, string?]>): IdentityAdministrationView {
  return {
    context: {
      userId, userName: "", organizationId: "org-1", organizationName: "Org", role: "viewer",
      deviceId: null, localBootstrap: false,
    },
    organizations: [],
    memberships: members.map(([memberId, userName, organizationId = "org-1"]) => ({
      organizationId, organizationName: "Org", userId: memberId, userName,
      userStatus: "active", role: "operator", createdAt: 1,
    })),
    teams: [],
  };
}

function audit(overrides: Partial<GovernanceAuditEntry>): GovernanceAuditEntry {
  return {
    auditId: "audit", requestId: "ask", approvalKind: "question", stage: "resolution", outcome: "answered",
    actor: { kind: "human", id: "user-ada" }, scope: { sessionId: "session", runnerId: "runner" }, timestamp: 10,
    ...overrides,
  };
}

test("the viewer's organization decides whether answers can belong to someone else (#2527)", () => {
  assert.equal(viewerIdentity(identity("user-ada", [["user-ada", "Ada"]])).shared, false);
  assert.equal(viewerIdentity(identity("user-ada", [])).shared, false, "a directory without the viewer still counts them");
  assert.equal(viewerIdentity(identity("user-ada", [["user-ada", "Ada"], ["user-x", "X", "org-2"]])).shared, false,
    "another organization's members never make this one shared");
  const shared = viewerIdentity(identity("user-ada", [["user-ada", "Ada"], ["user-grace", " Grace Hopper "], ["user-anon", ""]]));
  assert.equal(shared.shared, true);
  assert.deepEqual([...shared.names], [["user-ada", "Ada"], ["user-grace", "Grace Hopper"]]);

  assert.deepEqual(humanResolver(shared, "user-ada"), { kind: "viewer" });
  assert.deepEqual(humanResolver(shared, "user-grace"), { kind: "member", name: "Grace Hopper" });
  assert.deepEqual(humanResolver(shared, "user-anon"), { kind: "other" });
  assert.equal(humanResolver(shared, undefined), null);
  assert.equal(humanResolver(null, "user-ada"), null);
});

test("only members' answers from the audit name a question's resolver", () => {
  const answers = humanQuestionAnswers([
    audit({ auditId: "a" }),
    audit({ auditId: "b", outcome: "dismissed" }),
    audit({ auditId: "c", actor: { kind: "policy", id: "routine" } }),
    audit({ auditId: "d", stage: "policy_decision" }),
    audit({ auditId: "e", approvalKind: "policy_hook", outcome: "allowed" }),
    audit({ auditId: "f", requestId: "other", actor: { kind: "human" }, timestamp: 20 }),
  ]);
  assert.deepEqual([...answers], [
    ["ask", [{ actorId: "user-ada" }]],
    ["other", [{}]],
  ]);
  assert.equal(humanQuestionAnswers([]).size, 0);

  const directory = { viewer: null, questionAnswers: answers };
  assert.equal(questionAnswerActorId(directory, "ask"), "user-ada");
  assert.equal(questionAnswerActorId(directory, "other"), undefined);
  assert.equal(questionAnswerActorId(directory, "missing"), undefined);
});
