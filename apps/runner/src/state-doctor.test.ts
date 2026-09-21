import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { test } from "node:test";
import { CheckpointRefOwnershipLedger } from "./checkpoint-ref-ownership.js";
import { runStateDoctor, stateDoctorFileSyncFlags } from "./state-doctor.js";
import { WorktreeCleanupJournal, type RetainedWorktreeRefRecord } from "./worktree.js";

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
  const sessionDir = join(root, "sessions", "s_secret");
  mkdirSync(sessionDir, { recursive: true });
  const metaPath = join(sessionDir, "meta.json");
  const canary = "https://private.example/control-plane";
  writeFileSync(metaPath, `${JSON.stringify({
    sessionId: "s_secret", repoPath: canary, context: { kind: "native" }, worktreePath: canary,
  })}\n`, { mode: 0o600 });
  const before = readFileSync(metaPath, "utf8");
  const output = await capture([
    "runner", "--state-doctor", "inventory", "--data-dir", root,
  ]);
  const report = JSON.parse(output) as Record<string, unknown>;
  assert.equal(report.legacyCheckpointSessions, 1);
  assert.equal(output.includes(canary), false);
  assert.equal(output.includes("s_secret"), false);
  assert.equal(output.includes(root), false);
  assert.equal(readFileSync(metaPath, "utf8"), before);
});

test("state doctor reports bounded retained-ref states and identity diagnostics without sensitive coordinates", async (t) => {
  const root = fixture(t);
  const journal = new WorktreeCleanupJournal(root);
  const secretRepo = "/home/private-user/secret-repository";
  const base = (suffix: string, reason: RetainedWorktreeRefRecord["identityProof"]): RetainedWorktreeRefRecord => ({
    sessionId: `s_private_${suffix}`,
    worktreeId: `worktree-${suffix}`,
    cleanupId: `cleanup-${suffix}`,
    repoPath: secretRepo,
    context: { kind: "native" },
    branch: `private/customer/${suffix}`,
    expectedOid: "a".repeat(40),
    reasons: ["recorded_branch"],
    state: "pending",
    identityProof: reason,
    createdAt: 1,
    updatedAt: 1,
  });

  const unarmed = base("disabled", {
    stage: "capture", status: "unavailable", reason: "reflogs_disabled",
  });
  journal.addRetainedRef(unarmed);

  const checkedOut = base("backend", {
    stage: "capture", status: "unavailable", reason: "unsupported_ref_storage",
  });
  journal.addRetainedRef(checkedOut);
  journal.armRetainedRefs(checkedOut.sessionId, checkedOut.worktreeId, checkedOut.cleanupId);
  journal.updateRetainedRef({ ...checkedOut, armedAt: 2, pendingReason: "checked_out", updatedAt: 2 });

  const missing = base("missing", {
    stage: "reclaim", status: "proved", reason: "proof_recorded",
  });
  journal.addRetainedRef(missing);
  journal.finishRetainedRef(missing, "completed", "already_missing");

  const deleted = base("deleted", {
    stage: "reclaim", status: "proved", reason: "proof_recorded",
  });
  journal.addRetainedRef(deleted);
  journal.finishRetainedRef(deleted, "completed", "deleted");

  const retained = base("rotated", {
    stage: "reclaim", status: "changed", reason: "identity_rotated",
  });
  journal.addRetainedRef(retained);
  journal.finishRetainedRef(retained, "retained", "ref_changed_or_recreated");

  const metadata = base("metadata", {
    stage: "capture", status: "unavailable", reason: "metadata_read_failed",
  });
  journal.addRetainedRef(metadata);
  journal.finishRetainedRef(metadata, "retained", "identity_unproved");

  const output = await capture(["runner", "--state-doctor", "inventory", "--data-dir", root]);
  const report = JSON.parse(output) as {
    version: number;
    retainedRefReclamation: {
      records: Array<Record<string, unknown>>;
      omitted: number;
      unreadableRecords: number;
    };
  };
  assert.equal(report.version, 2);
  assert.equal(report.retainedRefReclamation.omitted, 0);
  assert.equal(report.retainedRefReclamation.unreadableRecords, 0);
  assert.deepEqual(
    [...new Set(report.retainedRefReclamation.records.map((record) => record.state))].sort(),
    ["already_absent", "deleted", "pending", "retained"],
  );
  assert.deepEqual(
    [...new Set(report.retainedRefReclamation.records.map((record) =>
      (record.identityProof as { reason: string }).reason))].sort(),
    ["identity_rotated", "metadata_read_failed", "proof_recorded", "reflogs_disabled", "unsupported_ref_storage"],
  );
  for (const record of report.retainedRefReclamation.records) {
    assert.match(String(record.recordId), /^[a-f0-9]{16}$/u);
    assert.match(String(record.generationId), /^[a-f0-9]{16}$/u);
    assert.match(String(record.branchId), /^[a-f0-9]{16}$/u);
  }
  for (const sensitive of [secretRepo, "private-user", "private/customer", "s_private", "cleanup-"]) {
    assert.equal(output.includes(sensitive), false, `inventory leaked ${sensitive}`);
  }
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

test("state doctor mutations require offline acknowledgment", async (t) => {
  const root = fixture(t);
  for (const command of ["adopt-checkpoints", "adopt-provider-state", "quarantine-wsl"]) {
    await assert.rejects(runStateDoctor([
      "runner", "--state-doctor", command, "--data-dir", root,
    ]), /ack-all-legacy-runners-stopped/, command);
  }
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

test("checkpoint adoption reclaims only exact unarmed retained refs", async (t) => {
  const root = fixture(t);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-qm", "checkpoint"]);
  const sessionDir = join(root, "sessions", "s_retained");
  mkdirSync(sessionDir, { recursive: true });
  const meta = {
    sessionId: "s_retained", repoPath: repo, context: { kind: "native" as const }, worktreePath: repo,
  };
  writeFileSync(join(sessionDir, "meta.json"), `${JSON.stringify(meta)}\n`, { mode: 0o600 });
  const journal = new WorktreeCleanupJournal(root);
  journal.add({ ...meta, worktreeId: "wt-target", cleanupId: "cleanup-target" });
  const retained = (overrides: Partial<RetainedWorktreeRefRecord>): RetainedWorktreeRefRecord => ({
    sessionId: meta.sessionId,
    worktreeId: "wt-target",
    cleanupId: "cleanup-target",
    repoPath: repo,
    context: meta.context,
    branch: "agent/shared",
    expectedOid: "c".repeat(40),
    reasons: ["recorded_branch"],
    state: "pending",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });
  journal.addRetainedRef(retained({}));
  journal.addRetainedRef(retained({ branch: "agent/armed", armedAt: 2 }));
  journal.addRetainedRef(retained({ cleanupId: "cleanup-newer" }));
  journal.addRetainedRef(retained({ worktreeId: "wt-other" }));

  await capture([
    "runner", "--state-doctor", "adopt-checkpoints", "--data-dir", root,
    "--session-id", meta.sessionId, "--ack-all-legacy-runners-stopped",
  ]);

  const durable = new WorktreeCleanupJournal(root);
  assert.deepEqual(durable.list(), []);
  assert.deepEqual(durable.listRetainedRefs().map((record) =>
    `${record.worktreeId}:${record.cleanupId}:${record.branch}`).sort(), [
    "wt-other:cleanup-target:agent/shared",
    "wt-target:cleanup-newer:agent/shared",
    "wt-target:cleanup-target:agent/armed",
  ]);
});

test("checkpoint adoption keeps cleanup retryable when retained-ref persistence fails", async (t) => {
  const root = fixture(t);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const sessionDir = join(root, "sessions", "s_ref_fault");
  mkdirSync(sessionDir, { recursive: true });
  const meta = {
    sessionId: "s_ref_fault", repoPath: repo, context: { kind: "native" as const }, worktreePath: repo,
  };
  const metaPath = join(sessionDir, "meta.json");
  writeFileSync(metaPath, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
  const journal = new WorktreeCleanupJournal(root);
  journal.add({ ...meta, worktreeId: "wt-target", cleanupId: "cleanup-target" });
  journal.addRetainedRef({
    ...meta,
    worktreeId: "wt-target",
    cleanupId: "cleanup-target",
    branch: "agent/shared",
    expectedOid: "d".repeat(40),
    reasons: ["recorded_branch"],
    state: "pending",
    createdAt: 1,
    updatedAt: 1,
  });
  const args = [
    "runner", "--state-doctor", "adopt-checkpoints", "--data-dir", root,
    "--session-id", meta.sessionId, "--ack-all-legacy-runners-stopped",
  ];

  await assert.rejects(runStateDoctor(args, () => {}, {
    beforeDurabilityOperationForTest: (operation) => {
      if (operation === "retained-ref-journal-write") {
        throw new Error("injected retained-ref journal write failure");
      }
    },
  }), /injected retained-ref journal write failure/);

  const durable = new WorktreeCleanupJournal(root);
  assert.equal(durable.list().length, 1, "cleanup retirement remains retryable");
  assert.equal(durable.listRetainedRefs().length, 1, "the unarmed row was not orphaned");
  assert.equal(JSON.parse(readFileSync(metaPath, "utf8")).checkpointRefVersion, undefined);
  assert.equal(existsSync(join(root, ".wollipog-runner-active-v1.lock")), false);
});

test("checkpoint adoption fails closed for an ambiguous retained-ref identity", async (t) => {
  const root = fixture(t);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const sessionDir = join(root, "sessions", "s_ambiguous");
  mkdirSync(sessionDir, { recursive: true });
  const meta = {
    sessionId: "s_ambiguous", repoPath: repo, context: { kind: "native" as const }, worktreePath: repo,
  };
  writeFileSync(join(sessionDir, "meta.json"), `${JSON.stringify(meta)}\n`, { mode: 0o600 });
  const journal = new WorktreeCleanupJournal(root);
  journal.add(meta);
  journal.addRetainedRef({
    ...meta,
    branch: "agent/legacy",
    expectedOid: "e".repeat(40),
    reasons: ["recorded_branch"],
    state: "pending",
    createdAt: 1,
    updatedAt: 1,
  });

  await assert.rejects(runStateDoctor([
    "runner", "--state-doctor", "adopt-checkpoints", "--data-dir", root,
    "--session-id", meta.sessionId, "--ack-all-legacy-runners-stopped",
  ]), /lacks a complete retained-ref identity/);
  assert.equal(new WorktreeCleanupJournal(root).list().length, 1);
  assert.equal(new WorktreeCleanupJournal(root).listRetainedRefs().length, 1);
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

test("maintenance lease release cannot mask the primary doctor operation failure", async (t) => {
  const root = fixture(t);
  const sessionDir = join(root, "sessions", "s_native");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "meta.json"), `${JSON.stringify({
    sessionId: "s_native", repoPath: root, context: { kind: "native" },
  })}\n`, { mode: 0o600 });
  const lease = join(root, ".wollipog-runner-active-v1.lock");
  await assert.rejects(runStateDoctor([
    "runner", "--state-doctor", "adopt-provider-state", "--data-dir", root,
    "--session-id", "s_native", "--ack-all-legacy-runners-stopped",
  ], () => {}, {
    beforeDurabilityOperationForTest: (operation) => {
      if (operation !== "maintenance-lease-published") return;
      writeFileSync(lease, "{}\n", { mode: 0o600 });
    },
  }), /adopt-provider-state requires a WSL session/);
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
