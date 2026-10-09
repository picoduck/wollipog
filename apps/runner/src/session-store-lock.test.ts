import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs, { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SessionStore, type SessionMeta } from "./session-store.js";

/* The per-session writer lock across processes (#2832). Each race runs real child processes against
 * one store directory. A child pauses inside the lock operation right after the last read of the lock
 * file that its decision depends on, and continues only when the test releases it, so check-then-write
 * interleavings are deterministic instead of timing luck. */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const STORE_MODULE = new URL("./session-store.ts", import.meta.url).href;
const ID = "s_lock";

const CHILD_SOURCE = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const config = JSON.parse(process.env.LOCK_RACE_CHILD);
const signal = (suffix) => \`\${config.signalDir}/\${config.name}.\${suffix}\`;
const real = { readFileSync: fs.readFileSync, existsSync: fs.existsSync };
const cell = new Int32Array(new SharedArrayBuffer(4));
let paused = false;
if (config.pauseOn) {
  fs[config.pauseOn] = function (path, ...rest) {
    const result = real[config.pauseOn].call(this, path, ...rest);
    if (!paused && String(path) === config.lockPath) {
      paused = true;
      fs.writeFileSync(signal("checked"), "");
      while (!real.existsSync(signal("go"))) Atomics.wait(cell, 0, 0, 5);
    }
    return result;
  };
  syncBuiltinESMExports();
}
const { SessionStore } = await import(config.storeModule);
const store = new SessionStore(config.root);
let result = null;
if (config.op === "acquire") result = store.acquireLock(config.id, config.owner);
else if (config.op === "refresh") result = store.refreshLock(config.id, config.owner);
else store.releaseLock(config.id, config.owner);
fs.writeFileSync(signal("result"), JSON.stringify(result));
`;

type ChildSpec = {
  name: string;
  op: "acquire" | "refresh" | "release";
  owner: string;
  /** The lock-file call after which the child waits for the test to release it. */
  pauseOn?: "readFileSync" | "existsSync";
};

class LockRace {
  readonly root = mkdtempSync(join(tmpdir(), "wollipog-lock-race-"));
  readonly signalDir = join(this.root, "signals");
  readonly lockPath = join(this.root, ID, "lock");
  readonly guardPath = join(this.root, ID, "lock.guard");
  private readonly childScript = join(this.root, "child.mjs");
  private readonly children = new Map<string, ChildProcess>();

  constructor() {
    fs.mkdirSync(this.signalDir);
    writeFileSync(this.childScript, CHILD_SOURCE);
    new SessionStore(this.root).create(sessionMeta());
  }

  /** Start a child and wait until it is paused inside the operation or has finished it. */
  async start(spec: ChildSpec): Promise<void> {
    const child = spawn(process.execPath, ["--import", "tsx", this.childScript], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        LOCK_RACE_CHILD: JSON.stringify({
          ...spec, id: ID, root: this.root, lockPath: this.lockPath, signalDir: this.signalDir, storeModule: STORE_MODULE,
        }),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    this.children.set(spec.name, child);
    await this.until(() => this.has(spec.name, "checked") || this.has(spec.name, "result") || child.exitCode !== null, `${spec.name} started`);
    if (child.exitCode !== null && !this.has(spec.name, "result")) {
      await exited;
      throw new Error(`${spec.name} exited without a result: ${stderr}`);
    }
  }

  /** Let a paused child finish, and wait for it. */
  async finish(name: string): Promise<void> {
    writeFileSync(join(this.signalDir, `${name}.go`), "");
    const child = this.children.get(name)!;
    await this.until(() => this.has(name, "result") || child.exitCode !== null, `${name} finished`);
  }

  async kill(name: string): Promise<void> {
    const child = this.children.get(name)!;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }

  result(name: string): unknown {
    return JSON.parse(readFileSync(join(this.signalDir, `${name}.result`), "utf8"));
  }

  lockOwner(): string | null {
    try { return readFileSync(this.lockPath, "utf8"); } catch { return null; }
  }

  /** Write a lock held by `owner` whose last refresh was `ageMs` ago. */
  writeLock(owner: string, ageMs: number): void {
    writeFileSync(this.lockPath, owner);
    const at = (Date.now() - ageMs) / 1000;
    utimesSync(this.lockPath, at, at);
  }

  sessionFiles(): string[] {
    return readdirSync(join(this.root, ID)).filter((name) => name.startsWith("lock")).sort();
  }

  async dispose(): Promise<void> {
    for (const child of this.children.values()) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    rmSync(this.root, { recursive: true, force: true });
  }

  private has(name: string, suffix: string): boolean {
    return existsSync(join(this.signalDir, `${name}.${suffix}`));
  }

  private async until(condition: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function sessionMeta(): SessionMeta {
  return {
    sessionId: ID, agentId: "a", workspaceId: "w", repoPath: "/r", worktreePath: "/r", driver: "codex",
    command: "c", args: [], env: {}, context: { kind: "native" }, agentSessionId: "t", status: "idle", title: "lock",
    config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null, seq: 0,
    createdAt: 1, updatedAt: 1,
  };
}

/** A pid that existed a moment ago and has exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid!;
}

function startTimeOf(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

test("of two processes taking a free lock, exactly one wins", async () => {
  const race = new LockRace();
  try {
    await race.start({ name: "a", op: "acquire", owner: "runner-a", pauseOn: "existsSync" });
    await race.start({ name: "b", op: "acquire", owner: "runner-b", pauseOn: "existsSync" });
    await race.finish("a");
    await race.finish("b");
    const winners = ["a", "b"].filter((name) => race.result(name) === true);
    assert.equal(winners.length, 1, "exactly one acquirer holds the lock");
    assert.equal(race.lockOwner(), `runner-${winners[0]}`);
    assert.deepEqual(race.sessionFiles(), ["lock"], "no guard or temp file is left behind");
  } finally {
    await race.dispose();
  }
});

test("of two processes taking over a stale lock, exactly one wins", async () => {
  const race = new LockRace();
  try {
    race.writeLock("dead-runner", 120_000);
    await race.start({ name: "a", op: "acquire", owner: "runner-a", pauseOn: "readFileSync" });
    await race.start({ name: "b", op: "acquire", owner: "runner-b", pauseOn: "readFileSync" });
    await race.finish("a");
    await race.finish("b");
    const winners = ["a", "b"].filter((name) => race.result(name) === true);
    assert.equal(winners.length, 1, "the stale lock is taken over exactly once");
    assert.equal(race.lockOwner(), `runner-${winners[0]}`);
    assert.deepEqual(race.sessionFiles(), ["lock"]);
  } finally {
    await race.dispose();
  }
});

test("a takeover never displaces a lock its owner refreshes in the meantime", async (t) => {
  for (const first of ["owner", "taker"] as const) {
    await t.test(`${first} reaches the lock first`, async () => {
      const race = new LockRace();
      try {
        race.writeLock("runner-o", 120_000);
        const owner: ChildSpec = { name: "o", op: "refresh", owner: "runner-o", pauseOn: "readFileSync" };
        const taker: ChildSpec = { name: "t", op: "acquire", owner: "runner-t", pauseOn: "readFileSync" };
        for (const spec of first === "owner" ? [owner, taker] : [taker, owner]) await race.start(spec);
        // The owner's refresh lands first; a takeover that already judged the lock stale must not follow it.
        await race.finish("o");
        await race.finish("t");
        const refreshed = race.result("o") === true;
        const tookOver = race.result("t") === true;
        assert.ok(!(refreshed && tookOver), "the refresh and the takeover cannot both succeed");
        assert.ok(refreshed || tookOver, "one of them proceeds");
        assert.equal(race.lockOwner(), tookOver ? "runner-t" : "runner-o");
      } finally {
        await race.dispose();
      }
    });
  }
});

test("a takeover is never removed by the stale owner releasing in the meantime", async () => {
  const race = new LockRace();
  try {
    race.writeLock("runner-o", 120_000);
    await race.start({ name: "t", op: "acquire", owner: "runner-t", pauseOn: "readFileSync" });
    await race.start({ name: "o", op: "release", owner: "runner-o", pauseOn: "readFileSync" });
    await race.finish("t");
    await race.finish("o");
    assert.equal(race.result("t"), true);
    assert.equal(race.lockOwner(), "runner-t", "the new owner's lock survives the old owner's release");
    // And the next acquirer does not get it as a free lock.
    await race.start({ name: "f", op: "acquire", owner: "runner-f" });
    assert.equal(race.result("f"), false);
  } finally {
    await race.dispose();
  }
});

test("a guard holder killed mid-section is recovered, and the takeover race still has one winner", async () => {
  const race = new LockRace();
  try {
    race.writeLock("dead-runner", 120_000);
    await race.start({ name: "k", op: "acquire", owner: "runner-k", pauseOn: "readFileSync" });
    await race.kill("k");
    await race.start({ name: "a", op: "acquire", owner: "runner-a", pauseOn: "readFileSync" });
    await race.start({ name: "b", op: "acquire", owner: "runner-b", pauseOn: "readFileSync" });
    await race.finish("a");
    await race.finish("b");
    const winners = ["a", "b"].filter((name) => race.result(name) === true);
    assert.equal(winners.length, 1);
    assert.equal(race.lockOwner(), `runner-${winners[0]}`);
    assert.deepEqual(race.sessionFiles(), ["lock"], "the dead holder's guard is gone");
  } finally {
    await race.dispose();
  }
});

test("a stale guard left by a dead pid is broken, and the takeover race still has one winner", async () => {
  const race = new LockRace();
  try {
    race.writeLock("dead-runner", 120_000);
    writeFileSync(race.guardPath, JSON.stringify({ pid: await deadPid(), start: "1", token: "dead" }));
    await race.start({ name: "a", op: "acquire", owner: "runner-a", pauseOn: "readFileSync" });
    await race.start({ name: "b", op: "acquire", owner: "runner-b", pauseOn: "readFileSync" });
    await race.finish("a");
    await race.finish("b");
    const winners = ["a", "b"].filter((name) => race.result(name) === true);
    assert.equal(winners.length, 1);
    assert.equal(race.lockOwner(), `runner-${winners[0]}`);
    assert.deepEqual(race.sessionFiles(), ["lock"]);
  } finally {
    await race.dispose();
  }
});

/* ---- guard liveness, in one process ---- */

function storeWithStaleLock(): { store: SessionStore; root: string; lock: string; guard: string } {
  const root = mkdtempSync(join(tmpdir(), "wollipog-lock-guard-"));
  const store = new SessionStore(root);
  store.create(sessionMeta());
  const lock = join(root, ID, "lock");
  writeFileSync(lock, "dead-runner");
  const at = (Date.now() - 120_000) / 1000;
  utimesSync(lock, at, at);
  return { store, root, lock, guard: join(root, ID, "lock.guard") };
}

function ageFile(path: string, ageMs: number): void {
  const at = (Date.now() - ageMs) / 1000;
  utimesSync(path, at, at);
}

test("a live guard holder is never broken: the lock operation fails closed", () => {
  const { store, root, lock, guard } = storeWithStaleLock();
  try {
    // The parent process is alive. With its real start time, even an old guard stays its own.
    const record = JSON.stringify({ pid: process.ppid, start: startTimeOf(process.ppid), token: "live" });
    writeFileSync(guard, record);
    ageFile(guard, 60_000);
    const started = performance.now();
    assert.equal(store.acquireLock(ID, "runner-a"), false);
    assert.ok(performance.now() - started < 1_000, "a busy guard is waited on only briefly");
    assert.equal(store.refreshLock(ID, "dead-runner"), false);
    store.releaseLock(ID, "dead-runner");
    assert.equal(readFileSync(lock, "utf8"), "dead-runner");
    assert.equal(readFileSync(guard, "utf8"), record, "the live holder's guard is untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a guard whose holder exists but belongs to another user (EPERM) counts as live", (t) => {
  const { store, root, guard } = storeWithStaleLock();
  try {
    const pid = 2 ** 22 + 7;
    writeFileSync(guard, JSON.stringify({ pid, start: "1", token: "other-user" }));
    const kill = process.kill.bind(process);
    t.mock.method(process, "kill", (target: number, signal?: string | number) => {
      if (target === pid) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      return kill(target, signal);
    });
    assert.equal(store.acquireLock(ID, "runner-a"), false);
    assert.ok(existsSync(guard));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an old guard whose pid now belongs to a later process is broken", { skip: process.platform !== "linux" }, () => {
  const { store, root, lock, guard } = storeWithStaleLock();
  try {
    writeFileSync(guard, JSON.stringify({ pid: process.ppid, start: "1", token: "reused" }));
    assert.equal(store.acquireLock(ID, "runner-a"), false, "a young guard is busy whatever its start time says");
    ageFile(guard, 60_000);
    assert.equal(store.acquireLock(ID, "runner-a"), true);
    assert.equal(readFileSync(lock, "utf8"), "runner-a");
    assert.equal(existsSync(guard), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a guard this process left behind is broken at once", () => {
  const { store, root, lock, guard } = storeWithStaleLock();
  try {
    writeFileSync(guard, JSON.stringify({ pid: process.pid, start: startTimeOf(process.pid), token: "leftover" }));
    assert.equal(store.acquireLock(ID, "runner-a"), true);
    assert.equal(readFileSync(lock, "utf8"), "runner-a");
    assert.equal(existsSync(guard), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a half-written guard is busy until it is clearly abandoned", () => {
  const { store, root, guard } = storeWithStaleLock();
  try {
    writeFileSync(guard, "");
    assert.equal(store.acquireLock(ID, "runner-a"), false);
    ageFile(guard, 60_000);
    assert.equal(store.acquireLock(ID, "runner-a"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("breaking a guard that a live holder replaced in between hands it back", () => {
  const { store, root, guard } = storeWithStaleLock();
  try {
    const abandoned = JSON.stringify({ pid: 1, start: "1", token: "abandoned" });
    const live = JSON.stringify({ pid: process.ppid, start: startTimeOf(process.ppid), token: "live" });
    writeFileSync(guard, live); // replaced after the caller read `abandoned`
    const internals = store as unknown as { breakLockGuard(path: string, observed: string): boolean };
    assert.equal(internals.breakLockGuard(guard, abandoned), false);
    assert.equal(readFileSync(guard, "utf8"), live);
    assert.deepEqual(readdirSync(join(root, ID)).filter((name) => name.includes("broken")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a takeover retries a rename Windows refuses, and fails closed when it keeps refusing", (t) => {
  for (const refusals of [2, Infinity]) {
    const { store, root, lock } = storeWithStaleLock();
    try {
      let refused = 0;
      const rename = fs.renameSync;
      t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
        if (String(to) === lock && refused < refusals) {
          refused++;
          throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
        }
        return rename(from, to);
      });
      syncBuiltinESMExports();
      const taken = store.acquireLock(ID, "runner-a");
      t.mock.restoreAll();
      syncBuiltinESMExports();
      assert.equal(taken, refusals === 2);
      assert.equal(readFileSync(lock, "utf8"), refusals === 2 ? "runner-a" : "dead-runner");
      assert.deepEqual(readdirSync(join(root, ID)).filter((name) => name.startsWith("lock")), ["lock"]);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("refresh moves only the mtime, and a same-owner acquire keeps the lock without a takeover", () => {
  const { store, root, lock } = storeWithStaleLock();
  try {
    const inode = fs.statSync(lock).ino;
    assert.equal(store.acquireLock(ID, "dead-runner"), true, "same-owner re-acquisition succeeds even when stale");
    assert.equal(fs.statSync(lock).ino, inode, "the owner keeps its lock file; nothing is taken over");
    assert.ok(Date.now() - fs.statSync(lock).mtimeMs < 10_000, "and refreshes it");
    ageFile(lock, 30_000);
    const before = fs.statSync(lock, { bigint: true });
    assert.equal(store.refreshLock(ID, "dead-runner"), true);
    const after = fs.statSync(lock, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.ok(after.mtimeMs > before.mtimeMs);
    assert.equal(readFileSync(lock, "utf8"), "dead-runner");
    assert.equal(store.refreshLock(ID, "someone-else"), false);
    store.releaseLock(ID, "someone-else");
    assert.equal(existsSync(lock), true, "release checks ownership");
    store.releaseLock(ID, "dead-runner");
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
