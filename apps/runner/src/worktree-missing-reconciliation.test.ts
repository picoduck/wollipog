import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { RunnerToControlPlane } from "@wollipog/protocol";
import { SessionStore } from "./session-store.js";
import { SessionManager } from "./session-manager.js";
import { isolateFromAmbientIgnores } from "./git-test-repo.js";
import { createRequestedWorktree, worktreeExternalRemovalState, worktreeIsAbsent, WorktreeCleanupJournal } from "./worktree.js";

for (const external of ["removed", "missing_registered", "unregistered_directory"] as const) {
  test(`archived removal reconciliation preserves data and resume recovery: ${external}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "wollipog-archived-removal-"));
    const repo = join(root, "repo"), dataDir = join(root, "data");
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args],
      { encoding: "utf8", stdio: "pipe" }).trim();
    let manager: SessionManager | undefined;
    try {
      mkdirSync(repo); git(repo, "init", "-b", "main"); isolateFromAmbientIgnores(repo);
      git(repo, "config", "user.email", "test@example.com"); git(repo, "config", "user.name", "Test");
      git(repo, "commit", "--allow-empty", "-m", "base");
      const created = await createRequestedWorktree(repo, "s_archived", { branch: "fix/local-only", baseRef: "HEAD" }, { dataDir });
      const worktree = { ...created, id: "original", source: "created" as const };
      writeFileSync(join(worktree.path, "unique.txt"), "unlanded committed work\n");
      git(worktree.path, "add", "."); git(worktree.path, "commit", "-m", "unique");
      const tip = git(worktree.path, "rev-parse", "HEAD");
      const admin = git(worktree.path, "rev-parse", "--absolute-git-dir");
      git(worktree.path, "update-ref", "refs/worktree/private", tip);
      const privateRef = readFileSync(join(admin, "refs/worktree/private"), "utf8");
      const store = new SessionStore(join(dataDir, "sessions"));
      store.create({ sessionId: "s_archived", agentId: "claude", workspaceId: "repo", repoPath: repo,
        worktreePath: worktree.path, worktreeBranch: worktree.branch, worktrees: [worktree],
        driver: "claude-code", command: "claude", args: [], env: {}, context: { kind: "native" },
        agentSessionId: null, status: "stopped", title: "Archived Worktree", config: {}, tokensIn: 0,
        tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1 });
      let providerConstructions = 0;
      manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, () => {
        providerConstructions++;
        throw new Error("No provider may be constructed by a blocked restart");
      }, dataDir);
      await assert.rejects(manager.discardWorktree("s_archived", worktree.path, { requireDelivered: true }), /no upstream/);
      await manager.reconcileCampaignWorktreeRemoval("s_archived", worktree.path, worktree.id);
      assert.equal(store.readMeta("s_archived")?.worktrees?.length, 1, "refused registered work is never retried for deletion");
      if (external === "missing_registered") {
        git(worktree.path, "checkout", "--detach");
        rmSync(worktree.path, { recursive: true }); // Fixture only: retain Git's private administrative state.
      } else {
        git(repo, "worktree", "remove", worktree.path);
        if (external === "unregistered_directory") {
          mkdirSync(worktree.path); writeFileSync(join(worktree.path, "private.txt"), "surviving private files\n");
        }
      }
      await manager.reconcileCampaignWorktreeRemoval("s_archived", worktree.path, "stale-generation");
      assert.equal(store.readMeta("s_archived")?.worktrees?.length, 1);
      const expected = external === "unregistered_directory" ? "unregistered" : "missing";
      assert.equal(await worktreeExternalRemovalState(repo, worktree.path), expected);
      assert.equal(await worktreeExternalRemovalState(join(root, "unavailable"), worktree.path), null);
      assert.equal(await worktreeExternalRemovalState(repo, worktree.path, { context: { kind: "wsl", distro: "absent" } }), null);
      assert.equal(store.acquireWorktreeLease("s_archived", "another-runner"), true);
      await manager.reconcileCampaignWorktreeRemoval("s_archived", worktree.path, worktree.id);
      assert.equal(store.readMeta("s_archived")?.worktrees?.length, 1, "another runner's lease fences reconciliation");
      store.releaseWorktreeLease("s_archived", "another-runner");
      if (external === "removed") {
        store.create({ ...store.readMeta("s_archived")!, sessionId: "s_shared",
          worktrees: [{ ...worktree, source: "attached" }] });
        await manager.reconcileCampaignWorktreeRemoval("s_archived", worktree.path, worktree.id);
        assert.equal(store.readMeta("s_archived")?.worktrees?.length, 1, "another session's selection keeps shared inventory intact");
        store.remove("s_shared");
        store.patchMeta("s_archived", { worktrees: [{ ...worktree, source: "attached" }] });
        await manager.reconcileCampaignWorktreeRemoval("s_archived", worktree.path, worktree.id);
        assert.equal(store.readMeta("s_archived")?.worktrees?.length, 1, "operator-owned inventory is retained");
        store.patchMeta("s_archived", { worktrees: [worktree] });
        const journal = (manager as unknown as { cleanupJournal: WorktreeCleanupJournal }).cleanupJournal;
        journal.add({ sessionId: "s_archived", worktreeId: worktree.id, cleanupId: "pending",
          repoPath: repo, worktreePath: worktree.path, context: { kind: "native" },
          branch: worktree.branch, removalMode: "safe", trigger: "archive_retirement" });
        const pending = journal.list();
        await manager.reconcileCampaignWorktreeRemoval("s_archived", worktree.path, worktree.id);
        assert.deepEqual(journal.list(), pending, "pending cleanup remains owned by its replay generation");
        assert.equal(store.readMeta("s_archived")?.worktrees?.length, 1);
        journal.remove("s_archived", worktree.id);
        const internals = manager as unknown as { retireWorktreeProcesses(...args: unknown[]): Promise<void> };
        const retire = internals.retireWorktreeProcesses;
        internals.retireWorktreeProcesses = async () => {
          store.patchMeta("s_archived", { worktrees: [{ ...worktree, id: "replacement-generation" }] });
        };
        await manager.reconcileCampaignWorktreeRemoval("s_archived", worktree.path, worktree.id);
        assert.equal(store.readMeta("s_archived")?.worktrees?.[0]?.id, "replacement-generation",
          "metadata replacement during process retirement is not forgotten");
        internals.retireWorktreeProcesses = retire;
        store.patchMeta("s_archived", { worktrees: [worktree] });
      }
      // Ordinary periodic reconciliation deliberately preserves a terminal selection for recovery.
      await manager.reconcileWorktreePullRequests({ replayDeferredRetirements: false });
      assert.equal(store.readMeta("s_archived")?.worktrees?.length, 1);
      const result = await manager.reconcileCampaignWorktreeRemoval("s_archived", worktree.path, worktree.id);
      assert.deepEqual(result.snapshot.worktrees, []);
      assert.equal(result.snapshot.worktreePath, null);
      assert.equal(result.snapshot.worktreeRecovery?.selectedPath, worktree.path);
      assert.equal(result.snapshot.worktreeRecovery?.expectedBranch, worktree.branch);
      store.flush("s_archived");
      assert.deepEqual(new SessionStore(join(dataDir, "sessions")).readMeta("s_archived")?.worktreeRecovery,
        store.readMeta("s_archived")?.worktreeRecovery, "the recovery fence survives a fresh store/process read");
      assert.equal(git(repo, "rev-parse", "refs/heads/fix/local-only"), tip);
      if (external === "missing_registered") {
        assert.equal(readFileSync(join(admin, "refs/worktree/private"), "utf8"), privateRef);
        assert.equal(readFileSync(join(admin, "HEAD"), "utf8").trim(), tip, "detached HEAD survives; no prune runs");
        assert.match(git(repo, "worktree", "list", "--porcelain"), /detached/);
      }
      if (external === "unregistered_directory") {
        assert.equal(readFileSync(join(worktree.path, "private.txt"), "utf8"), "surviving private files\n");
      }
      assert.match(await manager.sessionWorktreeRootFailure(store.readMeta("s_archived")!) ?? "", /Select a worktree/);
      store.patchMeta("s_archived", { agentSessionId: "stored-provider-thread" });
      const resumeFailure = await new Promise<{ error: string; code?: string }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("resume did not settle")), 5_000);
        manager!.prompt("s_archived", "Resume after removal", [], undefined, undefined, {
          commandId: "resume-reconciled", queued() {}, started() { reject(new Error("a blocked prompt started")); },
          completed() { reject(new Error("a blocked prompt completed")); }, uncertain() { reject(new Error("delivery is unknown")); },
          failed(error, code) { clearTimeout(timeout); resolve({ error, code }); },
        });
      });
      assert.equal(resumeFailure.code, "WORKTREE_RECOVERY_REQUIRED", "prompt resume crosses the launch guard without start()");
      assert.match(resumeFailure.error, /Select a worktree/);
      assert.equal(store.readMeta("s_archived")?.status, "input_required");
      assert.equal(providerConstructions, 0, "resume never constructs a provider in the primary checkout");
      const spec = { sessionId: "s_archived", workspaceId: "repo", workspacePath: repo, agentId: "claude",
        command: "claude", args: [], env: {}, driver: "claude-code" as const, context: { kind: "native" as const } };
      for (const useWorktree of [false, true]) {
        assert.equal(await manager.start({ ...spec, useWorktree }), false, "restart cannot silently choose primary or recreate a checkout");
        assert.deepEqual(store.readMeta("s_archived")?.worktrees, []);
        assert.equal(store.readMeta("s_archived")?.worktreeRecovery?.selectedPath, worktree.path);
      }
      assert.equal(providerConstructions, 0);
      const recoveryId = store.readMeta("s_archived")?.worktreeRecovery?.recoveryId;
      await manager.reconcileCampaignWorktreeRemoval("s_archived", worktree.path, worktree.id);
      assert.equal(store.readMeta("s_archived")?.worktreeRecovery?.recoveryId, recoveryId, "repeated reconciliation is idempotent");
      const replacement = await manager.requestWorktree("s_archived", { branch: "fix/replacement", baseRef: "HEAD" });
      assert.equal(store.readMeta("s_archived")?.worktreeRecovery, undefined, "explicit worktree selection clears the fence");
      assert.equal(store.readMeta("s_archived")?.worktreePath, replacement.worktree.path);
      assert.equal(await manager.sessionWorktreeRootFailure(store.readMeta("s_archived")!), null);
      if (external === "removed") {
        const selected = store.readMeta("s_archived")!;
        store.patchMeta("s_archived", { status: "idle" });
        renameSync(replacement.worktree.path, `${replacement.worktree.path}.temporarily-missing`);
        const recovery = manager as unknown as {
          recordWorktreeRecovery(meta: typeof selected, path: string, detail: string, phase: string): boolean;
        };
        assert.equal(recovery.recordWorktreeRecovery(store.readMeta("s_archived")!, replacement.worktree.path,
          "the directory is missing", "fixture verification"), true);
        renameSync(`${replacement.worktree.path}.temporarily-missing`, replacement.worktree.path);
        assert.ok(store.readMeta("s_archived")?.worktreeRecovery, "an ordinary incident was recorded");
        git(repo, "branch", "--set-upstream-to", "main", replacement.worktree.branch);
        await manager.discardWorktree("s_archived", replacement.worktree.path);
        assert.equal(store.readMeta("s_archived")?.worktreePath, null);
        assert.equal(store.readMeta("s_archived")?.worktreeRecovery, undefined,
          "intentional discard clears the incident for its removed selection");
        assert.equal(await manager.sessionWorktreeRootFailure(store.readMeta("s_archived")!), null);
      }
    } finally {
      manager?.shutdownAll(); rmSync(root, { recursive: true, force: true });
    }
  });
}

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
    assert.equal(await worktreeExternalRemovalState(repo, worktree.path), null, "symlinks are never external-removal proof");
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
