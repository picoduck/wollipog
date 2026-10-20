import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ControlPlaneDb } from "./db.js";
import { IncrementalVacuum, INCREMENTAL_VACUUM_ENV as ENV, INCREMENTAL_VACUUM_STARTUP_MS,
  INCREMENTAL_VACUUM_INTERVAL_MS, parseIncrementalVacuum } from "./incremental-vacuum.js";
import { convertIncrementalVacuum, incrementalVacuumConversionRequiredBytes } from "./incremental-vacuum-conversion.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
function setup(db: ControlPlaneDb, value?: string, sleep: (ms: number) => Promise<void> = async () => {}, time = T0) {
  const clock = { now: time };
  const logs: Array<{ level: string; details: Record<string, unknown>; message: string }> = [];
  const worker = new IncrementalVacuum(db, { env: value === undefined ? {} : { [ENV]: value },
    now: () => clock.now, sleep,
    log: { info: (details, message) => logs.push({ level: "info", details: { ...details }, message }),
      warn: (details, message) => logs.push({ level: "warn", details: { ...details }, message }) } });
  return { clock, logs, worker };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "incremental-vacuum-test-"));
  return { dir, path: join(dir, "control-plane.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function seed(db: ControlPlaneDb) {
  // No optional SQLite extensions: explicitly fill a file with interior holes and kept rows.
  db.raw().exec("CREATE TABLE vacuum_fixture(id INTEGER PRIMARY KEY, content TEXT); BEGIN");
  const insert = db.raw().prepare("INSERT INTO vacuum_fixture VALUES (?,?)");
  for (let i = 0; i < 1000; i++) insert.run(i, `keep-${i}-` + "x".repeat(8192));
  db.raw().exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE); DELETE FROM vacuum_fixture WHERE id%5<>0; PRAGMA wal_checkpoint(TRUNCATE)");
}

test("opt-in parsing rejects invalid values; off leaves existing free pages and mode unchanged", async () => {
  for (const v of [undefined, "", " ", "0", "true", "2", "-1", "on"]) {
    assert.equal(parseIncrementalVacuum(v).enabled, false);
    assert.equal(parseIncrementalVacuum(v).invalid, ![undefined, "", " ", "0"].includes(v));
  }
  assert.deepEqual(parseIncrementalVacuum(" 1 "), { enabled: true, invalid: false });
  const db = ControlPlaneDb.open(":memory:");
  try {
    assert.equal(db.incrementalVacuumStats().mode, 0);
    const h = setup(db, "invalid"); h.clock.now += 10 * DAY;
    assert.equal((await h.worker.runPass()).steps, 0);
    assert.equal(db.incrementalVacuumStats().mode, 0);
    assert.ok(h.logs.some((l) => l.details.event === "incremental_vacuum_invalid"));
  } finally { db.close(); }
});

test("only enabled empty databases choose incremental mode; startup never converts an existing DB", async () => {
  const f = fixture();
  let db = ControlPlaneDb.open(f.path);
  try {
    assert.equal(db.incrementalVacuumStats().mode, 0);
    db.close(); db = ControlPlaneDb.open(f.path, { incrementalVacuum: true });
    assert.equal(db.incrementalVacuumStats().mode, 0);
    const h = setup(db, "1"); h.clock.now += DAY;
    assert.ok(h.logs.some((l) => l.details.event === "incremental_vacuum_conversion_required"));
    assert.equal((await h.worker.runPass()).steps, 0);
  } finally { db.close(); f.cleanup(); }
  const fresh = ControlPlaneDb.open(":memory:", { incrementalVacuum: true });
  try { assert.equal(fresh.incrementalVacuumStats().mode, 2); } finally { fresh.close(); }
});

test("24h arming survives reopening; observed off disables and reenabling arms anew", async () => {
  const f = fixture();
  let db = ControlPlaneDb.open(f.path, { incrementalVacuum: true });
  try {
    seed(db);
    let h = setup(db, "1"); h.clock.now += DAY - 1;
    assert.equal((await h.worker.runPass()).steps, 0);
    assert.deepEqual(db.getIncrementalVacuumPolicy(), { enabled: true, armedAt: T0 + DAY });
    db.close(); db = ControlPlaneDb.open(f.path); // Off does not undo the file's mode.
    h = setup(db, "1", async () => {}, T0 + DAY);
    assert.equal(db.getIncrementalVacuumPolicy()?.armedAt, T0 + DAY);
    assert.ok((await h.worker.runPass()).reclaimedPages > 0);
    h.worker.stop();
    const off = setup(db, "0", async () => {}, T0 + 2 * DAY);
    assert.deepEqual(db.getIncrementalVacuumPolicy(), { enabled: false, armedAt: null });
    assert.equal((await off.worker.runPass()).steps, 0);
    setup(db, "1", async () => {}, T0 + 2 * DAY);
    assert.equal(db.getIncrementalVacuumPolicy()?.armedAt, T0 + 3 * DAY);
  } finally { db.close(); f.cleanup(); }
});

test("paced steps reclaim a real file after ordinary checkpointing, preserving rows and durability", async () => {
  const f = fixture(); const db = ControlPlaneDb.open(f.path, { incrementalVacuum: true });
  try {
    seed(db);
    const beforeBytes = statSync(f.path).size;
    const beforeRows = db.raw().prepare("SELECT * FROM vacuum_fixture ORDER BY id").all();
    const beforePages = db.incrementalVacuumStats().pages;
    const pauses: number[] = [];
    const h = setup(db, "1", async (ms) => { pauses.push(ms); }); h.clock.now += DAY;
    const result = await h.worker.runPass();
    assert.ok(result.reclaimedPages >= 256);
    assert.equal(result.steps, pauses.length);
    assert.ok(pauses.every((ms) => ms >= 1));
    assert.equal(beforePages - db.incrementalVacuumStats().pages, result.reclaimedPages);
    assert.equal(result.reclaimedBytes, result.reclaimedPages * db.incrementalVacuumStats().pageSize);
    db.raw().exec("PRAGMA wal_checkpoint(PASSIVE)");
    assert.ok(statSync(f.path).size < beforeBytes * 0.6);
    assert.deepEqual(db.raw().prepare("SELECT * FROM vacuum_fixture ORDER BY id").all(), beforeRows);
    assert.equal(db.raw().prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
    for (const [pragma, expected] of [["synchronous", 2], ["secure_delete", 1], ["busy_timeout", 250], ["wal_autocheckpoint", 1000]] as const) {
      assert.equal(Object.values(db.raw().prepare(`PRAGMA ${pragma}`).get()!)[0], expected);
    }
    assert.equal(db.raw().prepare("PRAGMA journal_mode").get()!.journal_mode, "wal");
    const log = h.logs.find((l) => l.details.event === "incremental_vacuum_pass")!;
    assert.equal(log.details.reclaimedPages, result.reclaimedPages);
    assert.equal(log.details.p95StepMs, result.p95StepMs);
    assert.equal(log.details.entryPoint, "maintenance"); assert.equal(typeof log.details.runId, "string");
  } finally { db.close(); f.cleanup(); }
});

test("malformed persisted arming state fails closed and reenabling gets a full delay", async () => {
  const db = ControlPlaneDb.open(":memory:", { incrementalVacuum: true });
  try {
    for (const value of ["broken", "null", '{}', '{"enabled":true,"armedAt":-1}', '{"enabled":true,"armedAt":"1"}']) {
      db.raw().prepare("INSERT OR REPLACE INTO control_plane_metadata(key,value) VALUES ('incremental_vacuum_policy',?)").run(value);
      const h = setup(db, "1");
      assert.equal(db.getIncrementalVacuumPolicy()?.armedAt, T0 + DAY);
      assert.equal((await h.worker.runPass()).steps, 0);
    }
  } finally { db.close(); }
});

test("threshold, 1–32 page budget, 1000-step cap and single-flight are enforced", async () => {
  const db = ControlPlaneDb.open(":memory:", { incrementalVacuum: true });
  try {
    const stats = { mode: 2, freePages: 255, pageSize: 4096, pages: 100_000 };
    db.incrementalVacuumStats = () => stats;
    const requested: number[] = [];
    db.incrementalVacuumStep = (pages) => { requested.push(pages); return { reclaimedPages: pages, freePages: 99_999 }; };
    let unblock!: () => void;
    const pause = new Promise<void>((r) => { unblock = r; });
    const h = setup(db, "1", async (ms) => { assert.ok(ms >= 1); await pause; }); h.clock.now += DAY;
    assert.equal((await h.worker.runPass()).steps, 0);
    stats.freePages = 256;
    const pass = h.worker.runPass(); assert.equal(h.worker.runPass(), pass);
    unblock();
    const result = await pass;
    assert.equal(result.steps, 1000); assert.equal(requested[0], 1);
    assert.ok(requested.every((p) => p >= 1 && p <= 32));
    assert.ok(h.logs.some((l) => l.details.stepLimitReached === true));
  } finally { db.close(); }
});

test("stop interrupts between steps; an error defers and a later pass resumes", async () => {
  const db = ControlPlaneDb.open(":memory:", { incrementalVacuum: true });
  try {
    db.incrementalVacuumStats = () => ({ mode: 2, freePages: 1000, pageSize: 4096, pages: 2000 });
    db.incrementalVacuumStep = () => { throw new Error("fixture busy"); };
    const h = setup(db, "1", async () => { h.worker.stop(); }); h.clock.now += DAY;
    assert.equal((await h.worker.runPass()).steps, 0);
    assert.ok(h.logs.some((l) => l.details.event === "incremental_vacuum_deferred"));
    db.incrementalVacuumStep = () => ({ reclaimedPages: 1, freePages: 999 });
    assert.equal((await h.worker.runPass()).steps, 1);
    assert.equal((await h.worker.runPass()).steps, 0);
    assert.ok(h.logs.some((l) => l.details.interrupted === true));
  } finally { db.close(); }
});

test("slow-step telemetry and three-times pacing use the measured complete step duration", async (t) => {
  const db = ControlPlaneDb.open(":memory:", { incrementalVacuum: true });
  try {
    db.incrementalVacuumStats = () => ({ mode: 2, freePages: 256, pageSize: 4096, pages: 1000 });
    let steps = 0;
    db.incrementalVacuumStep = () => ({ reclaimedPages: 1, freePages: 3 - ++steps });
    let elapsed = 0;
    t.mock.method(performance, "now", () => { elapsed += 20; return elapsed; });
    const rests: number[] = [];
    const h = setup(db, "1", async (ms) => { rests.push(ms); }); h.clock.now += DAY;
    const result = await h.worker.runPass();
    assert.deepEqual(rests, [60, 60, 60]);
    assert.equal(result.p95StepMs, 20); assert.equal(result.maxStepMs, 20);
    const warnings = h.logs.filter((l) => l.details.event === "incremental_vacuum_slow_step");
    assert.equal(warnings.length, 1, "slow storage warns once per pass, not once per step");
    assert.equal(warnings[0]!.details.stepMs, 20);
    assert.equal(h.logs.find((l) => l.details.event === "incremental_vacuum_pass")!.details.slowSteps, 3);
  } finally { db.close(); }
});

test("a contended vacuum defers without the request busy wait and restores connection settings", () => {
  const f = fixture(); const db = ControlPlaneDb.open(f.path, { incrementalVacuum: true });
  const other = new DatabaseSync(f.path);
  try {
    seed(db); other.exec("BEGIN IMMEDIATE");
    assert.throws(() => db.incrementalVacuumStep(1), /locked/);
    assert.equal(db.raw().prepare("PRAGMA busy_timeout").get()!.timeout, 250);
    assert.equal(db.raw().prepare("PRAGMA synchronous").get()!.synchronous, 2);
    other.exec("ROLLBACK");
    assert.ok(db.incrementalVacuumStep(1).reclaimedPages > 0);
    for (const n of [0, -1, 33, 1.5, NaN]) assert.throws(() => db.incrementalVacuumStep(n), /1–32/);
    db.raw().exec("BEGIN"); assert.throws(() => db.incrementalVacuumStep(1), /transaction/); db.raw().exec("ROLLBACK");
  } finally { other.close(); db.close(); f.cleanup(); }
});

test("schedule waits 10min then an hour after each pass and stops cleanly", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const db = ControlPlaneDb.open(":memory:");
  try {
    const h = setup(db); let passes = 0;
    h.worker.runPass = async () => { passes++; return { steps: 0, reclaimedPages: 0, reclaimedBytes: 0, p95StepMs: 0, maxStepMs: 0 }; };
    h.worker.start(); h.worker.start();
    t.mock.timers.tick(INCREMENTAL_VACUUM_STARTUP_MS - 1); assert.equal(passes, 0);
    t.mock.timers.tick(1); await Promise.resolve(); assert.equal(passes, 1);
    t.mock.timers.tick(INCREMENTAL_VACUUM_INTERVAL_MS); await Promise.resolve(); assert.equal(passes, 2);
    h.worker.stop(); t.mock.timers.tick(INCREMENTAL_VACUUM_INTERVAL_MS); assert.equal(passes, 2);
  } finally { db.close(); }
});

test("offline conversion refuses missing acknowledgement, insufficient/unknown disk and connected WAL owners", () => {
  const f = fixture(); let owner: DatabaseSync | undefined;
  try {
    owner = new DatabaseSync(f.path); owner.exec("PRAGMA journal_mode=WAL; CREATE TABLE kept(id INTEGER PRIMARY KEY, text TEXT); INSERT INTO kept VALUES(7,'kept')");
    assert.throws(() => convertIncrementalVacuum(f.path, { ownerStopped: false }), /owner-stopped/);
    assert.throws(() => convertIncrementalVacuum(f.path, { ownerStopped: true }), /locked/);
    owner.close(); owner = undefined;
    assert.throws(() => convertIncrementalVacuum(f.path, { ownerStopped: true, availableBytes: () => 0n }), /insufficient/);
    assert.throws(() => convertIncrementalVacuum(f.path, { ownerStopped: true,
      availableBytes: (p) => p === realpathSync(tmpdir()) ? 0n : 10n ** 15n }), /insufficient/);
    assert.throws(() => convertIncrementalVacuum(f.path, { ownerStopped: true, availableBytes: () => { throw new Error("disk unknown"); } }), /disk unknown/);
    owner = new DatabaseSync(f.path);
    assert.equal(owner.prepare("PRAGMA auto_vacuum").get()!.auto_vacuum, 0);
    assert.equal(owner.prepare("SELECT text FROM kept WHERE id=7").get()!.text, "kept");
  } finally { owner?.close(); f.cleanup(); }
});

test("offline conversion checks both locations, preserves WAL and rows, and is idempotent", () => {
  const f = fixture(); const source = new DatabaseSync(f.path);
  source.exec("PRAGMA journal_mode=WAL; CREATE TABLE kept(id INTEGER PRIMARY KEY, text TEXT); INSERT INTO kept VALUES(7,'kept')"); source.close();
  const checked: string[] = [];
  try {
    const result = convertIncrementalVacuum(f.path, { ownerStopped: true,
      availableBytes: (p) => { checked.push(p); return 10n ** 15n; } });
    assert.equal(result.converted, true);
    assert.ok(checked.includes(realpathSync(f.dir))); assert.ok(checked.includes(realpathSync(tmpdir())));
    assert.equal(result.requiredBytes, incrementalVacuumConversionRequiredBytes(result.databaseBytes));
    const db = new DatabaseSync(f.path);
    try {
      assert.equal(db.prepare("PRAGMA auto_vacuum").get()!.auto_vacuum, 2);
      assert.equal(db.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal");
      assert.equal(db.prepare("SELECT text FROM kept WHERE id=7").get()!.text, "kept");
      assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
    } finally { db.close(); }
    assert.equal(convertIncrementalVacuum(f.path, { ownerStopped: true }).converted, false);
    assert.equal(incrementalVacuumConversionRequiredBytes(100n), 200n + 256n * 1024n * 1024n);
    assert.equal(incrementalVacuumConversionRequiredBytes(10_000_000_001n), 21_000_000_003n);
  } finally { f.cleanup(); }
});

test("standalone conversion CLI validates acknowledgement and converts only the named fixture", () => {
  const f = fixture(); const source = new DatabaseSync(f.path);
  source.exec("CREATE TABLE kept(id INTEGER PRIMARY KEY); INSERT INTO kept VALUES(19)"); source.close();
  const script = fileURLToPath(new URL("../scripts/enable-incremental-vacuum.ts", import.meta.url));
  try {
    const refused = spawnSync(process.execPath, ["--import", "tsx", script, "--db", f.path], { encoding: "utf8" });
    assert.equal(refused.status, 1); assert.match(refused.stderr, /owner-stopped/);
    const converted = spawnSync(process.execPath, ["--import", "tsx", script, "--db", f.path, "--owner-stopped", "--temp-dir", f.dir], { encoding: "utf8" });
    assert.equal(converted.status, 0, converted.stderr);
    const output = JSON.parse(converted.stdout) as { converted: boolean; event: string; entryPoint: string };
    assert.equal(output.converted, true); assert.equal(output.event, "incremental_vacuum_conversion");
    assert.equal(output.entryPoint, "offline_cli");
    const db = new DatabaseSync(f.path);
    try { assert.equal(db.prepare("SELECT id FROM kept").get()!.id, 19); } finally { db.close(); }
  } finally { f.cleanup(); }
});

test("conversion and SQLite backups preserve transcript/search data; pre-conversion restores require conversion again", async () => {
  const f = fixture(); const oldBackup = join(f.dir, "old.db"); const newBackup = join(f.dir, "new.db");
  let db = ControlPlaneDb.open(f.path);
  try {
    db.registerRunner({ runnerId: "r", hostname: "fixture", os: "linux", version: "1", workspaces: [], agents: [] }, T0);
    db.createSession({ id: "s", runnerId: "r", workspaceId: "w", agentId: "a", title: "fixture",
      useWorktree: false, driver: "claude-code", config: {}, now: T0 });
    db.appendEvent("s", { kind: "user_message", text: "retained albatross prompt" }, T0);
    const events = db.raw().prepare("SELECT * FROM session_events").all();
    const search = db.raw().prepare("SELECT rowid,* FROM session_events_fts WHERE session_events_fts MATCH 'albatross'").all();
    assert.equal(search.length, 1);
    db.raw().prepare("VACUUM INTO ?").run(oldBackup);
    db.close();
    assert.equal(convertIncrementalVacuum(f.path, { ownerStopped: true }).converted, true);
    db = ControlPlaneDb.open(f.path);
    assert.deepEqual(db.raw().prepare("SELECT * FROM session_events").all(), events);
    assert.deepEqual(db.raw().prepare("SELECT rowid,* FROM session_events_fts WHERE session_events_fts MATCH 'albatross'").all(), search);
    db.raw().prepare("VACUUM INTO ?").run(newBackup);
    for (const [path, mode] of [[oldBackup, 0], [newBackup, 2]] as const) {
      const restored = ControlPlaneDb.open(path, { incrementalVacuum: true });
      try {
        assert.equal(restored.incrementalVacuumStats().mode, mode);
        assert.deepEqual(restored.raw().prepare("SELECT * FROM session_events").all(), events);
        const h = setup(restored, "1"); h.clock.now += DAY;
        assert.equal((await h.worker.runPass()).steps, 0);
        assert.equal(h.logs.some((l) => l.details.event === "incremental_vacuum_conversion_required"), mode === 0);
      } finally { restored.close(); }
    }
    assert.equal(convertIncrementalVacuum(oldBackup, { ownerStopped: true }).converted, true);
  } finally { db.close(); f.cleanup(); }
});
