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
import { publishNegotiatedSessionSnapshots } from "./control-plane-transport.js";
import type { LeaseProcessProbe } from "./provider-home-lease-evidence.js";
import { leaseRetirementProcessProof, SessionManager, type RetirementProcessProof } from "./session-manager.js";
import { SessionStore } from "./session-store.js";

/** Runner processes of the simulated host, by pid: each records its own evidence with the fences
 * it sets, and a later one proves an earlier one gone only once the test marks it gone (#4256). */
function host() {
  const gone = new Set<number>();
  const asked: number[] = [];
  const runner = (pid: number, bootId = "00000000-0000-4000-8000-000000000000"): RetirementProcessProof => ({
    current: () => ({ pid, process: { bootId, startTime: "100", marker: "a".repeat(32) } }),
    abandoned: (earlier) => { asked.push(earlier.pid); return gone.has(earlier.pid); },
  });
  return { gone, asked, runner };
}

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
    } else if (message.type === "session_runtime_updated") {
      svc.applySessionRuntimeUpdate("r", message.snapshot);
    }
  };
  /** A restarted runner registers its inventory, then republishes it in the negotiated protocol. */
  const reconnect = async (runner: SessionManager) => {
    await svc.hydrateRunnerSessionsCooperatively("r", runner.registrationSessionSnapshots(), { isCurrent: () => true });
    publishNegotiatedSessionSnapshots(runner, send);
  };
  type FakeDriver = { callbacks: DriverCallbacks; closes: number; disposed: number; proofs: boolean[];
    treeGone(proven: boolean): void; finishClose(): void };
  const drivers: FakeDriver[] = [];
  const provider = { disposeFails: false };
  /** A provider whose graceful close completes only when the test says so, or whose close and
   * disposal both fail without exit proof. Once it is disposed or has exited, the test decides when,
   * and whether, its whole process tree is proven gone; `proofs` records each proof's `terminate`. */
  const factory = (_kind: unknown, _options: unknown, callbacks: DriverCallbacks) => {
    let treeGone!: (proven: boolean) => void;
    const tree = new Promise<boolean>((resolve) => { treeGone = resolve; });
    let finishClose!: () => void;
    const closed = new Promise<void>((resolve) => { finishClose = resolve; });
    const driver: FakeDriver = { callbacks, closes: 0, disposed: 0, proofs: [], treeGone, finishClose };
    drivers.push(driver);
    return { initialize: async () => {}, newSession: async () => {}, prompt: async () => "end_turn", cancel() {},
      close: () => {
        driver.closes++;
        return provider.disposeFails ? Promise.reject(new Error("close failed")) : closed;
      },
      dispose() { driver.disposed++; if (provider.disposeFails) throw new Error("dispose failed"); },
      proveProcessTreeExit: ({ terminate }: { terminate: boolean }) => { driver.proofs.push(terminate); return tree; },
      setConfig() {}, resolvePermission: () => false, agentSessionId: () => "conversation" };
  };
  const manager = (store = new SessionStore(dir), proof?: RetirementProcessProof) => {
    const runner = new SessionManager(send, () => {}, store, "r", undefined, factory as never, dir, 1);
    if (proof) runner.setRetirementProcessProof(proof);
    return runner;
  };
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
  return { dir, db, svc, statuses, provider, manager, reconnect, launch, occupied, refused, child, hydrate, settlements,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("a provider that exits by itself frees its campaign slot once its process tree is proven gone, and its spend settles once (#3788)", async () => {
  for (const treeProven of [true, false]) {
    const h = harness();
    const runner = h.manager();
    let restarted: SessionManager | undefined;
    try {
      const provider = await h.launch(runner);
      provider.callbacks.onEvent({ kind: "token_usage", model: "claude-opus-5-5", inputTokens: 1, costUsd: 0.4 });
      assert.equal(h.occupied(), 1, "a running provider holds its slot");
      h.refused("so no replacement runs beside it");

      provider.callbacks.onExit(3);
      const failed = h.statuses.at(-1)!;
      assert.equal(failed.status, "failed");
      assert.equal(failed.detail, "agent exited 3");
      assert.equal(failed.campaignBudgetCheckpoint, undefined, "a descendant of the exited root may still run");
      assert.equal(h.occupied(), 1);
      h.refused("so the slot stays held until the whole tree is proven gone");
      // A late allocation redelivery cannot attest it meanwhile.
      runner.rearmGovernance("worker", {}, undefined, h.db.campaignBudgets.dispatch("worker"));
      assert.equal(h.occupied(), 1);

      provider.treeGone(treeProven);
      await new Promise((resolve) => setImmediate(resolve));
      let checkpoint = h.statuses.at(-1)!.campaignBudgetCheckpoint;
      if (!treeProven) {
        assert.equal(checkpoint, undefined, "a tree not proven gone keeps the slot");
        assert.equal(h.occupied(), 1);
        h.refused("and a replacement is still refused");
        // Shutdown reaps every process tree, which proves it; the restarted runner delivers the proof.
        assert.equal(runner.shutdownAll(), true);
        runner.recordShutdownRetirementCheckpoints(true);
        assert.equal(h.occupied(), 1, "nothing is released before the restart");
        restarted = h.manager();
        await h.reconnect(restarted);
        checkpoint = restarted.snapshotForControlPlane(new SessionStore(h.dir).readMeta("worker")!).campaignBudgetCheckpoint;
      }
      assert.ok(checkpoint, "the proof carries the final checkpoint");
      assert.equal(checkpoint.costUsd, 0.4);
      assert.equal(h.occupied(), 0, "the proof frees the slot without a history reload");
      if (treeProven) {
        assert.equal(h.db.campaignBudgets.active("worker"), true, "its final usage stays pending until its history settles");
        assert.deepEqual(h.settlements(), []);
      } else {
        assert.deepEqual(h.settlements(), [{ cost: 0.4 }], "the reconnect matched the history it already holds, so it settled once");
      }
      h.child("replacement");
      assert.equal(h.occupied(), 1, "a replacement is admitted");

      const view = h.hydrate(checkpoint.historyEpoch, checkpoint.throughSeq);
      assert.deepEqual(h.settlements(), [{ cost: 0.4 }], "the spend settles from the durable checkpoint");
      assert.equal(view.actual.costUsd, 0.4);
      assert.equal(h.hydrate(checkpoint.historyEpoch, checkpoint.throughSeq).actual.costUsd, 0.4, "repeated reads count it once");
      assert.deepEqual(h.settlements(), [{ cost: 0.4 }]);
    } finally { runner.shutdownAll(); restarted?.shutdownAll(); h.cleanup(); }
  }
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
      await h.reconnect(restarted);
      const dispatch = h.db.campaignBudgets.dispatch("worker");
      assert.equal(h.occupied(), proven ? 0 : 1, "the negotiated snapshots carry the stored proof, and only it");
      restarted.rearmGovernance("worker", {}, undefined, dispatch);
      if (!proven) {
        assert.equal(h.occupied(), 1, "without proof that the provider retired, the slot stays held");
        h.refused("and a replacement is still refused");
        assert.equal(h.statuses.some((status) => status.campaignBudgetCheckpoint), false, "no final checkpoint is attested");
        assert.equal(h.db.campaignBudgets.active("worker"), true, "the reservation stays outstanding");
        continue;
      }
      assert.equal(h.occupied(), 0, "the restarted runner's proof frees the slot without a history reload");
      assert.deepEqual(h.settlements(), [{ cost: 0.7 }], "the reconnect matched the history it already holds, so it settled once");
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
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((runner as any).closing.has("worker"), false, "the root's exit ends the retirement");
    // Its disposal threw, so only the non-killing proof after its own exit can prove its tree gone (#4257).
    assert.deepEqual(provider.proofs, [false]);
    assert.equal(h.statuses.some((status) => status.campaignBudgetCheckpoint), false, "a descendant may outlive the root");
    assert.equal(h.occupied(), 1);
    h.refused("so the slot stays held until the tree is proven gone");
    provider.treeGone(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(h.statuses.at(-1)!.campaignBudgetCheckpoint, "the tree proof retires the provider");
    assert.equal(h.occupied(), 0);
    h.child("replacement");
  } finally { runner.shutdownAll(); h.cleanup(); }
});

test("a Stop releases its campaign slot only once the disposed provider's whole tree is proven gone (#4257)", async () => {
  // The provider's graceful close completes, or its root exits while it closes; either way a
  // descendant can outlive the root, so only the exact driver's killing proof after disposal frees the slot.
  for (const completion of ["close", "root exit"] as const) {
    for (const treeProven of [true, false]) {
      const what = `${completion}, tree ${treeProven ? "proven" : "not proven"}`;
      const h = harness();
      const runner = h.manager();
      let restarted: SessionManager | undefined;
      const settle = () => new Promise((resolve) => setImmediate(resolve));
      try {
        const provider = await h.launch(runner);
        provider.callbacks.onEvent({ kind: "token_usage", model: "claude-opus-5-5", inputTokens: 1, costUsd: 0.5 });
        assert.ok(h.svc.stop("worker").ok);
        runner.stop("worker");
        assert.equal(h.db.getSession("worker")!.status, "stopped", `${what}: the runner has reported the stop`);
        assert.equal(h.occupied(), 1);

        if (completion === "root exit") {
          provider.callbacks.onExit(0);
          await settle();
          assert.equal((runner as any).closing.has("worker"), false, `${what}: the root's exit ends the retirement`);
          assert.deepEqual(provider.proofs, [], `${what}: no proof is taken before the provider is disposed`);
          assert.equal(h.occupied(), 1, `${what}: a descendant may outlive the root`);
          h.refused(`${what}: so no replacement runs beside it`);
        }
        provider.finishClose();
        await settle();
        assert.equal(provider.disposed, 1, `${what}: the close is followed by disposal`);
        assert.equal((runner as any).closing.has("worker"), false);
        // Each proof is the killing one (the provider-HOME settlement takes its own; drivers memoize it).
        assert.ok(provider.proofs.length > 0 && provider.proofs.every(Boolean), `${what}: the killing proof follows disposal`);
        assert.equal(h.statuses.some((status) => status.campaignBudgetCheckpoint), false, `${what}: nothing is attested yet`);
        assert.equal(h.occupied(), 1, `${what}: the slot stays held while the proof is pending`);
        h.refused(`${what}: and a replacement is refused`);
        // A late allocation redelivery cannot attest it meanwhile.
        runner.rearmGovernance("worker", {}, undefined, h.db.campaignBudgets.dispatch("worker"));
        assert.equal(h.occupied(), 1, `${what}: nor can an allocation redelivery`);

        provider.treeGone(treeProven);
        await settle();
        let checkpoint = h.statuses.at(-1)!.campaignBudgetCheckpoint;
        if (!treeProven) {
          assert.equal(checkpoint, undefined, `${what}: a tree not proven gone keeps the slot`);
          assert.equal(h.occupied(), 1);
          h.refused(`${what}: and a replacement is still refused`);
          runner.rearmGovernance("worker", {}, undefined, h.db.campaignBudgets.dispatch("worker"));
          assert.equal(h.occupied(), 1, `${what}: even after an allocation redelivery`);
          assert.equal(h.db.campaignBudgets.active("worker"), true, `${what}: the reservation stays outstanding`);
          // A shutdown that reaps every process tree proves it; the restarted runner delivers the proof.
          assert.equal(runner.shutdownAll(), true);
          runner.recordShutdownRetirementCheckpoints(true);
          assert.equal(h.occupied(), 1, `${what}: nothing is released before the restart`);
          restarted = h.manager();
          await h.reconnect(restarted);
          checkpoint = restarted.snapshotForControlPlane(new SessionStore(h.dir).readMeta("worker")!).campaignBudgetCheckpoint;
        }
        assert.ok(checkpoint, `${what}: the proof carries the final checkpoint`);
        assert.equal(checkpoint.costUsd, 0.5);
        assert.equal(checkpoint.generation, h.db.campaignBudgets.dispatch("worker")!.generation);
        assert.equal(h.occupied(), 0, `${what}: the proof frees the slot without a history reload`);
        h.child("replacement");
        assert.equal(h.occupied(), 1, `${what}: a replacement is admitted`);

        const view = h.hydrate(checkpoint.historyEpoch, checkpoint.throughSeq);
        assert.deepEqual(h.settlements(), [{ cost: 0.5 }], `${what}: the spend settles from the durable checkpoint`);
        assert.equal(view.actual.costUsd, 0.5);
        (restarted ?? runner).rearmGovernance("worker", {}, undefined, h.db.campaignBudgets.dispatch("worker"));
        assert.equal(h.hydrate(checkpoint.historyEpoch, checkpoint.throughSeq).actual.costUsd, 0.5, `${what}: counted once`);
        assert.deepEqual(h.settlements(), [{ cost: 0.5 }]);
      } finally { runner.shutdownAll(); restarted?.shutdownAll(); h.cleanup(); }
    }
  }
});

test("a Stop whose tree proof is pending when the runner shuts down is decided by the shutdown's reaping (#4257)", async () => {
  for (const reaped of [false, true]) {
    const h = harness();
    let restarted: SessionManager | undefined;
    try {
      const first = h.manager();
      const provider = await h.launch(first);
      assert.ok(h.svc.stop("worker").ok);
      first.stop("worker");
      provider.finishClose();
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(provider.proofs.length > 0 && provider.proofs.every(Boolean), "the killing tree proof is pending");
      assert.equal(first.shutdownAll(), true);
      first.recordShutdownRetirementCheckpoints(reaped);
      // The proof that lands after shutdown began decides nothing; the reaping does.
      provider.treeGone(true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(h.statuses.some((status) => status.campaignBudgetCheckpoint), false, "a shutting-down runner reports nothing");
      restarted = h.manager();
      await h.reconnect(restarted);
      assert.equal(h.occupied(), reaped ? 0 : 1, "only a reaping shutdown's stored proof frees the slot");
      if (reaped) h.child("replacement");
      else h.refused("an unproven shutdown keeps it");
    } finally { restarted?.shutdownAll(); h.cleanup(); }
  }
});

test("each exited provider of one campaign generation must be proven gone before the slot is released (#3788)", async () => {
  for (const proofs of [["first", "second"], ["second", "first"], ["second-only"]] as const) {
    const h = harness();
    const runner = h.manager();
    try {
      // The first provider exits; the session resumes under the same generation and exits again.
      const first = await h.launch(runner);
      first.callbacks.onExit(3);
      const second = await h.launch(runner);
      second.callbacks.onExit(3);
      const providers = { first, second };
      const settle = () => new Promise((resolve) => setImmediate(resolve));
      if (proofs[0] === "second-only") {
        first.treeGone(false);
        second.treeGone(true);
        await settle();
        assert.equal(h.statuses.some((status) => status.campaignBudgetCheckpoint), false, "the first provider's tree may still run");
        assert.equal(h.occupied(), 1);
        h.refused("so the slot stays held");
        continue;
      }
      providers[proofs[0]].treeGone(true);
      await settle();
      assert.equal(h.statuses.some((status) => status.campaignBudgetCheckpoint), false, `${proofs[0]} alone proves nothing`);
      assert.equal(h.occupied(), 1);
      h.refused("the other provider's tree may still run");
      providers[proofs[1]].treeGone(true);
      await settle();
      assert.ok(h.statuses.at(-1)!.campaignBudgetCheckpoint, "both proofs release the slot");
      assert.equal(h.occupied(), 0);
      h.child("replacement");
    } finally { runner.shutdownAll(); h.cleanup(); }
  }
});

test("a fence an earlier runner process left is never lifted by a later process's proofs (#3788)", async () => {
  const h = harness();
  let restarted: SessionManager | undefined;
  try {
    const first = h.manager();
    await h.launch(first);
    assert.ok(h.svc.stop("worker").ok);
    first.stop("worker");
    assert.equal(first.shutdownAll(), true);
    first.recordShutdownRetirementCheckpoints(false);

    // The restarted runner resumes the session under the same generation, and that provider exits
    // with its own tree proven gone. The interrupted retirement's provider is still unproven.
    restarted = h.manager();
    await h.reconnect(restarted);
    const resumed = await h.launch(restarted);
    resumed.callbacks.onExit(3);
    resumed.treeGone(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.statuses.some((status) => status.campaignBudgetCheckpoint), false);
    assert.equal(h.occupied(), 1, "the earlier process's provider may still run");
    h.refused("so a replacement is refused");
    // Even a reaping shutdown of the later process proves nothing about the earlier one.
    assert.equal(restarted.shutdownAll(), true);
    restarted.recordShutdownRetirementCheckpoints(true);
    const meta = new SessionStore(h.dir).readMeta("worker")!;
    assert.equal(meta.retiringProviderGeneration, h.db.campaignBudgets.dispatch("worker")!.generation, "the fence stays");
    assert.equal(h.manager().snapshotForControlPlane(meta).campaignBudgetCheckpoint, undefined);
  } finally { restarted?.shutdownAll(); h.cleanup(); }
});

test("an exit proof that lands while a same-generation relaunch waits to write its metadata stays lifted (#3788)", async () => {
  const h = harness();
  const runner = h.manager();
  try {
    const first = await h.launch(runner);
    first.callbacks.onExit(3);
    // Worktree operations hold the session. The relaunch queues a workspace check before it builds
    // its metadata and the metadata write after it, so a second hold lets the check through and
    // stops the write.
    const operations = () => (runner as any).worktreeOperations.get("worker");
    const hold = () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const done = (runner as any).runWorktreeOperation("worker", () => gate);
      return { done, release, queued: operations() };
    };
    const queuedBehind = async (queued: unknown, what: string) => {
      for (let turn = 0; operations() === queued; turn++) {
        assert.ok(turn < 1_000, what);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    };
    const check = hold();
    const relaunch = h.launch(runner);
    await queuedBehind(check.queued, "the relaunch queues its workspace check");
    const write = hold();
    check.release();
    await check.done;
    // The relaunch has built its metadata, with the fence still in place, and queued the write.
    await queuedBehind(write.queued, "the relaunch queues its metadata write");
    first.treeGone(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(new SessionStore(h.dir).readMeta("worker")!.retiringProviderGeneration, undefined, "the first provider is proven gone");
    write.release();
    await write.done;
    const second = await relaunch;
    assert.equal(new SessionStore(h.dir).readMeta("worker")!.retiringProviderGeneration, undefined, "the relaunch does not restore the fence");

    second.callbacks.onExit(3);
    second.treeGone(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(h.statuses.at(-1)!.campaignBudgetCheckpoint, "the relaunched provider's proof is not mistaken for an inherited fence");
    assert.equal(new SessionStore(h.dir).readMeta("worker")!.retiringProviderGeneration, undefined);
    assert.equal(h.occupied(), 0);
  } finally { runner.shutdownAll(); h.cleanup(); }
});

test("a restarted runner that proves the earlier runner gone releases the slot it left held (#4256)", async () => {
  // The earlier runner crashes while the Stop closes its provider, or shuts down without proving
  // its process trees reaped. Either way it never reports the child's final checkpoint.
  for (const ending of ["crash", "unproven shutdown"] as const) {
    for (const provenAtStartup of [true, false]) {
      const what = `${ending}, ${provenAtStartup ? "proven at startup" : "proven later"}`;
      const h = harness();
      const machine = host();
      const first = h.manager(undefined, machine.runner(1001));
      let restarted: SessionManager | undefined;
      try {
        const provider = await h.launch(first);
        provider.callbacks.onEvent({ kind: "token_usage", model: "claude-opus-5-5", inputTokens: 1, costUsd: 0.6 });
        assert.ok(h.svc.stop("worker").ok);
        first.stop("worker");
        assert.deepEqual(new SessionStore(h.dir).readMeta("worker")!.retiringProviderRunners?.map((runner) => runner.pid), [1001],
          `${what}: the fence records the runner process that set it`);
        if (ending === "unproven shutdown") {
          assert.equal(first.shutdownAll(), true);
          first.recordShutdownRetirementCheckpoints(false);
        }
        assert.equal(h.statuses.some((status) => status.campaignBudgetCheckpoint), false);

        if (provenAtStartup) machine.gone.add(1001);
        restarted = h.manager(undefined, machine.runner(1002));
        restarted.reconcileStore();
        await h.reconnect(restarted);
        const dispatch = h.db.campaignBudgets.dispatch("worker")!;
        restarted.rearmGovernance("worker", {}, undefined, dispatch);
        if (!provenAtStartup) {
          assert.equal(h.occupied(), 1, `${what}: without proof the slot stays held`);
          h.refused(`${what}: and a replacement is refused, even after an allocation redelivery`);
          assert.equal(h.statuses.some((status) => status.campaignBudgetCheckpoint), false);
          assert.equal(h.db.campaignBudgets.active("worker"), true, `${what}: the reservation stays outstanding`);
          // Retries repeat the same proof; time alone proves nothing.
          assert.equal(restarted.proveEarlierRunnerRetirements(true), true, `${what}: still unproven`);
          assert.equal(h.occupied(), 1);
          machine.gone.add(1001);
          assert.equal(restarted.proveEarlierRunnerRetirements(true), false, `${what}: the retry proves it`);
          assert.ok(h.statuses.at(-1)!.campaignBudgetCheckpoint, `${what}: and reports the final checkpoint at once`);
        }
        const meta = new SessionStore(h.dir).readMeta("worker")!;
        assert.equal(meta.retiringProviderGeneration, undefined, `${what}: the fence is lifted`);
        assert.equal(meta.retiringProviderRunners, undefined);
        const checkpoint = restarted.snapshotForControlPlane(meta).campaignBudgetCheckpoint!;
        assert.ok(checkpoint, `${what}: the snapshot carries the final checkpoint`);
        assert.equal(checkpoint.generation, dispatch.generation);
        assert.equal(checkpoint.costUsd, 0.6);
        assert.equal(h.occupied(), 0, `${what}: the proof frees the slot without a history reload`);
        h.child("replacement");
        assert.equal(h.occupied(), 1, `${what}: a replacement is admitted`);

        const view = h.hydrate(checkpoint.historyEpoch, checkpoint.throughSeq);
        assert.deepEqual(h.settlements(), [{ cost: 0.6 }], `${what}: the spend settles from the durable checkpoint`);
        assert.equal(view.actual.costUsd, 0.6);
        restarted.rearmGovernance("worker", {}, undefined, dispatch);
        assert.equal(h.hydrate(checkpoint.historyEpoch, checkpoint.throughSeq).actual.costUsd, 0.6, `${what}: counted once`);
        assert.deepEqual(h.settlements(), [{ cost: 0.6 }]);
      } finally { first.shutdownAll(); restarted?.shutdownAll(); h.cleanup(); }
    }
  }
});

test("an earlier runner proven gone after a same-generation relaunch hands the fence to the relaunched provider (#4256)", async () => {
  const h = harness();
  const machine = host();
  const first = h.manager(undefined, machine.runner(1001));
  let restarted: SessionManager | undefined;
  try {
    await h.launch(first);
    assert.ok(h.svc.stop("worker").ok);
    first.stop("worker");
    // Crash. The restarted runner cannot prove the earlier one gone and relaunches the session.
    restarted = h.manager(undefined, machine.runner(1002));
    restarted.reconcileStore();
    await h.reconnect(restarted);
    const resumed = await h.launch(restarted);
    resumed.callbacks.onExit(3);
    machine.gone.add(1001);
    assert.equal(restarted.proveEarlierRunnerRetirements(true), false, "the earlier runner is proven gone");
    assert.deepEqual(new SessionStore(h.dir).readMeta("worker")!.retiringProviderRunners?.map((runner) => runner.pid), [1002],
      "the fence now belongs to the relaunched provider's own retirement");
    assert.equal(h.statuses.some((status) => status.campaignBudgetCheckpoint), false, "whose tree may still run");
    assert.equal(h.occupied(), 1);
    h.refused("so a replacement is refused");
    resumed.treeGone(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(h.statuses.at(-1)!.campaignBudgetCheckpoint, "its own proof then releases the slot");
    assert.equal(h.occupied(), 0);
    h.child("replacement");
  } finally { first.shutdownAll(); restarted?.shutdownAll(); h.cleanup(); }
});

test("a fence recorded without process evidence is never lifted by a later runner process (#4256)", async () => {
  const h = harness();
  const machine = host();
  const first = h.manager(undefined, { current: () => undefined, abandoned: () => true });
  let restarted: SessionManager | undefined;
  try {
    await h.launch(first);
    assert.ok(h.svc.stop("worker").ok);
    first.stop("worker");
    restarted = h.manager(undefined, machine.runner(1002));
    restarted.reconcileStore();
    await h.reconnect(restarted);
    assert.equal(restarted.proveEarlierRunnerRetirements(true), false, "there is nothing to prove it with");
    assert.ok(new SessionStore(h.dir).readMeta("worker")!.retiringProviderGeneration, "so the fence stays");
    assert.equal(h.occupied(), 1);
    h.refused("and a replacement is refused");
  } finally { first.shutdownAll(); restarted?.shutdownAll(); h.cleanup(); }
});

test("every runner that ran a provider of a fenced generation must be proven gone before a later runner lifts the fence (#4256)", async () => {
  const h = harness();
  const machine = host();
  const first = h.manager(undefined, machine.runner(1001));
  let second: SessionManager | undefined;
  let third: SessionManager | undefined;
  try {
    await h.launch(first);
    assert.ok(h.svc.stop("worker").ok);
    first.stop("worker");
    // The first runner crashes. The second cannot prove it gone and relaunches the same generation.
    second = h.manager(undefined, machine.runner(1002));
    second.reconcileStore();
    await h.reconnect(second);
    const resumed = await h.launch(second);
    assert.deepEqual(new SessionStore(h.dir).readMeta("worker")!.retiringProviderRunners?.map((runner) => runner.pid), [1001, 1002],
      "the relaunching runner joins the fence");
    // Its provider exits with its tree unproven, and the second runner crashes too.
    resumed.callbacks.onExit(3);
    machine.gone.add(1001);
    third = h.manager(undefined, machine.runner(1003));
    third.reconcileStore();
    await h.reconnect(third);
    third.rearmGovernance("worker", {}, undefined, h.db.campaignBudgets.dispatch("worker"));
    assert.ok(new SessionStore(h.dir).readMeta("worker")!.retiringProviderGeneration, "proof about the first runner alone lifts nothing");
    assert.equal(h.statuses.some((status) => status.campaignBudgetCheckpoint), false);
    assert.equal(h.occupied(), 1, "the second runner's provider may still run");
    h.refused("so a replacement is refused");
    machine.gone.add(1002);
    assert.equal(third.proveEarlierRunnerRetirements(true), false, "both runners are proven gone");
    assert.ok(h.statuses.at(-1)!.campaignBudgetCheckpoint, "which releases the slot");
    assert.equal(h.occupied(), 0);
    h.child("replacement");
  } finally { first.shutdownAll(); second?.shutdownAll(); third?.shutdownAll(); h.cleanup(); }
});

test("a fence this pid recorded in an earlier boot is proven like any earlier runner's, not taken for this runner's own (#4256)", async () => {
  const h = harness();
  const machine = host();
  const earlierBoot = "00000000-0000-4000-8000-000000000000";
  const first = h.manager(undefined, machine.runner(1001, earlierBoot));
  let restarted: SessionManager | undefined;
  try {
    await h.launch(first);
    assert.ok(h.svc.stop("worker").ok);
    first.stop("worker");
    assert.equal(first.proveEarlierRunnerRetirements(), false, "the runner that set the fence proves its own providers itself");
    assert.deepEqual(machine.asked, []);
    // After a reboot the same pid and start-time tick name a different process.
    machine.gone.add(1001);
    restarted = h.manager(undefined, machine.runner(1001, "11111111-1111-4111-8111-111111111111"));
    restarted.reconcileStore();
    await h.reconnect(restarted);
    assert.deepEqual(machine.asked, [1001], "the earlier boot's runner is proven, not skipped");
    assert.equal(new SessionStore(h.dir).readMeta("worker")!.retiringProviderGeneration, undefined);
    assert.equal(h.occupied(), 0);
    h.child("replacement");
  } finally { first.shutdownAll(); restarted?.shutdownAll(); h.cleanup(); }
});

test("only a reboot or an empty provider cgroup proves an earlier runner gone, never a clean marker scan (#4256)", () => {
  const recordedBoot = "22222222-2222-4222-8222-222222222222";
  let boot = recordedBoot;
  let containment: "empty" | "populated" | "unit_removed" | "unverifiable" = "empty";
  const probe: LeaseProcessProbe = {
    bootId: () => boot,
    // The earlier runner is gone, and no readable process carries its marker.
    startTime: (pid) => pid === process.pid ? "100" : null,
    scan: () => ({ marked: [], uninspectable: [] }),
    containment: () => containment,
  };
  const proof = leaseRetirementProcessProof(probe);
  const runner = (evidence: Record<string, unknown>) => ({ pid: 4242, process: { bootId: recordedBoot, startTime: "100",
    marker: "b".repeat(32), version: 2 as const, containment: evidence as never } });
  const markerOnly = runner({ kind: "marker-parent-links", reason: "cgroup-not-delegated" });
  const contained = runner({ kind: "linux-cgroup-v2", bootId: recordedBoot, mountRoot: "/", cgroupPath: "user.slice/wollipog-providers-x", inode: "42" });
  assert.equal(proof.abandoned(markerOnly), false, "a child that cleared its environment would escape a marker scan");
  assert.equal(proof.abandoned(contained), true, "an empty provider cgroup holds no descendant");
  containment = "populated";
  assert.equal(proof.abandoned(contained), false, "a populated one may");
  containment = "unverifiable";
  assert.equal(proof.abandoned(contained), false, "an unverifiable one proves nothing");
  boot = "33333333-3333-4333-8333-333333333333";
  assert.equal(proof.abandoned(markerOnly), true, "a reboot ended every process");

  assert.ok(proof.current({ context: { kind: "native" } }), "a host-native provider records evidence");
  assert.equal(proof.current({ context: { kind: "wsl", distro: "Ubuntu" } }), undefined, "a WSL provider can outlive the runner's evidence");
  assert.equal(proof.current({ context: { kind: "native" }, executionTarget: { adapter: "container" } as never }), undefined,
    "so can a container provider");
});

test("a provider that exits by itself with code 0 or by a signal gets an accurate status and frees its slot only on its tree proof (#4256)", async () => {
  for (const code of [0, null]) {
    for (const treeProven of [true, false]) {
      const what = `code ${code}, tree ${treeProven ? "proven" : "not proven"}`;
      const h = harness();
      const runner = h.manager();
      try {
        const provider = await h.launch(runner);
        provider.callbacks.onEvent({ kind: "token_usage", model: "claude-opus-5-5", inputTokens: 1, costUsd: 0.3 });
        provider.callbacks.onExit(code);
        const reported = h.statuses.at(-1)!;
        assert.equal(reported.status, code === 0 ? "completed" : "failed", `${what}: the exit is reported`);
        assert.equal(reported.detail, code === 0 ? "agent exited (code 0)" : "agent exited by a signal");
        assert.equal(h.db.getSession("worker")!.status, reported.status);
        assert.equal(reported.campaignBudgetCheckpoint, undefined, `${what}: a descendant may outlive the root`);
        assert.ok(provider.proofs.length > 0 && provider.proofs.every((terminate) => !terminate),
          `${what}: only the non-killing proof follows the provider's own exit`);
        assert.equal(h.occupied(), 1);
        h.refused(`${what}: so no replacement runs beside it`);
        runner.rearmGovernance("worker", {}, undefined, h.db.campaignBudgets.dispatch("worker"));
        assert.equal(h.occupied(), 1, `${what}: nor does an allocation redelivery release it`);

        provider.treeGone(treeProven);
        await new Promise((resolve) => setImmediate(resolve));
        const checkpoint = h.statuses.at(-1)!.campaignBudgetCheckpoint;
        if (!treeProven) {
          assert.equal(checkpoint, undefined, `${what}: a tree not proven gone keeps the slot`);
          assert.equal(h.occupied(), 1);
          h.refused(`${what}: and a replacement is still refused`);
          assert.equal(h.db.campaignBudgets.active("worker"), true, `${what}: the reservation stays outstanding`);
          continue;
        }
        assert.ok(checkpoint, `${what}: the proof carries the final checkpoint`);
        assert.equal(checkpoint.costUsd, 0.3);
        assert.equal(h.occupied(), 0, `${what}: the proof frees the slot`);
        h.child("replacement");
        const view = h.hydrate(checkpoint.historyEpoch, checkpoint.throughSeq);
        assert.deepEqual(h.settlements(), [{ cost: 0.3 }], `${what}: the spend settles once`);
        assert.equal(view.actual.costUsd, 0.3);
        assert.equal(h.hydrate(checkpoint.historyEpoch, checkpoint.throughSeq).actual.costUsd, 0.3);
        assert.deepEqual(h.settlements(), [{ cost: 0.3 }]);
      } finally { runner.shutdownAll(); h.cleanup(); }
    }
  }
});
