import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { RunnerToControlPlane } from "@wollipog/protocol";
import { SessionStore } from "./session-store.js";
import { SessionManager } from "./session-manager.js";
import { isolateFromAmbientIgnores } from "./git-test-repo.js";
import { worktreeIsAbsent, WorktreeCleanupJournal } from "./worktree.js";

test("periodic reconciliation clears external removal after refusal without deleting surviving work", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-missing-reconciliation-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  const sent: RunnerToControlPlane[] = [];
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  let manager: SessionManager | undefined;
  try {
    mkdirSync(repo);
    git("init", "-b", "main");
    isolateFromAmbientIgnores(repo);
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("commit", "--allow-empty", "-m", "base");
    const store = new SessionStore(join(dataDir, "sessions"));
    store.create({
      sessionId: "s_missing", agentId: "claude", workspaceId: "repo", repoPath: repo,
      worktreePath: null, driver: "claude-code", command: "claude", args: [], env: {},
      context: { kind: "native" }, agentSessionId: null, status: "idle", title: "Missing Worktree",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: 0, createdAt: 1, updatedAt: 1,
    });
    manager = new SessionManager((message) => sent.push(message), () => {}, store, "runner", undefined, undefined, dataDir);
    const { worktree } = await manager.requestWorktree("s_missing", { baseRef: "HEAD", branch: "fix/missing" });
    writeFileSync(join(worktree.path, "change.txt"), "unlanded work\n");
    execFileSync("git", ["-C", worktree.path, "add", "change.txt"]);
    execFileSync("git", ["-C", worktree.path, "commit", "-m", "local-only work"]);
    const localTip = git("rev-parse", "refs/heads/fix/missing");
    await assert.rejects(manager.discardWorktree("s_missing", worktree.path, { requireDelivered: true }), /no upstream/);
    await manager.reconcileWorktreePullRequests();
    assert.equal(existsSync(join(worktree.path, "change.txt")), true, "refusal is not retried destructively");
    assert.equal(store.readMeta("s_missing")?.worktrees?.length, 1);

    // Simulate the owner removing a fixture worktree, never a host campaign worktree.
    git("worktree", "remove", worktree.path);
    mkdirSync(dirname(worktree.path), { recursive: true });
    assert.equal(await worktreeIsAbsent(repo, worktree.path), true);
    symlinkSync(join(root, "nonexistent"), worktree.path);
    assert.equal(await worktreeIsAbsent(repo, worktree.path), false, "dangling symlinks are not absence");
    rmSync(worktree.path);
    mkdirSync(worktree.path);
    writeFileSync(join(worktree.path, "private.txt"), "preserve me");
    await manager.reconcileWorktreePullRequests();
    assert.equal(store.readMeta("s_missing")?.worktrees?.length, 1, "unregistered files retain their inventory row");
    assert.equal(existsSync(join(worktree.path, "private.txt")), true);
    rmSync(worktree.path, { recursive: true });

    store.patchMeta("s_missing", { worktreePath: worktree.path, worktreeBranch: worktree.branch });
    await manager.reconcileWorktreePullRequests();
    assert.equal(store.readMeta("s_missing")?.worktreePath, worktree.path,
      "an idle session keeps its missing selection for launch-time recovery, never falling back to the primary checkout");
    store.patchMeta("s_missing", { status: "stopped" });
    for (const sessionStatus of ["stopped", "completed", "failed"] as const) {
      store.patchMeta("s_missing", { status: sessionStatus });
      await manager.reconcileWorktreePullRequests();
      assert.equal(store.readMeta("s_missing")?.worktreePath, worktree.path,
        `${sessionStatus} sessions can resume and must retain their missing selection for recovery`);
    }
    // Model choosing another working location before reconciling the old, unselected row.
    store.patchMeta("s_missing", { worktreePath: null, worktreeBranch: undefined, status: "stopped" });
    const journal = (manager as unknown as { cleanupJournal: WorktreeCleanupJournal }).cleanupJournal;
    journal.add({ sessionId: "s_missing", worktreeId: worktree.id, cleanupId: "original",
      repoPath: repo, worktreePath: worktree.path, context: { kind: "native" },
      branch: worktree.branch, removalMode: "safe", trigger: "archive_retirement" });
    journal.addRetainedRef({ sessionId: "s_missing", worktreeId: worktree.id, cleanupId: "original",
      repoPath: repo, context: { kind: "native" }, branch: worktree.branch, expectedOid: localTip,
      reasons: ["recorded_branch"], state: "pending", createdAt: Date.now(), updatedAt: Date.now() });
    const pending = journal.list();
    const retained = journal.listRetainedRefs();
    await manager.reconcileWorktreePullRequests({ replayDeferredRetirements: false });
    assert.deepEqual(journal.list(), pending, "the original cleanup generation remains owned by its replay path");
    assert.deepEqual(journal.listRetainedRefs(), retained, "its retained refs are not orphaned or rearmed under a new generation");
    assert.equal(store.readMeta("s_missing")?.worktrees?.length, 1);
    journal.remove("s_missing", worktree.id);
    journal.removeUnarmedRetainedRefs("s_missing", worktree.id, "original");
    const teardownMarker = join(root, "teardown-ran");
    store.patchMeta("s_missing", { worktreeHooks: { [worktree.id]: {
      configHash: "fixture", environment: {}, teardown: [{ name: "Release Resources",
        command: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(teardownMarker)},'ran')`],
        optional: false, timeoutSeconds: 30 }],
    } } });

    await manager.reconcileWorktreePullRequests();
    assert.deepEqual(store.readMeta("s_missing")?.worktrees, []);
    assert.equal(store.readMeta("s_missing")?.worktreePath, null);
    assert.equal(git("rev-parse", "refs/heads/fix/missing"), localTip, "unlanded branch is never deleted");
    assert.ok(sent.some((message) => message.type === "session_runtime_updated" &&
      message.snapshot.worktreePath === null && message.snapshot.worktrees?.length === 0));
    assert.equal(new WorktreeCleanupJournal(dataDir).list().length, 0);
    const receipt = new WorktreeCleanupJournal(dataDir).history().find((record) => record.worktreeId === worktree.id);
    assert.equal(receipt?.trigger, "external_removal");
    assert.equal(receipt?.teardown?.status, "completed_with_failures");
    assert.match(receipt?.teardown?.steps[0]?.error ?? "", /removed externally/);
    assert.equal(existsSync(teardownMarker), false, "hooks never fall back to a different checkout");
    await manager.reconcileWorktreePullRequests();
    assert.equal(git("rev-parse", "refs/heads/fix/missing"), localTip, "repeated reconciliation is harmless");
    assert.equal(await worktreeIsAbsent(join(root, "unavailable"), worktree.path), false);
    assert.equal(await worktreeIsAbsent(repo, worktree.path, { context: { kind: "wsl", distro: "unavailable" } }), false);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});
