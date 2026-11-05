import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PROTOCOL_VERSION, SESSION_EVENT_WIRE_EPOCH_FORMAT_OFFSET, SESSION_EVENT_WIRE_PROJECTION_VARIANTS,
  type RunnerToControlPlane } from "@wollipog/protocol";
import { ControlPlaneDb } from "../../control-plane/src/db.js";
import { Hub } from "../../control-plane/src/hub.js";
import { SessionsService } from "../../control-plane/src/sessions.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";

// A campaign child keeps its concurrency slot until the runner proves its provider retired (#3788).
// A real SessionManager launches the child through a fake provider and feeds its messages to a real
// SessionsService, as the runner socket does. Control-plane history hydration is simulated.

/** The wire epoch a current runner projects for its local log epoch, which the control plane stores. */
const wireEpoch = (localEpoch: number) => SESSION_EVENT_WIRE_EPOCH_FORMAT_OFFSET + localEpoch * SESSION_EVENT_WIRE_PROJECTION_VARIANTS;

type DriverCallbacks = { onEvent(payload: unknown): void; onExit(code: number | null): void };

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "campaign-slot-proof-"));
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner({ runnerId: "r", hostname: "test", os: "linux", version: "test", workspaces: [], agents: [] }, 1, PROTOCOL_VERSION);
  const child = (id: string) => {
    db.createSession({ id, runnerId: "r", workspaceId: null, agentId: "claude", title: id, useWorktree: false, driver: "claude-code",
      config: {}, now: 1, ...(id === "root" ? {} : { parentSessionId: "root" }) });
    db.updateSessionStatus(id, "running", 2);
  };
  child("root");
  db.campaignBudgets.authorize("root", { version: 1, accounting: "managed_workers_only", unpriced: "stop", concurrency: 1 });
  child("worker");
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true; hub.sendToRunner = () => true; hub.sessionChangedById = () => {};
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const statuses: Array<Extract<RunnerToControlPlane, { type: "session_status" }>> = [];
  // The runner's own messages, as its socket delivers them to the control plane.
  const send = (message: RunnerToControlPlane) => {
    if (message.type === "session_status") {
      statuses.push(message);
      svc.onSessionStatus(message.sessionId, message.status, message.detail, message.worktreePath, "r",
        message.controlPlaneLaunchId, message.capacityWait, message.campaignBudgetCheckpoint);
    } else if (message.type === "session_event") {
      svc.onSessionEvent(message.sessionId, message.payload, message.seq, message.ts, "r");
    }
  };
  const drivers: Array<{ callbacks: DriverCallbacks; closes: number; disposed: number }> = [];
  const provider = { disposeFails: false };
  /** A provider whose graceful close never completes, or whose close and disposal both fail without
   * exit proof, so only its exit or shutdown can retire it. */
  const factory = (_kind: unknown, _options: unknown, callbacks: DriverCallbacks) => {
    const driver = { callbacks, closes: 0, disposed: 0 };
    drivers.push(driver);
    return { initialize: async () => {}, newSession: async () => {}, prompt: async () => "end_turn", cancel() {},
      close: () => {
        driver.closes++;
        return provider.disposeFails ? Promise.reject(new Error("close failed")) : new Promise<void>(() => {});
      },
      dispose() { driver.disposed++; if (provider.disposeFails) throw new Error("dispose failed"); },
      setConfig() {}, resolvePermission: () => false, agentSessionId: () => "conversation" };
  };
  const manager = (store = new SessionStore(dir)) =>
    new SessionManager(send, () => {}, store, "r", undefined, factory as never, dir, 1);
  const launch = async (runner: SessionManager) => {
    assert.equal(await runner.start({ sessionId: "worker", agentId: "claude", workspaceId: "w", workspacePath: dir,
      driver: "claude-code", command: "claude", args: [], env: {}, context: { kind: "native" }, useWorktree: false,
      campaignBudgetDispatch: db.campaignBudgets.dispatch("worker") }), true, "the child launches");
    return drivers.at(-1)!;
  };
  const occupied = () => db.campaignBudgets.view("root")!.occupied;
  const refused = (message: string) => assert.throws(() => child("replacement"), /concurrency allowance reached/u, message);
  /** The control plane hydrates the child's history through `throughSeq`, then reads its campaign. */
  const hydrate = (localEpoch: number, throughSeq: number) => {
    db.reconcileRunnerHistory("worker", wireEpoch(localEpoch), throughSeq);
    db.setHydratedSeq("worker", throughSeq);
    return db.campaignBudgets.view("root")!;
  };
  const settlements = () => db.raw().prepare("SELECT cost FROM campaign_budget_settlements WHERE session_id='worker'")
    .all().map((row) => ({ ...row }));
  return { dir, db, svc, statuses, provider, manager, launch, occupied, refused, child, hydrate, settlements,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("a provider that exits by itself frees its campaign slot once the runner reports it, and its spend settles once (#3788)", async () => {
  const h = harness();
  const runner = h.manager();
  try {
    const provider = await h.launch(runner);
    provider.callbacks.onEvent({ kind: "token_usage", model: "claude-opus-5-5", inputTokens: 1, costUsd: 0.4 });
    assert.equal(h.occupied(), 1, "a running provider holds its slot");
    h.refused("so no replacement runs beside it");

    provider.callbacks.onExit(3);
    const failed = h.statuses.at(-1)!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.detail, "agent exited 3");
    assert.ok(failed.campaignBudgetCheckpoint, "the exit report carries the final checkpoint");
    assert.equal(failed.campaignBudgetCheckpoint.costUsd, 0.4);
    assert.equal(h.occupied(), 0, "the exit frees the slot without a history reload");
    assert.equal(h.db.campaignBudgets.active("worker"), true, "its final usage stays pending until its history settles");
    assert.deepEqual(h.settlements(), []);
    h.child("replacement");
    assert.equal(h.occupied(), 1, "a replacement is admitted");

    const view = h.hydrate(failed.campaignBudgetCheckpoint.historyEpoch, failed.campaignBudgetCheckpoint.throughSeq);
    assert.deepEqual(h.settlements(), [{ cost: 0.4 }], "the spend settles from the durable checkpoint");
    assert.equal(view.actual.costUsd, 0.4);
    assert.equal(h.hydrate(failed.campaignBudgetCheckpoint.historyEpoch, failed.campaignBudgetCheckpoint.throughSeq).actual.costUsd, 0.4,
      "repeated reads count it once");
    assert.deepEqual(h.settlements(), [{ cost: 0.4 }]);
  } finally { runner.shutdownAll(); h.cleanup(); }
});

test("a Stop a runner shutdown interrupts keeps its campaign slot until a restarted runner proves the provider retired (#3788)", async () => {
  for (const proven of [false, true]) {
    const h = harness();
    let restarted: SessionManager | undefined;
    try {
      const first = h.manager();
      const provider = await h.launch(first);
      provider.callbacks.onEvent({ kind: "token_usage", model: "claude-opus-5-5", inputTokens: 1, costUsd: 0.7 });
      assert.ok(h.svc.stop("worker").ok);
      first.stop("worker");
      assert.equal(provider.closes, 1, "the Stop is closing the provider");
      assert.equal(h.db.getSession("worker")!.status, "stopped", "the runner has already reported the stop");
      assert.equal(h.db.hasSessionStopIntent("worker"), false, "and the control plane has confirmed it");
      assert.equal(h.occupied(), 1, "a closing provider keeps its slot");
      h.refused("so no replacement runs beside it");

      // The runner shuts down before the close completes. Shutdown disposes the provider; only
      // the reaping it then waits for proves the provider's process tree gone.
      assert.equal(first.shutdownAll(), true);
      assert.equal(provider.disposed, 1);
      first.recordShutdownRetirementCheckpoints(proven);
      assert.equal(h.statuses.some((status) => status.campaignBudgetCheckpoint), false, "a shutting-down runner reports nothing");
      assert.equal(h.occupied(), 1);

      // The runner restarts and reconnects: its inventory still holds the stopped child, and the
      // control plane redelivers the child's allocation.
      restarted = h.manager();
      await h.svc.hydrateRunnerSessionsCooperatively("r", restarted.registrationSessionSnapshots(), { isCurrent: () => true });
      const dispatch = h.db.campaignBudgets.dispatch("worker");
      restarted.rearmGovernance("worker", {}, undefined, dispatch);
      if (!proven) {
        assert.equal(h.occupied(), 1, "without proof that the provider retired, the slot stays held");
        h.refused("and a replacement is still refused");
        assert.equal(h.statuses.some((status) => status.campaignBudgetCheckpoint), false, "no final checkpoint is attested");
        assert.equal(h.db.campaignBudgets.active("worker"), true, "the reservation stays outstanding");
        continue;
      }
      assert.equal(h.occupied(), 0, "the restarted runner's proof frees the slot without a history reload");
      assert.equal(h.db.campaignBudgets.active("worker"), true, "its final usage stays pending until its history settles");
      h.child("replacement");
      assert.equal(h.occupied(), 1, "a replacement is admitted");

      const checkpoint = restarted.snapshotForControlPlane(new SessionStore(h.dir).readMeta("worker")!).campaignBudgetCheckpoint!;
      assert.equal(checkpoint.generation, dispatch!.generation, "the proof names the child's current generation");
      assert.equal(checkpoint.costUsd, 0.7);
      const view = h.hydrate(checkpoint.historyEpoch, checkpoint.throughSeq);
      assert.deepEqual(h.settlements(), [{ cost: 0.7 }], "the spend settles from the durable checkpoint");
      assert.equal(view.actual.costUsd, 0.7);
      restarted.rearmGovernance("worker", {}, undefined, dispatch);
      assert.equal(h.hydrate(checkpoint.historyEpoch, checkpoint.throughSeq).actual.costUsd, 0.7, "a later redelivery counts it once");
      assert.deepEqual(h.settlements(), [{ cost: 0.7 }]);
    } finally { restarted?.shutdownAll(); h.cleanup(); }
  }
});

test("an unconfirmed retirement keeps its slot until the provider's exit proves it (#3788)", async () => {
  const h = harness();
  h.provider.disposeFails = true;
  const runner = h.manager();
  try {
    const provider = await h.launch(runner);
    assert.ok(h.svc.stop("worker").ok);
    runner.stop("worker");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((runner as any).closing.get("worker")?.unconfirmed, true, "the close and dispose failed without exit proof");
    // A late allocation redelivery must not attest a provider whose retirement is unconfirmed.
    runner.rearmGovernance("worker", {}, undefined, h.db.campaignBudgets.dispatch("worker"));
    assert.equal(h.statuses.some((status) => status.campaignBudgetCheckpoint), false);
    assert.equal(h.occupied(), 1);
    h.refused("an unconfirmed retirement keeps its slot");
    provider.callbacks.onExit(0);
    assert.ok(h.statuses.at(-1)!.campaignBudgetCheckpoint, "the exit retires the provider");
    assert.equal(h.occupied(), 0);
    h.child("replacement");
  } finally { runner.shutdownAll(); h.cleanup(); }
});
