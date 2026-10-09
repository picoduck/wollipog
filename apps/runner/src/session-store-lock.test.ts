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
 * one store directory. A child pauses inside the lock operation right after a chosen file operation
 * (for example the last read of the lock its decision depends on) and continues only when the test
 * releases it, so check-then-write interleavings are deterministic instead of timing luck. Children
 * created with `breaker` act as the runner: the one store allowed to break an abandoned guard. */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const STORE_MODULE = new URL("./session-store.ts", import.meta.url).href;
const ID = "s_lock";

const CHILD_SOURCE = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const config = JSON.parse(process.env.LOCK_RACE_CHILD);
const signal = (name, suffix) => \`\${config.signalDir}/\${name}.\${suffix}\`;
const realExists = fs.existsSync;
const cell = new Int32Array(new SharedArrayBuffer(4));
// Each pause fires once, right after its nth matching call (the first by default), and holds until the
// test writes <name>.go.
for (const fn of new Set(config.pauses.map((pause) => pause.fn))) {
  const original = fs[fn];
  const pending = config.pauses.filter((pause) => pause.fn === fn);
  fs[fn] = function (...args) {
    const result = original.apply(this, args);
    for (const pause of pending) {
      if (pause.fired) continue;
      const target = String(args[pause.arg]);
      if (pause.prefix ? !target.startsWith(pause.prefix) : target !== pause.path) continue;
      if (pause.exclude && target.includes(pause.exclude)) continue;
      pause.seen = (pause.seen ?? 0) + 1;
      if (pause.seen < (pause.nth ?? 1)) continue;
      pause.fired = true;
      fs.writeFileSync(signal(pause.name, "checked"), "");
      while (!realExists(signal(pause.name, "go"))) Atomics.wait(cell, 0, 0, 5);
      break;
    }
    return result;
  };
}
if (config.noHardLinks) {
  fs.linkSync = function () {
    throw Object.assign(new Error("not supported"), { code: "ENOTSUP" });
  };
}
if (config.refuseRenameOf) {
  // Windows-style refusal to move a file another process has open.
  const rename = fs.renameSync;
  fs.renameSync = function (...args) {
    if (String(args[0]) === config.refuseRenameOf) throw Object.assign(new Error("access denied"), { code: "EACCES" });
    return rename.apply(this, args);
  };
}
syncBuiltinESMExports();
const { SessionStore } = await import(config.storeModule);
const store = new SessionStore(config.root, undefined, undefined, config.breaker === true);
let result = null;
if (config.op === "acquire") result = store.acquireLock(config.id, config.owner);
else if (config.op === "refresh") result = store.refreshLock(config.id, config.owner);
else store.releaseLock(config.id, config.owner);
fs.writeFileSync(signal(config.name, "result"), JSON.stringify(result));
// Optionally stay alive afterwards, so this process's files name a live pid.
while (config.stayAlive && !realExists(signal(config.name, "exit"))) Atomics.wait(cell, 0, 0, 5);
`;

type Pause = {
  /** Pause name; the test releases it by name. */
  name: string;
  fn: "readFileSync" | "existsSync" | "renameSync" | "linkSync" | "openSync" | "writeFileSync";
  /** Which argument names the file: 0 for reads and a rename's source, 1 for a link's destination. */
  arg: 0 | 1;
  path?: string;
  prefix?: string;
  /** Pause after this many matching calls instead of the first. */
  nth?: number;
  /** Skip calls whose file name contains this. */
  exclude?: string;
};

type ChildSpec = {
  name: string;
  op: "acquire" | "refresh" | "release";
  owner: string;
  /** Shorthand: pause, under the child's own name, after this call on the lock file. */
  pauseOn?: "readFileSync" | "existsSync";
  pauses?: Pause[];
  /** Make every rename of this file fail as Windows does while another process has it open. */
  refuseRenameOf?: string;
  /** Keep the process alive after its result until the test writes <name>.exit. */
  stayAlive?: boolean;
  /** Behave like a filesystem without hard links. */
  noHardLinks?: boolean;
  /** Act as the runner: the one store allowed to break an abandoned guard. */
  breaker?: boolean;
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

  /** Start a child and wait until it reaches `waitFor` (any of its pauses by default) or finishes. */
  async start(spec: ChildSpec, waitFor?: string): Promise<void> {
    const pauses = spec.pauses ?? (spec.pauseOn ? [{ name: spec.name, fn: spec.pauseOn, arg: 0, path: this.lockPath }] : []);
    const child = spawn(process.execPath, ["--import", "tsx", this.childScript], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        LOCK_RACE_CHILD: JSON.stringify({
          ...spec, pauses, id: ID, root: this.root, signalDir: this.signalDir, storeModule: STORE_MODULE,
        }),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    this.children.set(spec.name, child);
    const names = waitFor ? [waitFor] : pauses.map((pause) => pause.name);
    await this.until(
      () => names.some((name) => this.has(name, "checked")) || this.has(spec.name, "result") || child.exitCode !== null,
      `${spec.name} started`,
    );
    if (child.exitCode !== null && !this.has(spec.name, "result")) {
      await exited;
      throw new Error(`${spec.name} exited without a result: ${stderr}`);
    }
  }

  /** Release pause `pause` of child `name`, then wait until it reaches `next` or finishes. */
  async resume(name: string, pause: string, next?: string): Promise<void> {
    writeFileSync(join(this.signalDir, `${pause}.go`), "");
    const child = this.children.get(name)!;
    await this.until(
      () => (next !== undefined && this.has(next, "checked")) || this.has(name, "result") || child.exitCode !== null,
      `${name} resumed`,
    );
  }

  /** Let a child paused under its own name finish, and wait for it. */
  async finish(name: string): Promise<void> {
    await this.resume(name, name);
  }

  paused(pause: string): boolean {
    return this.has(pause, "checked");
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

  /** Age the lock and any lock temp files (not guard files) by `ageMs`. */
  ageLockFiles(ageMs: number): void {
    for (const name of this.sessionFiles()) {
      if (name === "lock" || (name.endsWith(".tmp") && !name.startsWith("lock.guard"))) {
        const at = (Date.now() - ageMs) / 1000;
        utimesSync(join(this.root, ID, name), at, at);
      }
    }
  }

  /** Move the lock's and its temp files' mtimes `ms` into the past, as if that much time went by. */
  rewindLockFiles(ms: number): void {
    for (const name of this.sessionFiles()) {
      if (name === "lock" || (name.endsWith(".tmp") && !name.startsWith("lock.guard"))) {
        const path = join(this.root, ID, name);
        const at = (fs.statSync(path).mtimeMs - ms) / 1000;
        utimesSync(path, at, at);
      }
    }
  }

  sessionFiles(): string[] {
    return readdirSync(join(this.root, ID)).filter((name) => name.startsWith("lock")).sort();
  }

  async dispose(): Promise<void> {
    for (const name of this.children.keys()) writeFileSync(join(this.signalDir, `${name}.exit`), "");
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

/* ---- races between processes ---- */

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

test("a newly taken lock is never visible empty", async () => {
  const race = new LockRace();
  try {
    await race.start({
      name: "a", op: "acquire", owner: "runner-a",
      pauses: [
        { name: "a-linked", fn: "linkSync", arg: 1, path: race.lockPath },
        { name: "a-opened", fn: "openSync", arg: 0, path: race.lockPath },
      ],
    });
    assert.equal(race.lockOwner(), "runner-a", "the owner is in the file as soon as it exists");
    for (const pause of ["a-linked", "a-opened"]) if (race.paused(pause)) await race.resume("a", pause);
    assert.equal(race.result("a"), true);
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
    await race.start({ name: "f", op: "acquire", owner: "runner-f" });
    assert.equal(race.result("f"), false, "and the next acquirer does not get it as a free lock");
  } finally {
    await race.dispose();
  }
});

/* ---- a lease starts when it is published (CR-4.1, CR-5.2) ---- */

test("an acquirer that stalled while publishing a free lock never owns it alongside a later taker", async (t) => {
  for (const variant of ["linked", "no hard links", "no hard links, takeover pending"] as const) {
    await t.test(variant, async () => {
      const race = new LockRace();
      try {
        // A stalls mid-publication long enough for its lock to look stale once it lands.
        await race.start(variant === "linked"
          ? {
            name: "a", op: "acquire", owner: "runner-a",
            pauses: [{ name: "a-written", fn: "writeFileSync", arg: 0, prefix: `${race.lockPath}.`, exclude: "lock.guard" }],
          }
          : {
            name: "a", op: "acquire", owner: "runner-a", noHardLinks: true,
            pauses: [{ name: "a-written", fn: "openSync", arg: 0, path: race.lockPath }],
          });
        assert.ok(race.paused("a-written"));
        race.ageLockFiles(120_000);
        if (variant === "no hard links") {
          // A holds the guard while its lock is still empty, so B cannot take it over.
          await race.start({ name: "b", op: "acquire", owner: "runner-b", noHardLinks: true });
          await race.resume("a", "a-written");
        } else if (variant === "no hard links, takeover pending") {
          // B gets as far as reading the empty lock as stale, then A finishes writing and confirming.
          await race.start({
            name: "b", op: "acquire", owner: "runner-b", noHardLinks: true,
            pauses: [{ name: "b-read", fn: "readFileSync", arg: 0, path: race.lockPath }],
          });
          await race.resume("a", "a-written");
          if (race.paused("b-read")) await race.resume("b", "b-read");
        } else {
          // A publishes its old temp file; B arrives right after A reports.
          await race.resume("a", "a-written");
          await race.start({ name: "b", op: "acquire", owner: "runner-b" });
        }
        const winners = ["a", "b"].filter((name) => race.result(name) === true);
        assert.equal(winners.length, 1, "a lock is never held by both");
        assert.equal(race.lockOwner(), `runner-${winners[0]}`);
      } finally {
        await race.dispose();
      }
    });
  }
});

test("a free lock's lease starts after publication, however short the stall before linking (CR-E2-2.1)", async (t) => {
  for (const variant of ["second stall after the acquire", "second stall before the confirmation"] as const) {
    await t.test(variant, async () => {
      const race = new LockRace();
      try {
        // A writes its lock temp file and stalls 29 s: less than half the stale window.
        await race.start({
          name: "a", op: "acquire", owner: "runner-a",
          pauses: [
            { name: "a-written", fn: "writeFileSync", arg: 0, prefix: `${race.lockPath}.`, exclude: "lock.guard" },
            ...variant === "second stall before the confirmation"
              ? [{ name: "a-linked", fn: "linkSync" as const, arg: 1 as const, path: race.lockPath }]
              : [],
          ],
        });
        assert.ok(race.paused("a-written"));
        race.rewindLockFiles(29_000);
        if (variant === "second stall after the acquire") {
          await race.resume("a", "a-written");
          assert.equal(race.result("a"), true);
          // A then stalls 32 s: 61 s after its temp file was written, but only 32 s after it acquired.
          race.rewindLockFiles(32_000);
          await race.start({ name: "b", op: "acquire", owner: "runner-b" });
          assert.equal(race.result("b"), false, "the lease runs 60 s from the acquire, not from the temp file");
          assert.equal(race.lockOwner(), "runner-a");
        } else {
          await race.resume("a", "a-written", "a-linked");
          assert.ok(race.paused("a-linked"));
          // A stalls 32 s between linking and confirming: its unconfirmed lock is stale and B takes it.
          race.rewindLockFiles(32_000);
          await race.start({ name: "b", op: "acquire", owner: "runner-b" });
          assert.equal(race.result("b"), true);
          await race.resume("a", "a-linked");
          assert.equal(race.result("a"), false, "A finds the takeover and does not claim the lock");
          assert.equal(race.lockOwner(), "runner-b");
        }
      } finally {
        await race.dispose();
      }
    });
  }
});

test("a free acquirer stalled while confirming its lock holds the guard, so no takeover interleaves", async () => {
  const race = new LockRace();
  try {
    // A has linked its lock and read it back while confirming; the read is its only check before the touch.
    await race.start({ name: "a", op: "acquire", owner: "runner-a", pauseOn: "readFileSync" });
    assert.ok(race.paused("a"));
    race.ageLockFiles(120_000);
    await race.start({ name: "b", op: "acquire", owner: "runner-b" });
    await race.finish("a");
    const winners = ["a", "b"].filter((name) => race.result(name) === true);
    assert.deepEqual(winners, ["a"], "B cannot take over between A's check and A's touch");
    assert.equal(race.lockOwner(), "runner-a");
  } finally {
    await race.dispose();
  }
});

test("an acquirer that stalled right after publishing finds a takeover instead of claiming the lock", async () => {
  const race = new LockRace();
  try {
    await race.start({
      name: "a", op: "acquire", owner: "runner-a",
      pauses: [{ name: "a-linked", fn: "linkSync", arg: 1, path: race.lockPath }],
    });
    assert.ok(race.paused("a-linked"));
    race.ageLockFiles(120_000);
    // While A is stalled, its lock goes stale and B takes it over with a fresh lease.
    await race.start({ name: "b", op: "acquire", owner: "runner-b" });
    assert.equal(race.result("b"), true);
    await race.resume("a", "a-linked");
    assert.equal(race.result("a"), false, "A sees B's young lock and does not claim it");
    assert.equal(race.lockOwner(), "runner-b");
  } finally {
    await race.dispose();
  }
});

test("a takeover that stalled before its rename publishes a fresh lease", async () => {
  const race = new LockRace();
  try {
    race.writeLock("dead-runner", 120_000);
    // A's second lock temp file is its replacement (the first was its free attempt).
    await race.start({
      name: "a", op: "acquire", owner: "runner-a",
      pauses: [{ name: "a-replacement", fn: "writeFileSync", arg: 0, prefix: `${race.lockPath}.`, exclude: "lock.guard", nth: 2 }],
    });
    assert.ok(race.paused("a-replacement"));
    race.ageLockFiles(120_000);
    await race.resume("a", "a-replacement");
    assert.equal(race.result("a"), true);
    await race.start({ name: "b", op: "acquire", owner: "runner-b" });
    assert.equal(race.result("b"), false, "the replacement's lease starts when it is published");
    assert.equal(race.lockOwner(), "runner-a");
  } finally {
    await race.dispose();
  }
});

/* ---- guards abandoned by a dead process; only the runner breaks them ---- */

test("a guard holder killed mid-section is recovered by the runner, and the race still has one winner", async () => {
  const race = new LockRace();
  try {
    race.writeLock("dead-runner", 120_000);
    await race.start({ name: "k", op: "acquire", owner: "runner-k", pauseOn: "readFileSync" });
    await race.kill("k");
    // Any other process fails closed on the abandoned guard.
    await race.start({ name: "n", op: "acquire", owner: "tool-n" });
    assert.equal(race.result("n"), false);
    assert.ok(existsSync(race.guardPath));
    // The runner recovers it; a non-runner racing it still loses.
    await race.start({ name: "a", op: "acquire", owner: "runner-a", breaker: true, pauseOn: "readFileSync" });
    await race.start({ name: "b", op: "acquire", owner: "tool-b", pauseOn: "readFileSync" });
    await race.finish("a");
    await race.finish("b");
    const winners = ["a", "b"].filter((name) => race.result(name) === true);
    assert.equal(winners.length, 1);
    assert.equal(race.lockOwner(), { a: "runner-a", b: "tool-b" }[winners[0] as "a" | "b"]);
    assert.deepEqual(race.sessionFiles(), ["lock"], "the dead holder's guard is gone");
  } finally {
    await race.dispose();
  }
});

test("a stale guard left by a dead pid is broken only by the runner", async () => {
  const race = new LockRace();
  try {
    race.writeLock("dead-runner", 120_000);
    writeFileSync(race.guardPath, JSON.stringify({ pid: await deadPid(), start: "1", token: "dead" }));
    await race.start({ name: "n", op: "acquire", owner: "tool-n" });
    assert.equal(race.result("n"), false, "a non-runner process fails closed");
    await race.start({ name: "a", op: "acquire", owner: "runner-a", breaker: true, pauseOn: "readFileSync" });
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

test("a guard is never visible empty, so a live creator's old guard is never broken", async () => {
  const race = new LockRace();
  try {
    race.writeLock("runner-o", 120_000);
    await race.start({
      name: "o", op: "refresh", owner: "runner-o",
      pauses: [
        { name: "o-created", fn: "linkSync", arg: 1, path: race.guardPath },
        { name: "o-opened", fn: "openSync", arg: 0, path: race.guardPath },
      ],
    });
    assert.notEqual(readFileSync(race.guardPath, "utf8"), "", "the guard is complete as soon as it exists");
    const at = (Date.now() - 60_000) / 1000;
    utimesSync(race.guardPath, at, at);
    await race.start({ name: "t", op: "acquire", owner: "runner-t", breaker: true });
    for (const pause of ["o-created", "o-opened"]) if (race.paused(pause)) await race.resume("o", pause);
    assert.equal(race.result("t"), false, "the live creator's guard is respected however old it looks");
    assert.equal(race.result("o"), true);
    assert.equal(race.lockOwner(), "runner-o");
  } finally {
    await race.dispose();
  }
});

test("without hard links, a creator stalled before writing its guard is never broken", async () => {
  const race = new LockRace();
  try {
    race.writeLock("dead-runner", 120_000);
    await race.start({
      name: "a", op: "acquire", owner: "runner-a", noHardLinks: true,
      pauses: [{ name: "a-opened", fn: "openSync", arg: 0, path: race.guardPath }],
    });
    assert.equal(readFileSync(race.guardPath, "utf8"), "");
    const at = (Date.now() - 60_000) / 1000;
    utimesSync(race.guardPath, at, at);
    await race.start({
      name: "b", op: "acquire", owner: "runner-b", noHardLinks: true, breaker: true,
      pauses: [{ name: "b-lock", fn: "readFileSync", arg: 0, path: race.lockPath }],
    });
    await race.resume("a", "a-opened");
    if (race.paused("b-lock")) await race.resume("b", "b-lock");
    const winners = ["a", "b"].filter((name) => race.result(name) === true);
    assert.deepEqual(winners, ["a"], "the empty guard's creator keeps it; no second holder");
    assert.equal(race.lockOwner(), "runner-a");
  } finally {
    await race.dispose();
  }
});

/* ---- guard liveness, in one process ---- */

function storeWithStaleLock(breaker = true): { store: SessionStore; root: string; lock: string; guard: string } {
  const root = mkdtempSync(join(tmpdir(), "wollipog-lock-guard-"));
  const store = new SessionStore(root, undefined, undefined, breaker);
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

test("a guard this process left behind is broken by the runner store, and only by it", () => {
  for (const breaker of [false, true]) {
    const { store, root, lock, guard } = storeWithStaleLock(breaker);
    try {
      writeFileSync(guard, JSON.stringify({ pid: process.pid, start: startTimeOf(process.pid), token: "leftover" }));
      assert.equal(store.acquireLock(ID, "runner-a"), breaker);
      assert.equal(readFileSync(lock, "utf8"), breaker ? "runner-a" : "dead-runner");
      assert.equal(existsSync(guard), !breaker);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("an empty or malformed guard is never broken automatically, however old", () => {
  const { store, root, guard, lock } = storeWithStaleLock();
  try {
    for (const damaged of ["", "{\"pid\":"]) {
      writeFileSync(guard, damaged);
      ageFile(guard, 3_600_000);
      assert.equal(store.acquireLock(ID, "runner-a"), false);
      assert.equal(readFileSync(guard, "utf8"), damaged);
    }
    rmSync(guard);
    assert.equal(store.acquireLock(ID, "runner-a"), true, "deleting it by hand recovers");
    assert.equal(readFileSync(lock, "utf8"), "runner-a");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("breaking re-reads the guard and leaves a different one alone", () => {
  const { store, root, guard } = storeWithStaleLock();
  try {
    const abandoned = JSON.stringify({ pid: 1, start: "1", token: "abandoned" });
    const live = JSON.stringify({ pid: process.ppid, start: startTimeOf(process.ppid), token: "live" });
    writeFileSync(guard, live);
    const internals = store as unknown as { breakLockGuard(path: string, observed: string): boolean };
    assert.equal(internals.breakLockGuard(guard, abandoned), false);
    assert.equal(readFileSync(guard, "utf8"), live);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a break that Windows refuses leaves the abandoned guard for a later attempt", async (t) => {
  const { store, root, lock, guard } = storeWithStaleLock();
  try {
    writeFileSync(guard, JSON.stringify({ pid: await deadPid(), start: "1", token: "abandoned" }));
    const rename = fs.renameSync;
    t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === guard) throw Object.assign(new Error("access denied"), { code: "EACCES" });
      return rename(from, to);
    });
    syncBuiltinESMExports();
    assert.equal(store.acquireLock(ID, "runner-a"), false);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.ok(existsSync(guard));
    assert.equal(store.acquireLock(ID, "runner-a"), true);
    assert.equal(readFileSync(lock, "utf8"), "runner-a");
    assert.deepEqual(readdirSync(join(root, ID)).filter((name) => name.startsWith("lock")), ["lock"]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
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

test("without hard links, free and stale locks are taken inside the guard", (t) => {
  for (const stale of [false, true]) {
    const { store, root, lock } = storeWithStaleLock();
    try {
      if (!stale) rmSync(lock);
      t.mock.method(fs, "linkSync", () => { throw Object.assign(new Error("not supported"), { code: "ENOTSUP" }); });
      syncBuiltinESMExports();
      assert.equal(store.acquireLock(ID, "runner-a"), true);
      t.mock.restoreAll();
      syncBuiltinESMExports();
      assert.equal(readFileSync(lock, "utf8"), "runner-a");
      assert.ok(Date.now() - fs.statSync(lock).mtimeMs < 10_000);
      assert.deepEqual(readdirSync(join(root, ID)).filter((name) => name.startsWith("lock")), ["lock"]);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("without hard links, a short write never publishes a truncated owner", (t) => {
  const { store, root, lock } = storeWithStaleLock();
  try {
    rmSync(lock);
    const owner = "runner-a:history";
    t.mock.method(fs, "linkSync", () => { throw Object.assign(new Error("not supported"), { code: "ENOTSUP" }); });
    // Shorten the first single write to the lock file itself (not to temp files or the guard). A
    // publication that issues one write and trusts it is cut short here; writeFileSync keeps writing
    // until every byte is out, as its contract requires.
    const open = fs.openSync;
    let lockFd: number | undefined;
    t.mock.method(fs, "openSync", (...args: unknown[]) => {
      const fd = (open as (...a: unknown[]) => number)(...args);
      if (String(args[0]) === lock) lockFd = fd;
      return fd;
    });
    const write = fs.writeSync;
    let shortened = false;
    t.mock.method(fs, "writeSync", (fd: number, data: string | NodeJS.ArrayBufferView, ...rest: unknown[]) => {
      if (!shortened && fd === lockFd) {
        shortened = true;
        const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        const offset = typeof data === "string" ? 0 : (rest[0] as number | undefined) ?? 0;
        return write(fd, bytes, offset, 6); // the kernel accepted only part of it
      }
      return (write as (...args: unknown[]) => number)(fd, data, ...rest);
    });
    syncBuiltinESMExports();
    assert.equal(store.acquireLock(ID, owner), true);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(readFileSync(lock, "utf8"), owner, "the whole owner is published");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lock operations report failure instead of throwing when the filesystem refuses", (t) => {
  const { store, root, lock } = storeWithStaleLock();
  try {
    t.mock.method(fs, "utimesSync", () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    t.mock.method(fs, "rmSync", () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    syncBuiltinESMExports();
    assert.equal(store.acquireLock(ID, "dead-runner"), false, "a same-owner refresh that cannot write fails closed");
    assert.equal(store.refreshLock(ID, "dead-runner"), false);
    assert.doesNotThrow(() => store.releaseLock(ID, "dead-runner"));
    assert.equal(readFileSync(lock, "utf8"), "dead-runner");
    t.mock.restoreAll();
    syncBuiltinESMExports();
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a takeover whose temp-file cleanup fails still reports that it took the lock", (t) => {
  const { store, root, lock } = storeWithStaleLock();
  try {
    t.mock.method(fs, "rmSync", () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    syncBuiltinESMExports();
    assert.equal(store.acquireLock(ID, "runner-x"), true);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(readFileSync(lock, "utf8"), "runner-x");
    // The guard this process could not remove is its own leftover, broken by its next operation.
    assert.equal(store.refreshLock(ID, "runner-x"), true);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
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
