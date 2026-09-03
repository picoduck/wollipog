import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentCredentialSessionTargetError,
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
  assert.equal(mutationAuthorizationError("PUT", "/api/agent-harness-defaults", human("viewer")), null);
  assert.equal(mutationAuthorizationError("DELETE", "/api/agent-harness-defaults", human("viewer")), null);
  assert.match(mutationAuthorizationError("PUT", "/api/sessions/:id/title", human("viewer"))!, /read-only/);
  assert.equal(mutationAuthorizationError("POST", "/api/sessions", human("operator")), null);
  assert.match(mutationAuthorizationError("POST", "/api/identity/users", human("operator"))!, /owner or admin/);
  assert.equal(mutationAuthorizationError("POST", "/api/identity/users", human("admin")), null);
  assert.equal(mutationAuthorizationError("POST", "/api/identity/users", human("owner")), null);
});

test("agent mutations pass only after the separate conductor route allowlist authenticates them", () => {
  assert.equal(mutationAuthorizationError("POST", "/api/workflows", {
    kind: "agent",
    actorId: "s_conductor",
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

test("a user- or team-scoped conductor cannot mutate organization-global resources", () => {
  const userAgent: AgentPrincipal = {
    kind: "agent",
    actorId: "s_conductor",
    organizationId: "org_1",
    delegatedScope: { organizationId: "org_1", owner: { kind: "user", userId: "usr_1" } },
  };
  assert.equal(agentDelegationAuthorizationError("/api/sessions/s_1/prompt", userAgent), null);
  assert.match(agentDelegationAuthorizationError("/api/workflows", userAgent)!, /organization-wide/);
  assert.equal(agentDelegationAuthorizationError("/api/workflows", {
    ...userAgent,
    delegatedScope: { organizationId: "org_1", owner: { kind: "organization", organizationId: "org_1" } },
  }), null);
});

test("a purpose-bound credential confines worktree routes without blocking delegated sibling operations", () => {
  const credential: AgentPrincipal = {
    kind: "agent",
    actorId: "s_calling",
    credentialSessionId: "s_calling",
    organizationId: "org_1",
    delegatedScope: { organizationId: "org_1", owner: { kind: "user", userId: "usr_1" } },
  };
  assert.equal(agentCredentialSessionTargetError("/api/sessions/:id/worktrees", credential, "s_calling"), null);
  assert.match(agentCredentialSessionTargetError("/api/sessions/:id/worktrees", credential, "s_sibling")!, /only its own session/);
  assert.equal(agentCredentialSessionTargetError("/api/sessions/:id/prompt", credential, "s_sibling"), null,
    "the general agent-control credential retains its reviewed delegated sibling-session surface");
  assert.equal(agentCredentialSessionTargetError(
    "/api/sessions/:id/worktrees",
    { ...credential, credentialSessionId: undefined },
    "s_sibling",
  ), null,
    "a conductor retains its separately reviewed delegated scope");
});

test("a runner cannot turn a normal fork into a privileged conductor session", () => {
  const source = { agentId: "claude", driver: "claude", workspaceId: "workspace-1" };
  assert.equal(forkSnapshotIdentityError(source, {
    agentId: "claude", driver: "claude", workspaceId: "workspace-1",
  }), null);
  assert.match(forkSnapshotIdentityError(source, {
    agentId: "conductor", driver: "claude", workspaceId: "workspace-1",
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
