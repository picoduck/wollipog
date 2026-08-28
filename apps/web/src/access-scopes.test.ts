import assert from "node:assert/strict";
import test from "node:test";
import type { IdentityAdministrationView, ResourceScope } from "@wollipog/protocol";
import {
  accessScopeChoices,
  accessScopeLabel,
  canAssignAccessScope,
  canChangeAccessScope,
  scopeAudienceContainedForIdentity,
} from "./access-scopes.js";

function identity(role: IdentityAdministrationView["context"]["role"]): IdentityAdministrationView {
  return {
    context: {
      userId: "user-one",
      userName: "One",
      organizationId: "org",
      organizationName: "Organization",
      role,
      deviceId: "device",
      localBootstrap: false,
    },
    organizations: [{ organizationId: "org", name: "Organization", createdAt: 1 }],
    memberships: [{
      organizationId: "org", organizationName: "Organization", userId: "user-one", userName: "One",
      userStatus: "active", role, createdAt: 1,
    }, {
      organizationId: "org", organizationName: "Organization", userId: "user-two", userName: "Two",
      userStatus: "active", role: "operator", createdAt: 1,
    }],
    teams: [{ teamId: "team", organizationId: "org", name: "Builders", memberUserIds: ["user-one"], createdAt: 1 }],
  };
}

const scope = (owner: ResourceScope["owner"]): ResourceScope => ({ organizationId: "org", owner });

test("access choices expose only authorized creation scopes and use Title Case labels", () => {
  assert.deepEqual(accessScopeChoices(identity("operator")).map((choice) => choice.label), [
    "Private to Me",
    "Team: Builders",
  ]);
  assert.deepEqual(accessScopeChoices(identity("admin")).map((choice) => choice.label), [
    "Private to Me",
    "Team: Builders",
    "Organization-Wide",
  ]);
  assert.deepEqual(accessScopeChoices(identity("viewer")), [],
    "viewers are never offered creation scopes for a server-rejected mutation");
  assert.equal(accessScopeLabel(scope({ kind: "user", userId: "user-two" }), identity("admin")), "Private to Two");
});

test("client preflight widens scope containment by active team membership", () => {
  const one = scope({ kind: "user", userId: "user-one" });
  const two = scope({ kind: "user", userId: "user-two" });
  const team = scope({ kind: "team", teamId: "team" });
  assert.equal(scopeAudienceContainedForIdentity(identity("operator"), one, team), true,
    "the signed-in active team member is a narrower audience than their team");
  assert.equal(scopeAudienceContainedForIdentity(identity("operator"), two, team), false,
    "a non-member stays outside the team audience");
  assert.equal(scopeAudienceContainedForIdentity(identity("operator"), team, one), false,
    "membership never widens a team scope into a private one");
});

test("corrective actions only target scopes the current actor may assign", () => {
  const one = scope({ kind: "user", userId: "user-one" });
  const team = scope({ kind: "team", teamId: "team" });
  const admin = identity("admin");
  assert.equal(canAssignAccessScope(admin, { kind: "organization", organizationId: "org" }), true);
  assert.equal(canAssignAccessScope(admin, { kind: "team", teamId: "team" }), true);
  assert.equal(canAssignAccessScope(admin, { kind: "user", userId: "user-one" }), true);
  assert.equal(canAssignAccessScope(admin, { kind: "user", userId: "user-two" }), false,
    "an administrator cannot transfer a resource into another member's private scope");

  const member = identity("operator");
  assert.equal(canAssignAccessScope(member, { kind: "organization", organizationId: "org" }), false);
  assert.equal(canAssignAccessScope(member, { kind: "team", teamId: "team" }), true);
  assert.equal(canAssignAccessScope(member, { kind: "user", userId: "user-one" }), true);
  assert.equal(canChangeAccessScope(member, team, { kind: "user", userId: "user-one" }), true,
    "a team member may narrow a managed team resource to themselves");
  assert.equal(canChangeAccessScope(member, one, { kind: "team", teamId: "team" }), false,
    "an ordinary member may not broaden their private resource to a team");
  assert.equal(canChangeAccessScope(identity("viewer"), team, { kind: "user", userId: "user-one" }), false,
    "a Viewer remains read-only even when they belong to the current team");
});
