import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ControlPlaneToUi, RunnerMetadata } from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";

function runner(): RunnerMetadata {
  return {
    runnerId: "runner-1",
    hostname: "host",
    os: "linux",
    version: "1",
    agents: [{ id: "agent", name: "Agent", command: "agent", args: [], env: { SECRET: "sentinel" }, driver: "acp" }],
    workspaces: [{ id: "ws-1", name: "Repo", path: "/repo" }],
  };
}

function principal(db: ControlPlaneDb, token: string): HumanPrincipal {
  const device = db.deviceByTokenHash(hashToken(token))!;
  return {
    kind: "human",
    actorId: device.userId,
    userId: device.userId,
    userName: device.userName,
    organizationId: device.organizationId,
    organizationName: device.organizationName,
    role: device.role,
    deviceId: device.id,
    localBootstrap: false,
  };
}

test("identity roles, teams, ownership, suspension, and audit fail closed", () => {
  const db = ControlPlaneDb.open(":memory:");
  const local = db.localIdentityContext();
  const operator = db.createIdentityMember({
    userId: "usr_operator", displayName: "Operator", organizationId: local.organizationId, role: "operator", now: 10,
  });
  const viewer = db.createIdentityMember({
    userId: "usr_viewer", displayName: "Viewer", organizationId: local.organizationId, role: "viewer", now: 11,
  });
  db.createDevice({
    id: "dev_operator", name: "Operator phone", tokenHash: hashToken("operator-token"),
    userId: operator.userId, organizationId: local.organizationId, now: 12,
  });
  db.createDevice({
    id: "dev_viewer", name: "Viewer phone", tokenHash: hashToken("viewer-token"),
    userId: viewer.userId, organizationId: local.organizationId, now: 13,
  });
  db.registerRunner(runner(), 20, 53);
  db.createSession({
    id: "s_operator", runnerId: "runner-1", workspaceId: "ws-1", agentId: "agent", title: "Owned",
    useWorktree: false, driver: "acp", config: {},
    scope: { organizationId: local.organizationId, owner: { kind: "user", userId: operator.userId } }, now: 30,
  });
  const operatorPrincipal = principal(db, "operator-token");
  const viewerPrincipal = principal(db, "viewer-token");
  assert.equal(db.canAccessSession(operatorPrincipal, "s_operator"), true);
  assert.equal(db.canAccessSession(viewerPrincipal, "s_operator"), false);
  db.upsertPushSubscription({ endpoint: "https://push.example/operator", p256dh: "p", auth: "a", deviceId: "dev_operator", now: 31 });
  db.upsertPushSubscription({ endpoint: "https://push.example/viewer", p256dh: "p", auth: "a", deviceId: "dev_viewer", now: 32 });
  assert.deepEqual(
    db.listPushSubscriptions({ kind: "session", sessionId: "s_operator" }).map((sub) => sub.endpoint),
    ["https://push.example/operator"],
  );
  assert.deepEqual(db.listPushSubscriptions({ kind: "organization_admin", organizationId: local.organizationId }), []);

  assert.equal(db.setResourceScope({
    resource: "session", resourceId: "s_operator", scope: {
      organizationId: "org_other", owner: { kind: "organization", organizationId: "org_other" },
    }, now: 39,
  }), false, "another organization cannot take over a resource by knowing its id");
  assert.equal(db.sessionScope("s_operator")?.organizationId, local.organizationId);

  const team = db.createIdentityTeam({
    teamId: "team_review", organizationId: local.organizationId, name: "Reviewers",
    memberUserIds: [operator.userId, viewer.userId], now: 40,
  });
  assert.equal(db.setResourceScope({
    resource: "session", resourceId: "s_operator", scope: {
      organizationId: local.organizationId, owner: { kind: "team", teamId: team.teamId },
    }, now: 41,
  }), true);
  assert.equal(db.canAccessSession(viewerPrincipal, "s_operator"), true);
  assert.throws(() => db.deleteIdentityTeam(team.teamId, local.organizationId), /reassign resources/);
  assert.deepEqual(
    db.listPushSubscriptions({ kind: "session", sessionId: "s_operator" }).map((sub) => sub.endpoint),
    ["https://push.example/operator", "https://push.example/viewer"],
  );

  assert.equal(db.setResourceScope({
    resource: "workspace", runnerId: "runner-1", resourceId: "ws-1", scope: {
      organizationId: local.organizationId, owner: { kind: "user", userId: operator.userId },
    }, now: 50,
  }), true);
  db.registerRunner(runner(), 51, 53);
  assert.deepEqual(db.workspaceScope("runner-1", "ws-1")?.owner, { kind: "user", userId: operator.userId });
  assert.equal(db.listRunnersForPrincipal(viewerPrincipal)[0]?.workspaces.length, 0);
  assert.equal(db.listRunnersForPrincipal(operatorPrincipal)[0]?.agents[0]?.env.SECRET, undefined);

  assert.throws(() => db.updateIdentityMember({
    organizationId: local.organizationId, userId: local.userId, displayName: "Local owner",
    role: "viewer", status: "active", now: 60,
  }), /retain an active owner/);
  db.updateIdentityMember({
    organizationId: local.organizationId, userId: viewer.userId, displayName: "Viewer",
    role: "viewer", status: "suspended", now: 61,
  });
  assert.equal(db.deviceByTokenHash(hashToken("viewer-token")), null);
  assert.deepEqual(
    db.listPushSubscriptions({ kind: "session", sessionId: "s_operator" }).map((sub) => sub.endpoint),
    ["https://push.example/operator"],
  );

  db.recordMutationAudit({
    auditId: "mut_1", principal: operatorPrincipal, method: "POST", route: "/api/sessions",
    targetId: "s_operator", statusCode: 0, now: 70,
  });
  assert.equal(db.completeMutationAudit("mut_1", 201), true);
  const audit = db.listMutationAudit(local.organizationId);
  assert.equal(audit[0]?.statusCode, 201);
  assert.equal(audit[0]?.actorId, operator.userId);
  assert.equal(audit[0]?.deviceId, "dev_operator");
  assert.equal(JSON.stringify(audit).includes("operator-token"), false);
  db.close();
});

test("completed mutation audit ages into a lossless archive while crash intents stay hot", () => {
  const db = ControlPlaneDb.open(":memory:");
  const organizationId = db.localIdentityContext().organizationId;
  const completedAt = 1_000;
  db.recordMutationAudit({
    auditId: "mut_completed",
    principal: null,
    method: "POST",
    route: "/api/sessions",
    statusCode: 201,
    now: completedAt,
  });
  db.recordMutationAudit({
    auditId: "mut_incomplete",
    principal: null,
    method: "DELETE",
    route: "/api/sessions/:id",
    statusCode: 0,
    now: completedAt + 1,
  });
  const archiveAt = completedAt + 181 * 86_400_000;
  db.recordMutationAudit({
    auditId: "mut_new",
    principal: null,
    method: "PATCH",
    route: "/api/sessions/:id",
    statusCode: 200,
    now: archiveAt,
  });

  const raw = db.raw();
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM mutation_audit_archive").get() as { n: number }).n, 1);
  assert.deepEqual(
    (raw.prepare("SELECT audit_id FROM mutation_audit_archive").all() as Array<{ audit_id: string }>).map((row) => row.audit_id),
    ["mut_completed"],
  );
  assert.deepEqual(
    (raw.prepare("SELECT audit_id FROM mutation_audit ORDER BY audit_id").all() as Array<{ audit_id: string }>).map((row) => row.audit_id),
    ["mut_incomplete", "mut_new"],
  );
  assert.deepEqual(
    db.listMutationAudit(organizationId).map((entry) => entry.auditId),
    ["mut_new", "mut_incomplete", "mut_completed"],
    "hot and archived audit remain one ordered query surface",
  );
  assert.equal(db.completeMutationAudit("mut_incomplete", 503), true);
  assert.equal(db.listMutationAudit(organizationId).find((entry) => entry.auditId === "mut_incomplete")?.statusCode, 503);
  db.close();
});

test("usage aggregates freeze observation-time ownership and remain principal-scoped", () => {
  const db = ControlPlaneDb.open(":memory:");
  const local = db.localIdentityContext();
  const operator = db.createIdentityMember({
    userId: "usage_operator", displayName: "Usage operator", organizationId: local.organizationId, role: "operator", now: 1,
  });
  const viewer = db.createIdentityMember({
    userId: "usage_viewer", displayName: "Usage viewer", organizationId: local.organizationId, role: "viewer", now: 2,
  });
  db.createDevice({ id: "usage_op_device", name: "op", tokenHash: hashToken("usage-op"), userId: operator.userId, organizationId: local.organizationId, now: 3 });
  db.createDevice({ id: "usage_view_device", name: "view", tokenHash: hashToken("usage-view"), userId: viewer.userId, organizationId: local.organizationId, now: 4 });
  const team = db.createIdentityTeam({
    teamId: "usage_team", organizationId: local.organizationId, name: "Usage team",
    memberUserIds: [operator.userId, viewer.userId], now: 5,
  });
  db.registerRunner(runner(), 10, 54);
  db.createSession({
    id: "usage_scoped", runnerId: "runner-1", workspaceId: "ws-1", agentId: "agent", title: "Scoped",
    useWorktree: false, driver: "acp", config: {},
    scope: { organizationId: local.organizationId, owner: { kind: "user", userId: operator.userId } }, now: 11,
  });
  db.appendEvent("usage_scoped", { kind: "token_usage", inputTokens: 10, costUsd: 1 }, 3_600_000, { accrueUsage: true });
  const operatorPrincipal = principal(db, "usage-op");
  const viewerPrincipal = principal(db, "usage-view");
  const query = { since: 0, through: 10_000_000, granularity: "hour" as const };
  assert.equal(db.queryUsageAggregation(operatorPrincipal, query).totals.costUsd, 1);
  assert.equal(db.queryUsageAggregation(viewerPrincipal, query).totals.costUsd, 0);

  assert.equal(db.setResourceScope({
    resource: "session", resourceId: "usage_scoped",
    scope: { organizationId: local.organizationId, owner: { kind: "team", teamId: team.teamId } }, now: 20,
  }), true);
  db.appendEvent("usage_scoped", { kind: "token_usage", outputTokens: 5, costUsd: 2 }, 7_200_000, { accrueUsage: true });
  assert.equal(db.queryUsageAggregation(viewerPrincipal, query).totals.costUsd, 2, "the viewer sees only usage observed under the team scope");
  assert.equal(db.queryUsageAggregation(operatorPrincipal, query).totals.costUsd, 3, "the operator can see both their former user scope and current team scope");

  db.updateIdentityTeamMembers({
    teamId: team.teamId, organizationId: local.organizationId, memberUserIds: [operator.userId], now: 30,
  });
  assert.equal(db.queryUsageAggregation(viewerPrincipal, query).totals.costUsd, 0, "removed team members lose the frozen team aggregate");
  const admin: HumanPrincipal = {
    kind: "human", actorId: local.userId, userId: local.userId, userName: local.userName,
    organizationId: local.organizationId, organizationName: local.organizationName,
    role: "owner", deviceId: null, localBootstrap: true,
  };
  assert.equal(db.queryUsageAggregation(admin, query).totals.costUsd, 3, "organization owners see every scope in their organization");

  const insertUsage = db.raw().prepare(
    `INSERT INTO usage_hourly
       (bucket_ts, organization_id, owner_kind, owner_id, runner_id, workspace_id, agent_id, driver, model,
        input_tokens, output_tokens, cost_microusd)
     VALUES (10800000, ?, 'user', ?, ?, '', ?, 'acp', '', 1, 0, 1000000)`,
  );
  for (let index = 0; index < 25; index++) {
    insertUsage.run(local.organizationId, operator.userId, `usage-runner-${index}`, `usage-agent-${index}`);
  }
  const fleetQuery = { since: 0, through: 20_000_000, granularity: "hour" as const };
  const fleetUsage = db.queryUsageAggregation(operatorPrincipal, fleetQuery);
  assert.equal(fleetUsage.byRunner.length, 21, "breakdowns are bounded to top 20 plus Other");
  assert.equal(fleetUsage.byRunner.at(-1)?.key, "Other");
  assert.equal(db.queryUsageAggregation(operatorPrincipal, { ...fleetQuery, runnerId: "usage-runner-24" }).totals.costUsd, 1);
  assert.equal(db.queryUsageAggregation(viewerPrincipal, fleetQuery).totals.costUsd, 0, "SQL scope predicates exclude another user's fleet rows");

  assert.equal(db.setResourceScope({
    resource: "session", resourceId: "usage_scoped",
    scope: { organizationId: local.organizationId, owner: { kind: "organization", organizationId: local.organizationId } }, now: 40,
  }), true);
  assert.throws(
    () => db.deleteIdentityTeam(team.teamId, local.organizationId),
    /retained usage/,
    "a reusable team id cannot outlive its historical authorization generation",
  );
  db.close();
});

test("legacy device tokens migrate into the personal organization without replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-identity-migration-"));
  const path = join(root, "control-plane.db");
  try {
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER
    )`);
    const tokenHash = hashToken("legacy-token");
    raw.prepare("INSERT INTO devices VALUES (?, ?, ?, ?, ?)")
      .run("dev_legacy", "Legacy phone", tokenHash, 10, 20);
    raw.close();

    const db = ControlPlaneDb.open(path);
    const migrated = db.deviceByTokenHash(tokenHash);
    assert.equal(migrated?.id, "dev_legacy");
    assert.equal(migrated?.userId, "usr_local_owner");
    assert.equal(migrated?.organizationId, "org_personal");
    assert.equal(migrated?.role, "owner");
    assert.equal(migrated?.lastSeenAt, 20);
    db.close();

    const reopened = ControlPlaneDb.open(path);
    assert.equal(reopened.deviceByTokenHash(tokenHash)?.id, "dev_legacy", "reopening is idempotent");
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a runner snapshot fork atomically preserves scope and Project after its Location is removed", () => {
  const db = ControlPlaneDb.open(":memory:");
  const local = db.localIdentityContext();
  db.createIdentityMember({
    userId: "usr_operator", displayName: "Operator", organizationId: local.organizationId, role: "operator", now: 1,
  });
  db.registerRunner(runner(), 2, 53);
  const scope = { organizationId: local.organizationId, owner: { kind: "user" as const, userId: "usr_operator" } };
  db.createSession({
    id: "s_source", runnerId: "runner-1", workspaceId: "ws-1", agentId: "agent", title: "Source",
    useWorktree: true, driver: "acp", config: {}, scope, now: 3,
  });
  const source = db.getSession("s_source")!;
  db.removeProjectLocation(source.projectLocationId!, 4);
  db.createSessionFromSnapshot({
    id: "s_fork", workspaceId: "ws-1", agentId: "agent", title: "Fork", status: "idle",
    driver: "acp", useWorktree: true, worktreePath: "/repo-fork", config: {}, preview: null,
    pendingApproval: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false, seq: 0,
    createdAt: 4, updatedAt: 4,
  }, "runner-1", 4, db.sessionScope("s_source")!, {
    projectId: source.projectId!,
    projectLocationId: null,
  }, { sourceSessionId: "s_source", sourceTurn: 1 });
  assert.deepEqual(db.sessionScope("s_fork"), scope);
  assert.equal(db.getSession("s_fork")!.projectId, source.projectId);
  assert.equal(db.getSession("s_fork")!.projectLocationId, null);
  assert.equal(db.sessionForkIncludesAncestor("s_fork", "s_source"), true);
  assert.throws(() => db.createSessionFromSnapshot({
    id: "s_orphan", workspaceId: "ws-1", agentId: "agent", title: "Orphan", status: "idle",
    driver: "acp", useWorktree: true, worktreePath: "/repo-orphan", config: {}, preview: null,
    pendingApproval: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false, seq: 0,
    createdAt: 5, updatedAt: 5,
  }, "runner-1", 5, scope, {
    projectId: source.projectId!, projectLocationId: null,
  }, { sourceSessionId: "s_orphan", sourceTurn: 1 }));
  assert.equal(db.getSession("s_orphan"), null, "failed fork provenance rolls back the session row");
  db.close();
});

test("an unknown snapshot workspace inherits the restricted runner owner instead of widening", () => {
  const db = ControlPlaneDb.open(":memory:");
  const local = db.localIdentityContext();
  db.createIdentityMember({
    userId: "usr_operator", displayName: "Operator", organizationId: local.organizationId, role: "operator", now: 1,
  });
  db.registerRunner(runner(), 2, 53);
  const scope = { organizationId: local.organizationId, owner: { kind: "user" as const, userId: "usr_operator" } };
  db.setResourceScope({ resource: "runner", resourceId: "runner-1", scope, now: 3 });
  db.createSessionFromSnapshot({
    id: "s_unknown_workspace", workspaceId: "stale-workspace", agentId: "agent", title: "Imported",
    status: "idle", driver: "acp", useWorktree: false, worktreePath: null, config: {}, preview: null,
    pendingApproval: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false, seq: 0,
    createdAt: 4, updatedAt: 4,
  }, "runner-1", 4);
  assert.deepEqual(db.sessionScope("s_unknown_workspace"), scope);
  db.close();
});

test("deleting a runner removes ownership so a reused id receives a fresh scope", () => {
  const db = ControlPlaneDb.open(":memory:");
  const local = db.localIdentityContext();
  db.createIdentityMember({
    userId: "usr_operator", displayName: "Operator", organizationId: local.organizationId, role: "operator", now: 1,
  });
  db.registerRunner(runner(), 2, 53);
  db.setResourceScope({
    resource: "runner", resourceId: "runner-1",
    scope: { organizationId: local.organizationId, owner: { kind: "user", userId: "usr_operator" } }, now: 3,
  });
  assert.ok(db.deleteRunner("runner-1"));
  db.registerRunner(runner(), 4, 53);
  assert.deepEqual(db.runnerScope("runner-1")?.owner, {
    kind: "organization", organizationId: local.organizationId,
  });
  db.close();
});

test("a workspace dropped by discovery loses stale ownership before its id is reused", () => {
  const db = ControlPlaneDb.open(":memory:");
  const local = db.localIdentityContext();
  db.createIdentityMember({
    userId: "usr_operator", displayName: "Operator", organizationId: local.organizationId, role: "operator", now: 1,
  });
  db.registerRunner(runner(), 2, 53);
  const userScope = {
    organizationId: local.organizationId,
    owner: { kind: "user" as const, userId: "usr_operator" },
  };
  assert.equal(db.setResourceScope({
    resource: "workspace", runnerId: "runner-1", resourceId: "ws-1", scope: userScope, now: 3,
  }), true);

  db.registerRunner({ ...runner(), workspaces: [] }, 4, 53);
  assert.equal(db.workspaceScope("runner-1", "ws-1"), null);

  db.registerRunner(runner(), 5, 53);
  assert.deepEqual(db.workspaceScope("runner-1", "ws-1")?.owner, {
    kind: "organization", organizationId: local.organizationId,
  });
  db.close();
});

test("scoped websocket clients receive only authorized snapshots and deltas", () => {
  const db = ControlPlaneDb.open(":memory:");
  const local = db.localIdentityContext();
  db.createIdentityMember({
    userId: "usr_operator", displayName: "Operator", organizationId: local.organizationId, role: "operator", now: 1,
  });
  db.createIdentityMember({
    userId: "usr_viewer", displayName: "Viewer", organizationId: local.organizationId, role: "viewer", now: 2,
  });
  db.createDevice({ id: "d1", name: "one", tokenHash: hashToken("one"), userId: "usr_operator", organizationId: local.organizationId, now: 3 });
  db.createDevice({ id: "d2", name: "two", tokenHash: hashToken("two"), userId: "usr_viewer", organizationId: local.organizationId, now: 4 });
  db.registerRunner(runner(), 5, 53);
  db.createSession({
    id: "s_private", runnerId: "runner-1", workspaceId: "ws-1", agentId: "agent", title: "Private",
    useWorktree: false, driver: "acp", config: {},
    scope: { organizationId: local.organizationId, owner: { kind: "user", userId: "usr_operator" } }, now: 6,
  });
  const hub = new Hub(db);
  const seen = (auth: AuthPrincipal) => {
    const messages: ControlPlaneToUi[] = [];
    const socket = { send: (data: string) => messages.push(JSON.parse(data) as ControlPlaneToUi) };
    hub.addUiClient(socket, {
      deviceId: auth.deviceId ?? null, principal: auth, close: () => {},
    });
    return { messages, socket };
  };
  const operator = seen(principal(db, "one"));
  const viewer = seen(principal(db, "two"));
  const operatorMessages = operator.messages;
  const viewerMessages = viewer.messages;
  assert.deepEqual(operatorMessages[0]?.type === "snapshot" ? operatorMessages[0].sessions.map((s) => s.id) : [], ["s_private"]);
  assert.deepEqual(viewerMessages[0]?.type === "snapshot" ? viewerMessages[0].sessions.map((s) => s.id) : [], []);
  const sharedProjectId = operatorMessages[0]?.type === "snapshot" ? operatorMessages[0].projects?.[0]?.id : undefined;
  assert.ok(sharedProjectId);
  assert.equal(operatorMessages[0]?.type === "snapshot" ? operatorMessages[0].projects?.[0]?.totalSessionCount : -1, 1);
  assert.equal(viewerMessages[0]?.type === "snapshot" ? viewerMessages[0].projects?.[0]?.totalSessionCount : -1, 0);
  db.updateSessionStatus("s_private", "idle", 6);
  hub.sessionChangedById("s_private");
  const operatorProjectDelta = operatorMessages.findLast((message) =>
    message.type === "project_upsert" && message.project.id === sharedProjectId);
  const viewerProjectDelta = viewerMessages.findLast((message) =>
    message.type === "project_upsert" && message.project.id === sharedProjectId);
  assert.equal(operatorProjectDelta?.type === "project_upsert" ? operatorProjectDelta.project.activeSessionCount : -1, 0);
  assert.equal(viewerProjectDelta?.type === "project_upsert" ? viewerProjectDelta.project.activeSessionCount : -1, 0);
  const projectDeltaCount = operatorMessages.filter((message) => message.type === "project_upsert").length;
  db.appendEvent("s_private", { kind: "agent_message", text: "streaming" }, 7);
  hub.sessionChangedById("s_private");
  assert.equal(
    operatorMessages.filter((message) => message.type === "project_upsert").length,
    projectDeltaCount,
    "ordinary transcript updates do not recompute Project counts",
  );
  const privateProject = db.createProject({
    name: "Operator Project",
    scope: { organizationId: local.organizationId, owner: { kind: "user", userId: "usr_operator" } },
    now: 7,
  });
  hub.projectChanged(privateProject);
  assert.equal(operatorMessages.some((message) => message.type === "project_upsert" && message.project.id === privateProject.id), true);
  assert.equal(viewerMessages.some((message) => message.type === "project_upsert" && message.project.id === privateProject.id), false);
  db.deleteProject(privateProject.id, 8);
  hub.projectRemoved(privateProject.id);
  assert.equal(operatorMessages.some((message) => message.type === "project_removed" && message.projectId === privateProject.id), true);
  assert.equal(viewerMessages.some((message) => message.type === "project_removed" && message.projectId === privateProject.id), false);
  hub.runnerChanged("runner-1");
  const operatorRunnerDelta = operatorMessages.findLast((message) => message.type === "runner_upsert");
  assert.deepEqual(operatorRunnerDelta?.type === "runner_upsert" ? operatorRunnerDelta.runner.agents[0]?.env : null, {});
  assert.equal(operatorRunnerDelta?.type === "runner_upsert" ? operatorRunnerDelta.runner.runtime : null, undefined);
  hub.setUiSessionSubscriptions(operator.socket, 1, ["s_private"], []);
  hub.setUiSessionSubscriptions(viewer.socket, 1, ["s_private"], []);
  const operatorAck = operatorMessages.findLast((message) => message.type === "session_subscriptions_applied");
  const viewerAck = viewerMessages.findLast((message) => message.type === "session_subscriptions_applied");
  assert.deepEqual(operatorAck?.type === "session_subscriptions_applied" ? operatorAck.sessionIds : null, ["s_private"]);
  assert.deepEqual(viewerAck?.type === "session_subscriptions_applied" ? viewerAck.sessionIds : null, []);
  hub.sessionEvent({ id: 1, sessionId: "s_private", seq: 1, ts: 10, payload: { kind: "agent_message", text: "private" } });
  assert.equal(operatorMessages.some((message) => message.type === "session_event"), true);
  assert.equal(viewerMessages.some((message) => message.type === "session_event"), false);
  db.close();
});

test("ownership cascades synchronize Project membership before reconnect and same-Project reassignment", () => {
  const db = ControlPlaneDb.open(":memory:");
  const local = db.localIdentityContext();
  db.createIdentityMember({
    userId: "usr_operator", displayName: "Operator", organizationId: local.organizationId, role: "operator", now: 1,
  });
  db.registerRunner(runner(), 2, 53);
  const privateScope = {
    organizationId: local.organizationId,
    owner: { kind: "user" as const, userId: "usr_operator" },
  };
  assert.equal(db.setResourceScope({
    resource: "workspace", runnerId: "runner-1", resourceId: "ws-1", scope: privateScope, now: 3,
  }), true);
  db.createSession({
    id: "s_private", runnerId: "runner-1", workspaceId: "ws-1", agentId: "agent", title: "Private",
    useWorktree: false, driver: "acp", config: {}, scope: privateScope, now: 4,
  });
  const project = db.listProjects(true)[0]!;
  const location = project.locations[0]!;
  const hub = new Hub(db);
  const firstMessages: ControlPlaneToUi[] = [];
  const firstSocket = { send: (data: string) => firstMessages.push(JSON.parse(data) as ControlPlaneToUi) };
  hub.addUiClient(firstSocket);

  assert.equal(db.setResourceScope({
    resource: "session",
    resourceId: "s_private",
    scope: { organizationId: local.organizationId, owner: { kind: "organization", organizationId: local.organizationId } },
    now: 5,
  }), true);
  hub.closeScopedUiClients();
  hub.synchronizeProjectSessionState();
  hub.projectChangedById(project.id);
  assert.equal(db.getSession("s_private")?.projectId, null);
  assert.equal(
    firstMessages.findLast((message) => message.type === "project_upsert" && message.project.id === project.id)?.type === "project_upsert"
      ? (firstMessages.findLast((message) => message.type === "project_upsert" && message.project.id === project.id) as Extract<ControlPlaneToUi, { type: "project_upsert" }>).project.totalSessionCount
      : -1,
    0,
  );

  hub.removeUiClient(firstSocket);
  const reconnectedMessages: ControlPlaneToUi[] = [];
  hub.addUiClient({ send: (data: string) => reconnectedMessages.push(JSON.parse(data) as ControlPlaneToUi) });
  assert.equal(
    reconnectedMessages[0]?.type === "snapshot" ? reconnectedMessages[0].projects?.[0]?.totalSessionCount : -1,
    0,
  );

  assert.equal(db.setResourceScope({
    resource: "session", resourceId: "s_private", scope: privateScope, now: 6,
  }), true);
  hub.synchronizeProjectSessionState();
  db.setSessionProject("s_private", project.id, location.id, 7);
  hub.sessionChangedById("s_private");
  const restoredProject = reconnectedMessages.findLast((message) =>
    message.type === "project_upsert" && message.project.id === project.id);
  assert.equal(restoredProject?.type === "project_upsert" ? restoredProject.project.totalSessionCount : -1, 1);
  db.close();
});

test("organization-wide socket invalidation closes principals cached with a former admin role", () => {
  const db = ControlPlaneDb.open(":memory:");
  const local = db.localIdentityContext();
  db.createIdentityMember({
    userId: "usr_admin", displayName: "Admin", organizationId: local.organizationId, role: "admin", now: 1,
  });
  db.createDevice({ id: "dev_admin", name: "Admin", tokenHash: hashToken("admin"), userId: "usr_admin", organizationId: local.organizationId, now: 2 });
  const hub = new Hub(db);
  let closes = 0;
  hub.addUiClient({ send: () => {} }, {
    deviceId: "dev_admin", principal: principal(db, "admin"), close: () => { closes += 1; },
  });
  db.updateIdentityMember({
    organizationId: local.organizationId, userId: "usr_admin", displayName: "Admin",
    role: "operator", status: "active", now: 3,
  });
  hub.closeOrganizationUiClients(local.organizationId);
  assert.equal(closes, 1);
  db.close();
});
