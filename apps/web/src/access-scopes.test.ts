import assert from "node:assert/strict";
import test from "node:test";
import type { IdentityAdministrationView, ResourceScope } from "@wollipog/protocol";
import {
  accessScopeChoices,
  accessScopeLabel,
  canAssignAccessScope,
  scopeAudienceContained,
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
  assert.equal(accessScopeLabel(scope({ kind: "user", userId: "user-two" }), identity("admin")), "Private to Two");
});

test("client compatibility preflight is conservative for private, team, cross-user, and organization scopes", () => {
  const organization = scope({ kind: "organization", organizationId: "org" });
  const one = scope({ kind: "user", userId: "user-one" });
  const two = scope({ kind: "user", userId: "user-two" });
  const team = scope({ kind: "team", teamId: "team" });
  assert.equal(scopeAudienceContained(one, organization), true);
  assert.equal(scopeAudienceContained(organization, one), false);
  assert.equal(scopeAudienceContained(one, one), true);
  assert.equal(scopeAudienceContained(one, two), false);
  assert.equal(scopeAudienceContained(one, team), false);
});

test("corrective actions only target scopes the current actor may assign", () => {
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
});
