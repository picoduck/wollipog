import assert from "node:assert/strict";
import { test } from "node:test";
import type { CreateSessionRequest, ResourceScope, RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";
import {
  canAssignSessionProject,
  resolveSessionCreationOwnership,
} from "./session-creation-route.js";

const runner: RunnerMetadata = {
  runnerId: "runner-1",
  hostname: "host",
  os: "linux",
  version: "test",
  agents: [{ id: "agent", name: "Agent", command: "agent", args: [], env: {}, driver: "acp" }],
  workspaces: [{ id: "workspace-1", name: "Workspace", path: "/workspace" }],
};

function request(projectId?: string): CreateSessionRequest {
  return {
    runnerId: runner.runnerId,
    workspaceId: runner.workspaces[0]!.id,
    ...(projectId ? { projectId, projectLocationId: "location-placeholder" } : {}),
    agentId: "agent",
    title: "Session",
    useWorktree: false,
    config: {},
  };
}

test("explicit and inferred team Projects create sessions under the Project scope", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    const local = db.localIdentityContext();
    const teamScope: ResourceScope = {
      organizationId: local.organizationId,
      owner: { kind: "team", teamId: "team-project" },
    };
    db.createIdentityTeam({
      teamId: "team-project",
      organizationId: local.organizationId,
      name: "Project Team",
      memberUserIds: [local.userId],
      now: 1,
    });
    db.registerRunner(runner, 2, 53);
    const project = db.listProjects(true)[0]!;
    assert.equal(db.setResourceScope({ resource: "project", resourceId: project.id, scope: teamScope, now: 3 }), true);
    const principal: HumanPrincipal = {
      kind: "human",
      actorId: local.userId,
      userId: local.userId,
      userName: local.userName,
      organizationId: local.organizationId,
      organizationName: local.organizationName,
      role: local.role,
      deviceId: null,
      localBootstrap: true,
    };
    const location = db.getProject(project.id)!.locations[0]!;

    const explicit = resolveSessionCreationOwnership(db, principal, {
      ...request(project.id),
      projectLocationId: location.id,
    });
    assert.equal(explicit.ok, true);
    if (explicit.ok) {
      assert.deepEqual(explicit.scope, teamScope);
      const created = db.createSession({
        id: "session-team-project",
        runnerId: runner.runnerId,
        workspaceId: runner.workspaces[0]!.id,
        projectId: project.id,
        projectLocationId: location.id,
        agentId: "agent",
        title: "Team Project Session",
        useWorktree: false,
        driver: "acp",
        config: {},
        scope: explicit.scope,
        now: 4,
      });
      assert.equal(created.projectId, project.id);
      assert.deepEqual(db.sessionScope(created.id), teamScope);
    }

    const inferred = resolveSessionCreationOwnership(db, principal, request());
    assert.equal(inferred.ok, true);
    if (inferred.ok) {
      assert.deepEqual(inferred.scope, teamScope);
      assert.equal(inferred.body.projectId, undefined);
      assert.equal(inferred.body.projectLocationId, undefined);
    }
  } finally {
    db.close();
  }
});

test("No Project session creation remains user-scoped", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    const local = db.localIdentityContext();
    const principal: HumanPrincipal = {
      kind: "human",
      actorId: local.userId,
      userId: local.userId,
      userName: local.userName,
      organizationId: local.organizationId,
      organizationName: local.organizationName,
      role: local.role,
      deviceId: null,
      localBootstrap: true,
    };
    const resolved = resolveSessionCreationOwnership(db, principal, {
      ...request(), projectId: null, projectLocationId: null,
    });
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.deepEqual(resolved.scope, {
        organizationId: local.organizationId,
        owner: { kind: "user", userId: local.userId },
      });
    }
  } finally {
    db.close();
  }
});

test("Project assignment permits shared targets but protects detach authority", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    const local = db.localIdentityContext();
    db.createIdentityMember({
      userId: "member", displayName: "Member", organizationId: local.organizationId, role: "operator", now: 1,
    });
    db.registerRunner(runner, 2, 53);
    const project = db.listProjects(true)[0]!;
    const otherProject = db.createProject({ name: "Other Organization Project", now: 3 });
    const location = project.locations[0]!;
    const nonManager: HumanPrincipal = {
      kind: "human", actorId: "member", userId: "member", userName: "Member",
      organizationId: local.organizationId, organizationName: local.organizationName,
      role: "operator", deviceId: null, localBootstrap: false,
    };
    const owner: HumanPrincipal = {
      ...nonManager, actorId: local.userId, userId: local.userId, userName: local.userName,
      role: local.role, localBootstrap: true,
    };
    assert.equal(db.canAccessProject(nonManager, project.id), true);
    db.createSession({
      id: "member-session", runnerId: runner.runnerId, workspaceId: location.workspaceId,
      projectId: project.id, projectLocationId: location.id, agentId: "agent", title: "Member",
      useWorktree: false, driver: "acp", config: {},
      scope: { organizationId: local.organizationId, owner: { kind: "user", userId: "member" } }, now: 3,
    });
    db.createSession({
      id: "organization-session", runnerId: runner.runnerId, workspaceId: location.workspaceId,
      projectId: project.id, projectLocationId: location.id, agentId: "agent", title: "Organization",
      useWorktree: false, driver: "acp", config: {},
      scope: db.projectScope(project.id)!, now: 4,
    });

    assert.equal(canAssignSessionProject(db, nonManager, "member-session", project.id), true,
      "ordinary members may file their session into a shared organization Project");
    assert.equal(canAssignSessionProject(db, nonManager, "member-session", null), true,
      "a personal session owner may remove their own Project organization");
    assert.equal(canAssignSessionProject(db, nonManager, "organization-session", null), false,
      "an ordinary member cannot detach an organization-owned session");
    assert.equal(canAssignSessionProject(db, nonManager, "organization-session", otherProject.id), false,
      "an ordinary member cannot move an organization-owned session out of its current Project");
    assert.equal(canAssignSessionProject(db, nonManager, "member-session", otherProject.id), true,
      "a personal session owner may reorganize their own session between accessible Projects");
    assert.equal(canAssignSessionProject(db, owner, "organization-session", null), true);
    assert.equal(canAssignSessionProject(db, owner, "organization-session", otherProject.id), true);
  } finally {
    db.close();
  }
});
