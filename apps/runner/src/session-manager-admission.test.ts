import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerToControlPlane, SessionLaunchSpec } from "@wollipog/protocol";
import { SessionManager } from "./session-manager.js";
import { BoxAdmission } from "./box-admission.js";
import { SessionStore, type SessionMeta } from "./session-store.js";
import { WorktreeCleanupJournal, type WorktreeCleanupRecord } from "./worktree.js";

function meta(sessionId: string, agentId = "claude"): SessionMeta {
  return {
    sessionId, agentId, workspaceId: "repo", repoPath: "/repo", worktreePath: null,
    driver: "claude-code", command: "claude", args: [], env: {}, context: { kind: "native" },
    agentSessionId: null, status: "starting", title: sessionId, config: {}, tokensIn: 0, tokensOut: 0,
    costUsd: 0, preview: null, pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1,
  };
}

function launchSpec(root: string, sessionId: string): SessionLaunchSpec {
  return {
    sessionId,
    agentId: "claude",
    workspaceId: "repo",
    workspacePath: root,
    command: "claude",
    args: [sessionId],
    env: {},
    useWorktree: false,
    driver: "claude-code",
  };
}

test("native launches reject control-plane argv that differs from the exact runner-local agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-native-launch-allowlist-"));
  try {
    const sent: RunnerToControlPlane[] = [];
    const store = new SessionStore(join(root, "sessions"));
    let constructed = false;
    const manager = new SessionManager(
      (message) => sent.push(message),
      () => {},
      store,
      "runner",
      (driver, context, agentId) => {
        assert.equal(driver, "claude-code");
        assert.deepEqual(context, { kind: "native" });
        assert.equal(agentId, "claude");
        return { command: "claude", args: ["--safe"], env: {} };
      },
      () => {
        constructed = true;
        throw new Error("mismatched native argv reached driver construction");
      },
    );

    assert.equal(await manager.start({ ...launchSpec(root, "mismatch"), args: ["--dangerous"] }), false);
    assert.equal(constructed, false);
    assert.equal(store.readMeta("mismatch")?.command, "claude", "only runner-local argv is persisted");
    assert.deepEqual(store.readMeta("mismatch")?.args, ["--safe"]);
    assert.equal(store.readEvents("mismatch").at(-1)?.payload.kind, "error", "rejection is durably audited");
    const status = sent.find((message) =>
      message.type === "session_status" && message.sessionId === "mismatch" && message.status === "failed");
    assert.ok(status?.type === "session_status");
    assert.match(status.detail ?? "", /does not match runner-local configuration/);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native launches reject an agent identity absent from runner-local discovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-native-launch-unknown-"));
  try {
    const sent: RunnerToControlPlane[] = [];
    const store = new SessionStore(join(root, "sessions"));
    const manager = new SessionManager(
      (message) => sent.push(message),
      () => {},
      store,
      "runner",
      () => null,
      () => { throw new Error("unknown agent reached driver construction"); },
    );

    assert.equal(await manager.start(launchSpec(root, "unknown")), false);
    assert.equal(store.readMeta("unknown")?.command, "", "an unknown agent never persists wire argv");
    assert.equal(store.readEvents("unknown").at(-1)?.payload.kind, "error", "rejection is durably audited");
    const status = sent.find((message) =>
      message.type === "session_status" && message.sessionId === "unknown" && message.status === "failed");
    assert.ok(status?.type === "session_status");
    assert.match(status.detail ?? "", /is not configured or available/);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit host target rejects mismatched argv without replacing its live session", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-native-launch-restart-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    let disposals = 0;
    const factory = () => ({
      pid: 1,
      initialize: async () => {},
      newSession: async () => {},
      prompt: async () => ({ stopReason: "end_turn" as const }),
      cancel: () => {},
      dispose: () => { disposals++; },
      setConfig: () => {},
      resolvePermission: () => false,
      agentSessionId: () => null,
    });
    const manager = new SessionManager(
      () => {},
      () => {},
      store,
      "runner",
      (_driver, _context, agentId) => agentId === "claude"
        ? { command: "claude", args: ["s1"], env: {} }
        : null,
      factory as never,
      root,
    );
    const target = {
      id: "runner:runner:host:in_place",
      runnerId: "runner",
      kind: "local" as const,
      workspaceStrategy: "in_place" as const,
      adapter: "host" as const,
      boundaries: {
        filesystem: "host" as const,
        network: "inherit" as const,
        secrets: "runner_local" as const,
        billing: "agent_account" as const,
      },
    };
    const valid = { ...launchSpec(root, "s1"), executionTarget: target };
    assert.equal(await manager.start(valid), true);
    const before = store.readMeta("s1")!;

    assert.equal(await manager.start({ ...valid, command: "/bin/sh", args: ["-c", "danger"] }), false);
    const after = store.readMeta("s1")!;
    assert.equal(disposals, 0, "the rejected restart did not dispose the live provider");
    assert.deepEqual(manager.liveSessionIds(), ["s1"]);
    assert.equal(after.command, before.command);
    assert.deepEqual(after.args, before.args, "the rejected wire argv did not overwrite stored launch metadata");
    assert.equal(after.status, before.status, "the rejected restart did not alter lifecycle state");
    assert.equal(store.readEvents("s1").at(-1)?.payload.kind, "error", "the rejection remains durably audited");

    manager.stop("s1");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a denied weighted claim rolls back its provider slot", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-rollback-"));
  try {
    const gate = new BoxAdmission(root, 2);
    assert.equal(gate.acquire({ sessionId: "full", agentId: "claude", weight: 2 }), true);
    assert.equal(gate.acquire({ sessionId: "denied", agentId: "codex", weight: 1, agentLimit: 1 }), false);
    gate.release("full");
    assert.equal(
      gate.acquire({ sessionId: "next", agentId: "codex", weight: 1, agentLimit: 1 }),
      true,
      "the failed claim did not leak codex's only provider slot",
    );
    gate.releaseAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("box admission rejects invalid weights without claiming any slots", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-invalid-weight-"));
  try {
    const gate = new BoxAdmission(root, 2);
    for (const weight of [0, -1, 1.5, Number.NaN, 3]) {
      assert.equal(gate.acquire({ sessionId: `invalid-${String(weight)}`, agentId: "claude", weight }), false);
      assert.equal(gate.usedCapacity(), 0);
      assert.deepEqual(readdirSync(join(root, "admission")), [], "a rejected weight cannot create slot roots");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reacquiring an already-held session does not orphan capacity", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-idempotent-"));
  try {
    const gate = new BoxAdmission(root, 2);
    assert.equal(gate.acquire({ sessionId: "held", agentId: "claude", weight: 2 }), true);
    assert.equal(gate.usedCapacity(), 2);
    assert.equal(gate.acquire({ sessionId: "held", agentId: "claude", weight: 2 }), true);
    assert.equal(gate.usedCapacity(), 2);
    gate.release("held");
    assert.equal(gate.usedCapacity(), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a weighted acquire reclaims every global slot from a crashed process", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-stale-weight-"));
  try {
    const admissionRoot = join(root, "admission");
    mkdirSync(admissionRoot, { recursive: true });
    for (let index = 0; index < 2; index++) {
      const slot = join(admissionRoot, `slot-${index}`);
      mkdirSync(slot);
      writeFileSync(join(slot, "owner.json"), JSON.stringify({
        pid: 2_147_483_647,
        token: "crashed",
        sessionId: `old-${index}`,
        agentId: "claude",
      }));
    }
    const gate = new BoxAdmission(root, 2);
    assert.equal(gate.acquire({ sessionId: "replacement", agentId: "claude", weight: 2 }), true);
    assert.equal(gate.usedCapacity(), 2);
    gate.releaseAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capacity blockers identify the exact weighted, provider, target, and runner boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-blockers-"));
  try {
    const gate = new BoxAdmission(root, 3);
    assert.equal(gate.blocker({ sessionId: "heavy", agentId: "claude", weight: 4 })?.kind, "request_weight");

    const target = { agentId: "codex", weight: 1, targetId: "cloud-a", targetLimit: 1 };
    assert.equal(gate.acquire({ ...target, sessionId: "target-holder" }), true);
    assert.equal(gate.blocker({ ...target, sessionId: "target-waiter" })?.kind, "target_quota");
    gate.release("target-holder");

    assert.equal(gate.acquire({ sessionId: "provider-holder", agentId: "claude", weight: 1, agentLimit: 1 }), true);
    assert.equal(gate.blocker({ sessionId: "provider-waiter", agentId: "claude", weight: 1, agentLimit: 1 })?.kind,
      "agent_quota");
    assert.equal(gate.acquire({ sessionId: "global-holder", agentId: "codex", weight: 2 }), true);
    assert.equal(gate.blocker({ sessionId: "global-waiter", agentId: "gemini", weight: 1 })?.kind,
      "runner_capacity");
    gate.releaseAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one capacity observation scans each lease root once across a large waiter fan-out", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-observation-"));
  try {
    const gate = new BoxAdmission(root, 256);
    const sibling = new BoxAdmission(root, 256);
    assert.equal(gate.acquire({ sessionId: "provider-holder", agentId: "claude", weight: 1, agentLimit: 1 }), true);
    assert.equal(gate.acquire({
      sessionId: "target-holder", agentId: "codex", weight: 1, targetId: "cloud-a", targetLimit: 1,
    }), true);
    assert.equal(gate.acquire({
      sessionId: "exclusive-holder", agentId: "gemini", weight: 1, exclusiveGroup: "seatbelt:gemini",
    }), true);
    assert.equal(sibling.acquire({ sessionId: "weighted-sibling", agentId: "heavy", weight: 253 }), true);
    // Count deterministic filesystem-root inspections rather than asserting a timing threshold.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = gate as any;
    const original = internals.usedSlots.bind(gate) as (path: string) => number;
    const scans = new Map<string, number>();
    internals.usedSlots = (path: string) => {
      scans.set(path, (scans.get(path) ?? 0) + 1);
      return original(path);
    };
    const observation = gate.observe();
    for (let index = 0; index < 2_000; index++) {
      assert.equal(gate.blocker({
        sessionId: `provider-${index}`, agentId: "claude", weight: 1, agentLimit: 1,
      }, observation)?.kind, "agent_quota");
      assert.equal(gate.blocker({
        sessionId: `target-${index}`, agentId: "codex", weight: 1, targetId: "cloud-a", targetLimit: 1,
      }, observation)?.kind, "target_quota");
      assert.equal(gate.blocker({
        sessionId: `exclusive-${index}`, agentId: "gemini", weight: 1, exclusiveGroup: "seatbelt:gemini",
      }, observation)?.kind, "exclusive_group");
      assert.equal(gate.blocker({
        sessionId: `global-${index}`, agentId: "other", weight: 1,
      }, observation)?.kind, "runner_capacity");
    }
    assert.equal(scans.size, 4, "only the global, provider, target, and exclusive roots are relevant");
    assert.deepEqual([...scans.values()], [1, 1, 1, 1], "waiter fan-out does not multiply filesystem scans");
    gate.releaseAll();
    sibling.releaseAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capacity status deterministically summarizes blocker groups beyond the wire bound", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-overflow-"));
  try {
    const manager = new SessionManager(
      () => {}, () => {}, new SessionStore(root), "runner", undefined, undefined, root, 1,
    );
    // Exercise the aggregate directly so the regression is independent of provider launch setup.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gate = manager as any;
    for (let index = 0; index < 300; index++) {
      gate.admissionQueue.push({
        request: { sessionId: `s-${index}`, agentId: `agent-${index}`, weight: 2 },
        bypasses: 0,
        resolve: () => {},
      });
    }
    const status = manager.capacityState();
    assert.equal(status.blockers?.length, 256);
    assert.equal(status.blockers?.at(-1)?.kind, "diagnostic_overflow");
    assert.equal(status.blockers?.at(-1)?.waitingSessions, 45);
    assert.equal(
      status.blockers?.reduce((sum, blocker) => sum + (blocker.waitingSessions ?? 0), 0),
      status.queuedSessions,
    );

    gate.controlPlaneProtocolVersion = () => 134;
    gate.activeTurnWaiters.set("legacy-active-turn", {
      sessionId: "legacy-active-turn", agentId: "claude", weight: 1,
    });
    const legacy = manager.capacityState();
    assert.ok(legacy.blockers?.some((blocker) => blocker.kind === "runner_capacity"),
      "an older control plane receives a bounded report in its closed vocabulary");
    assert.equal(
      new Set(legacy.blockers?.map((blocker) =>
        `${blocker.kind}:${blocker.agentId ?? ""}:${blocker.targetId ?? ""}`)).size,
      legacy.blockers?.length,
      "legacy snapshots contain only one row for each dashboard blocker key",
    );
    assert.equal(
      legacy.blockers?.reduce((sum, blocker) => sum + (blocker.waitingSessions ?? 0), 0),
      legacy.queuedSessions,
      "coalescing the legacy capacity and overflow rows keeps the waiter total exact",
    );
    gate.activeTurnWaiters.clear();
    gate.controlPlaneProtocolVersion = () => 135;

    gate.admissionQueue.splice(0);
    assert.equal(gate.boxAdmission.acquire({ sessionId: "resident", agentId: "holder", weight: 1 }), true);
    for (let index = 0; index < 300; index++) {
      gate.admissionQueue.push({
        request: { sessionId: `global-${index}`, agentId: `agent-${index}`, weight: 1 },
        bypasses: 0,
        resolve: () => {},
      });
    }
    const global = manager.capacityState();
    assert.equal(global.blockers?.length, 1,
      "irrelevant agent identities do not split one global-capacity boundary");
    assert.equal(global.blockers?.[0]?.waitingSessions, 300);
    assert.equal(global.blockers?.[0]?.agentId, undefined);
    gate.boxAdmission.release("resident");

    const exactKinds = [
      "runner_capacity", "agent_quota", "target_quota", "exclusive_group", "queue_order", "active_turn_capacity",
    ] as const;
    const mixed = [
      ...Array.from({ length: 300 }, (_, index) => ({
        kind: "request_weight" as const,
        description: `request ${index}`,
        usedUnits: 1,
        limitUnits: 1,
        requiredUnits: 2,
        waitingSessions: 1,
        agentId: `agent-${index}`,
      })),
      ...exactKinds.map((kind) => ({
        kind,
        description: kind,
        usedUnits: 1,
        limitUnits: 1,
        requiredUnits: 1,
        waitingSessions: 1,
      })),
    ];
    gate.controlPlaneProtocolVersion = () => 135;
    const bounded = gate.boundCapacityBlockers(mixed, 1) as Array<{ kind: string; waitingSessions?: number }>;
    assert.equal(bounded.length, 256);
    for (const kind of ["request_weight", ...exactKinds]) {
      assert.ok(bounded.some((blocker) => blocker.kind === kind), `${kind} remains actionable after overflow`);
    }
    assert.equal(bounded.reduce((sum, blocker) => sum + (blocker.waitingSessions ?? 0), 0), mixed.length);
    assert.equal(gate.boundCapacityBlockers(mixed.slice(0, 256), 1).length, 256,
      "the protocol boundary itself needs no aggregate");
    const justOver = gate.boundCapacityBlockers(mixed.slice(0, 257), 1) as Array<{ kind: string }>;
    assert.equal(justOver.length, 256);
    assert.equal(justOver.at(-1)?.kind, "diagnostic_overflow");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained-session inventory is cached on hot reports and distinguishes resident from parked", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-capacity-inventory-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    store.create({ ...meta("resident"), agentSessionId: "provider-resident", status: "idle" });
    store.create({ ...meta("parked"), agentSessionId: "provider-parked", status: "idle" });
    let storeScans = 0;
    const originalListSessions = store.listSessions.bind(store);
    store.listSessions = () => {
      storeScans++;
      return originalListSessions();
    };
    const manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, root, 4);
    assert.deepEqual(manager.capacityState().dimensions, {
      activeTurns: { used: 0, limit: 4, available: 4 },
      residentProcessUnits: { used: 0, limit: 4, available: 4 },
      retainedSessions: { used: 2, limit: null, available: null },
      parkedSessions: 2,
      idleProcessPolicy: "retain",
    });
    manager.capacityState();
    assert.equal(storeScans, 1, "repeated turn-boundary reports do not rescan every durable session");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    internals.active.set("resident", {});
    internals.refreshCapacityInventorySession("resident");
    assert.equal(manager.capacityState().dimensions?.retainedSessions.used, 2);
    assert.equal(manager.capacityState().dimensions?.parkedSessions, 1,
      "a resumable resident session is retained but not parked");
    internals.active.delete("resident");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active-turn capacity is enforced across runner processes independently of resident leases", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-active-turn-capacity-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    store.create(meta("s1"));
    store.create(meta("s2"));
    const policy = {
      agentLimits: {},
      agentWeights: {},
      activeTurnLimit: 1,
      idleProcessPolicy: "retain" as const,
    };
    const firstManager = new SessionManager(
      () => {}, () => {}, store, "runner-a", undefined, undefined, root, 4,
      undefined, undefined, policy,
    );
    const secondManager = new SessionManager(
      () => {}, () => {}, store, "runner-b", undefined, undefined, root, 4,
      undefined, undefined, policy,
    );
    // Exercise the cross-process lease itself; prompt scheduling is covered by the queue tests.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = firstManager as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = secondManager as any;
    assert.equal(first.acquireActiveTurn("s1"), true);
    assert.equal(second.acquireActiveTurn("s2"), false);
    const waiting = secondManager.capacityState();
    assert.equal(waiting.usedUnits, 0, "a turn permit does not consume a resident-process unit");
    assert.equal(waiting.dimensions?.activeTurns.used, 1);
    assert.equal(waiting.dimensions?.residentProcessUnits.used, 0);
    assert.equal(waiting.blockers?.[0]?.kind, "active_turn_capacity");
    assert.equal(store.readMeta("s2")?.capacityWait?.kind, "active_turn_capacity");

    first.releaseActiveTurn("s1");
    assert.equal(second.acquireActiveTurn("s2"), true);
    assert.equal(secondManager.capacityState().dimensions?.activeTurns.used, 1);
    second.releaseActiveTurn("s2");
    firstManager.shutdownAll();
    secondManager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an active-turn waiter runs before another session drains its deeper local queue", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-active-turn-fairness-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    store.create(meta("s1"));
    store.create(meta("s2"));
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, root, 4,
      undefined, undefined, { agentLimits: {}, agentWeights: {}, activeTurnLimit: 1 },
    );
    const order: string[] = [];
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    let finishFirst!: () => void;
    const firstResult = new Promise<"end_turn">((resolve) => { finishFirst = () => resolve("end_turn"); });
    const client = {
      resolvePermission: () => false,
      cancel: () => {},
      dispose: () => {},
      prompt: (text: string) => {
        order.push(text);
        if (text === "A1") {
          firstStarted();
          return firstResult;
        }
        return Promise.resolve("end_turn" as const);
      },
      setConfig: () => {},
      agentSessionId: () => "provider",
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    for (const sessionId of ["s1", "s2"]) {
      internals.active.set(sessionId, {
        sessionId,
        client,
        repoPath: root,
        cwd: root,
        worktree: null,
        status: "running",
        running: true,
        queue: [],
      });
    }
    manager.prompt("s1", "A1");
    manager.prompt("s1", "A2");
    manager.prompt("s2", "B");
    internals.active.get("s1").running = false;
    internals.active.get("s2").running = false;
    const firstDrain = internals.drain("s1") as Promise<void>;
    await started;
    await internals.drain("s2");
    assert.equal(store.readMeta("s2")?.capacityWait?.kind, "active_turn_capacity");
    finishFirst();
    await firstDrain;
    for (let attempt = 0; attempt < 100 && order.length < 3; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(order, ["A1", "B", "A2"]);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty scheduled drain never creates a durable active-turn waiter", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-empty-active-turn-drain-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    store.create({ ...meta("holder"), status: "idle" });
    store.create({ ...meta("empty"), status: "idle" });
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, root, 2,
      undefined, undefined, { agentLimits: {}, agentWeights: {}, activeTurnLimit: 1 },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    assert.equal(internals.acquireActiveTurn("holder"), true);
    internals.active.set("empty", {
      sessionId: "empty",
      running: false,
      status: "idle",
      queue: [],
      client: { dispose: () => {}, agentSessionId: () => null },
    });
    await internals.drain("empty");
    assert.equal(internals.activeTurnWaiters.size, 0);
    assert.equal(store.readMeta("empty")?.status, "idle");
    assert.equal(store.readMeta("empty")?.capacityWait, undefined);
    internals.active.delete("empty");
    internals.releaseActiveTurn("holder");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authentication and history gates do not self-reschedule an undrainable FIFO", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-gated-active-turn-drain-"));
  try {
    for (const gate of ["authenticationBlocked", "historyQuarantined"] as const) {
      const store = new SessionStore(join(root, gate));
      store.create({ ...meta(gate), status: "idle" });
      const manager = new SessionManager(
        () => {}, () => {}, store, "runner", undefined, undefined, root, 2,
        undefined, undefined, { agentLimits: {}, agentWeights: {}, activeTurnLimit: 1 },
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const internals = manager as any;
      internals.active.set(gate, {
        sessionId: gate,
        running: false,
        status: "idle",
        queue: [{ id: "queued", text: "wait", images: [] }],
        [gate]: true,
        client: { dispose: () => {}, cancel: () => {}, agentSessionId: () => null },
      });
      let reschedules = 0;
      internals.scheduleDrain = () => { reschedules++; };
      await internals.drain(gate);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(reschedules, 0, `${gate} must wait for its recovery transition`);
      assert.equal(internals.activeTurnAdmitted.has(gate), false);
      manager.shutdownAll();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelling the last capacity-waiting prompt removes its waiter and queued status", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-cancel-active-turn-waiter-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    store.create({ ...meta("holder"), status: "idle" });
    store.create({ ...meta("waiting"), status: "idle" });
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, root, 2,
      undefined, undefined, { agentLimits: {}, agentWeights: {}, activeTurnLimit: 1 },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    assert.equal(internals.acquireActiveTurn("holder"), true);
    internals.active.set("waiting", {
      sessionId: "waiting",
      running: true,
      status: "idle",
      queue: [],
      client: { dispose: () => {}, cancel: () => {}, agentSessionId: () => null },
    });
    manager.prompt("waiting", "cancel me");
    const promptId = internals.active.get("waiting").queue[0].id as string;
    internals.active.get("waiting").running = false;
    await internals.drain("waiting");
    assert.equal(internals.activeTurnWaiters.has("waiting"), true);

    manager.removeQueuedPrompt("waiting", promptId);
    assert.equal(internals.activeTurnWaiters.has("waiting"), false);
    assert.equal(store.readMeta("waiting")?.status, "idle");
    assert.equal(store.readMeta("waiting")?.capacityWait, undefined);
    internals.releaseActiveTurn("holder");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelling a capacity waiter cannot overwrite a newer terminal status", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-cancel-waiter-terminal-status-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    store.create({ ...meta("holder"), status: "idle" });
    store.create({ ...meta("waiting"), status: "idle" });
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, root, 2,
      undefined, undefined, { agentLimits: {}, agentWeights: {}, activeTurnLimit: 1 },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    assert.equal(internals.acquireActiveTurn("holder"), true);
    const entry = {
      sessionId: "waiting",
      running: false,
      status: "idle",
      queue: [{ id: "queued", text: "wait", images: [] }],
      client: { dispose: () => {}, cancel: () => {}, agentSessionId: () => null },
    };
    internals.active.set("waiting", entry);
    await internals.drain("waiting");
    assert.equal(internals.activeTurnWaiters.has("waiting"), true);
    store.patchMeta("waiting", { status: "failed" });

    manager.removeQueuedPrompt("waiting", "queued");

    assert.equal(internals.activeTurnWaiters.has("waiting"), false);
    assert.equal(store.readMeta("waiting")?.status, "failed");
    internals.releaseActiveTurn("holder");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("containment that empties a FIFO removes its active-turn waiter and retry state", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-contained-active-turn-waiter-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    store.create({ ...meta("holder"), status: "idle" });
    store.create({ ...meta("contained"), status: "idle" });
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, root, 2,
      undefined, undefined, { agentLimits: {}, agentWeights: {}, activeTurnLimit: 1 },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    assert.equal(internals.acquireActiveTurn("holder"), true);
    const entry = {
      sessionId: "contained",
      running: false,
      status: "idle",
      queue: [{ id: "queued", text: "wait", images: [] }],
      client: { dispose: () => {}, cancel: () => {}, agentSessionId: () => null },
    };
    internals.active.set("contained", entry);
    await internals.drain("contained");
    assert.equal(internals.activeTurnWaiters.has("contained"), true);

    entry.queue.length = 0;
    entry.historyIntegrityFailure = "contained";
    await internals.drain("contained");

    assert.equal(internals.activeTurnWaiters.has("contained"), false);
    assert.equal(internals.activeTurnRetryTimer, null);
    assert.equal(store.readMeta("contained")?.status, "idle");
    assert.equal(store.readMeta("contained")?.capacityWait, undefined);
    internals.releaseActiveTurn("holder");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-running retained background metadata does not cancel a provider at capacity", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-retained-background-capacity-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    store.create({ ...meta("holder"), status: "idle" });
    store.create({ ...meta("orphaned"), status: "idle", backgroundWorkState: "orphaned" });
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, root, 2,
      undefined, undefined, { agentLimits: {}, agentWeights: {}, activeTurnLimit: 1 },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    assert.equal(internals.acquireActiveTurn("holder"), true);
    let cancellations = 0;
    const entry = {
      sessionId: "orphaned",
      running: false,
      status: "idle",
      queue: [],
      client: { dispose: () => {}, cancel: () => { cancellations++; }, agentSessionId: () => null },
    };
    internals.active.set("orphaned", entry);
    internals.reconcileAuthoritativeBackgroundWorkPermit("orphaned", entry, false);
    assert.equal(cancellations, 0);
    assert.equal(internals.activeTurnAdmitted.has("orphaned"), false);
    internals.releaseActiveTurn("holder");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("idle background rediscovery at active-turn capacity reports retained work without cancellation", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-idle-background-rediscovery-capacity-"));
  try {
    const sent: RunnerToControlPlane[] = [];
    const store = new SessionStore(join(root, "sessions"));
    store.create({ ...meta("holder"), status: "idle" });
    store.create({ ...meta("rediscovered"), status: "idle" });
    const manager = new SessionManager(
      (message) => sent.push(message), () => {}, store, "runner", undefined, undefined, root, 2,
      undefined, undefined, { agentLimits: {}, agentWeights: {}, activeTurnLimit: 1 },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    assert.equal(internals.acquireActiveTurn("holder"), true);
    let cancellations = 0;
    const entry = {
      sessionId: "rediscovered",
      running: false,
      providerInitiatedTurnActive: false,
      status: "idle",
      queue: [],
      client: { dispose: () => {}, cancel: () => { cancellations++; }, agentSessionId: () => null },
    };
    internals.active.set("rediscovered", entry);

    internals.onDriverBackgroundWork("rediscovered", {
      state: "running",
      pendingTaskIds: ["artifact-task"],
      jobs: [{ id: "artifact-task", launchType: "unknown", startedAt: 1 }],
    });

    assert.equal(cancellations, 0);
    assert.equal(internals.activeTurnAdmitted.has("rediscovered"), false);
    assert.equal(store.readMeta("rediscovered")?.backgroundWorkState, "running");
    assert.equal(store.readMeta("rediscovered")?.orphanedWork, undefined);
    assert.equal(sent.some((message) => message.type === "session_event" &&
      message.payload.kind === "error" && /Active Turn Capacity/.test(message.payload.message)), false);
    internals.releaseActiveTurn("holder");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launch-time background reconciliation at capacity cannot cancel the initializing provider", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-launch-background-reconcile-capacity-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    store.create({ ...meta("holder"), status: "idle" });
    store.create({ ...meta("launching"), status: "starting", backgroundWorkState: "running",
      pendingBackgroundTaskIds: ["seed-task"] });
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, root, 2,
      undefined, undefined, { agentLimits: {}, agentWeights: {}, activeTurnLimit: 1 },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    assert.equal(internals.acquireActiveTurn("holder"), true);
    let cancellations = 0;
    const entry = {
      sessionId: "launching",
      running: false,
      providerInitiatedTurnActive: false,
      status: "starting",
      queue: [],
      client: { dispose: () => {}, cancel: () => { cancellations++; }, agentSessionId: () => null },
    };
    internals.active.set("launching", entry);

    internals.reconcileAuthoritativeBackgroundWorkPermit("launching", entry, true);

    assert.equal(cancellations, 0);
    assert.equal(internals.activeTurnAdmitted.has("launching"), false);
    internals.releaseActiveTurn("holder");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a terminal missing-result continuation releases its active-work permit", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-missing-result-capacity-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    store.create({
      ...meta("missing-result"),
      status: "idle",
      backgroundWorkState: "continuation_pending",
      backgroundJobs: [{
        id: "job-1",
        parentTurnId: "turn-1",
        runnerId: "runner",
        workspaceId: "repo",
        context: { kind: "native" },
        launchType: "agent",
        registeredAt: 1,
        terminalStatus: "completed",
        terminalObservedAt: 2,
        continuationRequired: true,
        continuationId: "bgcont-1",
        continuationQueuedAt: 3,
        continuationSubmittedAt: 4,
        continuationAcceptedAt: 5,
      }],
    });
    store.create({ ...meta("next"), status: "idle" });
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, root, 2,
      undefined, undefined, { agentLimits: {}, agentWeights: {}, activeTurnLimit: 1 },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    const entry = {
      sessionId: "missing-result",
      running: false,
      status: "idle",
      queue: [],
      client: { dispose: () => {}, cancel: () => {}, agentSessionId: () => null },
    };
    internals.active.set("missing-result", entry);
    assert.equal(internals.acquireActiveTurn("missing-result"), true);
    internals.markBackgroundContinuationMissingResult("missing-result", ["job-1"]);
    assert.ok(store.readMeta("missing-result")?.backgroundJobs?.[0]?.continuationMissingResultAt);
    assert.equal(store.readMeta("missing-result")?.backgroundWorkState, undefined);

    internals.settleActiveWorkPermit("missing-result", entry);
    assert.equal(manager.capacityState().dimensions?.activeTurns.used, 0);
    assert.equal(internals.acquireActiveTurn("next"), true,
      "a terminally missing result cannot starve later sessions");
    internals.releaseActiveTurn("next");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal orphan metadata releases its active-work permit for another session", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-terminal-orphan-capacity-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    store.create({
      ...meta("orphaned"),
      status: "idle",
      backgroundWorkState: "orphaned",
      pendingBackgroundTaskIds: ["task-1"],
      orphanedWork: {
        pendingTaskIds: ["task-1"],
        markedAt: 1,
        reason: "process_exit",
        recoveryAttemptedAt: 2,
      },
    });
    store.create({ ...meta("next"), status: "idle" });
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, root, 2,
      undefined, undefined, { agentLimits: {}, agentWeights: {}, activeTurnLimit: 1 },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    const entry = {
      sessionId: "orphaned",
      running: false,
      status: "idle",
      queue: [],
      client: { dispose: () => {}, cancel: () => {}, agentSessionId: () => null },
    };
    internals.active.set("orphaned", entry);
    assert.equal(internals.acquireActiveTurn("orphaned"), true);

    internals.settleActiveWorkPermit("orphaned", entry);

    assert.equal(internals.activeTurnAdmitted.has("orphaned"), false);
    assert.equal(internals.acquireActiveTurn("next"), true);
    assert.equal(manager.capacityState().dimensions?.activeTurns.used, 1);
    internals.releaseActiveTurn("next");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a held terminal continuation releases its permit until recovery can run", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-held-continuation-capacity-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    store.create({
      ...meta("held"),
      status: "idle",
      costUsd: 1,
      config: { costBudgetUsd: 1 },
      backgroundWorkState: "continuation_pending",
      backgroundJobs: [{
        id: "job-1",
        parentTurnId: "turn-1",
        runnerId: "runner",
        workspaceId: "repo",
        context: { kind: "native" },
        launchType: "agent",
        registeredAt: 1,
        terminalStatus: "completed",
        terminalObservedAt: 2,
        continuationRequired: true,
        continuationId: "bgcont-1",
        continuationQueuedAt: 3,
      }],
    });
    store.create({ ...meta("next"), status: "idle" });
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, root, 2,
      undefined, undefined, { agentLimits: {}, agentWeights: {}, activeTurnLimit: 1 },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    const entry = {
      sessionId: "held",
      running: false,
      status: "idle",
      queue: [],
      client: { dispose: () => {}, cancel: () => {}, agentSessionId: () => null },
    };
    internals.active.set("held", entry);
    assert.equal(internals.acquireActiveTurn("held"), true);

    internals.settleActiveWorkPermit("held", entry);

    assert.equal(internals.activeTurnAdmitted.has("held"), false);
    assert.equal(internals.acquireActiveTurn("next"), true);
    internals.releaseActiveTurn("next");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tombstoned non-terminal job row cannot retain an active-work permit", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-tombstoned-background-capacity-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    store.create({ ...meta("tombstoned"), status: "idle", recoveredBackgroundTaskIds: ["task-1"] });
    store.create({ ...meta("next"), status: "idle" });
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, root, 2,
      undefined, undefined, { agentLimits: {}, agentWeights: {}, activeTurnLimit: 1 },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    const entry = {
      sessionId: "tombstoned",
      running: true,
      status: "running",
      queue: [],
      client: { dispose: () => {}, cancel: () => {}, agentSessionId: () => null },
    };
    internals.active.set("tombstoned", entry);
    assert.equal(internals.acquireActiveTurn("tombstoned"), true);
    internals.onDriverBackgroundWork("tombstoned", {
      state: "running",
      pendingTaskIds: ["task-1"],
      jobs: [{ id: "task-1", launchType: "agent", startedAt: 1 }],
    });
    assert.equal(store.readMeta("tombstoned")?.backgroundWorkState, undefined);
    assert.equal(store.readMeta("tombstoned")?.backgroundJobs?.[0]?.terminalStatus, undefined);

    entry.running = false;
    internals.settleActiveWorkPermit("tombstoned", entry);

    assert.equal(internals.activeTurnAdmitted.has("tombstoned"), false);
    assert.equal(internals.acquireActiveTurn("next"), true);
    internals.releaseActiveTurn("next");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retirement completion refreshes inventory after a suppressed handoff refresh", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-retirement-inventory-refresh-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    store.create({ ...meta("handoff"), status: "idle", agentSessionId: "provider-1" });
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, root, 1,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    const client = { dispose: () => {}, cancel: () => {}, agentSessionId: () => "provider-1" };
    const entry = {
      sessionId: "handoff",
      running: false,
      status: "idle",
      queue: [],
      client,
    };
    internals.active.set("handoff", entry);
    assert.equal(manager.capacityState().dimensions?.parkedSessions, 0);
    internals.deleteActiveSession("handoff", entry, false, false);
    const retirement = {
      client,
      entry,
      promise: Promise.resolve(),
      preserveAdmission: false,
      preserveLock: false,
      acceptPromptsDuringHandoff: false,
      parking: false,
    };
    internals.closing.set("handoff", retirement);

    internals.completeProviderRetirement("handoff", retirement);

    assert.equal(manager.capacityState().dimensions?.parkedSessions, 1);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an undelivered capacity snapshot is retried and reconnect can force reconciliation", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-capacity-report-retry-"));
  try {
    const manager = new SessionManager(
      () => { throw new Error("socket closed"); },
      () => {},
      new SessionStore(join(root, "sessions")),
      "runner",
      undefined,
      undefined,
      root,
      1,
    );
    assert.throws(() => manager.reportCapacity(), /socket closed/);
    let reports = 0;
    manager.setSend((message) => {
      if (message.type === "runner_capacity_status") reports++;
    });
    manager.reportCapacity();
    assert.equal(reports, 1, "a synchronous delivery failure did not poison the deduplication cache");
    manager.reportCapacity();
    assert.equal(reports, 1);
    manager.reportCapacity(true);
    assert.equal(reports, 2, "registration reconnect forces the current bounded snapshot");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("park-when-needed retires only a resumable idle provider and preserves its session", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-idle-provider-parking-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    let launches = 0;
    const closed: string[] = [];
    const resumedWith: Array<string | undefined> = [];
    let warmCloseStarted!: () => void;
    const warmClosing = new Promise<void>((resolve) => { warmCloseStarted = resolve; });
    let finishWarmClose!: () => void;
    const warmCloseFinished = new Promise<void>((resolve) => { finishWarmClose = resolve; });
    const factory = (_driver: unknown, options: { resumeId?: string }) => {
      launches++;
      resumedWith.push(options.resumeId);
      const providerId = options.resumeId ?? `provider-${launches}`;
      return {
        pid: launches,
        initialize: async () => {},
        newSession: async () => providerId,
        prompt: async () => "end_turn" as const,
        close: async () => {
          if (providerId === "provider-1") {
            warmCloseStarted();
            await warmCloseFinished;
          }
          closed.push(providerId);
          return true;
        },
        cancel: () => {},
        dispose: () => {},
        setConfig: () => {},
        resolvePermission: () => false,
        agentSessionId: () => providerId,
      };
    };
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, factory as never, root, 1,
      undefined, undefined, {
        agentLimits: {},
        agentWeights: {},
        idleProcessPolicy: "park_when_needed",
      },
    );
    const warmSpec = { ...launchSpec(root, "warm"), config: { model: "stable-model" } };
    assert.equal(await manager.start(warmSpec, "establish resume coordinate"), true);
    for (let attempt = 0; attempt < 100 && store.readMeta("warm")?.status !== "idle"; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(store.readMeta("warm")?.status, "idle");
    assert.equal(store.readMeta("warm")?.agentSessionId, "provider-1");

    const newStart = manager.start(launchSpec(root, "new"));
    await warmClosing;
    const durableStates = { queued: 0, started: 0, completed: 0, failed: 0 };
    const parkingPrompt = {
      commandId: "parking-prompt",
      queued: () => { durableStates.queued++; },
      started: () => { durableStates.started++; },
      completed: () => { durableStates.completed++; },
      failed: () => { durableStates.failed++; },
      uncertain: () => { durableStates.failed++; },
    };
    assert.equal(manager.prompt("warm", "resume parked session", [], undefined, undefined, parkingPrompt), true,
      "a prompt racing graceful parking is queued instead of cancelled");
    assert.deepEqual(durableStates, { queued: 1, started: 0, completed: 0, failed: 0 });
    finishWarmClose();
    assert.equal(await newStart, true, "resident pressure parks the warm process and admits the new one");
    assert.deepEqual(closed, ["provider-1"]);
    assert.deepEqual(manager.liveSessionIds(), ["new"]);
    assert.equal(store.readMeta("warm")?.status, "idle", "parking is not a terminal lifecycle transition");
    assert.equal(store.readMeta("warm")?.agentSessionId, "provider-1", "the resume coordinate remains durable");
    assert.equal(store.readMeta("warm")?.config.model, "stable-model");
    assert.equal(manager.capacityState().dimensions?.retainedSessions.used, 1,
      "the established parked conversation remains retained");
    assert.equal(manager.capacityState().dimensions?.parkedSessions, 1);
    manager.stop("new");
    await (manager as unknown as { closing: Map<string, { promise: Promise<void> }> })
      .closing.get("new")?.promise;
    for (let attempt = 0; attempt < 100 && launches < 3; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(launches, 3);
    assert.equal(resumedWith.at(-1), "provider-1", "the parked provider identity is used for resume");
    for (let attempt = 0; attempt < 100 && store.readMeta("warm")?.status !== "idle"; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(durableStates, { queued: 1, started: 1, completed: 1, failed: 0 },
      "the deferred durable prompt keeps one lifecycle and is never cancelled by automatic parking");
    assert.equal(store.readMeta("warm")?.config.model, "stable-model");
    assert.deepEqual(manager.liveSessionIds(), ["warm"]);
    manager.stop("warm");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parking replay preserves a non-durable prompt's dashboard identity and ordinal", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-parking-prompt-identity-"));
  try {
    const manager = new SessionManager(
      () => {}, () => {}, new SessionStore(join(root, "sessions")), "runner",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    internals.launchGenerations.set("parked", 7);
    internals.preLaunchQueues.set("parked", [{
      id: "stable-prompt-id",
      ordinal: 41,
      text: "resume me",
      images: [],
    }]);
    let replayed: unknown[] | undefined;
    internals.prompt = (...args: unknown[]) => { replayed = args; return true; };
    internals.resumePromptsQueuedDuringParking("parked", { parkingGeneration: 7 });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(replayed?.[7], 41, "FIFO order survives parking");
    assert.equal(replayed?.[11], "stable-prompt-id", "dashboard cancellation keeps the same id");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authoritative background work retains the active-work permit and cannot be parked", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-background-capacity-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    let background!: (update: {
      state: "running" | "orphaned" | null;
      pendingTaskIds: string[];
      jobs?: Array<{ id: string; launchType: "agent"; startedAt: number }>;
      terminalJobs?: Array<{
        id: string;
        launchType: "agent";
        startedAt: number;
        status: "completed";
        terminalAt: number;
        continuationRequired: boolean;
      }>;
    }) => void;
    let promptStarted!: () => void;
    const started = new Promise<void>((resolve) => { promptStarted = resolve; });
    let finishPrompt!: () => void;
    const promptResult = new Promise<"end_turn">((resolve) => { finishPrompt = () => resolve("end_turn"); });
    const factory = (_driver: unknown, _options: unknown, callbacks: {
      onBackgroundWork(update: Parameters<typeof background>[0]): void;
    }) => {
      background = callbacks.onBackgroundWork;
      return {
        pid: 1,
        initialize: async () => {},
        newSession: async () => "provider-1",
        prompt: async () => { promptStarted(); return promptResult; },
        close: async () => true,
        cancel: () => {},
        dispose: () => {},
        setConfig: () => {},
        resolvePermission: () => false,
        agentSessionId: () => "provider-1",
      };
    };
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, factory as never, root, 2,
      undefined, undefined, {
        agentLimits: {}, agentWeights: {}, activeTurnLimit: 1, idleProcessPolicy: "park_when_needed",
      },
    );
    assert.equal(await manager.start(launchSpec(root, "background")), true);
    manager.prompt("background", "do work");
    await started;
    background({
      state: "running",
      pendingTaskIds: ["task-1"],
      jobs: [{ id: "task-1", launchType: "agent", startedAt: 1 }],
    });
    finishPrompt();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    for (let attempt = 0; attempt < 100 && internals.active.get("background")?.running; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(manager.capacityState().dimensions?.activeTurns.used, 1);
    assert.equal(internals.idleProviderCanPark("background", internals.active.get("background")), false);

    background({
      state: null,
      pendingTaskIds: [],
      terminalJobs: [{
        id: "task-1",
        launchType: "agent",
        startedAt: 1,
        status: "completed",
        terminalAt: 2,
        continuationRequired: false,
      }],
    });
    assert.equal(manager.capacityState().dimensions?.activeTurns.used, 0);
    manager.stop("background");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex, app-server, and resume-capable ACP sessions park and resume by provider identity", async () => {
  for (const driver of ["codex", "codex-app-server", "acp"] as const) {
    const root = mkdtempSync(join(tmpdir(), `wollipog-${driver}-parking-`));
    try {
      const store = new SessionStore(join(root, "sessions"));
      let launches = 0;
      const resumeIds: Array<string | undefined> = [];
      const factory = (_kind: unknown, options: { resumeId?: string }, callbacks: {
        onAcpCapabilities?: (capabilities: {
          logout: boolean;
          loadSession: boolean;
          sessionList: boolean;
          sessionDelete: boolean;
          sessionResume: boolean;
          sessionClose: boolean;
        }) => void;
      }) => {
        launches++;
        resumeIds.push(options.resumeId);
        const providerId = options.resumeId ?? `${driver}-provider-${launches}`;
        return {
          pid: launches,
          initialize: async () => {
            if (driver === "acp") callbacks.onAcpCapabilities?.({
              logout: true,
              loadSession: true,
              sessionList: true,
              sessionDelete: false,
              sessionResume: true,
              sessionClose: true,
            });
          },
          newSession: async () => providerId,
          prompt: async () => "end_turn" as const,
          close: async () => true,
          cancel: () => {},
          dispose: () => {},
          setConfig: () => {},
          resolvePermission: () => false,
          agentSessionId: () => providerId,
        };
      };
      const manager = new SessionManager(
        () => {}, () => {}, store, "runner", undefined, factory as never, root, 1,
        undefined, undefined, { agentLimits: {}, agentWeights: {}, idleProcessPolicy: "park_when_needed" },
      );
      const spec = {
        ...launchSpec(root, "warm"),
        agentId: driver,
        command: driver,
        driver,
      };
      assert.equal(await manager.start(spec, "establish"), true, driver);
      for (let attempt = 0; attempt < 100 && store.readMeta("warm")?.status !== "idle"; attempt++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      const providerId = `${driver}-provider-1`;
      assert.equal(store.readMeta("warm")?.agentSessionId, providerId, driver);
      assert.equal(await manager.start({ ...spec, sessionId: "replacement", args: ["replacement"] }), true, driver);
      assert.equal(manager.capacityState().dimensions?.parkedSessions, 1, driver);
      manager.stop("replacement");
      await (manager as unknown as { closing: Map<string, { promise: Promise<void> }> })
        .closing.get("replacement")?.promise;
      manager.prompt("warm", "resume");
      for (let attempt = 0; attempt < 100 && launches < 3; attempt++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(resumeIds.at(-1), providerId, driver);
      manager.stop("warm");
      manager.shutdownAll();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("parking eligibility is capability-derived and fails closed for provider-owned state", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-provider-parking-rules-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, root, 8,
      undefined, undefined, { agentLimits: {}, agentWeights: {}, idleProcessPolicy: "park_when_needed" },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    const eligibleEntry = () => ({
      status: "idle",
      running: false,
      providerInitiatedTurnActive: false,
      queue: [],
      client: { agentSessionId: () => "provider", cancel: () => {}, dispose: () => {} },
      steerFenceIds: new Set(),
      reservedPromotions: new Map(),
    });
    const providers = [
      { id: "claude", driver: "claude-code", expected: true },
      { id: "codex", driver: "codex", expected: true },
      { id: "app-server", driver: "codex-app-server", expected: true },
      { id: "acp-resume", driver: "acp", acpCapabilities: { sessionResume: true }, expected: true },
      { id: "acp-load", driver: "acp", acpCapabilities: { loadSession: true }, expected: true },
      { id: "acp-unsafe", driver: "acp", acpCapabilities: {}, expected: false },
    ] as const;
    for (const provider of providers) {
      store.create({
        ...meta(provider.id),
        driver: provider.driver,
        agentSessionId: `provider-${provider.id}`,
        status: "idle",
        ...(provider.driver === "acp" ? { acpCapabilities: provider.acpCapabilities } : {}),
      });
      assert.equal(internals.idleProviderCanPark(provider.id, eligibleEntry()), provider.expected, provider.id);
    }

    store.create({
      ...meta("guarded"),
      agentSessionId: "provider-guarded",
      status: "input_required",
      pendingApproval: {
        requestId: "approval",
        title: "Approve",
        options: [{ optionId: "yes", name: "Yes" }],
      },
    });
    const guarded = eligibleEntry();
    guarded.status = "input_required";
    assert.equal(internals.idleProviderCanPark("guarded", guarded), false, "input and approval state stays resident");
    guarded.status = "idle";
    guarded.queue.push({ text: "queued" });
    assert.equal(internals.idleProviderCanPark("guarded", guarded), false, "queued provider commands stay resident");
    guarded.queue.length = 0;
    store.patchMeta("guarded", { pendingApproval: null, backgroundWorkState: "running", pendingBackgroundTaskIds: ["task"] });
    assert.equal(internals.idleProviderCanPark("guarded", guarded), false, "detached background work stays resident");
    internals.controlPlaneProtocolVersion = () => 134;
    internals.active.set("claude", eligibleEntry());
    assert.equal(internals.parkOneIdleProvider(), false,
      "a pre-v135 control plane cannot confirm parking, so the resident process is retained");
    internals.active.delete("claude");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("box admission is FIFO and a queued launch can be cancelled", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-"));
  try {
    const sent: RunnerToControlPlane[] = [];
    const store = new SessionStore(root);
    for (const id of ["s1", "s2", "s3"]) store.create(meta(id));
    const manager = new SessionManager((message) => sent.push(message), () => {}, store, "runner", undefined, undefined, undefined, 1);
    // Exercise the gate directly: driver construction is orthogonal and heavily covered elsewhere.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gate = manager as any;
    assert.equal(await gate.acquireAdmission("s1"), true);
    const second = gate.acquireAdmission("s2") as Promise<boolean>;
    const third = gate.acquireAdmission("s3") as Promise<boolean>;
    assert.deepEqual(
      sent.filter((m) => m.type === "session_status").map((m) => m.sessionId),
      ["s2", "s3"],
    );

    manager.cancel("s2");
    assert.equal(await second, false);
    assert.equal(store.readMeta("s2")?.status, "stopped", "legacy admission cancellation remains terminal");
    gate.releaseAdmission("s1");
    assert.equal(await third, true, "the next non-cancelled waiter receives the released slot");
    assert.deepEqual([...gate.admitted], ["s3"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live capacity increase drains waiters and a decrease preserves running leases", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-live-capacity-"));
  try {
    const sent: RunnerToControlPlane[] = [];
    const store = new SessionStore(root);
    for (const id of ["s1", "s2", "s3"]) store.create(meta(id));
    const manager = new SessionManager(
      (message) => sent.push(message), () => {}, store, "runner", undefined, undefined, undefined, 1,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gate = manager as any;
    assert.equal(await gate.acquireAdmission("s1"), true);
    const second = gate.acquireAdmission("s2") as Promise<boolean>;
    assert.equal(store.readMeta("s2")?.capacityWait?.kind, "runner_capacity");

    assert.equal(manager.configureCapacity({ configuredUnits: 2, revision: 1 }), true);
    assert.equal(await second, true, "the new unit is reconsidered immediately without a restart");
    assert.deepEqual([...gate.admitted].sort(), ["s1", "s2"]);
    assert.deepEqual(manager.capacityState(), {
      configuredUnits: 2,
      revision: 1,
      authority: "control_plane",
      usedUnits: 2,
      availableUnits: 0,
      queuedSessions: 0,
      blockers: [],
      dimensions: {
        activeTurns: { used: 0, limit: 2, available: 2 },
        residentProcessUnits: { used: 2, limit: 2, available: 0 },
        retainedSessions: { used: 0, limit: null, available: null },
        parkedSessions: 0,
        idleProcessPolicy: "retain",
      },
    });

    assert.equal(manager.configureCapacity({ configuredUnits: 1, revision: 2 }), true);
    assert.equal(manager.capacityState().usedUnits, 2, "a decrease never evicts either existing lease");
    assert.equal(manager.capacityState().availableUnits, 0);
    assert.equal(manager.configureCapacity({ configuredUnits: 3, revision: 2 }), false,
      "one revision cannot be replayed with different content");
    const third = gate.acquireAdmission("s3") as Promise<boolean>;
    assert.equal(store.readMeta("s3")?.capacityWait?.kind, "runner_capacity");
    gate.releaseAdmission("s1");
    assert.equal(await Promise.race([
      third.then(() => "admitted"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 30)),
    ]), "waiting", "the waiter stays parked until usage falls below the new ceiling");
    gate.releaseAdmission("s2");
    assert.equal(await third, true);
    assert.ok(sent.some((message) => message.type === "runner_capacity_status" &&
      message.status.configuredUnits === 1 && message.status.usedUnits === 2));
    gate.releaseAdmission("s3");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an implicit active-turn limit does not narrow preserved residents after a capacity decrease", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-implicit-active-turn-decrease-"));
  try {
    const store = new SessionStore(root);
    for (const id of ["s1", "s2"]) store.create(meta(id));
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, undefined, 2,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    assert.equal(await internals.acquireAdmission("s1"), true);
    assert.equal(await internals.acquireAdmission("s2"), true);
    assert.equal(internals.acquireActiveTurn("s1"), true);
    assert.equal(internals.acquireActiveTurn("s2"), true);

    assert.equal(manager.configureCapacity({ configuredUnits: 1, revision: 1 }), true);
    assert.deepEqual(manager.capacityState().dimensions?.activeTurns, {
      used: 2, limit: 1, available: 0,
    });
    internals.releaseActiveTurn("s1");
    internals.releaseActiveTurn("s2");

    assert.equal(internals.acquireActiveTurn("s1"), true);
    assert.equal(internals.acquireActiveTurn("s2"), true,
      "preserved resident sessions retain the pre-decrease concurrency behavior");
    internals.releaseActiveTurn("s1");
    internals.releaseActiveTurn("s2");
    internals.releaseAdmission("s1");
    internals.releaseAdmission("s2");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn interruption cannot cancel admission or discard an initial prompt before a turn exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-interrupt-"));
  try {
    const sent: RunnerToControlPlane[] = [];
    const store = new SessionStore(root);
    for (const id of ["s1", "s2", "s3"]) store.create(meta(id));
    const manager = new SessionManager((message) => sent.push(message), () => {}, store, "runner", undefined, undefined, undefined, 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gate = manager as any;
    assert.equal(await gate.acquireAdmission("s1"), true);
    const second = gate.acquireAdmission("s2") as Promise<boolean>;
    const third = gate.acquireAdmission("s3") as Promise<boolean>;

    manager.interruptTurn("s2");
    assert.equal(store.readMeta("s2")?.status, "queued");
    assert.equal(store.readEvents("s2").filter((event) => event.payload.kind === "turn_interrupted").length, 0);
    gate.releaseAdmission("s1");
    assert.equal(await second, true, "the existing launch keeps its admission place");
    gate.releaseAdmission("s2");
    assert.equal(await third, true);
    assert.deepEqual([...gate.admitted], ["s3"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second capacity-queued start materializes before driver construction", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-materialized-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    let releaseFirst!: () => void;
    const firstInitialize = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let constructions = 0;
    const factory = () => {
      const index = constructions++;
      return {
        pid: index + 1,
        initialize: async () => {
          if (index === 0) await firstInitialize;
        },
        newSession: async () => {},
        prompt: async () => ({ stopReason: "end_turn" as const }),
        cancel: () => {},
        dispose: () => {},
        setConfig: () => {},
        resolvePermission: () => false,
        agentSessionId: () => null,
      };
    };
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, factory as never, root, 1,
    );
    const first = manager.start(launchSpec(root, "s1"));
    while (constructions === 0) await new Promise<void>((resolve) => setImmediate(resolve));

    let resolveMaterialized!: (ready: boolean) => void;
    const materialized = new Promise<boolean>((resolve) => { resolveMaterialized = resolve; });
    const second = manager.start(
      launchSpec(root, "s2"),
      undefined,
      undefined,
      undefined,
      resolveMaterialized,
    );
    assert.equal(await Promise.race([
      materialized,
      new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error("queued session did not materialize")), 500)),
    ]), true);
    assert.equal(store.readMeta("s2")?.worktreePending, false);
    assert.equal(constructions, 1, "the queued session reaches its fence before driver construction");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.deepEqual((manager as any).admissionQueue.map(
      (entry: { request: { sessionId: string } }) => entry.request.sessionId,
    ), ["s2"]);

    manager.cancel("s2");
    assert.equal(await second, false);
    releaseFirst();
    assert.equal(await first, true);
    manager.stop("s1");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree preparation is bounded before admission while queued Native TUI materialization still completes", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-preparation-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-m", "base"], { cwd: repo, stdio: "ignore" });

    const store = new SessionStore(join(root, "sessions"));
    let releaseFirstPreparation!: () => void;
    const firstPreparation = new Promise<void>((resolve) => { releaseFirstPreparation = resolve; });
    let releaseFirstInitialize!: () => void;
    const firstInitialize = new Promise<void>((resolve) => { releaseFirstInitialize = resolve; });
    const preparationCalls: string[] = [];
    let constructions = 0;
    const factory = () => {
      const index = constructions++;
      return {
        pid: index + 1,
        initialize: async () => {
          if (index === 0) await firstInitialize;
        },
        newSession: async () => {},
        prompt: async () => ({ stopReason: "end_turn" as const }),
        cancel: () => {},
        dispose: () => {},
        setConfig: () => {},
        resolvePermission: () => false,
        agentSessionId: () => null,
      };
    };
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, factory as never, root, 1,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    internals.createSessionWorktree = async (
      _repoPath: string,
      sessionId: string,
    ) => {
      preparationCalls.push(sessionId);
      if (sessionId === "s1") await firstPreparation;
      // A real linked worktree, not a fabricated path: launch re-proves the selection's Git
      // registration immediately before constructing the provider.
      const path = join(root, `worktree-${sessionId}`);
      execFileSync("git", ["worktree", "add", "-B", `agent/${sessionId}`, path, "HEAD"],
        { cwd: repo, stdio: "ignore" });
      return { path, branch: `agent/${sessionId}` };
    };

    const first = manager.start({ ...launchSpec(repo, "s1"), useWorktree: true });
    const secondMaterialized = new Promise<boolean>((resolve) => {
      void manager.start(
        { ...launchSpec(repo, "s2"), useWorktree: true },
        undefined,
        undefined,
        undefined,
        resolve,
      );
    });
    while (preparationCalls.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(preparationCalls, ["s1"], "the second git preparation waits for the bounded permit");

    releaseFirstPreparation();
    assert.equal(await Promise.race([
      secondMaterialized,
      new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error("second worktree did not materialize after permit release")), 1_000)),
    ]), true);
    assert.deepEqual(preparationCalls, ["s1", "s2"]);
    // The admitted session constructs its provider after re-proving its own worktree, which is not
    // ordered against the queued session's materialization. Wait for that construction instead of
    // assuming it already happened, so the count below measures admission and nothing else.
    for (let attempt = 0; attempt < 500 && constructions === 0; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(constructions, 1, "the second provider remains behind process admission");

    manager.cancel("s2");
    releaseFirstInitialize();
    assert.equal(await first, true);
    manager.stop("s1");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-session worktree replacements serialize at limits above one and stale release preserves the winner", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-preparation-generation-"));
  try {
    const store = new SessionStore(root);
    for (const id of ["s1", "s2"]) store.create(meta(id));
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, root, 4,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gate = manager as any;
    const firstGeneration = gate.beginLaunchGeneration("s1") as number;
    assert.equal(await gate.acquireWorktreePreparation("s1", firstGeneration), true);
    const replacementGeneration = gate.beginLaunchGeneration("s1") as number;
    const replacement = gate.acquireWorktreePreparation("s1", replacementGeneration) as Promise<boolean>;
    const otherGeneration = gate.beginLaunchGeneration("s2") as number;
    assert.equal(await gate.acquireWorktreePreparation("s2", otherGeneration), true);
    assert.equal(await Promise.race([
      replacement.then(() => "acquired"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 30)),
    ]), "waiting", "same-session replacement waits even though global capacity remains");

    gate.releaseWorktreePreparation(firstGeneration);
    assert.equal(await replacement, true);
    assert.deepEqual(
      [...gate.worktreePreparations].sort((a, b) => a - b),
      [replacementGeneration, otherGeneration].sort((a, b) => a - b),
    );
    gate.releaseWorktreePreparation(firstGeneration);
    assert.equal(
      gate.worktreePreparations.has(replacementGeneration),
      true,
      "a stale duplicate release cannot release the replacement's ownership",
    );
    assert.deepEqual(gate.worktreePreparationQueue, []);
    gate.releaseWorktreePreparation(otherGeneration);
    gate.releaseWorktreePreparation(replacementGeneration);
    assert.deepEqual([...gate.worktreePreparations], []);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelling a queued same-session worktree replacement removes its waiter without leaking the active permit", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-preparation-cancel-"));
  try {
    const store = new SessionStore(root);
    store.create(meta("s1"));
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, root, 4,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gate = manager as any;
    const firstGeneration = gate.beginLaunchGeneration("s1") as number;
    assert.equal(await gate.acquireWorktreePreparation("s1", firstGeneration), true);
    const replacementGeneration = gate.beginLaunchGeneration("s1") as number;
    const replacement = gate.acquireWorktreePreparation("s1", replacementGeneration) as Promise<boolean>;
    manager.cancel("s1");
    assert.equal(await replacement, false);
    assert.deepEqual([...gate.worktreePreparations], [firstGeneration]);
    gate.releaseWorktreePreparation(firstGeneration);
    assert.deepEqual([...gate.worktreePreparations], []);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree preparation bound is enforced across runner processes sharing the data root", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-preparation-shared-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    store.create(meta("s1"));
    store.create(meta("s2"));
    const firstManager = new SessionManager(
      () => {}, () => {}, store, "runner-a", undefined, undefined, root, 1,
    );
    const secondManager = new SessionManager(
      () => {}, () => {}, store, "runner-b", undefined, undefined, root, 1,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = firstManager as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = secondManager as any;
    const firstGeneration = first.beginLaunchGeneration("s1") as number;
    const secondGeneration = second.beginLaunchGeneration("s2") as number;
    assert.equal(await first.acquireWorktreePreparation("s1", firstGeneration), true);
    const waiting = second.acquireWorktreePreparation("s2", secondGeneration) as Promise<boolean>;
    assert.equal(await Promise.race([
      waiting.then(() => "acquired"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 50)),
    ]), "waiting");
    first.releaseWorktreePreparation(firstGeneration);
    assert.equal(await Promise.race([
      waiting,
      new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error("shared worktree permit was not observed")), 1_000)),
    ]), true);
    second.releaseWorktreePreparation(secondGeneration);
    firstManager.shutdownAll();
    secondManager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-session worktree preparation is exclusive across runner processes when global capacity remains", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-preparation-shared-session-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    store.create(meta("s1"));
    const firstManager = new SessionManager(
      () => {}, () => {}, store, "runner-a", undefined, undefined, root, 4,
    );
    const secondManager = new SessionManager(
      () => {}, () => {}, store, "runner-b", undefined, undefined, root, 4,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = firstManager as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = secondManager as any;
    const firstGeneration = first.beginLaunchGeneration("s1") as number;
    const secondGeneration = second.beginLaunchGeneration("s1") as number;
    assert.equal(await first.acquireWorktreePreparation("s1", firstGeneration), true);
    const waiting = second.acquireWorktreePreparation("s1", secondGeneration) as Promise<boolean>;
    assert.equal(await Promise.race([
      waiting.then(() => "acquired"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 50)),
    ]), "waiting", "the shared per-session lease serializes rolling runner replacements");
    first.releaseWorktreePreparation(firstGeneration);
    assert.equal(await Promise.race([
      waiting,
      new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error("shared same-session lease was not observed")), 1_000)),
    ]), true);
    second.releaseWorktreePreparation(secondGeneration);
    firstManager.shutdownAll();
    secondManager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shutdown fences an active worktree continuation without releasing its lease early", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-preparation-shutdown-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-m", "base"], { cwd: repo, stdio: "ignore" });
    const store = new SessionStore(join(root, "sessions"));
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => { releasePreparation = resolve; });
    let preparationStarted = false;
    let constructions = 0;
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined,
      (() => {
        constructions++;
        throw new Error("provider must not be constructed after shutdown");
      }) as never,
      root,
      4,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    internals.createSessionWorktree = async (
      _repoPath: string,
      sessionId: string,
    ) => {
      preparationStarted = true;
      await preparation;
      return { path: join(root, `worktree-${sessionId}`), branch: `agent/${sessionId}` };
    };

    const start = manager.start({ ...launchSpec(repo, "s1"), useWorktree: true });
    while (!preparationStarted) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(internals.worktreePreparationAdmission.usedCapacity(), 1);
    manager.shutdownAll();
    assert.equal(internals.worktreePreparations.size, 1, "active ownership survives shutdown");
    assert.equal(
      internals.worktreePreparationAdmission.usedCapacity(),
      1,
      "the box-wide lease remains held while the git subprocess is unresolved",
    );

    releasePreparation();
    assert.equal(await start, false);
    assert.equal(constructions, 0);
    assert.equal(internals.worktreePreparations.size, 0);
    assert.equal(internals.worktreePreparationAdmission.usedCapacity(), 0);
    assert.equal(store.readMeta("s1")?.worktreePending, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree restart never publishes a catalog from the prior worktree while preparation is pending", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-catalog-fence-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-m", "base"], { cwd: repo, stdio: "ignore" });
    const store = new SessionStore(join(root, "sessions"));
    const oldWorktree = join(root, "old-worktree");
    store.create({
      ...meta("s1"),
      repoPath: repo,
      worktreePath: oldWorktree,
      status: "idle",
      sessionSlashCommands: [{ name: "old", source: "project" }],
      sessionSlashCommandProvenance: {
        driver: "claude-code",
        context: "native",
        root: oldWorktree,
        targetAdapter: "host",
        targetId: null,
        includeUserCommands: true,
        handoffManifestDigest: null,
      },
    });
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => { releasePreparation = resolve; });
    let preparationStarted = false;
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined,
      (() => { throw new Error("provider construction is outside this fence test"); }) as never,
      root,
      4,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    internals.createSessionWorktree = async (_repoPath: string, sessionId: string) => {
      preparationStarted = true;
      await preparation;
      return { path: join(root, `worktree-${sessionId}`), branch: `agent/${sessionId}` };
    };

    const start = manager.start({ ...launchSpec(repo, "s1"), useWorktree: true });
    while (!preparationStarted) await new Promise<void>((resolve) => setImmediate(resolve));
    const pending = store.readMeta("s1")!;
    assert.equal(pending.worktreePending, true);
    assert.equal(pending.worktreePath, null);
    assert.equal(pending.sessionSlashCommands, undefined);
    assert.equal(pending.sessionSlashCommandProvenance, undefined);

    manager.shutdownAll();
    releasePreparation();
    assert.equal(await start, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("in-place restart never carries a catalog proven for a prior worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-in-place-catalog-fence-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    const oldWorktree = join(root, "old-worktree");
    const store = new SessionStore(join(root, "sessions"));
    store.create({
      ...meta("s1"),
      repoPath: repo,
      worktreePath: oldWorktree,
      status: "idle",
      sessionSlashCommands: [{ name: "old", source: "project" }],
      sessionSlashCommandProvenance: {
        driver: "claude-code",
        context: "native",
        root: oldWorktree,
        targetAdapter: "host",
        targetId: null,
        includeUserCommands: true,
        handoffManifestDigest: null,
      },
    });
    let preparationEntered!: () => void;
    const entered = new Promise<void>((resolve) => { preparationEntered = resolve; });
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => { releasePreparation = resolve; });
    const factory = () => ({
      pid: 1,
      initialize: async () => {},
      newSession: async () => {},
      prompt: async () => ({ stopReason: "end_turn" as const }),
      cancel: () => {}, dispose: () => {}, setConfig: () => {},
      resolvePermission: () => false, agentSessionId: () => null,
    });
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, factory as never,
      undefined, 1, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, [],
      async () => {
        preparationEntered();
        await preparation;
      },
    );

    const start = manager.start({ ...launchSpec(repo, "s1"), useWorktree: false });
    await entered;
    const preparing = store.readMeta("s1")!;
    assert.equal(preparing.worktreePath, null);
    assert.equal(preparing.sessionSlashCommands, undefined);
    assert.equal(preparing.sessionSlashCommandProvenance, undefined);
    releasePreparation();
    assert.equal(await start, true);
    manager.stop("s1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelling an admitted pre-launch session releases its slot to the next waiter", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-cancel-start-"));
  try {
    const store = new SessionStore(root);
    store.create(meta("preparing"));
    store.create(meta("next"));
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, undefined, 1,
    );
    // Exercise the exact admitted-before-driver state reached during worktree preparation.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gate = manager as any;
    assert.equal(await gate.acquireAdmission("preparing"), true);
    const next = gate.acquireAdmission("next") as Promise<boolean>;
    manager.cancel("preparing");
    assert.equal(await next, true);
    assert.deepEqual([...gate.admitted], ["next"]);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("weighted admission fills usable capacity with the oldest eligible waiter", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-weighted-"));
  try {
    const store = new SessionStore(root);
    store.create(meta("heavy-1", "claude"));
    store.create(meta("heavy-2", "claude"));
    store.create(meta("light", "codex"));
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, undefined, 3,
      undefined, undefined,
      { agentLimits: {}, agentWeights: { claude: 2, codex: 1 } },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gate = manager as any;
    assert.equal(await gate.acquireAdmission("heavy-1"), true);
    const heavy = gate.acquireAdmission("heavy-2") as Promise<boolean>;
    const light = gate.acquireAdmission("light") as Promise<boolean>;
    gate.drainAdmissionQueue();
    assert.equal(await light, true, "a fitting older-eligible waiter uses the spare unit");
    assert.deepEqual([...gate.admitted].sort(), ["heavy-1", "light"]);
    gate.releaseAdmission("light");
    const stillWaiting = await Promise.race([
      heavy.then(() => "admitted"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 30)),
    ]);
    assert.equal(stillWaiting, "waiting");
    gate.releaseAdmission("heavy-1");
    assert.equal(await heavy, true);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded bypass reserves capacity for an older heavyweight waiter", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-fair-"));
  try {
    const store = new SessionStore(root);
    store.create(meta("blocker", "codex"));
    store.create(meta("heavy", "claude"));
    for (let index = 0; index < 9; index++) store.create(meta(`light-${index}`, "codex"));
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, undefined, 3,
      undefined, undefined,
      { agentLimits: {}, agentWeights: { claude: 3, codex: 1 } },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gate = manager as any;
    assert.equal(await gate.acquireAdmission("blocker"), true);
    const heavy = gate.acquireAdmission("heavy") as Promise<boolean>;
    for (let index = 0; index < 8; index++) {
      const light = gate.acquireAdmission(`light-${index}`) as Promise<boolean>;
      gate.drainAdmissionQueue();
      assert.equal(await light, true);
      gate.releaseAdmission(`light-${index}`);
    }
    const ninth = gate.acquireAdmission("light-8") as Promise<boolean>;
    gate.drainAdmissionQueue();
    assert.equal(await Promise.race([
      ninth.then(() => "admitted"),
      new Promise<string>((resolve) => setTimeout(() => resolve("reserved"), 30)),
    ]), "reserved", "after eight bypasses, new light work waits behind the older heavy request");
    assert.equal(store.readMeta("light-8")?.capacityWait?.kind, "queue_order",
      "a fitting request reports fairness, not a fabricated resource bottleneck");
    gate.releaseAdmission("blocker");
    assert.equal(await heavy, true);
    gate.releaseAdmission("heavy");
    assert.equal(await ninth, true);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider limits are enforced across runner processes sharing the data root", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-provider-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    store.create(meta("s1"));
    store.create(meta("s2"));
    const policy = { agentLimits: { claude: 1 }, agentWeights: {} };
    const firstManager = new SessionManager(
      () => {}, () => {}, store, "runner-a", undefined, undefined, root, 4,
      undefined, undefined, policy,
    );
    const secondManager = new SessionManager(
      () => {}, () => {}, store, "runner-b", undefined, undefined, root, 4,
      undefined, undefined, policy,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = firstManager as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = secondManager as any;
    assert.equal(await first.acquireAdmission("s1"), true);
    const waiting = second.acquireAdmission("s2") as Promise<boolean>;
    assert.equal(await Promise.race([
      waiting.then(() => "admitted"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 50)),
    ]), "waiting");
    first.releaseAdmission("s1");
    assert.equal(await Promise.race([
      waiting,
      new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error("provider slot was not observed")), 1500)),
    ]), true);
    firstManager.shutdownAll();
    secondManager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cloud target limits are enforced across runner processes independently of agent quotas", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-cloud-target-"));
  try {
    const first = new BoxAdmission(root, 4);
    const second = new BoxAdmission(root, 4);
    const request = { agentId: "codex", weight: 1, targetId: "runner:r:cloud:metered", targetLimit: 1 };
    assert.equal(first.acquire({ ...request, sessionId: "cloud-1" }), true);
    assert.equal(second.acquire({ ...request, sessionId: "cloud-2" }), false);
    first.release("cloud-1");
    assert.equal(second.acquire({ ...request, sessionId: "cloud-2" }), true);
    second.releaseAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Seatbelt serializes a shared provider transcript store across runner processes", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-seatbelt-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    store.create(meta("s1", "claude-primary"));
    store.create(meta("s2", "claude-reviewer"));
    store.create({ ...meta("acp", "generic-acp"), driver: "acp", command: "agent" });
    const isolation = { mode: "seatbelt" as const, network: "inherit" as const };
    const firstManager = new SessionManager(
      () => {}, () => {}, store, "runner-a", undefined, undefined, root, 4,
      undefined, undefined, { agentLimits: {}, agentWeights: {} }, isolation,
    );
    const secondManager = new SessionManager(
      () => {}, () => {}, store, "runner-b", undefined, undefined, root, 4,
      undefined, undefined, { agentLimits: {}, agentWeights: {} }, isolation,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = firstManager as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = secondManager as any;
    assert.equal(first.admissionRequest("acp").exclusiveGroup, undefined, "unknown ACP state is not serialized by guessing");
    assert.equal(await first.acquireAdmission("s1"), true);
    const waiting = second.acquireAdmission("s2") as Promise<boolean>;
    assert.equal(await Promise.race([
      waiting.then(() => "admitted"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 50)),
    ]), "waiting", "different agent ids still share one Claude transcript lease");
    first.releaseAdmission("s1");
    assert.equal(await Promise.race([
      waiting,
      new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error("Seatbelt provider lease was not observed")), 1500)),
    ]), true);
    firstManager.shutdownAll();
    secondManager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart cannot bypass a fork's in-process provider lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-fork-restart-"));
  try {
    const store = new SessionStore(root);
    store.create(meta("s1"));
    const sent: RunnerToControlPlane[] = [];
    let constructed = false;
    const manager = new SessionManager(
      (message) => sent.push(message), () => {}, store, "runner", undefined,
      (() => { constructed = true; throw new Error("must not construct"); }) as never,
      undefined, 4, undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "seatbelt", network: "inherit" },
    );
    // Exercise the exact same-process interlock held by forkConversation while it owns admission.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).forking.add("s1");
    await manager.start({
      sessionId: "s1", workspaceId: "repo", workspacePath: "/repo", agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code",
    });
    assert.equal(constructed, false);
    assert.match(JSON.stringify(sent), /conversation fork is in progress.*wait before restarting/);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a superseded duplicate launch cannot release the winning process slot", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-supersede-"));
  try {
    const store = new SessionStore(root);
    store.create(meta("s1"));
    const initializers: Array<() => void> = [];
    const factory = () => {
      let release!: () => void;
      const initialized = new Promise<void>((resolve) => { release = resolve; });
      initializers.push(release);
      return {
        pid: 1,
        initialize: () => initialized,
        newSession: async () => {},
        prompt: async () => ({ stopReason: "end_turn" as const }),
        cancel: () => {}, dispose: () => {}, setConfig: () => {},
        resolvePermission: () => false, agentSessionId: () => null,
      };
    };
    const manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, undefined, 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    assert.equal(await internals.acquireAdmission("s1"), true);
    const firstGeneration = internals.beginLaunchGeneration("s1");
    const first = internals.launch(store.readMeta("s1"), undefined, firstGeneration) as Promise<boolean>;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(initializers.length, 1, "the first launch reached driver initialization");
    assert.equal(await internals.acquireAdmission("s1"), true);
    const secondGeneration = internals.beginLaunchGeneration("s1");
    const second = internals.launch(store.readMeta("s1"), undefined, secondGeneration) as Promise<boolean>;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(initializers.length, 2, "the replacement reached driver initialization");

    initializers[0]!();
    assert.equal(await first, false, "the older launch observes that it was superseded");
    internals.releaseAdmissionIfInactive("s1");
    assert.deepEqual([...internals.admitted], ["s1"], "the winning live entry still owns the slot");

    initializers[1]!();
    assert.equal(await second, true);
    manager.stop("s1");
    assert.deepEqual([...internals.admitted], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a superseded async launch preparation cannot patch or publish over its replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-stale-prepare-"));
  try {
    const store = new SessionStore(root);
    const sent: RunnerToControlPlane[] = [];
    let preparationEntered!: () => void;
    const entered = new Promise<void>((resolve) => { preparationEntered = resolve; });
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => { releasePreparation = resolve; });
    const factory = () => ({
      pid: 1,
      initialize: async () => {},
      newSession: async () => {},
      prompt: async () => ({ stopReason: "end_turn" as const }),
      cancel: () => {}, dispose: () => {}, setConfig: () => {},
      resolvePermission: () => false, agentSessionId: () => null,
    });
    const manager = new SessionManager(
      (message) => sent.push(message), () => {}, store, "runner", undefined, factory as never,
      undefined, 1, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, [],
      async (launchMeta) => {
        if (launchMeta.driver !== "claude-code") return;
        preparationEntered();
        await preparation;
        launchMeta.capabilities = { supportsImages: true };
        launchMeta.sessionSlashCommands = [{ name: "stale", source: "project" }];
      },
    );

    const first = manager.start({
      ...launchSpec(root, "s1"),
      capabilities: { supportsImages: true },
    });
    await entered;
    const second = manager.start({
      ...launchSpec(root, "s1"),
      agentId: "codex",
      driver: "codex",
      command: "codex",
      capabilities: { supportsImages: false },
    });
    assert.equal(await second, true);
    releasePreparation();
    assert.equal(await first, false);

    const current = store.readMeta("s1");
    assert.equal(current?.driver, "codex");
    assert.deepEqual(current?.capabilities, { supportsImages: false });
    assert.equal(current?.sessionSlashCommands, undefined);
    assert.equal(
      sent.filter((message) => message.type === "session_runtime_updated").length,
      0,
      "the stale generation cannot publish a runtime snapshot",
    );
    manager.stop("s1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a superseded deferred launch cannot reap the replacement's reused worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-stale-worktree-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-m", "base"], { cwd: repo, stdio: "ignore" });
    const store = new SessionStore(join(root, "sessions"));
    let preparationEntered!: () => void;
    const entered = new Promise<void>((resolve) => { preparationEntered = resolve; });
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => { releasePreparation = resolve; });
    let preparations = 0;
    const factory = () => ({
      pid: 1,
      initialize: async () => {},
      newSession: async () => {},
      prompt: async () => ({ stopReason: "end_turn" as const }),
      cancel: () => {}, dispose: () => {}, setConfig: () => {},
      resolvePermission: () => false, agentSessionId: () => null,
    });
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, factory as never,
      root, 1, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, [],
      async () => {
        preparations++;
        if (preparations !== 1) return;
        preparationEntered();
        await preparation;
      },
    );

    const spec = { ...launchSpec(repo, "s1"), useWorktree: true };
    const first = manager.start(spec);
    await entered;
    const reusedPath = store.readMeta("s1")?.worktreePath;
    assert.ok(reusedPath && existsSync(reusedPath), "the first generation materializes its worktree");

    const second = manager.start(spec);
    assert.equal(await second, true);
    assert.equal(store.readMeta("s1")?.worktreePath, reusedPath);
    releasePreparation();
    assert.equal(await first, false);

    assert.equal(store.readMeta("s1")?.worktreePath, reusedPath, "the replacement keeps its durable root");
    assert.equal(existsSync(reusedPath), true, "the stale generation cannot reap the reused worktree");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((manager as any).active.has("s1"), true, "the replacement provider remains active");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.deepEqual([...(manager as any).admitted], ["s1"], "the replacement keeps its process slot");

    await manager.delete("s1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deferred cancellation preserves a reused dirty worktree and reaps a newly created worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-owned-worktree-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-m", "base"], { cwd: repo, stdio: "ignore" });
    const store = new SessionStore(join(root, "sessions"));
    let gateReused = false;
    let reusedEntered!: () => void;
    const reusedPreparationEntered = new Promise<void>((resolve) => { reusedEntered = resolve; });
    let releaseReused!: () => void;
    const reusedPreparation = new Promise<void>((resolve) => { releaseReused = resolve; });
    let newEntered!: () => void;
    const newPreparationEntered = new Promise<void>((resolve) => { newEntered = resolve; });
    let releaseNew!: () => void;
    const newPreparation = new Promise<void>((resolve) => { releaseNew = resolve; });
    const factory = () => ({
      pid: 1,
      initialize: async () => {}, newSession: async () => {},
      prompt: async () => ({ stopReason: "end_turn" as const }),
      cancel: () => {}, dispose: () => {}, setConfig: () => {},
      resolvePermission: () => false, agentSessionId: () => null,
    });
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, factory as never,
      root, 2, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, [],
      async (launchMeta) => {
        if (launchMeta.sessionId === "reused" && gateReused) {
          reusedEntered();
          await reusedPreparation;
        }
        if (launchMeta.sessionId === "new") {
          newEntered();
          await newPreparation;
        }
      },
    );

    const reusedSpec = { ...launchSpec(repo, "reused"), useWorktree: true };
    assert.equal(await manager.start(reusedSpec), true);
    manager.stop("reused");
    const reusedPath = store.readMeta("reused")?.worktreePath;
    assert.ok(reusedPath && existsSync(reusedPath));
    const dirtyPath = join(reusedPath, "keep-me.txt");
    writeFileSync(dirtyPath, "uncommitted user work\n");

    gateReused = true;
    const reusedRestart = manager.start(reusedSpec);
    await reusedPreparationEntered;
    manager.cancel("reused");
    releaseReused();
    assert.equal(await reusedRestart, false);
    assert.equal(existsSync(reusedPath), true, "a reused worktree survives launch cancellation");
    assert.equal(readFileSync(dirtyPath, "utf8"), "uncommitted user work\n");
    assert.equal(store.readMeta("reused")?.worktreePath, reusedPath);

    const newSpec = { ...launchSpec(repo, "new"), useWorktree: true };
    const newStart = manager.start(newSpec);
    await newPreparationEntered;
    const newPath = store.readMeta("new")?.worktreePath;
    assert.ok(newPath && existsSync(newPath));
    manager.cancel("new");
    releaseNew();
    assert.equal(await newStart, false);
    assert.equal(existsSync(newPath), false, "a worktree created by the cancelled launch is reaped");
    assert.equal(store.readMeta("new")?.worktreePath, null);

    await manager.delete("reused");
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("delete awaiting a reused worktree return still removes the explicitly deleted root", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-delete-reused-worktree-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-m", "base"], { cwd: repo, stdio: "ignore" });
    const store = new SessionStore(join(root, "sessions"));
    const factory = () => ({
      pid: 1,
      initialize: async () => {}, newSession: async () => {},
      prompt: async () => ({ stopReason: "end_turn" as const }),
      cancel: () => {}, dispose: () => {}, setConfig: () => {},
      resolvePermission: () => false, agentSessionId: () => null,
    });
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, factory as never,
      root, 2,
    );
    const spec = { ...launchSpec(repo, "deleted-reuse"), useWorktree: true };
    assert.equal(await manager.start(spec), true);
    manager.stop("deleted-reuse");
    const reusedPath = store.readMeta("deleted-reuse")?.worktreePath;
    assert.ok(reusedPath && existsSync(reusedPath));
    const dirtyPath = join(reusedPath, "delete-me.txt");
    writeFileSync(dirtyPath, "session-owned work\n");

    // Gate after createWorktree has identified and returned the healthy registered root, but
    // before startGeneration can republish it to the row that Restart reset to worktreePath=null.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = manager as any;
    const createSessionWorktree = internals.createSessionWorktree;
    let reusedReturned!: () => void;
    const returned = new Promise<void>((resolve) => { reusedReturned = resolve; });
    let releaseReturn!: () => void;
    const release = new Promise<void>((resolve) => { releaseReturn = resolve; });
    internals.createSessionWorktree = async (...args: unknown[]) => {
      const handle = await createSessionWorktree(...args);
      assert.equal(handle.created, false);
      reusedReturned();
      await release;
      return handle;
    };

    const restart = manager.start(spec);
    await returned;
    assert.equal(store.readMeta("deleted-reuse")?.worktreePath, null);
    const deletion = manager.delete("deleted-reuse");
    releaseReturn();
    assert.equal(await restart, false);
    await deletion;

    assert.equal(store.has("deleted-reuse"), false);
    assert.equal(existsSync(reusedPath), false, "explicit deletion reaps a reused root returned late");
    assert.equal(existsSync(dirtyPath), false);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("delete racing an attached-worktree restart never removes the operator-owned worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-delete-attached-worktree-"));
  try {
    const repo = join(root, "repo");
    const operatorRoot = join(root, "operator");
    const attachedPath = join(operatorRoot, "attached");
    mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-m", "base"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["worktree", "add", "-b", "operator/attached", attachedPath], { cwd: repo, stdio: "ignore" });
    const store = new SessionStore(join(root, "sessions"));
    let gateRestart = false;
    let restartEntered!: () => void;
    const entered = new Promise<void>((resolve) => { restartEntered = resolve; });
    let releaseRestart!: () => void;
    const release = new Promise<void>((resolve) => { releaseRestart = resolve; });
    const factory = () => ({
      pid: 1, initialize: async () => {}, newSession: async () => {},
      prompt: async () => ({ stopReason: "end_turn" as const }),
      cancel: () => {}, dispose: () => {}, setConfig: () => {},
      resolvePermission: () => false, agentSessionId: () => null,
    });
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, factory as never,
      root, 2, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, [],
      async () => {
        if (!gateRestart) return;
        restartEntered();
        await release;
      },
    );
    (manager as unknown as { configuredProjectPaths: string[] }).configuredProjectPaths = [operatorRoot];
    const spec = launchSpec(repo, "attached-restart");
    assert.equal(await manager.start(spec), true);
    await manager.attachWorktree(spec.sessionId, attachedPath);
    manager.stop(spec.sessionId);

    gateRestart = true;
    const restart = manager.start(spec);
    await entered;
    await manager.delete(spec.sessionId);
    releaseRestart();
    assert.equal(await restart, false);

    assert.equal(existsSync(attachedPath), true, "the stale launch cannot reap an attached worktree");
    execFileSync("git", ["-C", repo, "show-ref", "--verify", "--quiet", "refs/heads/operator/attached"]);
    assert.deepEqual(new WorktreeCleanupJournal(root).list(), []);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a delayed exit from a retired driver cannot tear down its replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-retired-driver-exit-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    const store = new SessionStore(join(root, "sessions"));
    const exits: Array<(code: number | null) => void> = [];
    let launches = 0;
    const factory = (_driver: unknown, _launch: unknown, callbacks: { onExit(code: number | null): void }) => {
      const launch = ++launches;
      exits.push(callbacks.onExit);
      return {
        pid: launch, initialize: async () => {}, newSession: async () => {}, close: async () => {},
        prompt: async () => ({ stopReason: "end_turn" as const }), cancel: () => {}, dispose: () => {},
        setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => `provider-${launch}`,
      };
    };
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, factory as never, root, 2,
    );
    const spec = launchSpec(repo, "retired-exit");
    assert.equal(await manager.start(spec), true);
    const first = (manager as unknown as { active: Map<string, { client: unknown }> }).active.get(spec.sessionId);
    assert.ok(first);
    assert.equal(await manager.start(spec), true);
    const internals = manager as unknown as {
      active: Map<string, { client: unknown }>;
      admitted: Set<string>;
      sessionCommandAuthority: {
        refresh(sessionId: string, commands: Array<{ name: string; source: "project" }>, provenance: string):
          Array<{ invocation?: { id: string; catalogRevision: string; executionMode: "passthrough" } }>;
        resolve(request: {
          sessionId: string;
          providerCommandId: string;
          catalogRevision: string;
          expectedExecutionMode: "passthrough";
        }): { ok: boolean };
      };
    };
    const replacement = internals.active.get(spec.sessionId);
    assert.ok(replacement && replacement.client !== first.client);
    const [command] = internals.sessionCommandAuthority.refresh(
      spec.sessionId,
      [{ name: "deploy", source: "project" }],
      "replacement-catalog",
    );
    assert.ok(command?.invocation);

    exits[0]!(1);

    assert.equal(internals.active.get(spec.sessionId), replacement);
    assert.equal(internals.admitted.has(spec.sessionId), true);
    assert.equal(internals.sessionCommandAuthority.resolve({
      sessionId: spec.sessionId,
      providerCommandId: command.invocation.id,
      catalogRevision: command.invocation.catalogRevision,
      expectedExecutionMode: command.invocation.executionMode,
    }).ok, true, "the retired driver's exit must not revoke its replacement's command authority");
    manager.stop(spec.sessionId);
    await (manager as unknown as { closing: Map<string, { promise: Promise<void> }> })
      .closing.get(spec.sessionId)?.promise;
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed close and dispose retain lifecycle fences until the exact client exits", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-provider-retirement-fence-"));
  let manager: SessionManager | undefined;
  let deletion: Promise<void> | undefined;
  let teardown: Promise<void> | undefined;
  let releaseDeletionTail!: () => void;
  const deletionTail = new Promise<void>((resolve) => { releaseDeletionTail = resolve; });
  const removeFixture = () => teardown ??= (async () => {
    try {
      // Row/worktree disappearance precedes boundary cleanup. Await the actual retry, including
      // its rejection, before shutdown clears the manager's in-flight deletion bookkeeping.
      await deletion;
    } finally {
      manager?.shutdownAll();
      rmSync(root, { recursive: true, force: true });
    }
  })();
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-m", "base"], { cwd: repo, stdio: "ignore" });
    const store = new SessionStore(join(root, "sessions"));
    const siblingStore = new SessionStore(join(root, "sessions"));
    let reportExit!: (code: number | null) => void;
    const client = {
      pid: 1, initialize: async () => {}, newSession: async () => {},
      close: async () => { throw new Error("close failed"); },
      prompt: async () => ({ stopReason: "end_turn" as const }), cancel: () => {},
      dispose: () => { throw new Error("dispose failed"); },
      setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => "provider-1",
    };
    const factory = (_driver: unknown, _launch: unknown, callbacks: { onExit(code: number | null): void }) => {
      reportExit = callbacks.onExit;
      return client;
    };
    manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, factory as never, root, 1,
    );
    const spec = { ...launchSpec(repo, "retirement-fence"), useWorktree: true };
    assert.equal(await manager.start(spec), true);
    const worktreePath = store.readMeta(spec.sessionId)?.worktreePath;
    assert.ok(worktreePath && existsSync(worktreePath));
    const internals = manager as unknown as {
      active: Map<string, { worktreeLeaseOwner?: string }>;
      admitted: Set<string>;
      closing: Map<string, { promise: Promise<void> }>;
      lockOwner: string;
      deleting: Set<string>;
      reapWorktree(record: WorktreeCleanupRecord, cleanupCurrentGeneration?: boolean): Promise<void>;
    };
    assert.ok(internals.active.get(spec.sessionId)?.worktreeLeaseOwner);
    assert.equal(store.acquireLock(spec.sessionId, internals.lockOwner), true);

    manager.stop(spec.sessionId);
    const retirement = internals.closing.get(spec.sessionId);
    assert.ok(retirement);
    await retirement.promise;
    assert.equal(internals.closing.get(spec.sessionId), retirement);
    assert.equal(internals.admitted.has(spec.sessionId), true);
    assert.equal(store.ownsLock(spec.sessionId, internals.lockOwner), true);
    assert.equal(siblingStore.acquireWorktreeLease(spec.sessionId, "cleanup-contender"), false);
    assert.equal(await manager.start(spec), false, "restart must remain fail-closed without exit proof");
    await assert.rejects(manager.delete(spec.sessionId), /retirement is unconfirmed/);
    assert.equal(store.has(spec.sessionId), true, "failed deletion retains complete cleanup provenance");
    assert.equal(existsSync(worktreePath), true);

    const deleteSession = manager.delete.bind(manager);
    t.mock.method(manager, "delete", (sessionId: string) => deletion = deleteSession(sessionId));
    const reapWorktree = internals.reapWorktree.bind(manager);
    let deletionTailEntered = false;
    t.mock.method(internals, "reapWorktree", async (...args: Parameters<typeof reapWorktree>) => {
      await reapWorktree(...args);
      // Hold the real deletion after worktree removal but before its final boundary cleanup.
      deletionTailEntered = true;
      await deletionTail;
    });
    reportExit(1);
    for (let attempt = 0; attempt < 500 && !deletionTailEntered; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(deletionTailEntered, true, "deferred deletion must reach the controlled cleanup tail");
    assert.ok(deletion, "exact-client exit must invoke the real automatic deletion retry");
    assert.equal(internals.closing.has(spec.sessionId), false);
    assert.equal(internals.admitted.has(spec.sessionId), false);
    assert.equal(store.ownsLock(spec.sessionId, internals.lockOwner), false);
    assert.equal(store.has(spec.sessionId), false,
      "late exact-client exit must automatically resume the already-requested deletion");
    assert.equal(existsSync(worktreePath), false,
      "automatic deletion retry must finish its journaled worktree cleanup");
    assert.equal(internals.deleting.has(spec.sessionId), true,
      "row/worktree disappearance must not be mistaken for complete deletion");
    const fixtureRemoval = removeFixture();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(existsSync(root), true, "fixture removal must wait for the held deletion tail");
    assert.equal(internals.deleting.has(spec.sessionId), true, "shutdown must also wait for deletion");
    releaseDeletionTail();
    await fixtureRemoval;
    assert.equal(existsSync(root), false, "the completed deletion permits fixture-root removal");
  } finally {
    releaseDeletionTail();
    await removeFixture();
  }
});

test("a synchronous no-close retirement failure is reported while retaining its lifecycle fence", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-provider-retirement-sync-failure-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    const store = new SessionStore(join(root, "sessions"));
    let reportExit!: (code: number | null) => void;
    const client = {
      pid: 1, initialize: async () => {}, newSession: async () => {},
      prompt: async () => ({ stopReason: "end_turn" as const }), cancel: () => {},
      dispose: () => { throw new Error("dispose failed"); },
      setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => "provider-sync-failure",
    };
    const factory = (_driver: unknown, _launch: unknown, callbacks: { onExit(code: number | null): void }) => {
      reportExit = callbacks.onExit;
      return client;
    };
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, factory as never, root, 1,
    );
    const spec = launchSpec(repo, "retirement-sync-failure");
    assert.equal(await manager.start(spec), true);
    const internals = manager as unknown as {
      admitted: Set<string>;
      closing: Map<string, { client: unknown }>;
    };

    assert.throws(() => manager.stop(spec.sessionId), /dispose failed/,
      "Stop must report that provider retirement remains unconfirmed");
    assert.equal(store.readMeta(spec.sessionId)?.status, "stopped");
    assert.equal(internals.closing.get(spec.sessionId)?.client, client);
    assert.equal(internals.admitted.has(spec.sessionId), true);
    assert.equal(await manager.start(spec), false, "restart must remain fenced until exact exit proof");

    reportExit(1);
    assert.equal(internals.closing.has(spec.sessionId), false);
    assert.equal(internals.admitted.has(spec.sessionId), false);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed synchronous retirement automatically resumes deletion after exact exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-provider-retirement-sync-delete-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-m", "base"], { cwd: repo, stdio: "ignore" });
    const store = new SessionStore(join(root, "sessions"));
    let reportExit!: (code: number | null) => void;
    const client = {
      pid: 1, initialize: async () => {}, newSession: async () => {},
      prompt: async () => ({ stopReason: "end_turn" as const }), cancel: () => {},
      dispose: () => { throw new Error("dispose failed"); },
      setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => "provider-sync-delete",
    };
    const factory = (_driver: unknown, _launch: unknown, callbacks: { onExit(code: number | null): void }) => {
      reportExit = callbacks.onExit;
      return client;
    };
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, factory as never, root, 1,
    );
    const spec = { ...launchSpec(repo, "retirement-sync-delete"), useWorktree: true };
    assert.equal(await manager.start(spec), true);
    const worktreePath = store.readMeta(spec.sessionId)?.worktreePath;
    assert.ok(worktreePath && existsSync(worktreePath));
    const internals = manager as unknown as {
      admitted: Set<string>;
      closing: Map<string, { client: unknown }>;
      pendingDeletions: Set<string>;
    };

    await assert.rejects(manager.delete(spec.sessionId), /dispose failed/);
    assert.equal(internals.closing.get(spec.sessionId)?.client, client);
    assert.equal(internals.pendingDeletions.has(spec.sessionId), true);
    assert.equal(store.has(spec.sessionId), true);
    assert.equal(existsSync(worktreePath), true);

    reportExit(1);
    for (let attempt = 0; attempt < 500 &&
        (store.has(spec.sessionId) || existsSync(worktreePath)); attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(internals.closing.has(spec.sessionId), false);
    assert.equal(internals.pendingDeletions.has(spec.sessionId), false);
    assert.equal(internals.admitted.has(spec.sessionId), false);
    assert.equal(store.has(spec.sessionId), false);
    assert.equal(existsSync(worktreePath), false);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orphan recovery cannot release a lock retained by failed provider retirement", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-retirement-orphan-fence-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    const store = new SessionStore(join(root, "sessions"));
    let reportExit!: (code: number | null) => void;
    const client = {
      pid: 1, initialize: async () => {}, newSession: async () => {},
      close: async () => { throw new Error("close failed"); },
      prompt: async () => ({ stopReason: "end_turn" as const }), cancel: () => {},
      dispose: () => { throw new Error("dispose failed"); },
      setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => "provider-orphan",
    };
    const factory = (_driver: unknown, _launch: unknown, callbacks: { onExit(code: number | null): void }) => {
      reportExit = callbacks.onExit;
      return client;
    };
    const manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, factory as never, root, 1,
    );
    const spec = { ...launchSpec(repo, "retirement-orphan-fence"), useWorktree: true };
    assert.equal(await manager.start(spec), true);
    store.patchMeta(spec.sessionId, {
      agentSessionId: "provider-orphan",
      orphanedWork: { pendingTaskIds: ["task-1"], markedAt: 1, reason: "process_exit" },
    });
    const internals = manager as unknown as {
      runOrphanRecovery(sessionId: string): Promise<void>;
      lockOwner: string;
      rewinding: Set<string>;
    };
    assert.equal(store.acquireLock(spec.sessionId, internals.lockOwner), true);
    assert.equal(manager.fenceRewind(spec.sessionId), true,
      "the queued rewind acquires its in-memory fence before retirement begins");

    await assert.rejects(manager.delete(spec.sessionId), /retirement is unconfirmed/);
    assert.equal(store.ownsLock(spec.sessionId, internals.lockOwner), true);
    assert.deepEqual(
      await manager.rewind(spec.sessionId, 1, true),
      { ok: false, error: "provider retirement is still in progress" },
    );
    assert.equal(internals.rewinding.has(spec.sessionId), false,
      "a refused queued rewind must release its pre-acquired in-memory fence");
    await internals.runOrphanRecovery(spec.sessionId);
    assert.equal(
      store.ownsLock(spec.sessionId, internals.lockOwner),
      true,
      "synthetic recovery must not release the retirement-owned cross-process lock",
    );
    assert.equal(manager.fenceRewind(spec.sessionId), false,
      "rewind must not enter while provider retirement remains unconfirmed");
    assert.deepEqual(
      await manager.rewind(spec.sessionId, 1),
      { ok: false, error: "provider retirement is still in progress" },
    );
    assert.equal(
      store.ownsLock(spec.sessionId, internals.lockOwner),
      true,
      "rewind must not release the retirement-owned cross-process lock",
    );

    reportExit(1);
    await manager.delete(spec.sessionId);
    assert.equal(store.has(spec.sessionId), false);
    manager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two runner processes sharing a data directory enforce one box-wide slot", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admission-shared-"));
  try {
    const store = new SessionStore(join(root, "sessions"));
    store.create(meta("s1"));
    store.create(meta("s2"));
    const firstManager = new SessionManager(() => {}, () => {}, store, "runner-a", undefined, undefined, root, 1);
    const secondManager = new SessionManager(() => {}, () => {}, store, "runner-b", undefined, undefined, root, 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = firstManager as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = secondManager as any;
    assert.equal(await first.acquireAdmission("s1"), true);
    const waiting = second.acquireAdmission("s2") as Promise<boolean>;
    const beforeRelease = await Promise.race([
      waiting.then(() => "admitted"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 50)),
    ]);
    assert.equal(beforeRelease, "waiting");
    first.releaseAdmission("s1");
    assert.equal(await Promise.race([
      waiting,
      new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error("shared slot was not observed")), 1500)),
    ]), true);
    firstManager.shutdownAll();
    secondManager.shutdownAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
