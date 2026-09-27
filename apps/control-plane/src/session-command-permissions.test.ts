import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import Fastify from "fastify";
import {
  DEFAULT_ORCHESTRATOR_DEFAULTS,
  queueHoldRecoveryAction,
  sessionHolds,
  worktreeRecoveryAction,
  type ControlPlaneToUi,
  type RunnerMetadata,
  type SessionCommandPermissions,
  type SessionHoldView,
  type SessionQueueHoldView,
  type SessionView,
  type WorktreeRecoveryView,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import type { AgentPrincipal, AuthPrincipal, HumanPrincipal } from "./identity.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
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
  fork: { allowed: true },
  rewind: { allowed: true },
  manageReviewFindings: { allowed: true },
  manageWorktrees: { allowed: true },
  worktreeSetup: { allowed: true },
  gitActions: { allowed: true },
};
/** The commands #1864 added. An agent credential's allowlist names only the worktree routes. */
const ISSUE_COMMANDS = ["fork", "rewind", "manageReviewFindings", "manageWorktrees", "worktreeSetup"] as const;
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
      fork: readOnly, rewind: readOnly, manageReviewFindings: readOnly, manageWorktrees: readOnly, worktreeSetup: readOnly,
      gitActions: readOnly,
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
    fork: { allowed: false, reason: AGENT_ROUTE },
    rewind: { allowed: false, reason: AGENT_ROUTE },
    manageReviewFindings: { allowed: false, reason: AGENT_ROUTE },
    worktreeSetup: { allowed: false, reason: AGENT_ROUTE },
    gitActions: { allowed: false, reason: AGENT_ROUTE },
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
  // A person's reader covers every hold too (#1867, #1875).
  assert.deepEqual(sessionHoldReader(human("viewer"), child, { ownsSession: true, isDescendant: false }),
    reader(false, false, false), "a Viewer may take no action the advice names, even on a session its scope names");
  for (const role of ["owner", "admin", "operator"] as const) {
    assert.deepEqual(sessionHoldReader(human(role), child, { ownsSession: false, isDescendant: false }),
      reader(false, true, true), `a non-owning ${role} may restart it and manage its worktrees, but not stop its jobs`);
    assert.deepEqual(sessionHoldReader(human(role), child, { ownsSession: true, isDescendant: false }),
      reader(true, true, true), `an owning ${role} may take every action`);
  }

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
  assert.deepEqual(withCampaignHoldAdviceFor({ ...source, isSessionOwner: () => true }, human("owner"), projection),
    projection, "a person who may take every action reads the server's copy");

  // The same rewrite reaches a campaign embedded in a session view, which prompt_session returns
  // for a nested Orchestrator as get_session does.
  const view = { id: "s_nested", orchestratorCampaign: projection } as unknown as SessionView;
  const embedded = withSessionHoldAdviceFor(source, nested, view, undefined).orchestratorCampaign as typeof projection;
  assert.deepEqual(advice(embedded), advice(withCampaignHoldAdviceFor(source, nested, projection)));
  assert.doesNotMatch(advice(embedded)[1]!, /stop_background_job/u);
});

test("a person's Held Children advice is written for them, looking up only the ownership it reads (#1867, #1875)", () => {
  const recovery = { recoveryId: "wr_1", detectedAt: 1, selectedPath: "/w/c", expectedBranch: "fix/c", detail: "switched" };
  const queueHold = {
    kind: "worktree_rebind" as const, holdId: "qh_1", since: 1, target: "/w/next", queuedPrompts: 1,
    unfinishedBackgroundJobs: 1, canStopJobs: true as const,
  };
  // A runner that cannot stop one job: its advice reads only whether the person may restart.
  const { canStopJobs: _canStopJobs, ...unstoppable } = { ...queueHold, holdId: "qh_3" };
  const view = { worktreeRecovery: recovery, queueHold, holds: sessionHolds({ worktreeRecovery: recovery, queueHold }) };
  const refused = withHoldAdviceFor(view, { canManageWorktrees: false }).holds!;
  assert.equal(refused[0]!.recoveryAction, worktreeRecoveryAction(recovery, { canManageWorktrees: false }));
  assert.doesNotMatch(refused[0]!.recoveryAction, /select_worktree|create_worktree/u);
  assert.match(refused[0]!.recoveryAction, /switch fix\/c/u, "the branch to restore is still named");
  assert.equal(refused[1], view.holds[1], "a reader without canStopJobs leaves queue-hold advice as written");

  const both = { recoveryId: "wr_2", detectedAt: 1, selectedPath: "/w/b", expectedBranch: "fix/b", detail: "switched" };
  const bothQueue = { ...queueHold, holdId: "qh_2" };
  const records: ReturnType<SessionCommandPermissionSource["sessionHoldRecords"]> = new Map([
    ["s_queue", { parentSessionId: "s_orch", queueHold }],
    ["s_wt", { parentSessionId: "s_orch", worktreeRecovery: recovery }],
    ["s_both", { parentSessionId: "s_orch", worktreeRecovery: both, queueHold: bothQueue }],
    ["s_unstoppable", { parentSessionId: "s_orch", queueHold: unstoppable }],
  ]);
  let recordReads: string[][] = [];
  let ownerLookups: string[] = [];
  let owned = new Set<string>();
  const source: SessionCommandPermissionSource = {
    isSessionOwner: (_principal, id) => { ownerLookups.push(id); return owned.has(id); },
    isSessionDescendant: () => false,
    sessionHoldRecords: (ids) => {
      recordReads.push([...ids]);
      return new Map(ids.flatMap((id) => records.has(id) ? [[id, records.get(id)!] as const] : []));
    },
  };
  // The projection lists every held child, whether or not the reader's dashboard has loaded it.
  const projection = {
    heldChildren: [
      { sessionId: "s_queue", holds: sessionHolds({ queueHold }) },
      { sessionId: "s_wt", holds: sessionHolds({ worktreeRecovery: recovery }) },
      { sessionId: "s_both", holds: sessionHolds({ worktreeRecovery: both, queueHold: bothQueue }) },
      { sessionId: "s_unstoppable", holds: sessionHolds({ queueHold: unstoppable }) },
    ],
  };
  const writtenFor = (principal: HumanPrincipal) => {
    recordReads = [];
    ownerLookups = [];
    return withCampaignHoldAdviceFor(source, principal, projection).heldChildren.map((child) => child.holds);
  };
  const reader = (canStopJobs: boolean, canRestart: boolean, canManageWorktrees: boolean) =>
    ({ canStopJobs, canRestart, canManageWorktrees });

  const none = reader(false, false, false);
  const forViewer = writtenFor(human("viewer"));
  assert.deepEqual(forViewer, [
    sessionHolds({ queueHold }, [], none),
    sessionHolds({ worktreeRecovery: recovery }, [], none),
    sessionHolds({ worktreeRecovery: both, queueHold: bothQueue }, [], none),
    sessionHolds({ queueHold: unstoppable }, [], none),
  ], "a Viewer's advice is written for them, for every hold kind");
  assert.doesNotMatch(forViewer.flat().map((hold) => hold.recoveryAction).join(" "),
    /stop_background_job|Stop Job|restart|select_worktree|create_worktree/u, "and names no action they could take");
  assert.deepEqual(recordReads, [["s_queue", "s_wt", "s_both", "s_unstoppable"]], "every held child is read");
  assert.deepEqual(ownerLookups, [], "but the role gate refuses a Viewer before ownership is read");

  const nonOwner = reader(false, true, true);
  assert.doesNotMatch(sessionHolds({ queueHold }, [], nonOwner)[0]!.recoveryAction, /stop_background_job|Stop Job/u);
  for (const role of ["owner", "admin", "operator"] as const) {
    assert.deepEqual(writtenFor(human(role)), [
      sessionHolds({ queueHold }, [], nonOwner),
      projection.heldChildren[1]!.holds,
      sessionHolds({ worktreeRecovery: both, queueHold: bothQueue }, [], nonOwner),
      projection.heldChildren[3]!.holds,
    ], `a non-owning ${role} may restart and manage the worktrees, but not stop a job`);
    assert.deepEqual(ownerLookups, ["s_queue", "s_both"],
      "only the children whose runner can stop a job have their ownership looked up");
    owned = new Set(["s_queue", "s_both"]);
    assert.deepEqual(writtenFor(human(role)), projection.heldChildren.map((child) => child.holds),
      `an owning ${role} reads the server's copy`);
    owned = new Set();
  }

  // An agent credential's advice covers every hold, and it reads every held child (#1863).
  recordReads = [];
  const worker: AgentPrincipal = {
    kind: "agent", actorId: "s_orch", credentialSessionId: "s_orch", organizationId: "org_1",
    delegatedScope: { organizationId: "org_1", owner: { kind: "user", userId: "usr_1" } },
  };
  const forAgent = withCampaignHoldAdviceFor(source, worker, projection).heldChildren;
  assert.deepEqual(recordReads, [["s_queue", "s_wt", "s_both", "s_unstoppable"]]);
  assert.notEqual(forAgent[0]!.holds[0]!.recoveryAction, projection.heldChildren[0]!.holds[0]!.recoveryAction,
    "its queue-hold advice is written for it");
});

test("a person's session reads and live updates carry worktree-recovery advice written for them (#1867)", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "person-hold-advice-"));
  const database = join(root, "control-plane.db");
  const recovery: WorktreeRecoveryView = {
    recoveryId: "wr-1", detectedAt: 10, selectedPath: "/w/child", expectedBranch: "fix/child", detail: "branch switched",
  };
  const queueHold: SessionQueueHoldView = {
    kind: "worktree_rebind", holdId: "qh-1", since: 10, target: "/w/next", queuedPrompts: 1,
    unfinishedBackgroundJobs: 1, canStopJobs: true, restartKeepsQueue: true,
  };
  const seed = ControlPlaneDb.open(database);
  const local = seed.localIdentityContext();
  try {
    seed.registerRunner({ runnerId: "r", hostname: "test", os: "linux", version: "test", agents: [], workspaces: [] }, 1, 55);
    for (const [userId, role] of [["usr_admin", "admin"], ["usr_viewer", "viewer"], ["usr_viewer_2", "viewer"]] as const) {
      seed.createIdentityMember({ userId, displayName: userId, organizationId: local.organizationId, role, now: 2 });
    }
    const scope = { organizationId: local.organizationId, owner: { kind: "organization" as const, organizationId: local.organizationId } };
    seed.createSession({ id: "orch", runnerId: "r", workspaceId: null, agentId: null, title: "Orchestrator",
      useWorktree: false, driver: "codex", config: { permissionMode: "orchestrator" },
      orchestratorPolicy: resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default", {}),
      scope, now: 3 });
    for (const id of ["orch-wt", "orch-queue"]) {
      seed.createSession({ id, parentSessionId: "orch", runnerId: "r", workspaceId: null, agentId: null, title: id,
        useWorktree: false, driver: "codex", config: {}, scope, now: 4 });
    }
  } finally { seed.close(); }
  // The holds as the runner reports them, stored the way a session snapshot stores them.
  const raw = new DatabaseSync(database);
  try {
    raw.prepare("UPDATE sessions SET worktree_recovery=? WHERE id=?").run(JSON.stringify(recovery), "orch-wt");
    raw.prepare("UPDATE sessions SET queue_hold=? WHERE id=?").run(JSON.stringify(queueHold), "orch-queue");
  } finally { raw.close(); }
  const db = ControlPlaneDb.open(database);
  const member = (userId: string, role: HumanPrincipal["role"]): HumanPrincipal => ({
    ...human(role, userId), organizationId: local.organizationId, organizationName: local.organizationName,
  });
  const admin = member("usr_admin", "admin");
  const viewer = member("usr_viewer", "viewer");
  const app = Fastify();
  const principals: Record<string, AuthPrincipal> = { admin, viewer };
  registerSessionLookupRoute(app, { db, requestPrincipal: (req) => principals[String(req.headers.authorization)] ?? null });
  await app.ready();
  t.after(async () => { await app.close(); db.close(); rmSync(root, { recursive: true, force: true }); });

  const serverCopy = worktreeRecoveryAction(recovery);
  const viewerCopy = worktreeRecoveryAction(recovery, { canManageWorktrees: false });
  const queueCopy = queueHoldRecoveryAction(queueHold);
  // The queue-hold advice is written for a Viewer too (#1875).
  const viewerQueueCopy = queueHoldRecoveryAction(queueHold, { canStopJobs: false, canRestart: false });
  const read = async (who: string, id: string) => {
    const response = await app.inject({ method: "GET", url: `/api/sessions/lookup/by-id?id=${id}`, headers: { authorization: who } });
    assert.equal(response.statusCode, 200);
    return (response.json() as { session: SessionView }).session;
  };
  const heldAdvice = (session: SessionView | undefined) => Object.fromEntries((session?.orchestratorCampaign?.heldChildren ?? [])
    .map((child) => [child.sessionId, child.holds.map((hold: SessionHoldView) => hold.recoveryAction)]));

  assert.deepEqual(heldAdvice(await read("viewer", "orch")), { "orch-wt": [viewerCopy], "orch-queue": [viewerQueueCopy] },
    "a Viewer's Held Children do not name select_worktree or create_worktree");
  assert.deepEqual(heldAdvice(await read("admin", "orch")), { "orch-wt": [serverCopy], "orch-queue": [queueCopy] });
  assert.deepEqual((await read("viewer", "orch-wt")).holds?.map((hold) => hold.recoveryAction), [viewerCopy],
    "the held session's own view is written for the Viewer too");
  assert.deepEqual((await read("admin", "orch-wt")).holds?.map((hold) => hold.recoveryAction), [serverCopy]);

  const hub = new Hub(db);
  const connect = (principal: HumanPrincipal) => {
    const messages: ControlPlaneToUi[] = [];
    hub.addUiClient({ send: (data: string) => messages.push(JSON.parse(data) as ControlPlaneToUi) },
      { deviceId: principal.deviceId, principal, close: () => {} });
    return messages;
  };
  const clients = {
    admin: connect(admin), viewer: connect(viewer), otherViewer: connect(member("usr_viewer_2", "viewer")),
  };
  const snapshotAdvice = (messages: ControlPlaneToUi[]) => {
    const snapshot = messages[0];
    return heldAdvice(snapshot?.type === "snapshot" ? snapshot.sessions.find((s) => s.id === "orch") : undefined);
  };
  assert.deepEqual(snapshotAdvice(clients.viewer)["orch-wt"], [viewerCopy]);
  assert.deepEqual(snapshotAdvice(clients.admin)["orch-wt"], [serverCopy]);
  hub.sessionChangedById("orch");
  const upsertAdvice = (messages: ControlPlaneToUi[]) => {
    const upsert = [...messages].reverse().find((message) => message.type === "session_upsert" && message.session.id === "orch");
    return heldAdvice(upsert?.type === "session_upsert" ? upsert.session : undefined);
  };
  assert.deepEqual(upsertAdvice(clients.viewer)["orch-wt"], [viewerCopy]);
  assert.deepEqual(upsertAdvice(clients.otherViewer)["orch-wt"], [viewerCopy], "Viewers sharing a verdict share the advice");
  assert.deepEqual(upsertAdvice(clients.admin)["orch-wt"], [serverCopy]);
});

test("a person's Held Children carry queue-hold advice written for them, for a child their dashboard has not loaded (#1875)", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "person-queue-advice-"));
  const database = join(root, "control-plane.db");
  // A runner that can stop one of the child's jobs, and one that cannot, with no deadline either way.
  const stoppable: SessionQueueHoldView = {
    kind: "worktree_rebind", holdId: "qh-private", since: 10, target: "/w/next", queuedPrompts: 1,
    unfinishedBackgroundJobs: 1, canStopJobs: true,
  };
  const unstoppable: SessionQueueHoldView = {
    kind: "provider_account_switch", holdId: "qh-shared", since: 10, target: "account-2", queuedPrompts: 2,
    unfinishedBackgroundJobs: 1,
  };
  const seed = ControlPlaneDb.open(database);
  const local = seed.localIdentityContext();
  try {
    seed.registerRunner({ runnerId: "r", hostname: "test", os: "linux", version: "test", agents: [], workspaces: [] }, 1, 55);
    for (const [userId, role] of [["usr_admin", "admin"], ["usr_viewer", "viewer"], ["usr_owner", "operator"]] as const) {
      seed.createIdentityMember({ userId, displayName: userId, organizationId: local.organizationId, role, now: 2 });
    }
    const shared = { organizationId: local.organizationId, owner: { kind: "organization" as const, organizationId: local.organizationId } };
    seed.createSession({ id: "orch", runnerId: "r", workspaceId: null, agentId: null, title: "Orchestrator",
      useWorktree: false, driver: "codex", config: { permissionMode: "orchestrator" },
      orchestratorPolicy: resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default", {}),
      scope: shared, now: 3 });
    // A child only its owner and admins can see, so a Viewer's dashboard never loads it.
    seed.createSession({ id: "held-private", parentSessionId: "orch", runnerId: "r", workspaceId: null, agentId: null,
      title: "held-private", useWorktree: false, driver: "codex", config: {},
      scope: { organizationId: local.organizationId, owner: { kind: "user", userId: "usr_owner" } }, now: 4 });
    seed.createSession({ id: "held-shared", parentSessionId: "orch", runnerId: "r", workspaceId: null, agentId: null,
      title: "held-shared", useWorktree: false, driver: "codex", config: {}, scope: shared, now: 4 });
  } finally { seed.close(); }
  const raw = new DatabaseSync(database);
  try {
    raw.prepare("UPDATE sessions SET queue_hold=? WHERE id=?").run(JSON.stringify(stoppable), "held-private");
    raw.prepare("UPDATE sessions SET queue_hold=? WHERE id=?").run(JSON.stringify(unstoppable), "held-shared");
  } finally { raw.close(); }
  const db = ControlPlaneDb.open(database);
  const member = (userId: string, role: HumanPrincipal["role"]): HumanPrincipal => ({
    ...human(role, userId), organizationId: local.organizationId, organizationName: local.organizationName,
  });
  const principals: Record<string, HumanPrincipal> = {
    admin: member("usr_admin", "admin"), viewer: member("usr_viewer", "viewer"), owner: member("usr_owner", "operator"),
  };
  const app = Fastify();
  registerSessionLookupRoute(app, { db, requestPrincipal: (req) => principals[String(req.headers.authorization)] ?? null });
  await app.ready();
  t.after(async () => { await app.close(); db.close(); rmSync(root, { recursive: true, force: true }); });

  const heldAdvice = (session: SessionView | undefined) => Object.fromEntries((session?.orchestratorCampaign?.heldChildren ?? [])
    .map((child) => [child.sessionId, child.holds.map((hold: SessionHoldView) => hold.recoveryAction)]));
  const read = async (who: string) => {
    const response = await app.inject({ method: "GET", url: "/api/sessions/lookup/by-id?id=orch", headers: { authorization: who } });
    assert.equal(response.statusCode, 200);
    return heldAdvice((response.json() as { session: SessionView }).session);
  };
  const viewerAdvice = {
    "held-private": [queueHoldRecoveryAction(stoppable, { canStopJobs: false, canRestart: false })],
    "held-shared": [queueHoldRecoveryAction(unstoppable, { canStopJobs: false, canRestart: false })],
  };
  const adminAdvice = {
    "held-private": [queueHoldRecoveryAction(stoppable, { canStopJobs: false, canRestart: true })],
    "held-shared": [queueHoldRecoveryAction(unstoppable)],
  };
  const serverCopy = {
    "held-private": [queueHoldRecoveryAction(stoppable)],
    "held-shared": [queueHoldRecoveryAction(unstoppable)],
  };

  assert.deepEqual(await read("viewer"), viewerAdvice, "a Viewer's advice is written for them");
  assert.doesNotMatch(Object.values(viewerAdvice).flat().join(" "), /stop_background_job|Stop Job|restart/u,
    "and names neither stopping a job nor restarting");
  assert.deepEqual(await read("admin"), adminAdvice, "an admin who does not own a child may restart it but not stop its job");
  assert.doesNotMatch(adminAdvice["held-private"][0]!, /stop_background_job|Stop Job/u);
  assert.match(adminAdvice["held-private"][0]!, /restart/u);
  assert.deepEqual(await read("owner"), serverCopy, "the child's owner may take every action it names");

  const hub = new Hub(db);
  const connect = (principal: HumanPrincipal) => {
    const messages: ControlPlaneToUi[] = [];
    hub.addUiClient({ send: (data: string) => messages.push(JSON.parse(data) as ControlPlaneToUi) },
      { deviceId: principal.deviceId, principal, close: () => {} });
    return messages;
  };
  const clients = { viewer: connect(principals.viewer!), admin: connect(principals.admin!) };
  const snapshot = clients.viewer[0];
  assert.equal(snapshot?.type, "snapshot");
  const sessions = snapshot?.type === "snapshot" ? snapshot.sessions : [];
  assert.equal(sessions.some((session) => session.id === "held-private"), false,
    "the Viewer's dashboard never loads the child it cannot see");
  assert.deepEqual(heldAdvice(sessions.find((session) => session.id === "orch")), viewerAdvice,
    "but Held Children lists it with advice written for them");
  hub.sessionChangedById("orch");
  const upsertAdvice = (messages: ControlPlaneToUi[]) => {
    const upsert = [...messages].reverse().find((message) => message.type === "session_upsert" && message.session.id === "orch");
    return heldAdvice(upsert?.type === "session_upsert" ? upsert.session : undefined);
  };
  assert.deepEqual(upsertAdvice(clients.viewer), viewerAdvice);
  assert.deepEqual(upsertAdvice(clients.admin), adminAdvice);
});

test("fork, rewind, review findings and worktree commands follow the role gate, the agent route allowlist and the worktree rules (#1864)", () => {
  const child = { id: "s_child", parentSessionId: "s_parent" };
  for (const role of ["owner", "admin", "operator"] as const) {
    const permissions = sessionCommandPermissions(human(role), child, { ownsSession: false, isDescendant: false });
    for (const command of ISSUE_COMMANDS) {
      assert.deepEqual(permissions[command], { allowed: true }, `a non-owning ${role} may ${command}`);
    }
  }
  const viewer = sessionCommandPermissions(human("viewer"), child, { ownsSession: true, isDescendant: false });
  for (const command of ISSUE_COMMANDS) {
    assert.deepEqual(viewer[command], { allowed: false, reason: VIEWER }, `a Viewer may not ${command}`);
  }

  const scope = { organizationId: "org_1", owner: { kind: "user" as const, userId: "usr_1" } };
  const orchestrator: AgentPrincipal = {
    kind: "agent", actorId: "s_parent", credentialSessionId: "s_parent", orchestrator: true,
    organizationId: "org_1", delegatedScope: scope,
  };
  const worker: AgentPrincipal = { ...orchestrator, orchestrator: undefined };
  const descendant = { ownsSession: false, isDescendant: true };
  const unrelated = { ownsSession: false, isDescendant: false };
  for (const principal of [orchestrator, worker]) {
    const permissions = sessionCommandPermissions(principal, { id: "s_parent", parentSessionId: null }, unrelated);
    for (const command of ["fork", "rewind", "manageReviewFindings", "worktreeSetup"] as const) {
      assert.deepEqual(permissions[command], { allowed: false, reason: AGENT_ROUTE },
        `no agent credential's allowlist reaches ${command}`);
    }
  }

  const worktrees = (principal: AgentPrincipal, target: Parameters<typeof sessionCommandPermissions>[1],
    facts: typeof descendant) => sessionCommandPermissions(principal, target, facts).manageWorktrees;
  assert.deepEqual(worktrees(orchestrator, child, descendant), { allowed: true },
    "the controlling Orchestrator may manage its child's worktrees");
  assert.deepEqual(worktrees(orchestrator, { id: "s_other", parentSessionId: null }, unrelated), {
    allowed: false, reason: "The session credential may manage only its descendants.",
  }, "an Orchestrator is confined to its descendants");
  const strict = { id: "s_parent", parentSessionId: null };
  assert.deepEqual(worktrees(orchestrator, strict, unrelated), {
    allowed: false,
    reason: "Strict Project Isolation prevents this Orchestrator from managing its own worktrees; select a child session.",
  }, "Strict Project Isolation, the default, refuses an Orchestrator its own worktrees");
  const relaxed = {
    ...strict,
    orchestratorPolicy: { execution: { strictProjectIsolation: false } } as Parameters<typeof sessionCommandPermissions>[1]["orchestratorPolicy"],
  };
  assert.deepEqual(worktrees(orchestrator, relaxed, unrelated), { allowed: true },
    "an Orchestrator launched without Strict Project Isolation may manage its own worktrees");
  assert.deepEqual(worktrees(worker, strict, unrelated), { allowed: true }, "a worker may manage its own worktrees");
  assert.deepEqual(worktrees(worker, child, descendant), {
    allowed: false, reason: "The session credential may manage only its own session.",
  }, "a worker may not manage its descendant's worktrees");
});

test("Git actions follow the role gate and the agent route allowlist (#1870)", () => {
  const child = { id: "s_child", parentSessionId: "s_parent" };
  for (const role of ["owner", "admin", "operator"] as const) {
    for (const ownsSession of [true, false]) {
      assert.deepEqual(sessionCommandPermissions(human(role), child, { ownsSession, isDescendant: false }).gitActions,
        { allowed: true }, `${ownsSession ? "an owning" : "a non-owning"} ${role} may run Git actions`);
    }
  }
  assert.deepEqual(sessionCommandPermissions(human("viewer"), child, { ownsSession: true, isDescendant: false }).gitActions,
    { allowed: false, reason: VIEWER }, "a Viewer may not, even on a session its scope names");

  const scope = { organizationId: "org_1", owner: { kind: "user" as const, userId: "usr_1" } };
  const orchestrator: AgentPrincipal = {
    kind: "agent", actorId: "s_parent", credentialSessionId: "s_parent", orchestrator: true,
    organizationId: "org_1", delegatedScope: scope,
  };
  const worker: AgentPrincipal = { ...orchestrator, orchestrator: undefined };
  const targets = [
    [child, { ownsSession: false, isDescendant: true }],
    [{ id: "s_parent", parentSessionId: null }, { ownsSession: false, isDescendant: false }],
  ] as const;
  for (const principal of [orchestrator, worker]) {
    for (const [target, facts] of targets) {
      assert.deepEqual(sessionCommandPermissions(principal, target, facts).gitActions, { allowed: false, reason: AGENT_ROUTE },
        "no agent credential's allowlist reaches the Git route, for its own session or a descendant");
    }
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
  const viewerRead = await read("viewer", "s_shared");
  for (const command of ["archive", "unarchive", "prompt", "delete", ...LATER_COMMANDS, ...ISSUE_COMMANDS] as const) {
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
