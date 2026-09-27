import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ORCHESTRATOR_DEFAULTS,
  PROTOCOL_VERSION,
  WOLLIPOG_AGENT_ACTOR_SESSION_HEADER,
  queueHoldRecoveryAction,
  worktreeRecoveryAction,
  type SessionHoldView,
  type SessionQueueHoldView,
  type WorktreeRecoveryView,
} from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";

/** Each tool hold advice can name, with the route that serves it and a request that reaches the
 * route's authorization. A route admits a credential when it answers anything but 401, 403 or 404:
 * the runner is offline in this fixture, so an admitted request stops there. */
const TOOLS = {
  stop_background_job: { named: /stop_background_job/u, path: (id: string) => `/api/sessions/${id}/background-jobs/job-1/stop` },
  select_worktree: { named: /select_worktree/u, path: (id: string) => `/api/sessions/${id}/worktrees/select`, body: { path: "/w/any" } },
  create_worktree: { named: /create_worktree/u, path: (id: string) => `/api/sessions/${id}/worktrees`, body: { branch: "fix/any" } },
  // Restarting is named by the recommendation (restart_session) and by the warning against it.
  restart_session: { named: /restart/iu, path: (id: string) => `/api/sessions/${id}/restart`, body: {} },
} as const;
type Tool = keyof typeof TOOLS;

const QUEUE_HOLD_STOPPABLE: SessionQueueHoldView = {
  kind: "worktree_rebind", holdId: "qh-stoppable", since: 10, target: "/w/next", queuedPrompts: 1,
  unfinishedBackgroundJobs: 1, canStopJobs: true, restartKeepsQueue: true,
};
/** No bound and no single-job stop, so restarting is the recommended way out. */
const QUEUE_HOLD_RESTART_ONLY: SessionQueueHoldView = {
  kind: "provider_account_switch", holdId: "qh-restart", since: 10, target: "work account", queuedPrompts: 2,
  unfinishedBackgroundJobs: 1, oldestUnfinishedJob: { launchType: "monitor", startedAt: 5 },
};
const WORKTREE_RECOVERY: WorktreeRecoveryView = {
  recoveryId: "wr-1", detectedAt: 10, selectedPath: "/w/child", expectedBranch: "fix/child", detail: "branch switched",
};

test("hold advice an agent credential reads names exactly the tools its routes admit (#1863)", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hold-advice-route-"));
  const database = join(root, "control-plane.db");
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((done) => listener.close(() => done()));

  // worker ─┬─ worker-queue  (restart-only queue hold)
  //         └─ worker-wt     (worktree recovery)
  // orch ───┬─ orch-queue    (stoppable queue hold)
  //         ├─ orch-wt       (worktree recovery)
  //         └─ orch-mid ── orch-grand (stoppable queue hold)
  const sessions: Array<[id: string, parent: string | undefined, orchestrator: boolean]> = [
    ["worker", undefined, false], ["worker-queue", "worker", false], ["worker-wt", "worker", false],
    ["orch", undefined, true], ["orch-queue", "orch", false], ["orch-wt", "orch", false],
    ["orch-mid", "orch", false], ["orch-grand", "orch-mid", false],
  ];
  const seed = ControlPlaneDb.open(database);
  try {
    const local = seed.localIdentityContext();
    seed.registerRunner({ runnerId: "r", hostname: "test", os: "linux", version: "test", agents: [], workspaces: [] }, 1, PROTOCOL_VERSION);
    for (const [id, parentSessionId, orchestrator] of sessions) {
      seed.createSession({ id, parentSessionId, runnerId: "r", workspaceId: null, agentId: null, title: id,
        useWorktree: false, driver: "codex", config: orchestrator ? { permissionMode: "orchestrator" } : {},
        ...(orchestrator ? {
          orchestratorPolicy: resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default",
            { execution: { strictProjectIsolation: false } }),
        } : {}),
        scope: { organizationId: local.organizationId, owner: { kind: "user", userId: local.userId } }, now: 2 });
    }
  } finally { seed.close(); }
  // The holds as the runner reports them, stored the way a session snapshot stores them.
  const raw = new DatabaseSync(database);
  try {
    const holds: Array<[string, "queue_hold" | "worktree_recovery", unknown]> = [
      ["worker-queue", "queue_hold", QUEUE_HOLD_RESTART_ONLY], ["orch-queue", "queue_hold", QUEUE_HOLD_STOPPABLE],
      ["orch-grand", "queue_hold", QUEUE_HOLD_STOPPABLE],
      ["worker-wt", "worktree_recovery", WORKTREE_RECOVERY], ["orch-wt", "worktree_recovery", WORKTREE_RECOVERY],
    ];
    for (const [id, column, hold] of holds) {
      raw.prepare(`UPDATE sessions SET ${column}=? WHERE id=?`).run(JSON.stringify(hold), id);
    }
  } finally { raw.close(); }

  let logs = "";
  const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: resolve(fileURLToPath(new URL("../../..", import.meta.url))),
    env: { ...process.env, CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(port),
      CONTROL_PLANE_DB: database, CONTROL_PLANE_TOKEN: "hold-advice-fixture-token" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk: unknown) => { logs = (logs + String(chunk)).slice(-8192); };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  try {
    const deadline = Date.now() + 20_000;
    let healthy = false;
    while (Date.now() < deadline) {
      try { if ((await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) { healthy = true; break; } } catch {}
      await delay(50);
    }
    assert.ok(healthy, logs);
    const live = ControlPlaneDb.open(database);
    try {
      for (const [id] of sessions) {
        live.updateSessionStatus(id, "running", Date.now());
        assert.equal(live.setAgentControlCredential(id, "r", hashToken(`token-${id}`), Date.now()), true);
      }
    } finally { live.close(); }

    const call = async (as: string, method: string, path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method, signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer token-${as}`, [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: as,
          ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, json: await response.json() as Record<string, unknown> };
    };
    const adviceFor = async (reader: string, target: string) => {
      const read = await call(reader, "GET", `/api/sessions/${target}`);
      assert.equal(read.status, 200, `${reader} reads ${target}`);
      const holds = (read.json.session as { holds?: SessionHoldView[] }).holds ?? [];
      assert.equal(holds.length, 1, `${target} is held`);
      return holds[0]!.recoveryAction;
    };

    // [reader, target, tools the advice may name for that hold]
    const cases: Array<[string, string, Tool[]]> = [
      ["worker", "worker-queue", ["stop_background_job", "restart_session"]],
      ["worker-queue", "worker-queue", ["stop_background_job", "restart_session"]],
      ["orch", "orch-queue", ["stop_background_job", "restart_session"]],
      ["orch", "orch-grand", ["stop_background_job", "restart_session"]],
      ["orch-mid", "orch-grand", ["stop_background_job", "restart_session"]],
      ["orch-grand", "orch-grand", ["stop_background_job", "restart_session"]],
      ["worker", "worker-wt", ["select_worktree", "create_worktree"]],
      ["worker-wt", "worker-wt", ["select_worktree", "create_worktree"]],
      ["orch", "orch-wt", ["select_worktree", "create_worktree"]],
    ];
    // Every advice is read before any route is probed, since an admitted restart may change a session.
    const advice = new Map<string, string>();
    for (const [reader, target] of cases) advice.set(`${reader}>${target}`, await adviceFor(reader, target));

    const listed = await call("worker", "GET", "/api/sessions");
    const listedHolds = (listed.json.sessions as Array<{ id: string; holds?: SessionHoldView[] }>)
      .find((session) => session.id === "worker-queue")?.holds;
    assert.equal(listedHolds?.[0]?.recoveryAction, advice.get("worker>worker-queue"), "list_sessions writes the same advice");

    const descendants = await call("orch", "GET", "/api/sessions/orch/descendant-requests");
    assert.equal(descendants.status, 200, JSON.stringify(descendants.json));
    const blocked = (descendants.json.blockedChildren ?? []) as Array<{ sessionId: string; holds: SessionHoldView[] }>;
    const blockedAdvice = (id: string) => blocked.find((item) => item.sessionId === id)?.holds[0]?.recoveryAction;
    assert.equal(blockedAdvice("orch-grand"), advice.get("orch>orch-grand"), "list_descendant_requests writes the same advice");
    assert.equal(blockedAdvice("orch-queue"), advice.get("orch>orch-queue"));
    assert.equal(blockedAdvice("orch-wt"), advice.get("orch>orch-wt"));

    // The campaign projection spans every descendant, so a grandchild's advice is written for the
    // Orchestrator there too: through its own route and inside its own session view.
    const campaign = await call("orch", "GET", "/api/sessions/orch/orchestrator-campaign");
    assert.equal(campaign.status, 200, JSON.stringify(campaign.json));
    const ownView = await call("orch", "GET", "/api/sessions/orch");
    const embedded = (ownView.json.session as { orchestratorCampaign?: typeof campaign.json }).orchestratorCampaign;
    for (const projection of [campaign.json, embedded]) {
      const held = (projection?.heldChildren ?? []) as Array<{ sessionId: string; holds: SessionHoldView[] }>;
      assert.deepEqual(held.map((item) => item.sessionId).sort(), ["orch-grand", "orch-queue", "orch-wt"]);
      for (const item of held) {
        assert.equal(item.holds[0]?.recoveryAction, advice.get(`orch>${item.sessionId}`),
          `the campaign's advice for ${item.sessionId} is written for the Orchestrator`);
      }
    }

    const workerRefusal = await call("worker", "POST", "/api/sessions/worker-wt/prompt", { text: "are you there?" });
    assert.equal(workerRefusal.status, 409);
    assert.match(String(workerRefusal.json.error), /switch fix\/child/u, "the branch to restore is still named");
    assert.doesNotMatch(String(workerRefusal.json.error), /select_worktree|create_worktree/u,
      "prompt_session's refusal is written for the worker parent");
    const orchestratorRefusal = await call("orch", "POST", "/api/sessions/orch-wt/prompt", { text: "are you there?" });
    assert.equal(orchestratorRefusal.status, 409);
    assert.match(String(orchestratorRefusal.json.error), /select_worktree/u, "the controlling Orchestrator is told to use it");

    // The controlling Orchestrator reading its direct child may take every action: it reads
    // exactly what the server writes for everyone.
    assert.equal(advice.get("orch>orch-queue"), queueHoldRecoveryAction(QUEUE_HOLD_STOPPABLE));
    assert.equal(advice.get("orch>orch-wt"), worktreeRecoveryAction(WORKTREE_RECOVERY));
    assert.notEqual(advice.get("orch>orch-grand"), queueHoldRecoveryAction(QUEUE_HOLD_STOPPABLE),
      "a grandchild's jobs are not the Orchestrator's to stop");

    const restarts: Array<[string, string]> = [];
    for (const [reader, target, tools] of cases) {
      const text = advice.get(`${reader}>${target}`)!;
      for (const tool of tools) {
        // A restart the route admits may replace the session; probe it last.
        if (tool === "restart_session") { restarts.push([reader, target]); continue; }
        const route = TOOLS[tool];
        const probe = await call(reader, "POST", route.path(target), "body" in route ? route.body : undefined);
        const admitted = ![401, 403, 404].includes(probe.status);
        assert.equal(route.named.test(text), admitted,
          `${reader} reading ${target}: ${tool} is ${admitted ? "admitted" : `refused (${probe.status})`}, and the advice ` +
          `${route.named.test(text) ? "names" : "omits"} it: ${text}`);
      }
    }
    for (const [reader, target] of restarts) {
      const text = advice.get(`${reader}>${target}`)!;
      const probe = await call(reader, "POST", TOOLS.restart_session.path(target), {});
      const admitted = ![401, 403, 404].includes(probe.status);
      assert.equal(TOOLS.restart_session.named.test(text), admitted,
        `${reader} reading ${target}: restart_session is ${admitted ? "admitted" : `refused (${probe.status})`}: ${text}`);
    }
    // The cases above cover both outcomes for every tool.
    assert.match(advice.get("orch>orch-queue")!, /stop_background_job/u);
    assert.doesNotMatch(advice.get("orch>orch-grand")!, /stop_background_job/u);
    assert.match(advice.get("worker>worker-queue")!, /restart_session/u);
    assert.doesNotMatch(advice.get("worker-queue>worker-queue")!, /restart/iu);
    assert.doesNotMatch(advice.get("orch-grand>orch-grand")!, /restart/iu);
    assert.match(advice.get("worker-wt>worker-wt")!, /select_worktree/u);
    assert.doesNotMatch(advice.get("worker>worker-wt")!, /select_worktree/u);
  } finally {
    child.kill();
    await new Promise((done) => child.once("exit", done));
    rmSync(root, { recursive: true, force: true });
  }
});
