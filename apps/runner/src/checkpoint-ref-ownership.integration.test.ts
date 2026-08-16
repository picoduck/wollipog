import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CheckpointRefOwnershipLedger } from "./checkpoint-ref-ownership.js";
import { setGitRunnerForTests, type GitRunOpts } from "./git-ops.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";
import { createWorktree, WorktreeCleanupJournal } from "./worktree.js";

function haveGit(): boolean {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

test("re-upgrade reclaims a rollback-deleted owned namespace and preserves unknown runner refs", {
  skip: !haveGit(),
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-checkpoint-rollback-reclaim-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  const store = new SessionStore(join(dataDir, "sessions"));
  let upgraded: SessionManager | undefined;
  let reupgraded: SessionManager | undefined;
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);

    // Pre-compatibility runner state: the durable row and legacy namespace are the only ownership
    // evidence. The first compatible upgrade must claim the tuple before mirroring canonical refs.
    store.create({
      sessionId: "s_rollback_owned", agentId: "claude", workspaceId: "repo", repoPath: repo,
      worktreePath: repo, driver: "claude-code", command: "claude", args: [], env: {},
      context: { kind: "native" }, agentSessionId: null, status: "stopped", title: "owned",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: 0, createdAt: 1, updatedAt: 1, indexReset: true,
    });
    git(repo, ["update-ref", "refs/mam/s_rollback_owned/turn-1", tree]);
    upgraded = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
    upgraded.reconcileStore();
    await waitFor(
      () => git(repo, ["for-each-ref", "--format=%(refname)", "refs/wollipog/s_rollback_owned/"]) !== "",
      "the compatible upgrade did not mirror the canonical checkpoint ref",
    );
    assert.equal(new CheckpointRefOwnershipLedger(dataDir).list().length, 1);
    upgraded.shutdownAll();
    upgraded = undefined;

    // A rollback runner knows only the old namespace. Its deletion removes the row and legacy ref,
    // but cannot remove the ownership ledger or canonical ref created by the compatible release.
    git(repo, ["update-ref", "-d", "refs/mam/s_rollback_owned/turn-1"]);
    store.remove("s_rollback_owned");
    assert.equal(git(repo, ["rev-parse", "refs/wollipog/s_rollback_owned/turn-1"]), tree);

    // This neighboring session belongs to another runner sharing the repository. With no local
    // ownership record, neither namespace is eligible for the re-upgrade sweep.
    git(repo, ["update-ref", "refs/mam/s_unknown_neighbor/turn-1", tree]);
    git(repo, ["update-ref", "refs/wollipog/s_unknown_neighbor/turn-1", tree]);

    reupgraded = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
    reupgraded.reconcileStore();
    await waitFor(
      () => git(repo, ["for-each-ref", "--format=%(refname)", "refs/wollipog/s_rollback_owned/"]) === "" &&
        new CheckpointRefOwnershipLedger(dataDir).list().length === 0,
      "the compatible re-upgrade did not reclaim the rollback-orphaned canonical ref",
    );
    assert.equal(git(repo, ["rev-parse", "refs/mam/s_unknown_neighbor/turn-1"]), tree);
    assert.equal(git(repo, ["rev-parse", "refs/wollipog/s_unknown_neighbor/turn-1"]), tree);
  } finally {
    upgraded?.shutdownAll();
    reupgraded?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup preserves owned refs for a live session row between worktrees", {
  skip: !haveGit(),
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-checkpoint-pending-worktree-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  const store = new SessionStore(join(dataDir, "sessions"));
  const ledger = new CheckpointRefOwnershipLedger(dataDir);
  let manager: SessionManager | undefined;
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
    store.create({
      sessionId: "s_pending", agentId: "claude", workspaceId: "repo", repoPath: repo,
      worktreePath: null, worktreePending: true, driver: "claude-code", command: "claude",
      args: [], env: {}, context: { kind: "native" }, agentSessionId: null, status: "failed",
      title: "pending", config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null,
      pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1, indexReset: true, turnCount: 1,
    });
    ledger.claim({ sessionId: "s_pending", repoPath: repo, context: { kind: "native" } });
    git(repo, ["update-ref", "refs/mam/s_pending/turn-1", tree]);
    git(repo, ["update-ref", "refs/wollipog/s_pending/turn-1", tree]);

    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
    manager.reconcileStore();
    await waitFor(
      () => (manager as any).checkpointRefMaintenanceActive === 0 &&
        (manager as any).checkpointRefMaintenanceQueue.length === 0,
      "startup checkpoint maintenance did not settle",
    );

    assert.equal(git(repo, ["rev-parse", "refs/mam/s_pending/turn-1"]), tree);
    assert.equal(git(repo, ["rev-parse", "refs/wollipog/s_pending/turn-1"]), tree);
    assert.equal(ledger.listSession("s_pending").length, 1,
      "the live repository/context binding retains its durable ownership proof");
    assert.equal(store.readMeta("s_pending")?.worktreePending, false,
      "startup may clear the stranded materialization flag without relinquishing ref ownership");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup cleanup contains journal removal failures and retries later", {
  skip: !haveGit(),
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-checkpoint-journal-remove-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  const store = new SessionStore(join(dataDir, "sessions"));
  const logs: string[] = [];
  let manager: SessionManager | undefined;
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const handle = await createWorktree(repo, "s_journal_retry", { dataDir });
    const journal = new WorktreeCleanupJournal(dataDir);
    journal.add({
      sessionId: "s_journal_retry",
      repoPath: repo,
      worktreePath: handle.path,
      context: { kind: "native" },
    });
    manager = new SessionManager(() => {}, (line) => logs.push(line), store, "runner", undefined, undefined, dataDir);
    const internals = manager as any;
    const remove = internals.cleanupJournal.remove.bind(internals.cleanupJournal);
    internals.cleanupJournal.remove = () => { throw new Error("injected cleanup journal ENOSPC"); };

    assert.doesNotThrow(() => manager!.reconcileStore());
    await waitFor(
      () => logs.some((line) => line.includes("needs retry after cleanup journal update")),
      "journal removal failure was not contained and logged",
    );
    assert.equal(new WorktreeCleanupJournal(dataDir).list().length, 1,
      "failed durable removal retains the idempotent cleanup record");

    internals.cleanupJournal.remove = remove;
    manager.reconcileStore();
    await waitFor(
      () => new WorktreeCleanupJournal(dataDir).list().length === 0,
      "the next startup pass did not remove the retained cleanup record",
    );
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup cleanup retains a journaled worktree for a forward checkpoint layout", {
  skip: !haveGit(),
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-checkpoint-forward-cleanup-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  const store = new SessionStore(join(dataDir, "sessions"));
  const logs: string[] = [];
  let manager: SessionManager | undefined;
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const handle = await createWorktree(repo, "s_forward", { dataDir });
    store.create({
      sessionId: "s_forward", agentId: "claude", workspaceId: "repo", repoPath: repo,
      worktreePath: handle.path, driver: "claude-code", command: "claude", args: [], env: {},
      context: { kind: "native" }, agentSessionId: null, status: "stopped", title: "forward",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: 0, createdAt: 1, updatedAt: 1, indexReset: true,
      checkpointRefVersion: 3 as 2,
    });
    const journal = new WorktreeCleanupJournal(dataDir);
    journal.add({
      sessionId: "s_forward",
      repoPath: repo,
      worktreePath: handle.path,
      context: { kind: "native" },
    });
    manager = new SessionManager(
      () => {}, (line) => logs.push(line), store, "runner", undefined, undefined, dataDir,
    );

    assert.doesNotThrow(() => manager!.reconcileStore());
    await waitFor(
      () => logs.some((line) => line.includes("needs retry after checkpoint ownership validation")),
      "forward-layout cleanup validation was not contained and logged",
    );
    assert.equal(existsSync(handle.path), true, "an unknown live namespace keeps its worktree");
    assert.equal(journal.list().length, 1, "the durable cleanup record remains retryable");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed canonical reclaim retains ownership proof and the next startup retries it", {
  skip: !haveGit(),
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-checkpoint-reclaim-retry-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  const store = new SessionStore(join(dataDir, "sessions"));
  const logs: string[] = [];
  let failedRunner: SessionManager | undefined;
  let retryRunner: SessionManager | undefined;
  t.after(() => setGitRunnerForTests());
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const ledger = new CheckpointRefOwnershipLedger(dataDir);
    ledger.claim({ sessionId: "s_retry_owned", repoPath: repo, context: { kind: "native" } });
    git(repo, ["update-ref", "refs/wollipog/s_retry_owned/turn-1", tree]);

    let injected = false;
    const realGit = async (cwd: string, args: string[], opts?: GitRunOpts): Promise<string> =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: { ...process.env, ...opts?.env },
        input: opts?.stdin,
        timeout: opts?.timeoutMs,
      });
    setGitRunnerForTests(async (cwd, args, opts) => {
      if (!injected && args[0] === "update-ref" &&
          opts?.stdin?.includes("delete refs/wollipog/s_retry_owned/turn-1")) {
        injected = true;
        throw new Error("injected canonical ref deletion failure");
      }
      return realGit(cwd, args, opts);
    });

    failedRunner = new SessionManager(() => {}, (line) => logs.push(line), store, "runner", undefined, undefined, dataDir);
    failedRunner.reconcileStore();
    await waitFor(
      () => logs.some((line) => line.includes("checkpoint ref ownership reclaim failed for s_retry_owned")),
      "the injected deletion failure was not reported",
    );
    assert.equal(git(repo, ["rev-parse", "refs/wollipog/s_retry_owned/turn-1"]), tree);
    assert.equal(ledger.list().length, 1, "failed deletion must retain durable ownership proof");
    failedRunner.shutdownAll();
    failedRunner = undefined;

    setGitRunnerForTests();
    retryRunner = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
    retryRunner.reconcileStore();
    await waitFor(
      () => git(repo, ["for-each-ref", "--format=%(refname)", "refs/wollipog/s_retry_owned/"]) === "" &&
        ledger.list().length === 0,
      "the next startup did not retry the retained ownership claim",
    );
  } finally {
    failedRunner?.shutdownAll();
    retryRunner?.shutdownAll();
    setGitRunnerForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("one session transfers repositories and deletion reclaims every exact owned tuple", {
  skip: !haveGit(),
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-checkpoint-ownership-transfer-"));
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  const repoC = join(root, "repo-c");
  const dataDir = join(root, "data");
  const store = new SessionStore(join(dataDir, "sessions"));
  let manager: SessionManager | undefined;
  try {
    for (const repo of [repoA, repoB, repoC]) {
      execFileSync("git", ["init", repo]);
      execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
      execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    }
    const factory = () => ({
      pid: 1,
      initialize: async () => {},
      newSession: async () => {},
      prompt: async () => ({ stopReason: "end_turn" as const }),
      cancel: () => {},
      dispose: () => {},
      setConfig: () => {},
      resolvePermission: () => false,
      agentSessionId: () => null,
    });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const spec = (workspacePath: string) => ({
      sessionId: "s_transfer", workspaceId: "repo", workspacePath, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: true, driver: "claude-code" as const,
      context: { kind: "native" as const },
    });
    assert.equal(await manager.start(spec(repoA)), true);
    assert.equal(await manager.start(spec(repoB)), true, "a new exact tuple must not conflict with the old repository claim");
    assert.equal(store.readMeta("s_transfer")?.repoPath, repoB);
    await waitFor(
      () => new CheckpointRefOwnershipLedger(dataDir).listSession("s_transfer").every((record) => record.repoPath !== repoA),
      "the stale repository-A tuple was not independently reclaimed",
    );

    // Simulate another durable tuple surviving a prior transfer. Deletion must enumerate every
    // exact same-session ownership record, not only the current session row's repository.
    const ledger = new CheckpointRefOwnershipLedger(dataDir);
    ledger.claim({ sessionId: "s_transfer", repoPath: repoC, context: { kind: "native" } });
    const treeC = git(repoC, ["rev-parse", "HEAD^{tree}"]);
    git(repoC, ["update-ref", "refs/wollipog/s_transfer/turn-1", treeC]);
    git(repoC, ["update-ref", "refs/mam/s_transfer/turn-1", treeC]);

    await manager.delete("s_transfer");
    assert.deepEqual(ledger.listSession("s_transfer"), []);
    assert.deepEqual(new WorktreeCleanupJournal(dataDir).list(), []);
    assert.equal(git(repoC, ["for-each-ref", "--format=%(refname)", "refs/wollipog/s_transfer/"]), "");
    assert.equal(git(repoC, ["for-each-ref", "--format=%(refname)", "refs/mam/s_transfer/"]), "");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a permanently missing owned repository is terminal on startup", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-checkpoint-ownership-missing-"));
  const missingRepo = join(root, "removed-repo");
  const dataDir = join(root, "data");
  const store = new SessionStore(join(dataDir, "sessions"));
  const ledger = new CheckpointRefOwnershipLedger(dataDir);
  let manager: SessionManager | undefined;
  try {
    ledger.claim({ sessionId: "s_missing_repo", repoPath: missingRepo, context: { kind: "native" } });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
    manager.reconcileStore();
    await waitFor(
      () => ledger.listSession("s_missing_repo").length === 0,
      "a permanently missing repository retained an unreclaimable ownership tuple",
    );
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-Git directory and regular-file ownership locations are terminal", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-checkpoint-ownership-nonrepo-"));
  const nonGitDirectory = join(root, "ordinary-directory");
  const regularFile = join(root, "ordinary-file");
  const dataDir = join(root, "data");
  const store = new SessionStore(join(dataDir, "sessions"));
  const ledger = new CheckpointRefOwnershipLedger(dataDir);
  let manager: SessionManager | undefined;
  try {
    mkdirSync(nonGitDirectory);
    writeFileSync(regularFile, "not a repository\n");
    ledger.claim({ sessionId: "s_nonrepo", repoPath: nonGitDirectory, context: { kind: "native" } });
    ledger.claim({ sessionId: "s_nonrepo", repoPath: regularFile, context: { kind: "native" } });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
    manager.reconcileStore();
    await waitFor(
      () => ledger.listSession("s_nonrepo").length === 0,
      "non-repository ownership locations retained unreclaimable tuples",
    );
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("deleting a current in-place session reclaims stale worktree tuples", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-checkpoint-in-place-delete-"));
  const oldRepo = join(root, "old-worktree-repo");
  const currentRepo = join(root, "current-in-place-repo");
  const dataDir = join(root, "data");
  const store = new SessionStore(join(dataDir, "sessions"));
  const ledger = new CheckpointRefOwnershipLedger(dataDir);
  let manager: SessionManager | undefined;
  try {
    for (const repo of [oldRepo, currentRepo]) {
      execFileSync("git", ["init", repo]);
      execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
      execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    }
    const tree = git(oldRepo, ["rev-parse", "HEAD^{tree}"]);
    ledger.claim({ sessionId: "s_in_place", repoPath: oldRepo, context: { kind: "native" } });
    git(oldRepo, ["update-ref", "refs/mam/s_in_place/turn-1", tree]);
    git(oldRepo, ["update-ref", "refs/wollipog/s_in_place/turn-1", tree]);
    store.create({
      sessionId: "s_in_place", agentId: "claude", workspaceId: "repo", repoPath: currentRepo,
      worktreePath: null, driver: "claude-code", command: "claude", args: [], env: {},
      context: { kind: "native" }, agentSessionId: null, status: "stopped", title: "in place",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: 0, createdAt: 1, updatedAt: 1, indexReset: true,
    });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
    await manager.delete("s_in_place");
    assert.deepEqual(ledger.listSession("s_in_place"), []);
    assert.equal(git(oldRepo, ["for-each-ref", "--format=%(refname)", "refs/mam/s_in_place/"]), "");
    assert.equal(git(oldRepo, ["for-each-ref", "--format=%(refname)", "refs/wollipog/s_in_place/"]), "");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale cleanup tuple cannot delete a current replacement tuple for the same session", {
  skip: !haveGit(),
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-checkpoint-stale-cleanup-"));
  const repoA = join(root, "stale-repo");
  const repoB = join(root, "current-repo");
  const dataDir = join(root, "data");
  const store = new SessionStore(join(dataDir, "sessions"));
  const ledger = new CheckpointRefOwnershipLedger(dataDir);
  const cleanupJournal = new WorktreeCleanupJournal(dataDir);
  let manager: SessionManager | undefined;
  try {
    for (const repo of [repoA, repoB]) {
      execFileSync("git", ["init", repo]);
      execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
      execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    }
    const staleWorktree = await createWorktree(repoA, "s_replaced", { dataDir });
    cleanupJournal.add({
      sessionId: "s_replaced",
      repoPath: repoA,
      worktreePath: staleWorktree.path,
      context: { kind: "native" },
    });
    ledger.claim({ sessionId: "s_replaced", repoPath: repoA, context: { kind: "native" } });
    ledger.claim({ sessionId: "s_replaced", repoPath: repoB, context: { kind: "native" } });
    const treeA = git(repoA, ["rev-parse", "HEAD^{tree}"]);
    const treeB = git(repoB, ["rev-parse", "HEAD^{tree}"]);
    for (const namespace of ["mam", "wollipog"]) {
      git(repoA, ["update-ref", `refs/${namespace}/s_replaced/turn-1`, treeA]);
      git(repoB, ["update-ref", `refs/${namespace}/s_replaced/turn-1`, treeB]);
    }
    store.create({
      sessionId: "s_replaced", agentId: "claude", workspaceId: "repo", repoPath: repoB,
      worktreePath: repoB, driver: "claude-code", command: "claude", args: [], env: {},
      context: { kind: "native" }, agentSessionId: null, status: "stopped", title: "replacement",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: 0, createdAt: 1, updatedAt: 1, indexReset: true,
    });

    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
    manager.reconcileStore();
    await waitFor(
      () => new WorktreeCleanupJournal(dataDir).list().length === 0 &&
        ledger.listSession("s_replaced").every((ownership) => ownership.repoPath !== repoA),
      "stale tuple cleanup did not converge",
    );
    assert.equal(git(repoA, ["for-each-ref", "--format=%(refname)", "refs/wollipog/s_replaced/"]), "");
    assert.equal(git(repoB, ["rev-parse", "refs/wollipog/s_replaced/turn-1"]), treeB);
    assert.equal(git(repoB, ["rev-parse", "refs/mam/s_replaced/turn-1"]), treeB);
    assert.equal(ledger.listSession("s_replaced").some((ownership) => ownership.repoPath === repoB), true);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("delete passes its journaled owner identity to immediate worktree cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-checkpoint-delete-owner-"));
  const dataDir = join(root, "data");
  const store = new SessionStore(join(dataDir, "sessions"));
  const ownerHash = "d".repeat(64);
  const worktreePath = join(root, "worktree");
  let manager: SessionManager | undefined;
  try {
    store.create({
      sessionId: "s_delete_owner", agentId: "claude", workspaceId: "repo", repoPath: root,
      worktreePath, driver: "claude-code", command: "claude", args: [], env: {},
      context: { kind: "native" }, agentSessionId: null, status: "stopped", title: "owned",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: 0, createdAt: 1, updatedAt: 1, indexReset: true, checkpointRefVersion: 2,
    });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
    const internals = manager as any;
    internals.runnerOwnerHash = ownerHash;
    internals.cleanupProviderState = async () => {};
    let reaped: unknown;
    internals.reapWorktree = async (record: unknown) => { reaped = record; };

    await manager.delete("s_delete_owner");

    const journaled = new WorktreeCleanupJournal(dataDir).list();
    assert.equal(journaled.length, 1);
    assert.equal(journaled[0]?.checkpointOwnerHash, ownerHash);
    assert.deepEqual(reaped, journaled[0],
      "immediate cleanup must retain the exact owner proof installed in the durable journal");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});
