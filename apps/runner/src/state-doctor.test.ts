import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { CheckpointRefOwnershipLedger } from "./checkpoint-ref-ownership.js";
import { runStateDoctor, stateDoctorFileSyncFlags } from "./state-doctor.js";
import { WorktreeCleanupJournal } from "./worktree.js";

function fixture(t: Parameters<typeof test>[1] extends (t: infer T) => unknown ? T : never) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-state-doctor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, ".wollipog-runner-owner-v2.json"), `${JSON.stringify({
    version: 2,
    ownerHash: "a".repeat(64),
  })}\n`, { mode: 0o600 });
  writeFileSync(join(root, ".wollipog-runner-owner-v1.json"), `${JSON.stringify({
    version: 1,
    ownerHash: "b".repeat(64),
  })}\n`, { mode: 0o600 });
  return root;
}

async function capture(argv: string[]): Promise<string> {
  let output = "";
  await runStateDoctor(argv, (value) => { output += value; });
  return output;
}

test("Windows state-doctor file fsync uses a write-capable handle", () => {
  assert.notEqual(stateDoctorFileSyncFlags("win32") & constants.O_RDWR, 0);
  assert.equal(stateDoctorFileSyncFlags("linux") & constants.O_RDWR, 0);
});

test("state doctor inventory is redacted, deterministic in shape, and read-only", async (t) => {
  const root = fixture(t);
  const conductor = join(root, "conductor");
  mkdirSync(conductor);
  const legacy = join(conductor, "secret-session.mcp.json");
  const canary = "mamwhsec_NEVER_PRINT_ME https://private.example/control-plane";
  writeFileSync(legacy, canary, { mode: 0o600 });
  const before = readFileSync(legacy, "utf8");
  const output = await capture([
    "runner", "--state-doctor", "inventory", "--data-dir", root,
  ]);
  const report = JSON.parse(output) as Record<string, unknown>;
  assert.equal(report.legacyConductorConfigs, 1);
  assert.equal(output.includes(canary), false);
  assert.equal(output.includes("secret-session"), false);
  assert.equal(output.includes(root), false);
  assert.equal(readFileSync(legacy, "utf8"), before);
});

test("state doctor holds an exclusive runner-compatible maintenance lease through inventory", async (t) => {
  const root = fixture(t);
  const lease = join(root, ".wollipog-runner-active-v1.lock");
  let observed = false;
  await runStateDoctor(
    ["runner", "--state-doctor", "inventory", "--data-dir", root],
    () => {},
    {
      pid: 4242,
      hostname: "doctor-host",
      beforeDurabilityOperationForTest: (operation) => {
        if (operation !== "maintenance-lease-published") return;
        observed = true;
        assert.equal(existsSync(lease), true);
        assert.throws(() => writeFileSync(lease, "competitor", { flag: "wx" }), /EEXIST/u);
        const record = JSON.parse(readFileSync(lease, "utf8")) as Record<string, unknown>;
        assert.equal(record.version, 2);
        assert.equal(record.ownerHash, "a".repeat(64));
        assert.equal(record.pid, 4242);
      },
    },
  );
  assert.equal(observed, true);
  assert.equal(existsSync(lease), false, "maintenance lease is released only after the command completes");
});

test("state doctor mutations require offline acknowledgment and quarantine without reading bytes", async (t) => {
  const root = fixture(t);
  const conductor = join(root, "conductor");
  mkdirSync(conductor);
  const legacy = join(conductor, "session.mcp.json");
  writeFileSync(legacy, "TOKEN_CANARY", { mode: 0o600 });
  await assert.rejects(runStateDoctor([
    "runner", "--state-doctor", "quarantine-conductor", "--data-dir", root,
  ]), /ack-all-legacy-runners-stopped/);
  const output = await capture([
    "runner", "--state-doctor", "quarantine-conductor", "--data-dir", root,
    "--ack-all-legacy-runners-stopped",
  ]);
  assert.equal(existsSync(legacy), false);
  assert.equal(output.includes("TOKEN_CANARY"), false);
  const result = JSON.parse(output) as { quarantined: number; quarantineId: string };
  assert.equal(result.quarantined, 1);
  const target = join(root, "state-quarantine", result.quarantineId, "conductor");
  const manifest = JSON.parse(readFileSync(join(target, "manifest.json"), "utf8")) as {
    items: Array<{ itemId: string; originalName: string; storedAs: string }>;
  };
  assert.equal(manifest.items.length, 1);
  assert.equal(manifest.items[0]?.originalName, "session.mcp.json");
  assert.equal(manifest.items[0]?.storedAs, "0001.mcp.json");
  assert.match(manifest.items[0]?.itemId ?? "", /^[a-f0-9]{64}$/u);
  assert.deepEqual(readdirSync(target).sort(), ["0001.mcp.json", "manifest.json"]);
});

test("state doctor refuses all work while a runner lease remains", async (t) => {
  const root = fixture(t);
  writeFileSync(join(root, ".wollipog-runner-active-v1.lock"), "{}", { mode: 0o600 });
  await assert.rejects(runStateDoctor([
    "runner", "--state-doctor", "inventory", "--data-dir", root,
  ]), /active or unrecovered lease/);
});

test("checkpoint adoption preserves a live worktree by retiring its exact stale cleanup proof", async (t) => {
  const root = fixture(t);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "tracked.txt"), "checkpoint\n");
  execFileSync("git", ["-C", repo, "add", "tracked.txt"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "checkpoint"]);
  const oid = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const worktreePath = join(root, "live-worktree");
  execFileSync("git", ["-C", repo, "worktree", "add", "-qb", "agent/s_adopt", worktreePath]);
  for (const namespace of ["wollipog", "mam"]) {
    execFileSync("git", ["-C", repo, "update-ref", `refs/${namespace}/s_adopt/turn-1`, oid]);
  }
  const sessionDir = join(root, "sessions", "s_adopt");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "meta.json"), `${JSON.stringify({
    sessionId: "s_adopt",
    repoPath: repo,
    context: { kind: "native" },
    worktreePath,
  })}\n`, { mode: 0o600 });
  const ledger = new CheckpointRefOwnershipLedger(root);
  const legacy = { sessionId: "s_adopt", repoPath: repo, context: { kind: "native" as const } };
  ledger.claim(legacy);
  new WorktreeCleanupJournal(root).add({ ...legacy, worktreePath });

  const output = await capture([
    "runner", "--state-doctor", "adopt-checkpoints", "--data-dir", root,
    "--session-id", "s_adopt", "--ack-all-legacy-runners-stopped",
  ]);
  assert.match(output, /"sourcePreserved":true/u);
  assert.deepEqual(new WorktreeCleanupJournal(root).list(), [],
    "the stale cleanup record cannot reap the newly owner-scoped live row on restart");
  assert.equal(existsSync(worktreePath), true);
  assert.equal(execFileSync("git", ["-C", worktreePath, "rev-parse", "--is-inside-work-tree"],
    { encoding: "utf8" }).trim(), "true");
  assert.equal(ledger.get(legacy), null, "startup has no stale proof that could delete preserved source refs");
  assert.ok(ledger.get({ ...legacy, ownerHash: "a".repeat(64) }),
    "owner-scoped refs have durable cleanup ownership before metadata publication");
  for (const namespace of ["wollipog", "mam"]) {
    assert.equal(execFileSync("git", ["-C", repo, "rev-parse", `refs/${namespace}/s_adopt/turn-1`],
      { encoding: "utf8" }).trim(), oid);
    assert.equal(execFileSync("git", ["-C", repo, "rev-parse",
      `refs/${namespace}/owners/${"a".repeat(64)}/s_adopt/turn-1`], { encoding: "utf8" }).trim(), oid);
  }
  assert.equal(JSON.parse(readFileSync(join(sessionDir, "meta.json"), "utf8")).checkpointRefVersion, 2);
});

test("checkpoint adoption fails closed for mismatched, owner-scoped, and deleted cleanup state", async (t) => {
  const root = fixture(t);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const sessionDir = join(root, "sessions", "s_refuse");
  mkdirSync(sessionDir, { recursive: true });
  const meta = {
    sessionId: "s_refuse", repoPath: repo, context: { kind: "native" as const },
    worktreePath: join(root, "live"),
  };
  writeFileSync(join(sessionDir, "meta.json"), `${JSON.stringify(meta)}\n`, { mode: 0o600 });
  const args = [
    "runner", "--state-doctor", "adopt-checkpoints", "--data-dir", root,
    "--session-id", "s_refuse", "--ack-all-legacy-runners-stopped",
  ];
  const journal = new WorktreeCleanupJournal(root);
  journal.add({ ...meta, worktreePath: join(root, "other") });
  await assert.rejects(runStateDoctor(args), /does not exactly match/);
  journal.add({ ...meta, checkpointOwnerHash: "a".repeat(64) });
  await assert.rejects(runStateDoctor(args), /already names an owner-scoped generation/);
  journal.remove(meta.sessionId);
  const deletedDir = join(root, "sessions", ".deleted");
  mkdirSync(deletedDir);
  writeFileSync(join(deletedDir, createHash("sha256").update(meta.sessionId).digest("hex")), meta.sessionId);
  await assert.rejects(runStateDoctor(args), /deletion-tombstoned/);
});

test("checkpoint adoption faults leave metadata last and retryable", async (t) => {
  const root = fixture(t);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-qm", "checkpoint"]);
  const oid = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", repo, "update-ref", "refs/wollipog/s_fault/turn-1", oid]);
  const sessionDir = join(root, "sessions", "s_fault");
  mkdirSync(sessionDir, { recursive: true });
  const meta = { sessionId: "s_fault", repoPath: repo, context: { kind: "native" as const }, worktreePath: repo };
  const metaPath = join(sessionDir, "meta.json");
  writeFileSync(metaPath, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
  new WorktreeCleanupJournal(root).add({ ...meta, worktreePath: repo });
  const operations: string[] = [];
  const args = [
    "runner", "--state-doctor", "adopt-checkpoints", "--data-dir", root,
    "--session-id", "s_fault", "--ack-all-legacy-runners-stopped",
  ];
  await assert.rejects(runStateDoctor(args, () => {}, {
    beforeDurabilityOperationForTest: (operation, path) => {
      operations.push(operation);
      if (operation === "rename" && path === metaPath) throw new Error("injected metadata publication fault");
    },
  }), /injected metadata publication fault/);
  assert.equal(JSON.parse(readFileSync(metaPath, "utf8")).checkpointRefVersion, undefined,
    "metadata remains legacy until every external ownership resource is durable");
  assert.deepEqual(new WorktreeCleanupJournal(root).list(), []);
  assert.ok(new CheckpointRefOwnershipLedger(root).get({ ...meta, ownerHash: "a".repeat(64) }));
  assert.ok(operations.indexOf("checkpoint-refs-adopted") < operations.indexOf("checkpoint-owner-published"));
  assert.ok(operations.indexOf("checkpoint-owner-published") < operations.indexOf("rename"));
  assert.equal(existsSync(join(root, ".wollipog-runner-active-v1.lock")), false,
    "fault paths still release the maintenance lease");
  await runStateDoctor(args, () => {});
  assert.equal(JSON.parse(readFileSync(metaPath, "utf8")).checkpointRefVersion, 2);
});

test("conductor quarantine fsyncs its manifest before moving any secret file", async (t) => {
  const root = fixture(t);
  const conductor = join(root, "conductor");
  mkdirSync(conductor);
  writeFileSync(join(conductor, "session.mcp.json"), "secret", { mode: 0o600 });
  const operations: Array<{ operation: string; path: string }> = [];
  await runStateDoctor([
    "runner", "--state-doctor", "quarantine-conductor", "--data-dir", root,
    "--ack-all-legacy-runners-stopped",
  ], () => {}, {
    beforeDurabilityOperationForTest: (operation, path) => { operations.push({ operation, path }); },
  });
  const manifestFsync = operations.findIndex((entry) =>
    entry.operation === "fsync-file" && entry.path.endsWith("manifest.json"));
  const firstMove = operations.findIndex((entry) =>
    entry.operation === "rename" && entry.path.endsWith("0001.mcp.json"));
  assert.ok(manifestFsync >= 0 && firstMove > manifestFsync);
  const afterMove = operations.slice(firstMove + 1).filter((entry) => entry.operation === "fsync-directory");
  assert.ok(afterMove.some((entry) => entry.path === conductor), "source directory entry is durable");
  assert.ok(afterMove.some((entry) => entry.path.endsWith("conductor")), "target directory entry is durable");
});

test("maintenance lease release cannot mask the primary doctor operation failure", async (t) => {
  const root = fixture(t);
  const conductor = join(root, "conductor");
  mkdirSync(conductor);
  writeFileSync(join(conductor, "session.mcp.json"), "secret", { mode: 0o600 });
  const lease = join(root, ".wollipog-runner-active-v1.lock");
  await assert.rejects(runStateDoctor([
    "runner", "--state-doctor", "quarantine-conductor", "--data-dir", root,
    "--ack-all-legacy-runners-stopped",
  ], () => {}, {
    beforeDurabilityOperationForTest: (operation) => {
      if (operation !== "rename") return;
      writeFileSync(lease, "{}\n", { mode: 0o600 });
      throw new Error("primary quarantine failure");
    },
  }), /primary quarantine failure/);
  assert.equal(existsSync(lease), true, "a replacement lease is never removed");
});

test("state doctor rejects ambiguous arguments and reports unreadable metadata without exposing it", async (t) => {
  const root = fixture(t);
  const sessionDir = join(root, "sessions", "s_secret");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "meta.json"), "SECRET_CANARY:not-json", { mode: 0o600 });

  const output = await capture([
    "runner", "--state-doctor", "inventory", "--data-dir", root,
  ]);
  assert.equal((JSON.parse(output) as { unreadableSessionMetadata: number }).unreadableSessionMetadata, 1);
  assert.equal(output.includes("SECRET_CANARY"), false);
  await assert.rejects(runStateDoctor([
    "runner", "--state-doctor", "adopt-checkpoints", "--data-dir", root,
    "--session-id", "s_secret", "--ack-all-legacy-runners-stopped",
  ]), (error: unknown) => {
    const text = String(error);
    assert.match(text, /unsafe state metadata: meta\.json/u);
    assert.equal(text.includes("SECRET_CANARY"), false);
    return true;
  });
  await assert.rejects(runStateDoctor([
    "runner", "--state-doctor", "inventory", "--data-dir", root, "--data-dir", root,
  ]), /duplicate state-doctor argument/);
  await assert.rejects(runStateDoctor([
    "runner", "--state-doctor", "inventory", "--data-dir",
  ]), /requires a value/);
  await assert.rejects(runStateDoctor([
    "runner", "--state-doctor", "inventory", "--data-dir", "--session-id", "s_secret",
  ]), /--data-dir requires a value/);
});
