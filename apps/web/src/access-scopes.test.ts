import assert from "node:assert/strict";
import test from "node:test";
import type { AccessScopeChangePreview, IdentityAdministrationView, ResourceScope } from "@wollipog/protocol";
import {
  accessScopeAudience,
  accessScopeChoices,
  accessScopeImpact,
  accessScopeLabel,
  accessScopeSentence,
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

function preview(
  currentScope: ResourceScope,
  targetScope: ResourceScope,
  options: Partial<AccessScopeChangePreview> = {},
): AccessScopeChangePreview {
  return {
    resource: "project", resourceId: "project", currentScope, targetScope, affectedProjects: [],
    activeSessionCount: 0, totalSessionCount: 0, sessionsToNarrow: 0, compatible: true, confirmationToken: "token",
    ...options,
  };
}

test("choice descriptions and the readout sentence say who has access, never 'resource'", () => {
  const admin = identity("admin");
  assert.deepEqual(accessScopeChoices(admin).map((choice) => choice.description), [
    "Only you and organization admins.",
    "Everyone on Builders (1 person).",
    "Everyone in your organization.",
  ]);
  assert.equal(accessScopeAudience(scope({ kind: "user", userId: "user-two" }), admin), "Only Two and organization admins.");
  assert.equal(accessScopeSentence(scope({ kind: "organization", organizationId: "org" }), admin),
    "Everyone in your organization can see and use it.");
  const empty = { ...admin, teams: [{ ...admin.teams[0]!, memberUserIds: [] }] };
  assert.equal(accessScopeChoices(empty)[1]?.description, "Everyone on Builders (no members yet).");
  assert.equal(accessScopeSentence(scope({ kind: "team", teamId: "team" }), empty),
    "Builders has no members yet, so only organization admins can see and use it.");
});

test("impact wording follows the direction and the counts, including one and zero sessions", () => {
  const admin = identity("admin");
  const org = scope({ kind: "organization", organizationId: "org" });
  const me = scope({ kind: "user", userId: "user-one" });
  const team = scope({ kind: "team", teamId: "team" });
  assert.deepEqual(accessScopeImpact(preview(org, me, { resource: "workspace" }), admin), {
    kind: "narrowing",
    title: "This Location Becomes Private to You",
    body: "Others in your organization lose access to this location.",
  });
  assert.deepEqual(accessScopeImpact(preview(org, me, { totalSessionCount: 1, activeSessionCount: 1 }), admin), {
    kind: "narrowing",
    title: "1 Session Becomes Private to You",
    body: "That includes 1 active session. Others in your organization lose access to this project and its sessions.",
  });
  assert.deepEqual(accessScopeImpact(preview(org, team, { totalSessionCount: 1, activeSessionCount: 1 }), admin), {
    kind: "narrowing",
    title: "Only Builders Keeps Access",
    body: "Everyone on Builders (1 person) keeps access. Its one session, which is active, is narrowed to the team.",
  });
  assert.deepEqual(accessScopeImpact(preview(org, team, { totalSessionCount: 3 }), admin), {
    kind: "narrowing",
    title: "Only Builders Keeps Access",
    body: "Everyone on Builders (1 person) keeps access. 3 sessions are narrowed to the team.",
  });
  assert.deepEqual(accessScopeImpact(preview(me, team, { totalSessionCount: 2 }), admin), {
    kind: "broadening",
    text: "Everyone on Builders (1 person) will see this project and its 2 sessions.",
  }, "a member's private resource moving to their team broadens it");
  assert.deepEqual(accessScopeImpact(preview(team, org), admin), {
    kind: "broadening",
    text: "Everyone in your organization will see this project.",
  });
});

test("server refusals are reworded, and only a narrower Location offers to change it", () => {
  const admin = identity("admin");
  const org = scope({ kind: "organization", organizationId: "org" });
  const me = scope({ kind: "user", userId: "user-one" });
  const refused = (resource: "project" | "workspace", reason: string) =>
    accessScopeImpact(preview(me, org, { resource, compatible: false, confirmationToken: undefined, reason }), admin);
  assert.deepEqual(refused("project", "The requested Project access would expose a narrower Location. Change that Location first or choose a narrower Project scope."), {
    kind: "incompatible",
    message: "A location in this project is more private than this choice. Change that location's access first, or choose a more private option.",
    blockedByLocation: true,
  });
  assert.deepEqual(refused("workspace", "The requested Location access would be broader than its Machine access."), {
    kind: "incompatible",
    message: "The machine this location is on isn't shared that widely. Choose a more private option.",
    blockedByLocation: false,
  });
  assert.deepEqual(refused("workspace", "The requested Location access is narrower than an attached Project. Narrow those Projects first or choose a broader Location scope."), {
    kind: "incompatible",
    message: "A project that uses this location is shared more widely than this choice. Change that project's access first, or choose a wider option.",
    blockedByLocation: false,
  });
  assert.deepEqual(refused("workspace", "A session in this Location has an incompatible private owner and cannot be transferred by a Location access change."), {
    kind: "incompatible",
    message: "A session in this location is private to someone else, so changing the location's access can't include it.",
    blockedByLocation: false,
  });
  assert.deepEqual(refused("project", "Something new."), {
    kind: "incompatible", message: "Something new.", blockedByLocation: false,
  }, "an unknown reason is shown as written");
});
