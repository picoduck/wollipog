import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import {
  DEFAULT_WAL_AUTOCHECKPOINT_PAGES,
  WAL_CHECKPOINT_BACKSTOP_PAGES,
  WAL_CHECKPOINT_STALL_MS,
  WalCheckpointer,
  logWalCheckpointerEvent,
  sqliteHasWalResetFix,
  type WalCheckpointerEvent,
  type WalCheckpointerOptions,
} from "./wal-checkpointer.js";

/**
 * #2761: the control plane checkpoints its write-ahead log from a worker thread, so ingest commits
 * no longer copy and flush the log on the event loop. The worker only ever runs PASSIVE
 * checkpoints, the main connection's automatic checkpoint stays as a backstop, and neither a
 * stalled nor a failing worker can grow the log without bound or take the control plane down.
 */

const RUNNER_ID = "wal-runner";
/** The worker never runs on a SQLite without the WAL-reset fix; its behaviour is tested where it runs. */
const LIVE = sqliteHasWalResetFix(process.versions.sqlite)
  ? {} : { skip: `SQLite ${process.versions.sqlite} lacks the WAL-reset fix, so no worker runs` };

function runnerMeta(): RunnerMetadata {
  return {
    runnerId: RUNNER_ID, hostname: "host", os: "linux", version: "1.0.0",
    workspaces: [{ id: "ws", name: "Repo", path: "/tmp/wal" }],
    agents: [{ id: "agent", name: "Agent", command: "claude", args: [], env: {}, driver: "claude-code",
      available: true, context: { kind: "native" } }],
  };
}

/** Every scenario watches the heartbeat at a short threshold and fails on a stall it did not expect
 * (#2834): a worker passing every 20 ms or faster never goes a second without completing one. */
function open(t: TestContext, options: WalCheckpointerOptions = {}, { expectStalls = false } = {}) {
  if ((options.intervalMs ?? 250) <= 20) options = { stallAfterMs: 1_000, ...options };
  const root = mkdtempSync(join(tmpdir(), "wollipog-wal-checkpointer-"));
  const location = join(root, "control-plane.db");
  const db = ControlPlaneDb.open(location);
  const events: WalCheckpointerEvent[] = [];
  let closed = false;
  const close = () => {
    if (!closed) db.close();
    closed = true;
  };
  // Every connection on the file closes before its directory is removed (Windows refuses otherwise).
  const cleanups: Array<() => void> = [];
  t.after(() => {
    for (const cleanup of cleanups.reverse()) cleanup();
    close();
    rmSync(root, { recursive: true, force: true });
    if (!expectStalls) assert.deepEqual(events.filter((event) => event.type === "stalled"), [], "no stall was reported");
  });
  db.registerRunner(runnerMeta(), 1_000);
  db.createSession({ id: "s-1", runnerId: RUNNER_ID, workspaceId: "ws", agentId: "agent", title: "WAL",
    useWorktree: false, driver: "claude-code", config: {}, now: 1_000 });
  const checkpointer = db.startWalCheckpoints({ ...options, onEvent: (event) => events.push(event) });
  assert.ok(checkpointer);
  let seq = 0;
  /** Streamed runner events, committed relaxed exactly like live ingest. */
  const ingest = (count: number) => {
    for (let i = 0; i < count; i++) {
      seq++;
      db.appendEvent("s-1", { kind: "agent_message", text: `streamed chunk ${seq} `.repeat(20) }, 2_000 + seq,
        { runnerSeq: seq, historyEpoch: null, accrueUsage: true });
    }
  };
  const pragma = (name: string) => Object.values(db.raw().prepare(`PRAGMA ${name}`).get()!)[0];
  const defer = (cleanup: () => void) => cleanups.push(cleanup);
  return { db, location, wal: `${location}-wal`, events, checkpointer, ingest, pragma, close, defer };
}

async function until(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const has = (events: WalCheckpointerEvent[], type: WalCheckpointerEvent["type"]) =>
  events.some((event) => event.type === type);

test("the worker checkpoints the log while the main connection's own checkpoint waits at the backstop", LIVE, async (t) => {
  const h = open(t, { intervalMs: 20 });
  await until(() => has(h.events, "online"), "the worker to start");
  assert.equal(h.pragma("wal_autocheckpoint"), WAL_CHECKPOINT_BACKSTOP_PAGES);
  assert.equal(h.pragma("synchronous"), 2, "commit durability is unchanged: the connection stays FULL");
  assert.equal(h.pragma("journal_mode"), "wal");
  h.ingest(300);
  await until(() => h.events.some((event) => event.type === "checkpoint" && event.checkpointed > 0),
    "a worker checkpoint");
  const checkpoint = h.events.filter((event) => event.type === "checkpoint").at(-1);
  assert.equal(checkpoint?.type === "checkpoint" && checkpoint.busy, 0, "PASSIVE reports, never waits");
});

test("the worker runs only PASSIVE checkpoints", () => {
  const source = readFileSync(new URL("./wal-checkpointer.ts", import.meta.url), "utf8");
  const modes = [...source.matchAll(/wal_checkpoint\(([A-Z]*)\)/g)].map((match) => match[1]);
  assert.ok(modes.length > 0);
  assert.deepEqual([...new Set(modes)], ["PASSIVE"], "no FULL, RESTART or TRUNCATE checkpoint");
});

test("main-connection readers and writers never wait for the worker", LIVE, async (t) => {
  const h = open(t, { intervalMs: 1 });
  await until(() => has(h.events, "online"), "the worker to start");
  // Any wait for a lock the worker held would now fail at once with SQLITE_BUSY.
  h.db.raw().exec("PRAGMA busy_timeout = 0");
  // A long-lived reader elsewhere pins part of the log; the worker must skip past it, not wait.
  const reader = new DatabaseSync(h.location);
  h.defer(() => reader.close());
  reader.exec("BEGIN");
  reader.prepare("SELECT COUNT(*) FROM session_events").get();
  for (let round = 0; round < 20; round++) {
    h.ingest(50);
    assert.ok(h.db.getSession("s-1"));
    await new Promise((resolve) => setImmediate(resolve));
  }
  reader.exec("COMMIT");
  await until(() => h.events.some((event) => event.type === "checkpoint" && event.checkpointed === event.log),
    "a complete checkpoint once the reader is gone");
});

test("a dead worker leaves the log bounded by the backstop, and the main connection keeps writing", LIVE, async (t) => {
  const backstopPages = 64;
  const h = open(t, { intervalMs: 20, backstopPages, restartDelaysMs: [60_000] });
  await until(() => has(h.events, "online"), "the worker to start");
  await (h.checkpointer as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
  await until(() => has(h.events, "exited"), "the exit to be observed");
  const exited = h.events.find((event) => event.type === "exited");
  assert.equal(exited?.type === "exited" && exited.restartInMs, 60_000);
  assert.equal(h.checkpointer.running(), false);
  const pageSize = Number(h.pragma("page_size"));
  const walPages = () => Math.max(0, statSync(h.wal).size - 32) / (pageSize + 24);
  // The file keeps its largest size, and opening the database already wrote up to SQLite's
  // default threshold; start from an empty log so only the backstop can bound it.
  h.db.raw().exec("PRAGMA wal_checkpoint(TRUNCATE)");
  assert.equal(walPages(), 0);
  h.ingest(2_000); // at least one new frame each
  // The log restarts after each backstop checkpoint, so it never grows much past one backstop.
  assert.ok(walPages() <= backstopPages * 3,
    `the log holds ${walPages()} pages after 2,000 commits with a ${backstopPages}-page backstop`);
  assert.equal(h.db.getHydratedSeq("s-1"), 2_000, "every commit succeeded without the worker");
});

test("a live worker that stops checkpointing leaves the log bounded by the backstop", LIVE, async (t) => {
  const backstopPages = 64;
  // The worker runs its first pass and then none for an hour: alive, holding no lock, not keeping up.
  const h = open(t, { intervalMs: 3_600_000, backstopPages });
  await until(() => has(h.events, "online"), "the worker to start");
  const pageSize = Number(h.pragma("page_size"));
  const walPages = () => Math.max(0, statSync(h.wal).size - 32) / (pageSize + 24);
  h.db.raw().exec("PRAGMA wal_checkpoint(TRUNCATE)");
  h.ingest(2_000);
  assert.ok(walPages() <= backstopPages * 3,
    `the log holds ${walPages()} pages after 2,000 commits with a ${backstopPages}-page backstop`);
  assert.equal(h.checkpointer.running(), true);
  assert.equal(h.db.getHydratedSeq("s-1"), 2_000);
});

test("a crashed worker restarts and resumes checkpointing", LIVE, async (t) => {
  const h = open(t, { intervalMs: 20, restartDelaysMs: [20] });
  await until(() => has(h.events, "online"), "the worker to start");
  await (h.checkpointer as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
  await until(() => h.events.filter((event) => event.type === "online").length === 2, "the restart");
  const restarted = h.events.length;
  h.ingest(200);
  await until(() => h.events.slice(restarted).some((event) => event.type === "checkpoint" && event.checkpointed > 0),
    "a checkpoint by the restarted worker");
  assert.equal(h.checkpointer.running(), true);
});

test("a worker that cannot open the database never takes the control plane down", LIVE, async (t) => {
  const h = open(t, { intervalMs: 20 });
  const events: WalCheckpointerEvent[] = [];
  const broken = new WalCheckpointer(h.db.raw(), join(h.location, "not-a-directory", "missing.db"), {
    restartDelaysMs: [20], onEvent: (event) => events.push(event),
  });
  broken.start();
  h.defer(() => broken.stop());
  await until(() => events.filter((event) => event.type === "exited").length >= 2, "two failed starts");
  assert.ok(has(events, "failed"));
  h.ingest(10);
  assert.equal(h.db.getHydratedSeq("s-1"), 10, "the main connection is unaffected");
  broken.stop();
  const settled = events.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(events.length, settled, "a stopped checkpointer schedules nothing more");
});

test("a clean shutdown checkpoints once more and leaves no log or lock behind", LIVE, async (t) => {
  const h = open(t, { intervalMs: 60_000 });
  await until(() => has(h.events, "online"), "the worker to start");
  h.ingest(300);
  assert.ok(existsSync(h.wal));
  const reportsBeforeStop = h.events.length;
  h.db.stopWalCheckpoints();
  assert.equal(h.checkpointer.running(), false);
  // The worker reported its last checkpoint before it closed; the report arrives on a later turn.
  await until(() => has(h.events.slice(reportsBeforeStop), "checkpoint"), "the last checkpoint's report");
  const last = h.events.slice(reportsBeforeStop).filter((event) => event.type === "checkpoint").at(-1);
  assert.equal(last?.type === "checkpoint" && last.checkpointed, last?.type === "checkpoint" && last.log,
    "the stop ran a complete last checkpoint");
  assert.equal(h.pragma("wal_autocheckpoint"), DEFAULT_WAL_AUTOCHECKPOINT_PAGES);
  h.close();
  assert.equal(existsSync(h.wal), false, "the main connection closed last and removed the log");
  // Nothing holds a lock: another connection can take the write lock at once.
  const next = new DatabaseSync(h.location);
  try {
    next.exec("PRAGMA busy_timeout = 0");
    next.exec("BEGIN IMMEDIATE");
    next.exec("COMMIT");
    assert.equal(Number(Object.values(next.prepare("SELECT COUNT(*) FROM session_events").get()!)[0]), 300);
  } finally {
    next.close();
  }
});

test("an in-memory database has no log to checkpoint", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    assert.equal(db.startWalCheckpoints(), null);
  } finally {
    db.close();
  }
});

test("the worker runs only on a SQLite with the WAL-reset fix", (t) => {
  // https://sqlite.org/wal.html#the_wal_reset_bug: fixed in 3.51.3, backported to 3.44.6 and 3.50.7.
  const cases: Array<[string | undefined, boolean]> = [
    ["3.47.2", false], // Node 22.13.0, the oldest supported runtime
    ["3.51.2", false], ["3.51.3", true], ["3.53.1", true], ["3.60.0", true], ["4.0.0", true],
    ["3.44.5", false], ["3.44.6", true], ["3.45.0", false], ["3.50.6", false], ["3.50.7", true],
    ["", false], [undefined, false], ["unknown", false],
  ];
  for (const [version, fixed] of cases) assert.equal(sqliteHasWalResetFix(version), fixed, String(version));

  const root = mkdtempSync(join(tmpdir(), "wollipog-wal-unfixed-"));
  const db = ControlPlaneDb.open(join(root, "control-plane.db"));
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const events: WalCheckpointerEvent[] = [];
  const checkpointer = db.startWalCheckpoints({ sqliteVersion: "3.47.2", onEvent: (event) => events.push(event) });
  assert.equal(checkpointer?.running(), false);
  assert.deepEqual(events, [{ type: "disabled", reason: "SQLite 3.47.2 lacks the WAL-reset fix" }]);
  assert.equal(Object.values(db.raw().prepare("PRAGMA wal_autocheckpoint").get()!)[0], DEFAULT_WAL_AUTOCHECKPOINT_PAGES,
    "the main connection keeps checkpointing itself");
  db.stopWalCheckpoints();
});

test("restart backoff advances until a worker stays up long enough to count as healthy", LIVE, async (t) => {
  const kill = async (h: ReturnType<typeof open>, online: number) => {
    await until(() => h.events.filter((event) => event.type === "online").length === online, `start ${online}`);
    await (h.checkpointer as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
    await until(() => h.events.filter((event) => event.type === "exited").length === online, `exit ${online}`);
  };
  const delays = (h: ReturnType<typeof open>) =>
    h.events.flatMap((event) => event.type === "exited" ? [event.restartInMs] : []);

  const failing = open(t, { intervalMs: 20, restartDelaysMs: [10, 50, 100], healthyAfterMs: 60_000 });
  for (let started = 1; started <= 3; started++) await kill(failing, started);
  assert.deepEqual(delays(failing), [10, 50, 100], "a worker that keeps dying backs off");

  const healthy = open(t, { intervalMs: 20, restartDelaysMs: [10, 50, 100], healthyAfterMs: 0 });
  for (let started = 1; started <= 3; started++) await kill(healthy, started);
  assert.deepEqual(delays(healthy), [10, 10, 10], "a worker that stayed healthy restarts at the first delay");
});

// #2834: a checkpoint hung inside the kernel holds the checkpoint lock against the backstop, so the
// main thread watches the worker's completed-pass count and reports a worker that stops completing.
// The stall clock starts when a worker spawns, so every test with a live worker allows a full
// second: ten times a worker's startup, even on a loaded machine.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ofType = <T extends WalCheckpointerEvent["type"]>(events: WalCheckpointerEvent[], type: T) =>
  events.filter((event): event is Extract<WalCheckpointerEvent, { type: T }> => event.type === type);

/** The watchdog driven one check at a time: no worker and no timer, so no timing to race. With a
 * threshold of 0, the second check in a row without a pass reports the stall. */
function watchdog(location: string) {
  const events: WalCheckpointerEvent[] = [];
  const checkpointer = new WalCheckpointer({ exec: () => {} }, location, {
    stallAfterMs: 0, onEvent: (event) => events.push(event),
  });
  const passes = new Int32Array(new SharedArrayBuffer(4));
  const internals = checkpointer as unknown as { passes: Int32Array | null; sizingWal: boolean; checkHeartbeat(): void };
  internals.passes = passes;
  return {
    checkpointer, events,
    check: () => internals.checkHeartbeat(),
    pass: () => Atomics.add(passes, 0, 1),
    sizing: () => internals.sizingWal,
    walBytes: () => ofType(events, "stalled").map((event) => event.walBytes),
  };
}

test("the watchdog reports one stall per stretch without a pass, with the log's size, and one recovery", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wal-watchdog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const location = join(root, "control-plane.db");
  writeFileSync(`${location}-wal`, Buffer.alloc(4_096));
  const w = watchdog(location);
  w.check(); // the first check without a pass reads the log's size, off the event loop
  await until(() => !w.sizing(), "the size reading");
  w.check();
  assert.deepEqual(w.walBytes(), [4_096], "the stall reports the log's size");
  w.check();
  w.check();
  assert.equal(ofType(w.events, "stalled").length, 1, "one report per stall, not one per check");
  w.pass();
  w.check();
  w.pass();
  w.check();
  assert.equal(ofType(w.events, "recovered").length, 1, "only a reported stall recovers, once");
  w.check();
  w.check();
  assert.equal(ofType(w.events, "stalled").length, 2, "a new stretch without a pass is a new stall");
  w.checkpointer.stop();
  w.pass();
  w.check();
  w.check();
  w.check();
  assert.deepEqual(w.events.map((event) => event.type), ["stalled", "recovered", "stalled"],
    "a stopped checkpointer reports nothing more");

  const missing = watchdog(join(root, "missing.db"));
  missing.check();
  await until(() => !missing.sizing(), "the failed size reading");
  missing.check();
  assert.deepEqual(missing.walBytes(), [null], "no size when the log cannot be read");
});

test("a size reading that returns after its stall ended never reaches a later stall's report", (t) => {
  // Readings of the log's size wait until the test answers them, as on storage slow to return.
  type StatCallback = (error: Error | null, stats: { size: number }) => void;
  const readings: StatCallback[] = [];
  const original = fs.stat;
  const statMock = t.mock.method(fs, "stat", ((path: string, ...rest: unknown[]) => {
    if (String(path).endsWith("-wal")) readings.push(rest.at(-1) as StatCallback);
    else (original as (...args: unknown[]) => void)(path, ...rest);
  }) as typeof fs.stat);
  syncBuiltinESMExports();
  t.after(() => {
    statMock.mock.restore();
    syncBuiltinESMExports();
  });
  const w = watchdog(join(tmpdir(), "wollipog-wal-watchdog.db"));
  w.check();
  w.check();
  assert.deepEqual(w.walBytes(), [null], "the stall is reported without waiting for the reading");
  w.pass();
  w.check();
  w.check(); // a new stretch without a pass, while the first stall's reading is still out
  assert.equal(readings.length, 1, "one reading at a time");
  readings[0]!(null, { size: 123 });
  w.check();
  assert.deepEqual(w.walBytes(), [null, null], "the earlier stall's reading is discarded");
  assert.equal(readings.length, 2, "the second stall asked for its own reading");
  readings[1]!(null, { size: 456 });
  w.pass();
  w.check();
  w.check();
  readings[2]!(null, { size: 789 });
  w.check();
  assert.deepEqual(w.walBytes(), [null, null, 789], "a stall's own reading is reported");
});

test("a worker that completes no pass is reported stalled once per stall, then recovered, and logged", LIVE, async (t) => {
  const stallAfterMs = 1_000;
  const hold = new Int32Array(new SharedArrayBuffer(4));
  const release = () => {
    Atomics.store(hold, 0, 0);
    Atomics.notify(hold, 0);
  };
  const h = open(t, { intervalMs: 20, stallAfterMs, holdPasses: hold }, { expectStalls: true });
  h.defer(release);
  await until(() => has(h.events, "online"), "the worker to start");
  h.ingest(100);

  for (let stall = 1; stall <= 2; stall++) {
    // The worker blocks inside a pass, as one waiting on a flush that never completes would.
    Atomics.store(hold, 0, 1);
    await until(() => ofType(h.events, "stalled").length === stall, `stall ${stall}`);
    const stalled = ofType(h.events, "stalled").at(-1)!;
    // Measured, like the stall itself, from the last check that saw a pass complete.
    assert.ok(stalled.sinceLastPassMs >= stallAfterMs, `not before the threshold: ${stalled.sinceLastPassMs} ms`);
    // The size is read off the event loop and may still be on its way; the driven tests pin it.
    assert.ok(stalled.walBytes === null || stalled.walBytes > 0, `the log's size: ${stalled.walBytes}`);
    await sleep(stallAfterMs * 2);
    assert.equal(ofType(h.events, "stalled").length, stall, "one report per stall, not one per check");
    assert.equal(h.checkpointer.running(), true, "the worker is not restarted: terminate cannot interrupt a hang");

    release();
    await until(() => ofType(h.events, "recovered").length === stall, `recovery ${stall}`);
    assert.ok(ofType(h.events, "recovered").at(-1)!.stalledMs >= stallAfterMs);
    await sleep(stallAfterMs);
    assert.equal(ofType(h.events, "stalled").length, stall, "a completed pass clears the stall");
    assert.equal(ofType(h.events, "recovered").length, stall, "recovery is reported once");
  }

  const logged: Array<[level: string, fields: object, message: string]> = [];
  const log = {
    info: (fields: object, message: string) => logged.push(["info", fields, message]),
    warn: (fields: object, message: string) => logged.push(["warn", fields, message]),
  };
  for (const event of h.events) logWalCheckpointerEvent(log, event);
  const stalls = logged.filter(([, , message]) => message.includes("stalled"));
  assert.equal(stalls.length, 2);
  assert.equal(stalls[0]![0], "warn");
  assert.deepEqual(Object.keys(stalls[0]![1]), ["sinceLastPassMs", "walBytes"]);
  assert.deepEqual(logged.filter(([, , message]) => message.includes("recovered")).map(([level]) => level), ["info", "info"]);
});

test("a sustained workload with idle stretches and a long reader reports no stall, nor does a clean shutdown", LIVE, async (t) => {
  const stallAfterMs = 1_000;
  const h = open(t, { intervalMs: 20, stallAfterMs });
  await until(() => has(h.events, "online"), "the worker to start");
  for (let round = 0; round < 10; round++) {
    h.ingest(100);
    await sleep(20);
  }
  // An empty, idle log: every pass finds no frames at all, reports nothing, and still counts.
  await until(() => {
    const row = h.db.raw().prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number; log: number };
    return row.busy === 0 && row.log === 0;
  }, "an empty log");
  const reports = h.events.length;
  await sleep(stallAfterMs * 2);
  assert.equal(h.events.length, reports, "passes over an empty log report nothing");
  // Busy passes: a reader pins the log, so passes skip the frames it still uses.
  const reader = new DatabaseSync(h.location);
  h.defer(() => reader.close());
  reader.exec("BEGIN");
  reader.prepare("SELECT COUNT(*) FROM session_events").get();
  for (let round = 0; round < 10; round++) {
    h.ingest(100);
    await sleep(stallAfterMs / 5);
  }
  assert.ok(h.events.some((event) => event.type === "checkpoint" && event.checkpointed < event.log),
    "passes ran beside the reader without copying everything");
  reader.exec("COMMIT");
  h.db.stopWalCheckpoints();
  await sleep(stallAfterMs * 2);
  assert.deepEqual(ofType(h.events, "stalled"), []);
});

test("a stopped, disabled or restarting worker never reports a stall", async (t) => {
  const stallAfterMs = 1_000;
  await t.test("stopped", LIVE, async (t) => {
    const h = open(t, { intervalMs: 20, stallAfterMs });
    await until(() => has(h.events, "online"), "the worker to start");
    h.db.stopWalCheckpoints();
    await sleep(stallAfterMs * 2.5);
    assert.deepEqual(ofType(h.events, "stalled"), []);
  });
  await t.test("restarting", LIVE, async (t) => {
    const h = open(t, { intervalMs: 20, stallAfterMs, restartDelaysMs: [60_000] });
    await until(() => has(h.events, "online"), "the worker to start");
    await (h.checkpointer as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
    await until(() => has(h.events, "exited"), "the exit to be observed");
    await sleep(stallAfterMs * 2.5);
    assert.equal(h.checkpointer.running(), false);
    assert.deepEqual(ofType(h.events, "stalled"), []);
  });
  await t.test("disabled", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "wollipog-wal-unfixed-"));
    const db = ControlPlaneDb.open(join(root, "control-plane.db"));
    t.after(() => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const events: WalCheckpointerEvent[] = [];
    // No worker spawns, so nothing is watched: even a threshold of 0 reports nothing.
    db.startWalCheckpoints({ sqliteVersion: "3.47.2", stallAfterMs: 0, onEvent: (event) => events.push(event) });
    await sleep(500);
    assert.deepEqual(events.map((event) => event.type), ["disabled"]);
  });
});

test("the control plane logs failures, stalls and recoveries, and nothing for routine passes", () => {
  const logged: Array<[level: string, message: string]> = [];
  const log = {
    info: (_fields: object, message: string) => logged.push(["info", message]),
    warn: (_fields: object, message: string) => logged.push(["warn", message]),
  };
  const events: WalCheckpointerEvent[] = [
    { type: "online" },
    { type: "checkpoint", busy: 0, log: 10, checkpointed: 10 },
    { type: "stalled", sinceLastPassMs: WAL_CHECKPOINT_STALL_MS, walBytes: null },
    { type: "recovered", stalledMs: 45_000 },
    { type: "failed", message: "boom" },
    { type: "exited", code: 1, restartInMs: 1_000 },
    { type: "disabled", reason: "old" },
  ];
  for (const event of events) logWalCheckpointerEvent(log, event);
  assert.deepEqual(logged, [
    ["warn", "WAL checkpoint worker stalled; no checkpoint pass has completed"],
    ["info", "WAL checkpoint worker recovered"],
    ["warn", "WAL checkpoint worker failed"],
    ["warn", "WAL checkpoint worker exited; restarting"],
    ["info", "WAL checkpoint worker disabled"],
  ]);
});
