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
import { WorktreeCleanupJournal } from "./worktree.js";

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
      return { path: join(root, `worktree-${sessionId}`), branch: `agent/${sessionId}` };
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
