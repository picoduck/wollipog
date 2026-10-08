import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import {
  DEFAULT_WAL_AUTOCHECKPOINT_PAGES,
  WAL_CHECKPOINT_BACKSTOP_PAGES,
  WalCheckpointer,
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

function runnerMeta(): RunnerMetadata {
  return {
    runnerId: RUNNER_ID, hostname: "host", os: "linux", version: "1.0.0",
    workspaces: [{ id: "ws", name: "Repo", path: "/tmp/wal" }],
    agents: [{ id: "agent", name: "Agent", command: "claude", args: [], env: {}, driver: "claude-code",
      available: true, context: { kind: "native" } }],
  };
}

function open(t: TestContext, options: WalCheckpointerOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wal-checkpointer-"));
  const location = join(root, "control-plane.db");
  const db = ControlPlaneDb.open(location);
  const events: WalCheckpointerEvent[] = [];
  let closed = false;
  const close = () => {
    if (!closed) db.close();
    closed = true;
  };
  t.after(() => {
    close();
    rmSync(root, { recursive: true, force: true });
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
  return { db, location, wal: `${location}-wal`, events, checkpointer, ingest, pragma, close };
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

test("the worker checkpoints the log while the main connection's own checkpoint waits at the backstop", async (t) => {
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

test("main-connection readers and writers never wait for the worker", async (t) => {
  const h = open(t, { intervalMs: 1 });
  await until(() => has(h.events, "online"), "the worker to start");
  // Any wait for a lock the worker held would now fail at once with SQLITE_BUSY.
  h.db.raw().exec("PRAGMA busy_timeout = 0");
  // A long-lived reader elsewhere pins part of the log; the worker must skip past it, not wait.
  const reader = new DatabaseSync(h.location);
  t.after(() => reader.close());
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

test("a dead worker leaves the log bounded by the backstop, and the main connection keeps writing", async (t) => {
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

test("a crashed worker restarts and resumes checkpointing", async (t) => {
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

test("a worker that cannot open the database never takes the control plane down", async (t) => {
  const h = open(t, { intervalMs: 20 });
  const events: WalCheckpointerEvent[] = [];
  const broken = new WalCheckpointer(h.db.raw(), join(h.location, "not-a-directory", "missing.db"), {
    restartDelaysMs: [20], onEvent: (event) => events.push(event),
  });
  broken.start();
  t.after(() => broken.stop());
  await until(() => events.filter((event) => event.type === "exited").length >= 2, "two failed starts");
  assert.ok(has(events, "failed"));
  h.ingest(10);
  assert.equal(h.db.getHydratedSeq("s-1"), 10, "the main connection is unaffected");
  broken.stop();
  const settled = events.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(events.length, settled, "a stopped checkpointer schedules nothing more");
});

test("a clean shutdown checkpoints once more and leaves no log or lock behind", async (t) => {
  const h = open(t, { intervalMs: 60_000 });
  await until(() => has(h.events, "online"), "the worker to start");
  h.ingest(300);
  assert.ok(existsSync(h.wal));
  h.db.stopWalCheckpoints();
  assert.equal(h.checkpointer.running(), false);
  // The worker reported its last checkpoint before it closed; the report arrives on a later turn.
  await until(() => has(h.events, "checkpoint"), "the last checkpoint's report");
  const last = h.events.filter((event) => event.type === "checkpoint").at(-1);
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
