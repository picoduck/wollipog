import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  sessionHolds,
  type ControlPlaneToUi,
  type RunnerMetadata,
  type SessionCommandPermissions,
  type SessionView,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import type { AgentPrincipal, AuthPrincipal, HumanPrincipal } from "./identity.js";
import { registerSessionLookupRoute } from "./session-lookup-route.js";
import {
  sessionCommandPermissions,
  sessionHoldReader,
  withCampaignHoldAdviceFor,
  withHoldAdviceFor,
  withSessionCommandPermissions,
  withSessionHoldAdviceFor,
  type SessionCommandPermissionSource,
} from "./session-command-permissions.js";

const VIEWER = "Your Viewer role is read-only.";
const STOP_JOB_OWNER = "Only the session owner or its controlling Orchestrator can stop its background jobs.";
const AGENT_UNARCHIVE = "Session credentials may archive descendants, but cannot unarchive them.";
const AGENT_DELETE = "Session credentials cannot delete sessions.";
const AGENT_ROUTE = "Session credentials cannot use this command.";
const ALL_ALLOWED: SessionCommandPermissions = {
  stop: { allowed: true },
  restart: { allowed: true },
  stopBackgroundJob: { allowed: true },
  archive: { allowed: true },
  unarchive: { allowed: true },
  prompt: { allowed: true },
  delete: { allowed: true },
  cancelTurn: { allowed: true },
  manageQueue: { allowed: true },
  rename: { allowed: true },
  configure: { allowed: true },
  respond: { allowed: true },
};
/** The commands #1857 added, none of which an agent credential's allowlist names except configure. */
const LATER_COMMANDS = ["cancelTurn", "manageQueue", "rename", "configure", "respond"] as const;
const NON_OWNER: SessionCommandPermissions = {
  ...ALL_ALLOWED,
  stopBackgroundJob: { allowed: false, reason: STOP_JOB_OWNER },
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
    assert.deepEqual(sessionCommandPermissions(human(role), child, sees), NON_OWNER,
      `a non-owning ${role} may stop, restart, archive, unarchive, prompt and delete, but not stop one job`);
  }
  const readOnly = { allowed: false, reason: VIEWER };
  for (const facts of [owns, sees]) {
    assert.deepEqual(sessionCommandPermissions(human("viewer"), child, facts), {
      stop: readOnly, restart: readOnly, stopBackgroundJob: readOnly,
      archive: readOnly, unarchive: readOnly, prompt: readOnly, delete: readOnly,
      cancelTurn: readOnly, manageQueue: readOnly, rename: readOnly, configure: readOnly, respond: readOnly,
    }, "a Viewer is read-only even for a session its scope names");
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
  assert.deepEqual(sessionCommandPermissions(orchestrator, child, descendant), {
    ...ALL_ALLOWED,
    unarchive: { allowed: false, reason: AGENT_UNARCHIVE },
    delete: { allowed: false, reason: AGENT_DELETE },
    cancelTurn: { allowed: false, reason: AGENT_ROUTE },
    manageQueue: { allowed: false, reason: AGENT_ROUTE },
    rename: { allowed: false, reason: AGENT_ROUTE },
    respond: { allowed: false, reason: AGENT_ROUTE },
  }, "the controlling Orchestrator may stop, restart, stop one job of, archive, prompt and configure its child, but never unarchive or delete it or use a route outside its allowlist");

  const grandchild = sessionCommandPermissions(orchestrator, { id: "s_grandchild", parentSessionId: "s_child" }, descendant);
  assert.deepEqual(grandchild.stop, { allowed: true });
  assert.deepEqual(grandchild.stopBackgroundJob, { allowed: false, reason: STOP_JOB_OWNER },
    "a grandchild's jobs belong to its own parent's campaign");

  const worker = sessionCommandPermissions({ ...orchestrator, orchestrator: undefined }, child, descendant);
  assert.deepEqual(worker.restart, { allowed: true });
  assert.deepEqual(worker.stopBackgroundJob, { allowed: false, reason: STOP_JOB_OWNER });
  assert.deepEqual(worker.archive, { allowed: true });
  assert.deepEqual(worker.prompt, { allowed: true });
  assert.deepEqual(worker.unarchive, { allowed: false, reason: AGENT_UNARCHIVE });

  const self = sessionCommandPermissions(orchestrator, { id: "s_parent", parentSessionId: null },
    { ownsSession: false, isDescendant: false });
  for (const command of ["stop", "restart", "stopBackgroundJob", "archive", "prompt"] as const) {
    const permission = self[command];
    assert.equal(permission?.allowed, false, `an agent cannot ${command} its own session`);
    assert.match(permission?.allowed === false ? permission.reason : "", /^The session credential may manage only its descendants\.$/u,
      "the refusal is the route's own, as a sentence");
  }
  assert.deepEqual(self.unarchive, { allowed: false, reason: AGENT_UNARCHIVE });
  assert.deepEqual(self.delete, { allowed: false, reason: AGENT_DELETE });
});

test("the commands #1857 added follow the role gate, the agent route allowlist and descendant confinement", () => {
  const child = { id: "s_child", parentSessionId: "s_parent" };
  const sees = { ownsSession: false, isDescendant: false };
  for (const role of ["owner", "admin", "operator"] as const) {
    const permissions = sessionCommandPermissions(human(role), child, sees);
    for (const command of LATER_COMMANDS) {
      assert.deepEqual(permissions[command], { allowed: true }, `a non-owning ${role} may ${command}`);
    }
  }
  const viewer = sessionCommandPermissions(human("viewer"), child, { ownsSession: true, isDescendant: false });
  for (const command of LATER_COMMANDS) {
    assert.deepEqual(viewer[command], { allowed: false, reason: VIEWER }, `a Viewer may not ${command}`);
  }

  const scope = { organizationId: "org_1", owner: { kind: "user" as const, userId: "usr_1" } };
  const worker: AgentPrincipal = {
    kind: "agent", actorId: "s_parent", credentialSessionId: "s_parent",
    organizationId: "org_1", delegatedScope: scope,
  };
  const descendant = sessionCommandPermissions(worker, child, { ownsSession: false, isDescendant: true });
  assert.deepEqual(descendant.configure, { allowed: true }, "a worker credential may configure its descendant");
  for (const command of ["cancelTurn", "manageQueue", "rename", "respond"] as const) {
    assert.deepEqual(descendant[command], { allowed: false, reason: AGENT_ROUTE },
      `no agent credential's allowlist reaches ${command}`);
  }
  const unrelated = sessionCommandPermissions(worker, { id: "s_other", parentSessionId: null },
    { ownsSession: false, isDescendant: false });
  assert.deepEqual(unrelated.configure, {
    allowed: false, reason: "The session credential may manage only its descendants.",
  }, "configure keeps descendant confinement");
  const own = sessionCommandPermissions(worker, { id: "s_parent", parentSessionId: null },
    { ownsSession: false, isDescendant: false });
  assert.deepEqual(own.configure, { allowed: false, reason: "An agent may change only its own maxChildSessions." },
    "the config route admits a credential's own session, but its service refuses every setting this verdict describes");
});

test("an agent credential's hold reader follows the routes its advice names (#1863)", () => {
  const scope = { organizationId: "org_1", owner: { kind: "user" as const, userId: "usr_1" } };
  const orchestrator: AgentPrincipal = {
    kind: "agent", actorId: "s_parent", credentialSessionId: "s_parent", orchestrator: true,
    organizationId: "org_1", delegatedScope: scope,
  };
  const worker: AgentPrincipal = { ...orchestrator, orchestrator: undefined };
  const child = { id: "s_child", parentSessionId: "s_parent" };
  const grandchild = { id: "s_grandchild", parentSessionId: "s_child" };
  const descendant = { ownsSession: false, isDescendant: true };
  const self = { ownsSession: false, isDescendant: false };
  const reader = (canStopJobs: boolean, canRestart: boolean, canManageWorktrees: boolean) =>
    ({ canStopJobs, canRestart, canManageWorktrees });

  assert.deepEqual(sessionHoldReader(orchestrator, child, descendant), reader(true, true, true),
    "the controlling Orchestrator may take every action the advice names");
  assert.deepEqual(sessionHoldReader(orchestrator, grandchild, descendant), reader(false, true, true),
    "a grandchild's jobs belong to its own parent");
  assert.deepEqual(sessionHoldReader(worker, child, descendant), reader(false, true, false),
    "a worker parent may restart its child but neither stop its jobs nor manage its worktrees");
  assert.deepEqual(sessionHoldReader(worker, { id: "s_parent", parentSessionId: null }, self), reader(false, false, true),
    "a worker manages its own worktrees, but cannot restart itself or stop its own jobs");
  const own = { id: "s_parent", parentSessionId: null };
  const policy = (strictProjectIsolation: boolean) =>
    ({ execution: { strictProjectIsolation } }) as unknown as SessionView["orchestratorPolicy"];
  assert.deepEqual(sessionHoldReader(orchestrator, own, self), reader(false, false, false),
    "an Orchestrator's own worktrees are refused under Strict Project Isolation, which is the default");
  assert.deepEqual(sessionHoldReader(orchestrator, { ...own, orchestratorPolicy: policy(false) }, self),
    reader(false, false, true));
  assert.equal(sessionHoldReader(human("viewer"), child, descendant), undefined,
    "a person reads the server's copy, which the dashboard rewrites itself");

  const recovery = { recoveryId: "wr_1", detectedAt: 1, selectedPath: "/w/c", expectedBranch: "fix/c", detail: "switched" };
  const queueHold = {
    kind: "worktree_rebind" as const, holdId: "qh_1", since: 1, target: "/w/next", queuedPrompts: 1,
    unfinishedBackgroundJobs: 1, canStopJobs: true as const,
  };
  const view = { worktreeRecovery: recovery, queueHold, holds: sessionHolds({ worktreeRecovery: recovery, queueHold }) };
  assert.equal(withHoldAdviceFor(view, undefined), view, "no reader leaves the view as it is");
  const tailored = withHoldAdviceFor(view, reader(false, true, false));
  assert.deepEqual(tailored.holds, sessionHolds({ worktreeRecovery: recovery, queueHold }, [], reader(false, true, false)));
  assert.deepEqual(tailored.holds?.map((hold) => hold.holdId), ["wr_1", "qh_1"]);
  assert.doesNotMatch(tailored.holds?.map((hold) => hold.recoveryAction).join(" ") ?? "",
    /stop_background_job|select_worktree|create_worktree/u);
  assert.deepEqual(withHoldAdviceFor(view, reader(true, true, true)).holds, view.holds,
    "a reader allowed everything reads the server's copy");
  const stale = { ...view, queueHold: { ...queueHold, holdId: "qh_2" } };
  assert.equal(withHoldAdviceFor(stale, reader(false, false, false)).holds?.[1], view.holds[1],
    "a hold with no matching record is left as written");
});

test("a campaign's held children are written for the agent credential reading it, wherever the campaign is embedded (#1863)", () => {
  const scope = { organizationId: "org_1", owner: { kind: "user" as const, userId: "usr_1" } };
  // A nested Orchestrator: its root campaign lists every descendant, its own session included.
  const nested: AgentPrincipal = {
    kind: "agent", actorId: "s_nested", credentialSessionId: "s_nested", orchestrator: true,
    organizationId: "org_1", delegatedScope: scope,
  };
  const recovery = { recoveryId: "wr_1", detectedAt: 1, selectedPath: "/w/n", expectedBranch: "fix/n", detail: "switched" };
  const queueHold = {
    kind: "worktree_rebind" as const, holdId: "qh_1", since: 1, target: "/w/next", queuedPrompts: 1,
    unfinishedBackgroundJobs: 1, canStopJobs: true as const,
  };
  const policy = (strictProjectIsolation: boolean) =>
    ({ execution: { strictProjectIsolation } }) as unknown as SessionView["orchestratorPolicy"];
  const records = new Map<string, ReturnType<SessionCommandPermissionSource["sessionHoldRecords"]> extends
    Map<string, infer R> ? R : never>([
    ["s_nested", { parentSessionId: "s_root", orchestratorPolicy: policy(false), worktreeRecovery: recovery }],
    ["s_grandchild", { parentSessionId: "s_child", queueHold }],
  ]);
  const source: SessionCommandPermissionSource = {
    isSessionOwner: () => false,
    isSessionDescendant: (ancestor, target) => ancestor === "s_nested" && target === "s_grandchild",
    sessionHoldRecords: (ids) => new Map(ids.flatMap((id) => records.has(id) ? [[id, records.get(id)!] as const] : [])),
  };
  const projection = {
    heldChildren: [
      { sessionId: "s_nested", holds: sessionHolds({ worktreeRecovery: recovery }) },
      { sessionId: "s_grandchild", holds: sessionHolds({ queueHold }) },
      { sessionId: "s_gone", holds: sessionHolds({ queueHold }) },
    ],
  };
  const advice = (value: typeof projection) => value.heldChildren.map((child) => child.holds[0]?.recoveryAction ?? "");

  const [own, grandchild, gone] = advice(withCampaignHoldAdviceFor(source, nested, projection));
  assert.match(own!, /select_worktree/u, "an Orchestrator without Strict Project Isolation may recover its own worktree");
  assert.doesNotMatch(grandchild!, /stop_background_job/u, "a grandchild's jobs are not the Orchestrator's to stop");
  assert.match(grandchild!, /restart/u, "it may still restart a descendant");
  assert.equal(gone, projection.heldChildren[2]!.holds[0]!.recoveryAction, "a child with no record is left as written");
  records.set("s_nested", { ...records.get("s_nested")!, orchestratorPolicy: policy(true) });
  assert.doesNotMatch(advice(withCampaignHoldAdviceFor(source, nested, projection))[0]!, /select_worktree/u,
    "under Strict Project Isolation it may not");
  assert.equal(withCampaignHoldAdviceFor(source, human("owner"), projection), projection, "a person's projection is unchanged");

  // The same rewrite reaches a campaign embedded in a session view, which prompt_session returns
  // for a nested Orchestrator as get_session does.
  const view = { id: "s_nested", orchestratorCampaign: projection } as unknown as SessionView;
  const embedded = withSessionHoldAdviceFor(source, nested, view, undefined).orchestratorCampaign as typeof projection;
  assert.deepEqual(advice(embedded), advice(withCampaignHoldAdviceFor(source, nested, projection)));
  assert.doesNotMatch(advice(embedded)[1]!, /stop_background_job/u);
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
  const viewerRead = await read("viewer", "s_shared");
  for (const command of ["archive", "unarchive", "prompt", "delete", ...LATER_COMMANDS] as const) {
    assert.deepEqual(viewerRead?.[command], { allowed: false, reason: VIEWER }, `a Viewer's read refuses ${command}`);
    assert.deepEqual((await read("admin", "s_owned"))?.[command], { allowed: true },
      `a non-owning admin's read still allows ${command}`);
  }
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
  assert.deepEqual(snapshotPermissions(clients.admin), NON_OWNER);
  assert.equal(snapshotPermissions(clients.local), undefined, "a trusted local client keeps every command offered");

  db.updateSessionStatus("s_owned", "idle", 4);
  hub.sessionChangedById("s_owned");
  const upsertPermissions = (messages: ControlPlaneToUi[]) => {
    const upsert = [...messages].reverse()
      .find((message) => message.type === "session_upsert" && message.session.id === "s_owned");
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
