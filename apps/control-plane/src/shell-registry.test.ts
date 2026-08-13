import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ControlPlaneDb } from "./db.js";
import { ShellRegistry } from "./shell-registry.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-shell-registry-"));
  const path = join(dir, "control-plane.db");
  const db = ControlPlaneDb.open(path);
  db.raw().prepare(
    `INSERT INTO runners (runner_id, hostname, os, version, status, created_at, updated_at)
     VALUES ('runner-1', 'box', 'linux', 'test', 'online', 1, 1)`,
  ).run();
  db.raw().prepare(
    "INSERT INTO sessions (id, runner_id, title, created_at, updated_at) VALUES ('session-1', 'runner-1', 'Test', 1, 1)",
  ).run();
  return { dir, path, db, registry: new ShellRegistry(db) };
}

test("durable shell history survives CP restart and snapshot replay is idempotent", () => {
  const f = fixture();
  try {
    f.registry.create({
      shellId: "shell-1",
      sessionId: "session-1",
      runnerId: "runner-1",
      name: "Shell 1",
      createdAt: 10,
      pty: true,
    });
    assert.deepEqual(
      f.registry.output("runner-1", "shell-1", "stdout", "one\n", 1, 11),
      { seq: 1, stream: "stdout", data: "one\n" },
    );
    assert.equal(f.registry.output("runner-1", "shell-1", "stdout", "duplicate", 1, 12), null);
    assert.equal(f.registry.markReconnecting("runner-1", 13)[0]?.status, "reconnecting");
    const replayed = f.registry.snapshot("runner-1", {
      type: "shell_snapshot",
      shellId: "shell-1",
      sessionId: "session-1",
      name: "Shell 1",
      createdAt: 10,
      pty: true,
      kind: "shell",
      status: "running",
      exitCode: null,
      outputStartSeq: 1,
      outputEndSeq: 2,
      outputTruncated: false,
      chunks: [
        { seq: 1, stream: "stdout", data: "one\n" },
        { seq: 2, stream: "stderr", data: "two\n" },
      ],
    }, 14);
    assert.equal(replayed?.status, "running");
    f.registry.create({
      shellId: "shell-opened-after-snapshot",
      sessionId: "session-1",
      runnerId: "runner-1",
      name: "Shell 2",
      createdAt: 14,
    });
    assert.deepEqual(f.registry.inventoryComplete("runner-1", ["shell-1"], 15), []);
    assert.equal(f.registry.get("shell-opened-after-snapshot")?.status, "running");
    assert.deepEqual(
      f.registry.output("runner-1", "shell-opened-after-snapshot", "stdout", "still live\n", 1, 15),
      { seq: 1, stream: "stdout", data: "still live\n" },
      "a shell opened after the point-in-time inventory remains writable",
    );
    assert.deepEqual(f.registry.history("shell-1", 0, 200)?.chunks, [
      { seq: 1, stream: "stdout", data: "one\n" },
      { seq: 2, stream: "stderr", data: "two\n" },
    ]);

    f.db.close();
    const reopened = ControlPlaneDb.open(f.path);
    try {
      const registry = new ShellRegistry(reopened);
      assert.equal(registry.reconcileStartup(16), 2);
      assert.equal(registry.get("shell-1")?.status, "reconnecting");
      assert.equal(registry.history("shell-1", 0, 200)?.chunks.length, 2);
      const missing = registry.inventoryComplete("runner-1", [], 17);
      assert.deepEqual(missing.map((shell) => shell.shellId).sort(), ["shell-1", "shell-opened-after-snapshot"]);
      assert.ok(missing.every((shell) => shell.status === "exited"));
      assert.equal(registry.get("shell-1")?.status, "exited");
    } finally {
      reopened.close();
    }
  } finally {
    try { rmSync(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Windows may retain a WAL handle briefly. */ }
  }
});

test("close tombstone blocks an in-flight reconnect snapshot from resurrecting a shell", () => {
  const f = fixture();
  try {
    assert.equal(f.registry.nextName("session-1"), "Shell 1");
    f.registry.create({
      shellId: "shell-1",
      sessionId: "session-1",
      runnerId: "runner-1",
      name: "Shell 1",
      createdAt: 10,
    });
    f.registry.remove("shell-1", "runner-1", 11);
    assert.equal(f.registry.nextName("session-1"), "Shell 2", "closed shell names are never reused");
    assert.equal(f.registry.snapshot("runner-1", {
      type: "shell_snapshot",
      shellId: "shell-1",
      sessionId: "session-1",
      name: "Shell 1",
      createdAt: 10,
      pty: false,
      kind: "shell",
      status: "running",
      exitCode: null,
      outputStartSeq: 1,
      outputEndSeq: 0,
      outputTruncated: false,
      chunks: [],
    }, 12), null);
    assert.equal(f.registry.get("shell-1"), undefined);
    assert.deepEqual(f.registry.pendingCloseIds("runner-1"), ["shell-1"]);
    f.registry.inventoryComplete("runner-1", ["shell-1"], 13);
    assert.deepEqual(f.registry.pendingCloseIds("runner-1"), ["shell-1"], "retained until runner confirms exit");
    f.registry.exit("runner-1", "shell-1", null, 0, 14);
    assert.deepEqual(f.registry.pendingCloseIds("runner-1"), []);
  } finally {
    f.db.close();
    try { rmSync(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best-effort temp cleanup */ }
  }
});

test("registration resolves reconnecting shells only for runners without durable inventory", () => {
  const f = fixture();
  try {
    f.registry.create({
      shellId: "legacy-shell",
      sessionId: "session-1",
      runnerId: "runner-1",
      name: "Shell 1",
      createdAt: 10,
    });
    f.registry.markReconnecting("runner-1", 11);
    assert.deepEqual(f.registry.reconcileRegistration("runner-1", 56, 12).map((shell) => shell.shellId), ["legacy-shell"]);
    assert.equal(f.registry.get("legacy-shell")?.status, "exited");

    f.registry.create({
      shellId: "durable-shell",
      sessionId: "session-1",
      runnerId: "runner-1",
      name: "Shell 2",
      createdAt: 20,
    });
    f.registry.markReconnecting("runner-1", 21);
    assert.deepEqual(f.registry.reconcileRegistration("runner-1", 57, 22), []);
    assert.equal(f.registry.get("durable-shell")?.status, "reconnecting");
  } finally {
    f.db.close();
    try { rmSync(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best-effort temp cleanup */ }
  }
});

test("sustained small-chunk output prunes incrementally with durable counters", () => {
  const f = fixture();
  try {
    f.registry.create({
      shellId: "busy-shell",
      sessionId: "session-1",
      runnerId: "runner-1",
      name: "Shell 1",
      createdAt: 10,
    });
    for (let seq = 1; seq <= 3_000; seq++) {
      assert.ok(f.registry.output("runner-1", "busy-shell", "stdout", "x", seq, 10 + seq));
    }
    const stats = f.db.raw().prepare(
      "SELECT output_chars AS chars, output_chunks AS chunks FROM session_shells WHERE shell_id='busy-shell'",
    ).get() as unknown as { chars: number; chunks: number };
    assert.deepEqual({ ...stats }, { chars: 2_048, chunks: 2_048 });
    assert.equal(f.registry.get("busy-shell")?.outputStartSeq, 953);
    assert.equal(f.registry.get("busy-shell")?.outputTruncated, true);

    f.registry.create({
      shellId: "wide-shell",
      sessionId: "session-1",
      runnerId: "runner-1",
      name: "Shell 2",
      createdAt: 20,
    });
    for (let seq = 1; seq <= 220; seq++) {
      assert.ok(f.registry.output("runner-1", "wide-shell", "stdout", "y".repeat(1_000), seq, 20 + seq));
    }
    const wideStats = f.db.raw().prepare(
      "SELECT output_chars AS chars, output_chunks AS chunks FROM session_shells WHERE shell_id='wide-shell'",
    ).get() as unknown as { chars: number; chunks: number };
    assert.deepEqual({ ...wideStats }, { chars: 200_000, chunks: 200 });
    assert.equal(f.registry.get("wide-shell")?.outputStartSeq, 21);
  } finally {
    f.db.close();
    try { rmSync(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best-effort temp cleanup */ }
  }
});

test("startup repairs a crash-interrupted shell-output counter migration", () => {
  const f = fixture();
  try {
    f.registry.create({
      shellId: "migration-shell",
      sessionId: "session-1",
      runnerId: "runner-1",
      name: "Migration shell",
      createdAt: 10,
    });
    for (let seq = 1; seq <= 3; seq++) {
      assert.ok(f.registry.output("runner-1", "migration-shell", "stdout", "abc", seq, 10 + seq));
    }
    f.db.raw().exec(
      `DROP TRIGGER session_shell_output_insert_stats;
       DROP TRIGGER session_shell_output_delete_stats;
       UPDATE session_shells SET output_chars=0, output_chunks=0 WHERE shell_id='migration-shell';`,
    );
    f.db.close();

    const reopened = ControlPlaneDb.open(f.path);
    try {
      const stats = reopened.raw().prepare(
        "SELECT output_chars AS chars, output_chunks AS chunks FROM session_shells WHERE shell_id='migration-shell'",
      ).get() as unknown as { chars: number; chunks: number };
      assert.deepEqual({ ...stats }, { chars: 9, chunks: 3 });
      const registry = new ShellRegistry(reopened);
      assert.ok(registry.output("runner-1", "migration-shell", "stdout", "z", 4, 20));
      const afterInsert = reopened.raw().prepare(
        "SELECT output_chars AS chars, output_chunks AS chunks FROM session_shells WHERE shell_id='migration-shell'",
      ).get() as unknown as { chars: number; chunks: number };
      assert.deepEqual({ ...afterInsert }, { chars: 10, chunks: 4 }, "recreated triggers maintain repaired counters");
    } finally {
      reopened.close();
    }
  } finally {
    try { rmSync(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best-effort temp cleanup */ }
  }
});

test("large reconnect snapshots prune one bounded suffix atomically", () => {
  const f = fixture();
  try {
    const chunkCount = 30_000;
    const replayed = f.registry.snapshot("runner-1", {
      type: "shell_snapshot",
      shellId: "snapshot-shell",
      sessionId: "session-1",
      name: "Agent TUI",
      createdAt: 10,
      pty: true,
      kind: "agent_tui",
      status: "running",
      exitCode: null,
      outputStartSeq: 1,
      outputEndSeq: chunkCount,
      outputTruncated: false,
      chunks: Array.from({ length: chunkCount }, (_, index) => ({
        seq: index + 1,
        stream: "stdout" as const,
        data: "x",
      })),
    }, 20);
    assert.equal(replayed?.outputStartSeq, chunkCount - 2_048 + 1);
    assert.equal(replayed?.outputTruncated, true);
    const stats = f.db.raw().prepare(
      "SELECT output_chars AS chars, output_chunks AS chunks FROM session_shells WHERE shell_id='snapshot-shell'",
    ).get() as unknown as { chars: number; chunks: number };
    assert.deepEqual({ ...stats }, { chars: 2_048, chunks: 2_048 });
    assert.equal(f.registry.history("snapshot-shell", 0, 1)?.chunks[0]?.seq, chunkCount - 2_048 + 1);

    const wideCount = 300;
    const wide = f.registry.snapshot("runner-1", {
      type: "shell_snapshot",
      shellId: "wide-snapshot-shell",
      sessionId: "session-1",
      name: "Wide shell",
      createdAt: 11,
      pty: true,
      kind: "shell",
      status: "running",
      exitCode: null,
      outputStartSeq: 1,
      outputEndSeq: wideCount,
      outputTruncated: false,
      chunks: Array.from({ length: wideCount }, (_, index) => ({
        seq: index + 1,
        stream: "stdout" as const,
        data: "y".repeat(1_000),
      })),
    }, 21);
    assert.equal(wide?.outputStartSeq, 101);
    const wideStats = f.db.raw().prepare(
      "SELECT output_chars AS chars, output_chunks AS chunks FROM session_shells WHERE shell_id='wide-snapshot-shell'",
    ).get() as unknown as { chars: number; chunks: number };
    assert.deepEqual({ ...wideStats }, { chars: 200_000, chunks: 200 });
  } finally {
    f.db.close();
    try { rmSync(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best-effort temp cleanup */ }
  }
});

test("snapshot ingest failure rolls back the shell and every output chunk", () => {
  const f = fixture();
  try {
    f.db.raw().exec(
      `CREATE TRIGGER reject_snapshot_test_chunk
       BEFORE INSERT ON session_shell_output
       WHEN NEW.shell_id='rollback-shell' AND NEW.seq=2
       BEGIN SELECT RAISE(ABORT, 'intentional snapshot ingest failure'); END;`,
    );
    assert.throws(() => f.registry.snapshot("runner-1", {
      type: "shell_snapshot",
      shellId: "rollback-shell",
      sessionId: "session-1",
      name: "Rollback shell",
      createdAt: 10,
      pty: true,
      kind: "shell",
      status: "running",
      exitCode: null,
      outputStartSeq: 1,
      outputEndSeq: 2,
      outputTruncated: false,
      chunks: [
        { seq: 1, stream: "stdout", data: "first" },
        { seq: 2, stream: "stdout", data: "rejected" },
      ],
    }, 20), /intentional snapshot ingest failure/);
    assert.equal(f.registry.get("rollback-shell"), undefined);
    const chunks = f.db.raw().prepare(
      "SELECT COUNT(*) AS count FROM session_shell_output WHERE shell_id='rollback-shell'",
    ).get() as unknown as { count: number };
    assert.equal(chunks.count, 0);
  } finally {
    f.db.close();
    try { rmSync(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best-effort temp cleanup */ }
  }
});

test("definitive failed-open discard leaves no close tombstone", () => {
  const f = fixture();
  try {
    f.registry.create({
      shellId: "never-opened",
      sessionId: "session-1",
      runnerId: "runner-1",
      name: "Shell 1",
      createdAt: 10,
    });
    f.registry.discardUnopened("never-opened", "runner-1");
    assert.equal(f.registry.get("never-opened"), undefined);
    assert.deepEqual(f.registry.pendingCloseIds("runner-1"), []);
  } finally {
    f.db.close();
    try { rmSync(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best-effort temp cleanup */ }
  }
});
