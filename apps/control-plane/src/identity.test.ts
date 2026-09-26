import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentCredentialSessionTargetError,
  backgroundJobStopActor,
  backgroundJobStopAuthorizationError,
  orchestratorSelfWorktreeAuthorizationError,
  agentDelegationAuthorizationError,
  boundedTargetId,
  forkProjectAssignment,
  forkSnapshotIdentityError,
  mutationAuthorizationError,
  providerForkCleanupTarget,
  providerForkNeedsCleanup,
  providerForkSnapshotIdError,
  workflowActorForPrincipal,
  type AgentPrincipal,
  type HumanPrincipal,
} from "./identity.js";

function human(role: HumanPrincipal["role"]): HumanPrincipal {
  return {
    kind: "human",
    actorId: "dev_1",
    userId: "usr_1",
    userName: "Ada",
    organizationId: "org_1",
    organizationName: "Team",
    role,
    deviceId: "dev_1",
    localBootstrap: false,
  };
}

test("organization roles centrally gate mutations while reads remain available", () => {
  assert.equal(mutationAuthorizationError("GET", "/api/sessions", human("viewer")), null);
  assert.match(mutationAuthorizationError("POST", "/api/sessions", human("viewer"))!, /read-only/);
  assert.equal(mutationAuthorizationError("PUT", "/api/sessions/:id/reminder", human("viewer")), null);
  assert.equal(mutationAuthorizationError("DELETE", "/api/sessions/:id/reminder", human("viewer")), null);
  assert.equal(mutationAuthorizationError("PUT", "/api/projects/:id/worktree-setup-notice/dismiss", human("viewer")), null);
  assert.equal(mutationAuthorizationError("PUT", "/api/agent-harness-defaults", human("viewer")), null);
  assert.equal(mutationAuthorizationError("DELETE", "/api/agent-harness-defaults", human("viewer")), null);
  assert.match(mutationAuthorizationError("PUT", "/api/sessions/:id/title", human("viewer"))!, /read-only/);
  assert.equal(mutationAuthorizationError("POST", "/api/sessions", human("operator")), null);
  assert.match(mutationAuthorizationError("POST", "/api/identity/users", human("operator"))!, /owner or admin/);
  assert.equal(mutationAuthorizationError("POST", "/api/identity/users", human("admin")), null);
  assert.equal(mutationAuthorizationError("POST", "/api/identity/users", human("owner")), null);
});

test("agent mutations pass only after the separate agent-control route allowlist authenticates them", () => {
  assert.equal(mutationAuthorizationError("POST", "/api/workflows", {
    kind: "agent",
    actorId: "s_agent",
    organizationId: "org_1",
    delegatedScope: { organizationId: "org_1", owner: { kind: "organization", organizationId: "org_1" } },
  }), null);
  assert.match(mutationAuthorizationError("POST", "/api/workflows", null)!, /authentication/);
  assert.equal(mutationAuthorizationError("POST", "/hooks/v1/example", null), null);
});

test("workflow domain actors preserve authenticated agent and human attribution", () => {
  const agent: AgentPrincipal = {
    kind: "agent",
    actorId: "s_agent_control",
    organizationId: "org_1",
    delegatedScope: { organizationId: "org_1", owner: { kind: "organization", organizationId: "org_1" } },
  };
  assert.deepEqual(workflowActorForPrincipal(agent, "usr_local"), { kind: "agent", id: "s_agent_control" });
  assert.deepEqual(workflowActorForPrincipal(human("operator"), "usr_local"), { kind: "human", id: "usr_1" });
  assert.deepEqual(workflowActorForPrincipal(null, "usr_local"), { kind: "human", id: "usr_local" });
});

test("a user- or team-scoped agent session cannot mutate organization-global resources", () => {
  const userAgent: AgentPrincipal = {
    kind: "agent",
    actorId: "s_agent",
    organizationId: "org_1",
    delegatedScope: { organizationId: "org_1", owner: { kind: "user", userId: "usr_1" } },
  };
  assert.equal(agentDelegationAuthorizationError("/api/compatibility", userAgent), null);
  assert.equal(agentDelegationAuthorizationError("/api/sessions/s_1/prompt", userAgent), null);
  assert.match(agentDelegationAuthorizationError("/api/workflows", userAgent)!, /organization-wide/);
  assert.equal(agentDelegationAuthorizationError("/api/workflows", {
    ...userAgent,
    delegatedScope: { organizationId: "org_1", owner: { kind: "organization", organizationId: "org_1" } },
  }), null);
});

test("orchestrators can mutate verified descendants while execution policy governs their own worktree", () => {
  const credential: AgentPrincipal = {
    kind: "agent", actorId: "s_parent", credentialSessionId: "s_parent", orchestrator: true,
    organizationId: "org_1", delegatedScope: { organizationId: "org_1", owner: { kind: "user", userId: "usr_1" } },
  };
  for (const route of ["/api/sessions/:id/worktrees", "/api/sessions/:id/worktrees/discard", "/api/sessions/:id/prompt", "/api/sessions/:id/stop", "/api/sessions/:id/restart"]) {
    assert.equal(agentCredentialSessionTargetError(route, credential, "s_child", true), null);
    assert.equal(agentCredentialSessionTargetError(route, credential, "s_grandchild", true), null);
    for (const target of ["s_other", "s_sibling"]) {
      assert.match(agentCredentialSessionTargetError(route, credential, target)!, /descendants/);
    }
    if (route.includes("worktrees")) {
      assert.equal(agentCredentialSessionTargetError(route, credential, "s_parent"), null);
    } else {
      assert.match(agentCredentialSessionTargetError(route, credential, "s_parent", true)!, /descendants/);
    }
  }
  const stopJob = "/api/sessions/:id/background-jobs/:jobId/stop";
  assert.equal(agentCredentialSessionTargetError(stopJob, credential, "s_child", true), null);
  assert.match(agentCredentialSessionTargetError(stopJob, credential, "s_sibling")!, /descendants/);
  assert.match(agentCredentialSessionTargetError(stopJob, credential, "s_parent", true)!, /descendants/);
  assert.equal(agentCredentialSessionTargetError("/api/sessions/:id/config", credential, "s_parent"), null);
  assert.equal(agentCredentialSessionTargetError("/api/sessions/:id/config", credential, "s_child", true), null);
  assert.match(agentCredentialSessionTargetError("/api/sessions/:id/config", credential, "s_sibling")!, /descendants/);
  assert.equal(agentDelegationAuthorizationError("/api/governance/policies", credential), null);
  assert.match(orchestratorSelfWorktreeAuthorizationError(credential, "s_parent", true)!, /Strict Project Isolation/);
  assert.equal(orchestratorSelfWorktreeAuthorizationError(credential, "s_parent", false), null);
  assert.equal(orchestratorSelfWorktreeAuthorizationError(credential, "s_child", true), null);
});

test("ordinary credentials retain self worktrees but confine descendant lifecycle and guardrail mutations", () => {
  const credential: AgentPrincipal = {
    kind: "agent",
    actorId: "s_calling",
    credentialSessionId: "s_calling",
    organizationId: "org_1",
    delegatedScope: { organizationId: "org_1", owner: { kind: "user", userId: "usr_1" } },
  };
  assert.equal(agentCredentialSessionTargetError("/api/sessions/:id/worktrees", credential, "s_calling"), null);
  assert.match(agentCredentialSessionTargetError("/api/sessions/:id/worktrees", credential, "s_sibling")!, /only its own session/);
  assert.match(agentCredentialSessionTargetError(
    "/api/sessions/:id/worktrees/discard",
    credential,
    "s_sibling",
  )!, /only its own session/);
  for (const route of ["/api/sessions/:id/prompt", "/api/sessions/:id/stop", "/api/sessions/:id/restart", "/api/sessions/:id/archive"]) {
    assert.equal(agentCredentialSessionTargetError(route, credential, "s_grandchild", true), null);
    assert.match(agentCredentialSessionTargetError(route, credential, "s_sibling")!, /descendants/);
    assert.match(agentCredentialSessionTargetError(route, credential, "s_calling", true)!, /descendants/);
    assert.match(agentCredentialSessionTargetError(route, { ...credential, credentialSessionId: undefined }, "s_child", true)!, /descendants/);
  }
  assert.equal(agentCredentialSessionTargetError("/api/sessions/:id/config", credential, "s_calling"), null);
  assert.equal(agentCredentialSessionTargetError("/api/sessions/:id/config", credential, "s_grandchild", true), null);
  assert.match(agentCredentialSessionTargetError("/api/sessions/:id/config", credential, "s_sibling")!, /descendants/);
  assert.equal(agentCredentialSessionTargetError(
    "/api/sessions/:id/worktrees",
    { ...credential, credentialSessionId: undefined },
    "s_sibling",
  ), null,
    "an agent principal without a session credential retains its separately reviewed delegated scope");
});

test("a runner cannot change a fork's agent, driver, or workspace identity", () => {
  const source = { agentId: "claude", driver: "claude", workspaceId: "workspace-1" };
  assert.equal(forkSnapshotIdentityError(source, {
    agentId: "claude", driver: "claude", workspaceId: "workspace-1",
  }), null);
  assert.match(forkSnapshotIdentityError(source, {
    agentId: "codex", driver: "claude", workspaceId: "workspace-1",
  })!, /different agent or workspace identity/);
  assert.match(forkSnapshotIdentityError(source, {
    agentId: "claude", driver: "acp", workspaceId: "workspace-1",
  })!, /different agent or workspace identity/);
  assert.match(forkSnapshotIdentityError(source, {
    agentId: "claude", driver: "claude", workspaceId: "workspace-2",
  })!, /different agent or workspace identity/);
  assert.equal(forkSnapshotIdentityError(
    { agentId: "claude", driver: "claude", workspaceId: null },
    { agentId: "claude", driver: "claude", workspaceId: null },
  ), null);
  assert.equal(forkSnapshotIdentityError(
    {
      agentId: "claude",
      driver: "claude",
      workspaceId: "workspace-refiled",
      executionWorkspacePath: "/repos/original",
    },
    {
      agentId: "claude",
      driver: "claude",
      workspaceId: "workspace-original",
      workspacePath: "/repos/original",
    },
  ), null, "runner execution identity wins over mutable control-plane filing");
  assert.equal(forkSnapshotIdentityError(
    {
      agentId: "claude",
      driver: "claude",
      workspaceId: "workspace-refiled",
      executionWorkspacePath: "C:\\Repos\\Original\\",
    },
    {
      agentId: "claude",
      driver: "claude",
      workspaceId: "workspace-original",
      workspacePath: "/mnt/c/repos/original",
    },
  ), null, "equivalent Windows and WSL execution paths retain runner identity");
  assert.match(forkSnapshotIdentityError(
    {
      agentId: "claude",
      driver: "claude",
      workspaceId: "workspace-refiled",
      executionWorkspacePath: "/repos/original",
    },
    {
      agentId: "claude",
      driver: "claude",
      workspaceId: "workspace-refiled",
      workspacePath: "/repos/other",
    },
  )!, /different agent or workspace identity/);
});

test("provider fork timeouts require cleanup even before the runner confirms creation", () => {
  assert.equal(providerForkNeedsCleanup(false, true), true);
  assert.equal(providerForkNeedsCleanup(true, false), true);
  assert.equal(providerForkNeedsCleanup(false, false), false);
  assert.equal(providerForkCleanupTarget("requested-target", false, true), "requested-target");
});

test("provider fork snapshot IDs fail closed before persistence", () => {
  const requestedTarget = "requested-target";
  const untrustedForeignId = "foreign-target";
  assert.equal(providerForkSnapshotIdError(requestedTarget, requestedTarget), null);
  assert.equal(
    providerForkSnapshotIdError(requestedTarget, untrustedForeignId),
    "runner returned the wrong fork session",
  );
  const cleanupTarget = providerForkCleanupTarget(requestedTarget, true, false);
  assert.equal(cleanupTarget, requestedTarget);
  assert.notEqual(cleanupTarget, untrustedForeignId, "the untrusted reply id is never tombstoned or deleted");
});

test("forks inherit the current Project without claiming an unreliable re-filed Location", () => {
  const source = {
    runnerId: "runner-1",
    workspaceId: "workspace-refiled",
    projectId: "project-current",
  };
  const location = {
    id: "location-current",
    projectId: "project-current",
    runnerId: "runner-1",
    workspaceId: "workspace-refiled",
    availability: "online",
  };
  assert.deepEqual(forkProjectAssignment(source, location, "workspace-original"), {
    projectId: "project-current",
    projectLocationId: null,
  });
  assert.deepEqual(forkProjectAssignment(source, location, "workspace-refiled"), {
    projectId: "project-current",
    projectLocationId: "location-current",
  });
  assert.deepEqual(forkProjectAssignment({ ...source, projectId: null }, location, "workspace-refiled"), {
    projectId: null,
    projectLocationId: null,
  });
});

test("mutation audit target extraction is bounded and never inspects request bodies", () => {
  assert.equal(boundedTargetId({ sessionId: "s_1", body: "secret" }), "s_1");
  assert.equal(boundedTargetId({ resource: "session", resourceId: "s_owned" }), "s_owned");
  assert.equal(boundedTargetId({ policyId: "pol_1" }), "pol_1");
  assert.equal(boundedTargetId({ triggerId: "trg_1" }), "trg_1");
  assert.equal(boundedTargetId({ attemptId: "att_1" }), "att_1");
  assert.equal(boundedTargetId({ userId: "u".repeat(300) })?.length, 256);
  assert.equal(boundedTargetId({ body: "secret" }), undefined);
});

test("a session credential attaches artifacts only to its own session", () => {
  const scope = { organizationId: "org_1", owner: { kind: "user" as const, userId: "usr_1" } };
  const child: AgentPrincipal = {
    kind: "agent", actorId: "s_child", credentialSessionId: "s_child", orchestrator: false,
    organizationId: "org_1", delegatedScope: scope,
  };
  for (const route of ["/api/sessions/:id/artifacts/screenshots", "/api/sessions/:id/artifacts/videos"]) {
    assert.equal(agentCredentialSessionTargetError(route, child, "s_child"), null);
    // An artifact's session is proof of who produced it, so ancestry grants nothing here, unlike
    // prompt or stop, where a parent legitimately manages its descendants.
    for (const [target, descendant] of [["s_parent", false], ["s_grandchild", true], ["s_sibling", false]] as const) {
      assert.match(agentCredentialSessionTargetError(route, child, target, descendant)!, /only to its own session/, target);
    }
    assert.match(agentCredentialSessionTargetError(route, { ...child, orchestrator: true }, "s_grandchild", true)!,
      /only to its own session/, "the Orchestrator role does not widen it either");
    assert.match(agentCredentialSessionTargetError(route, { ...child, credentialSessionId: undefined }, "s_child")!,
      /only to its own session/, "a credential without a session fails closed");
    assert.equal(agentDelegationAuthorizationError(route, child), null,
      "a user-scoped session can attach, unlike the organization-wide /api/artifacts routes");
  }
});

test("only the session owner and its controlling Orchestrator may stop one of its background jobs (#1780)", () => {
  const scope = { organizationId: "org_1", owner: { kind: "user" as const, userId: "usr_1" } };
  const orchestrator: AgentPrincipal = {
    kind: "agent", actorId: "s_parent", credentialSessionId: "s_parent", orchestrator: true,
    organizationId: "org_1", delegatedScope: scope,
  };
  const child = { id: "s_child", parentSessionId: "s_parent" };
  assert.equal(backgroundJobStopAuthorizationError(orchestrator, child, false), null);
  assert.deepEqual(backgroundJobStopActor(orchestrator, "usr_local"), { kind: "orchestrator", sessionId: "s_parent" });

  const refused = /only the session owner or its controlling Orchestrator/;
  // A grandchild belongs to its own parent's campaign; a worker parent is not an Orchestrator.
  assert.match(backgroundJobStopAuthorizationError(orchestrator, { id: "s_grandchild", parentSessionId: "s_child" }, false)!, refused);
  assert.match(backgroundJobStopAuthorizationError({ ...orchestrator, orchestrator: undefined }, child, false)!, refused);
  // The session itself, and a sibling Orchestrator, are other callers.
  assert.match(backgroundJobStopAuthorizationError({ ...orchestrator, actorId: "s_child", credentialSessionId: "s_child" },
    { id: "s_child", parentSessionId: "s_child" }, false)!, refused);
  assert.match(backgroundJobStopAuthorizationError({ ...orchestrator, actorId: "s_other", credentialSessionId: "s_other" }, child, false)!,
    refused);
  assert.match(backgroundJobStopAuthorizationError({ ...orchestrator, credentialSessionId: undefined }, child, false)!, refused);
  assert.match(backgroundJobStopAuthorizationError(orchestrator, { id: "s_root", parentSessionId: null }, false)!, refused);
  // An agent never qualifies through the ownership flag.
  assert.match(backgroundJobStopAuthorizationError({ ...orchestrator, orchestrator: undefined }, child, true)!, refused);

  // A person qualifies only as the session's owner, not by an organization role.
  const owner = {
    kind: "human" as const, actorId: "usr_1", userId: "usr_1", userName: "Owner", organizationId: "org_1",
    organizationName: "Org", role: "operator" as const, deviceId: null, localBootstrap: false,
  };
  assert.equal(backgroundJobStopAuthorizationError(owner, child, true), null);
  assert.match(backgroundJobStopAuthorizationError({ ...owner, role: "admin" as const }, child, false)!, refused);
  assert.deepEqual(backgroundJobStopActor(owner, "usr_local"), { kind: "user", userId: "usr_1" });
});
