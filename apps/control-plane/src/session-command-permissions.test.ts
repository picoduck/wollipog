import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import type { ControlPlaneToUi, RunnerMetadata, SessionCommandPermissions } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import type { AgentPrincipal, AuthPrincipal, HumanPrincipal } from "./identity.js";
import { registerSessionLookupRoute } from "./session-lookup-route.js";
import { sessionCommandPermissions, withSessionCommandPermissions } from "./session-command-permissions.js";

const VIEWER = "Your Viewer role is read-only.";
const STOP_JOB_OWNER = "Only the session owner or its controlling Orchestrator can stop its background jobs.";
const ALL_ALLOWED: SessionCommandPermissions = {
  stop: { allowed: true },
  restart: { allowed: true },
  stopBackgroundJob: { allowed: true },
};

function human(role: HumanPrincipal["role"], userId = "usr_1"): HumanPrincipal {
  return {
    kind: "human", actorId: userId, userId, userName: userId, organizationId: "org_1",
    organizationName: "Org", role, deviceId: `dev_${userId}`, localBootstrap: false,
  };
}

test("a person's command permissions follow the role gate and Stop Job's owner rule (#1843)", () => {
  const child = { id: "s_child", parentSessionId: "s_parent" };
  const owns = { ownsSession: true, isDescendant: false };
  const sees = { ownsSession: false, isDescendant: false };
  for (const role of ["owner", "admin", "operator"] as const) {
    assert.deepEqual(sessionCommandPermissions(human(role), child, owns), ALL_ALLOWED, `an owning ${role} keeps every command`);
  }
  for (const role of ["owner", "admin"] as const) {
    assert.deepEqual(sessionCommandPermissions(human(role), child, sees), {
      stop: { allowed: true },
      restart: { allowed: true },
      stopBackgroundJob: { allowed: false, reason: STOP_JOB_OWNER },
    }, `a non-owning ${role} may stop and restart but not stop one job`);
  }
  const readOnly = { allowed: false, reason: VIEWER };
  for (const facts of [owns, sees]) {
    assert.deepEqual(sessionCommandPermissions(human("viewer"), child, facts),
      { stop: readOnly, restart: readOnly, stopBackgroundJob: readOnly },
      "a Viewer is read-only even for a session its scope names");
  }
});

test("an agent credential's command permissions follow descendant confinement and the controlling Orchestrator rule (#1843)", () => {
  const scope = { organizationId: "org_1", owner: { kind: "user" as const, userId: "usr_1" } };
  const orchestrator: AgentPrincipal = {
    kind: "agent", actorId: "s_parent", credentialSessionId: "s_parent", orchestrator: true,
    organizationId: "org_1", delegatedScope: scope,
  };
  const child = { id: "s_child", parentSessionId: "s_parent" };
  const descendant = { ownsSession: false, isDescendant: true };
  assert.deepEqual(sessionCommandPermissions(orchestrator, child, descendant), ALL_ALLOWED,
    "the controlling Orchestrator may stop, restart, and stop one job of its child");

  const grandchild = sessionCommandPermissions(orchestrator, { id: "s_grandchild", parentSessionId: "s_child" }, descendant);
  assert.deepEqual(grandchild.stop, { allowed: true });
  assert.deepEqual(grandchild.stopBackgroundJob, { allowed: false, reason: STOP_JOB_OWNER },
    "a grandchild's jobs belong to its own parent's campaign");

  const worker = sessionCommandPermissions({ ...orchestrator, orchestrator: undefined }, child, descendant);
  assert.deepEqual(worker.restart, { allowed: true });
  assert.deepEqual(worker.stopBackgroundJob, { allowed: false, reason: STOP_JOB_OWNER });

  const self = sessionCommandPermissions(orchestrator, { id: "s_parent", parentSessionId: null },
    { ownsSession: false, isDescendant: false });
  for (const command of ["stop", "restart", "stopBackgroundJob"] as const) {
    const permission = self[command];
    assert.equal(permission.allowed, false, `an agent cannot ${command} its own session`);
    assert.match(permission.allowed ? "" : permission.reason, /^The session credential may manage only its descendants\.$/u,
      "the refusal is the route's own, as a sentence");
  }
});

test("reads carry the requester's command permissions; a trusted local read is unchanged (#1843)", async (t) => {
  const db = ControlPlaneDb.open(":memory:");
  const local = db.localIdentityContext();
  const runner: RunnerMetadata = {
    runnerId: "runner-1", hostname: "host", os: "linux", version: "1", agents: [],
    workspaces: [{ id: "ws-1", name: "Repo", path: "/repo" }],
  };
  db.registerRunner(runner, 1, 55);
  for (const [userId, role] of [["usr_owner", "operator"], ["usr_admin", "admin"], ["usr_viewer", "viewer"]] as const) {
    db.createIdentityMember({ userId, displayName: userId, organizationId: local.organizationId, role, now: 2 });
  }
  db.createSession({
    id: "s_owned", runnerId: "runner-1", workspaceId: "ws-1", agentId: null, title: "Owned",
    useWorktree: false, driver: "claude-code", config: {},
    scope: { organizationId: local.organizationId, owner: { kind: "user", userId: "usr_owner" } }, now: 3,
  });
  db.createSession({
    id: "s_shared", runnerId: "runner-1", workspaceId: "ws-1", agentId: null, title: "Shared",
    useWorktree: false, driver: "claude-code", config: {},
    scope: { organizationId: local.organizationId, owner: { kind: "organization", organizationId: local.organizationId } }, now: 4,
  });
  const member = (userId: string, role: HumanPrincipal["role"]): HumanPrincipal => ({
    ...human(role, userId), organizationId: local.organizationId, organizationName: local.organizationName,
  });
  const owner = member("usr_owner", "operator");
  const admin = member("usr_admin", "admin");
  const viewer = member("usr_viewer", "viewer");

  const session = db.getSession("s_owned")!;
  assert.equal(withSessionCommandPermissions(db, null, session), session, "a trusted local read is not decorated");
  assert.equal(db.getSession("s_owned")!.commandPermissions, undefined, "permissions are never stored");

  const principals: Record<string, AuthPrincipal> = { owner, admin, viewer };
  const app = Fastify();
  registerSessionLookupRoute(app, {
    db,
    requestPrincipal: (req) => principals[String(req.headers.authorization)] ?? null,
  });
  await app.ready();
  t.after(async () => { await app.close(); db.close(); });
  const read = async (who: string, id: string) => {
    const response = await app.inject({
      method: "GET", url: `/api/sessions/lookup/by-id?id=${id}`, headers: { authorization: who },
    });
    assert.equal(response.statusCode, 200);
    return (response.json() as { session: { commandPermissions?: SessionCommandPermissions } }).session.commandPermissions;
  };
  assert.deepEqual(await read("owner", "s_owned"), ALL_ALLOWED);
  assert.deepEqual((await read("admin", "s_owned"))?.stopBackgroundJob, { allowed: false, reason: STOP_JOB_OWNER });
  assert.deepEqual((await read("admin", "s_owned"))?.stop, { allowed: true });
  assert.deepEqual(await read("admin", "s_shared"), ALL_ALLOWED, "an organization-scoped session is the admin's own");
  assert.deepEqual((await read("viewer", "s_shared"))?.restart, { allowed: false, reason: VIEWER });
});

test("each live client receives its own command permissions for one session change (#1843)", (t) => {
  const db = ControlPlaneDb.open(":memory:");
  t.after(() => db.close());
  const local = db.localIdentityContext();
  db.registerRunner({
    runnerId: "runner-1", hostname: "host", os: "linux", version: "1", agents: [],
    workspaces: [{ id: "ws-1", name: "Repo", path: "/repo" }],
  }, 1, 55);
  for (const [userId, role] of [["usr_owner", "operator"], ["usr_admin", "admin"], ["usr_admin_2", "admin"], ["usr_viewer", "viewer"]] as const) {
    db.createIdentityMember({ userId, displayName: userId, organizationId: local.organizationId, role, now: 2 });
  }
  db.createSession({
    id: "s_owned", runnerId: "runner-1", workspaceId: "ws-1", agentId: null, title: "Owned",
    useWorktree: false, driver: "claude-code", config: {},
    scope: { organizationId: local.organizationId, owner: { kind: "user", userId: "usr_owner" } }, now: 3,
  });
  const hub = new Hub(db);
  const connect = (principal: HumanPrincipal | undefined) => {
    const messages: ControlPlaneToUi[] = [];
    hub.addUiClient({ send: (data: string) => messages.push(JSON.parse(data) as ControlPlaneToUi) }, {
      deviceId: principal?.deviceId ?? null, ...(principal ? { principal } : {}), close: () => {},
    });
    return messages;
  };
  const member = (userId: string, role: HumanPrincipal["role"]): HumanPrincipal => ({
    ...human(role, userId), organizationId: local.organizationId, organizationName: local.organizationName,
  });
  const clients = {
    owner: connect(member("usr_owner", "operator")),
    admin: connect(member("usr_admin", "admin")),
    otherAdmin: connect(member("usr_admin_2", "admin")),
    local: connect(undefined),
  };
  const snapshotPermissions = (messages: ControlPlaneToUi[]) => {
    const snapshot = messages[0];
    return snapshot?.type === "snapshot" ? snapshot.sessions.find((s) => s.id === "s_owned")?.commandPermissions : "no snapshot";
  };
  assert.deepEqual(snapshotPermissions(clients.owner), ALL_ALLOWED);
  assert.deepEqual(snapshotPermissions(clients.admin), {
    stop: { allowed: true }, restart: { allowed: true }, stopBackgroundJob: { allowed: false, reason: STOP_JOB_OWNER },
  });
  assert.equal(snapshotPermissions(clients.local), undefined, "a trusted local client keeps every command offered");

  db.updateSessionStatus("s_owned", "idle", 4);
  hub.sessionChangedById("s_owned");
  const upsertPermissions = (messages: ControlPlaneToUi[]) => {
    const upsert = messages.findLast((message) => message.type === "session_upsert" && message.session.id === "s_owned");
    return upsert?.type === "session_upsert" ? upsert.session.commandPermissions : "no upsert";
  };
  assert.deepEqual(upsertPermissions(clients.owner), ALL_ALLOWED);
  assert.deepEqual(upsertPermissions(clients.admin), snapshotPermissions(clients.admin));
  assert.deepEqual(upsertPermissions(clients.otherAdmin), snapshotPermissions(clients.admin),
    "clients sharing a verdict share one serialization and still receive it");
  assert.equal(upsertPermissions(clients.local), undefined);

  // An ownership change leaves organization admins connected; each is resent the session only
  // because its verdict changed, and nothing is resent when no verdict moves.
  assert.equal(db.setResourceScope({
    resource: "session", resourceId: "s_owned", now: 5,
    scope: { organizationId: local.organizationId, owner: { kind: "organization", organizationId: local.organizationId } },
  }), true);
  const before = { admin: clients.admin.length, local: clients.local.length };
  hub.closeScopedUiClients();
  assert.deepEqual(upsertPermissions(clients.admin), ALL_ALLOWED, "the admin now owns the session through its organization");
  assert.deepEqual(upsertPermissions(clients.otherAdmin), ALL_ALLOWED);
  assert.equal(clients.admin.length, before.admin + 1);
  assert.equal(clients.local.length, before.local, "a trusted local client has no verdict to refresh");
  hub.closeScopedUiClients();
  assert.equal(clients.admin.length, before.admin + 1, "an unchanged verdict is not resent");
});
