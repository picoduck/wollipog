import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ORCHESTRATOR_DEFAULTS,
  PROTOCOL_VERSION,
  type AgentDefinition,
  type ResourceScope,
  type RunnerMetadata,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import type { AgentPrincipal } from "./identity.js";
import { childHarnessAgents, childModelMachines } from "./orchestrator-settings.js";

// #2940: an agent delegated as one user gets that user's member access to runners and their
// workspaces, and nothing else. The live route path is covered end to end by
// apps/runner/src/full-control-runner-access.integration.test.ts; this pins the edges.

const now = 1_000;
const MODEL = "claude-opus-5-5";
const CLAUDE: AgentDefinition = { id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code",
  context: { kind: "native" }, available: true, authStatus: "authenticated",
  capabilities: { models: [{ id: MODEL, default: true }], effortLevels: ["high"], slashCommands: [],
    permissionModes: ["default", "orchestrator"], supportsImages: true, supportsApprovals: true } };

function fixture() {
  const db = ControlPlaneDb.open(":memory:");
  const org = db.localIdentityContext().organizationId;
  const otherOrg = "org_other";
  db.raw().prepare("INSERT INTO identity_organizations (organization_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(otherOrg, "Other", now, now);
  for (const [userId, role] of [["usr_member", "operator"], ["usr_admin", "admin"], ["usr_viewer", "viewer"], ["usr_peer", "operator"]] as const) {
    db.createIdentityMember({ userId, displayName: userId, organizationId: org, role, now });
  }
  db.createIdentityTeam({ teamId: "team_member", organizationId: org, name: "Member", memberUserIds: ["usr_member", "usr_admin", "usr_viewer"], now });
  db.createIdentityTeam({ teamId: "team_peer", organizationId: org, name: "Peer", memberUserIds: ["usr_peer"], now });
  const register = (runnerId: string, scope: ResourceScope) => {
    const meta: RunnerMetadata = { runnerId, hostname: runnerId, os: "linux", version: "test",
      workspaces: [{ id: "w", name: "W", path: `/w/${runnerId}` }], agents: [CLAUDE] };
    db.registerRunner(meta, now, PROTOCOL_VERSION, scope);
  };
  const user = (userId: string): ResourceScope => ({ organizationId: org, owner: { kind: "user", userId } });
  const team = (teamId: string): ResourceScope => ({ organizationId: org, owner: { kind: "team", teamId } });
  const organization: ResourceScope = { organizationId: org, owner: { kind: "organization", organizationId: org } };
  register("org-runner", organization);
  register("member-runner", user("usr_member"));
  register("admin-runner", user("usr_admin"));
  register("viewer-runner", user("usr_viewer"));
  register("peer-runner", user("usr_peer"));
  register("member-team-runner", team("team_member"));
  register("peer-team-runner", team("team_peer"));
  register("other-org-runner", { organizationId: otherOrg, owner: { kind: "organization", organizationId: otherOrg } });
  const agent = (delegatedScope: ResourceScope): AgentPrincipal => ({
    kind: "agent", actorId: "s_agent", organizationId: delegatedScope.organizationId, delegatedScope,
  });
  const visible = (principal: AgentPrincipal) => db.listRunnersForPrincipal(principal).map((runner) => runner.runnerId).sort();
  return { db, org, user, team, organization, agent, visible };
}

test("an agent delegated as a member reaches that member's runners and workspaces, never another user's, team's or organization's", () => {
  const f = fixture();
  try {
    const member = f.agent(f.user("usr_member"));
    assert.deepEqual(f.visible(member), ["member-runner", "member-team-runner", "org-runner"]);
    for (const runnerId of ["org-runner", "member-runner", "member-team-runner"]) {
      assert.equal(f.db.canAccessRunner(member, runnerId), true, runnerId);
      assert.equal(f.db.canAccessWorkspace(member, runnerId, "w"), true, runnerId);
    }
    for (const runnerId of ["peer-runner", "admin-runner", "peer-team-runner", "other-org-runner"]) {
      assert.equal(f.db.canAccessRunner(member, runnerId), false, runnerId);
      assert.equal(f.db.canAccessWorkspace(member, runnerId, "w"), false, runnerId);
    }
    // Access to a runner never implies its workspace: a narrower workspace keeps its own owner.
    assert.equal(f.db.setResourceScope({ resource: "workspace", runnerId: "org-runner", resourceId: "w",
      scope: f.user("usr_peer"), now }), true);
    assert.equal(f.db.canAccessRunner(member, "org-runner"), true);
    assert.equal(f.db.canAccessWorkspace(member, "org-runner", "w"), false);
    assert.deepEqual(f.db.listRunnersForPrincipal(member).find((runner) => runner.runnerId === "org-runner")!.workspaces, []);
    // A delegation that claims another organization reaches nothing.
    assert.equal(f.db.canAccessRunner({ ...member, organizationId: "org_other" }, "other-org-runner"), false);
  } finally { f.db.close(); }
});

// #3676: get_campaign derives childHarnessAgents and childModelMachines from exactly the runners the
// root's credential can list. Every runner here is online, so a runner its Human cannot use is
// left out because access refuses it, not because it is offline.
test("a user-delegated root's campaign lists eligible agents on the runners its Human can use, and loses them with the membership", () => {
  const f = fixture();
  try {
    const policy = { childHarnessMatch: "harness" as const, behavior: { ...DEFAULT_ORCHESTRATOR_DEFAULTS.behavior,
      childHarness: { agentId: "claude", driver: "claude-code" as const, context: { kind: "native" as const } }, childModel: MODEL } };
    const member = f.agent(f.user("usr_member"));
    const machines = (principal: AgentPrincipal) => {
      const runners = f.db.listRunnersForPrincipal(principal);
      assert.ok(runners.every((runner) => runner.status === "online"));
      return {
        agents: childHarnessAgents(policy, runners)?.map(({ runnerId, agentId }) => [runnerId, agentId]),
        models: childModelMachines(policy, runners)?.map(({ runnerId, supported }) => [runnerId, supported]),
      };
    };
    const reachable = ["member-runner", "member-team-runner", "org-runner"];
    assert.deepEqual(machines(member), {
      agents: reachable.map((runnerId) => [runnerId, "claude"]),
      models: reachable.map((runnerId) => [runnerId, true]),
    });
    // Access is evaluated when the campaign is read: suspending the Human drops the shared runners.
    f.db.updateIdentityMember({ organizationId: f.org, userId: "usr_member", displayName: "usr_member", role: "operator", status: "suspended", now });
    assert.deepEqual(machines(member), { agents: [["member-runner", "claude"]], models: [["member-runner", true]] });
  } finally { f.db.close(); }
});

test("an administrator's delegated agent gets member access only, and a viewer, suspended or removed user's agent loses shared runners", () => {
  const f = fixture();
  try {
    // The administrator's own role would reach every runner in the organization; the agent does not.
    assert.deepEqual(f.visible(f.agent(f.user("usr_admin"))), ["admin-runner", "member-team-runner", "org-runner"]);
    // Viewers cannot launch, so their agents reach only what they own, exactly as before.
    assert.deepEqual(f.visible(f.agent(f.user("usr_viewer"))), ["viewer-runner"]);
    const member = f.agent(f.user("usr_member"));
    f.db.updateIdentityMember({ organizationId: f.org, userId: "usr_member", displayName: "usr_member", role: "operator", status: "suspended", now });
    assert.deepEqual(f.visible(member), ["member-runner"]);
    f.db.updateIdentityMember({ organizationId: f.org, userId: "usr_member", displayName: "usr_member", role: "operator", status: "active", now });
    assert.deepEqual(f.visible(member), ["member-runner", "member-team-runner", "org-runner"]);
    f.db.raw().prepare("DELETE FROM identity_memberships WHERE organization_id=? AND user_id=?").run(f.org, "usr_member");
    assert.deepEqual(f.visible(member), ["member-runner"]);
  } finally { f.db.close(); }
});

test("organization- and team-delegated agents, and every non-runner resource, keep the exact delegated-owner rule", () => {
  const f = fixture();
  try {
    // A Custom root delegated organization-wide is unchanged.
    assert.deepEqual(f.visible(f.agent(f.organization)), ["admin-runner", "member-runner", "member-team-runner",
      "org-runner", "peer-runner", "peer-team-runner", "viewer-runner"]);
    assert.deepEqual(f.visible(f.agent(f.team("team_member"))), ["member-team-runner"]);

    const member = f.agent(f.user("usr_member"));
    const create = (id: string, scope: ResourceScope) => f.db.createSession({ id, runnerId: "org-runner", workspaceId: "w",
      agentId: null, title: id, useWorktree: false, driver: "claude-code", config: {}, now, scope });
    create("s_org", f.organization);
    create("s_team", f.team("team_member"));
    create("s_own", f.user("usr_member"));
    assert.equal(f.db.canAccessSession(member, "s_own"), true);
    assert.equal(f.db.canAccessSession(member, "s_org"), false, "organization sessions stay unreadable");
    assert.equal(f.db.canAccessSession(member, "s_team"), false, "team sessions stay unreadable");
    assert.deepEqual(f.db.listSessionsForPrincipal(member).map((session) => session.id), ["s_own"]);
    const project = f.db.createProject({ name: "Organization", scope: f.organization, now });
    assert.equal(f.db.canAccessProject(member, project.id), false, "organization Projects stay unreadable");
  } finally { f.db.close(); }
});
