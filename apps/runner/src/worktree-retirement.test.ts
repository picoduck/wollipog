import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { cpSync, existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequestedWorktree, discardWorktreeIfSafe, inspectWorktreeRetirement, WorktreeCleanupJournal, type WorktreeCleanupRecord } from "./worktree.js";
import { isolateFromAmbientIgnores } from "./git-test-repo.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

for (const interrupted of [false, true]) test(`person retirement pins branch, tip, cleanliness and directory, preserving commits${interrupted ? " across interrupted cleanup" : ""}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-person-retirement-"));
  const repo = join(root, "repo"), dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  try {
    execFileSync("git", ["init", "-b", "main", repo], { stdio: "pipe" });
    isolateFromAmbientIgnores(repo);
    git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@example.com");
    writeFileSync(join(repo, "base.txt"), "base\n"); git(repo, "add", "."); git(repo, "commit", "-m", "base");
    const worktree = await createRequestedWorktree(repo, "s_person", { branch: "fix/private", baseRef: "HEAD" }, { dataDir });
    const handle = { ...worktree, id: "original", source: "created" as const };
    writeFileSync(join(worktree.path, "unique.txt"), "unique committed work\n");
    git(worktree.path, "add", "."); git(worktree.path, "commit", "-m", "unique");
    const state = await inspectWorktreeRetirement(repo, "s_person", handle, { dataDir });
    await assert.rejects(inspectWorktreeRetirement(repo, "s_other", handle, { dataDir }), /ownership could not be proven/);
    assert.equal(state.clean, true);
    assert.equal((await discardWorktreeIfSafe(repo, "s_person", handle, { dataDir })).removed, false,
      "ordinary agent discard still requires delivery evidence");
    for (const stale of [{ ...state, branch: "another" }, { ...state, headSha: "f".repeat(40) },
      { ...state, pathIdentity: "0:0" }, { ...state, path: repo }, { ...state, clean: false as never }]) {
      assert.equal((await discardWorktreeIfSafe(repo, "s_person", handle, { dataDir, ownerConfirmedState: stale })).removed, false);
      assert.ok(existsSync(worktree.path));
    }
    writeFileSync(join(worktree.path, "dirty.txt"), "preserve\n");
    await assert.rejects(inspectWorktreeRetirement(repo, "s_person", handle, { dataDir }), /uncommitted/);
    assert.equal((await discardWorktreeIfSafe(repo, "s_person", handle, { dataDir, ownerConfirmedState: state })).removed, false);
    rmSync(join(worktree.path, "dirty.txt"));
    writeFileSync(join(worktree.path, "advanced.txt"), "new work\n");
    git(worktree.path, "add", "."); git(worktree.path, "commit", "-m", "advanced");
    assert.equal((await discardWorktreeIfSafe(repo, "s_person", handle, { dataDir, ownerConfirmedState: state })).removed, false);
    git(worktree.path, "reset", "--hard", state.headSha); // Fixture-only return to the inspected tip.
    renameSync(worktree.path, `${worktree.path}.original`);
    cpSync(`${worktree.path}.original`, worktree.path, { recursive: true });
    assert.equal((await discardWorktreeIfSafe(repo, "s_person", handle, { dataDir, ownerConfirmedState: state })).removed, false,
      "a replacement directory at the same path and tip is not the inspected generation");
    rmSync(worktree.path, { recursive: true }); renameSync(`${worktree.path}.original`, worktree.path);
    git(worktree.path, "checkout", "-b", "fix/replacement");
    assert.equal((await discardWorktreeIfSafe(repo, "s_person", handle, { dataDir, ownerConfirmedState: state })).removed, false,
      "a branch change with an identical tip invalidates confirmation");
    git(worktree.path, "checkout", worktree.branch);
    const raced = await discardWorktreeIfSafe(repo, "s_person", handle, { dataDir, ownerConfirmedState: state,
      beforeRemove: async () => { git(worktree.path, "checkout", "fix/replacement"); } });
    assert.equal(raced.removed, false, "final branch identity is checked after teardown awaits");
    git(worktree.path, "checkout", worktree.branch);
    const store = new SessionStore(join(dataDir, "sessions"));
    store.create({ sessionId: "s_person", agentId: "claude", workspaceId: "repo", repoPath: repo,
      worktreePath: worktree.path, worktreeBranch: worktree.branch, worktrees: [handle],
      driver: "claude-code", command: "claude", args: [], env: {}, context: { kind: "native" },
      agentSessionId: null, status: "stopped", title: "Person Retirement", config: {}, tokensIn: 0, tokensOut: 0,
      costUsd: 0, preview: null, pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1 });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
    const internals = manager as unknown as { liveWorktreeUsesPath(sessionId: string, path: string): boolean };
    const liveUsesPath = internals.liveWorktreeUsesPath;
    internals.liveWorktreeUsesPath = () => true;
    await assert.rejects(manager.campaignWorktreeRetirement("s_person", { operation: "inspect", path: worktree.path }), /still active/);
    internals.liveWorktreeUsesPath = liveUsesPath;
    const inspected = await manager.campaignWorktreeRetirement("s_person", { operation: "inspect", path: worktree.path });
    assert.deepEqual(inspected.retirementState, state);
    await assert.rejects(manager.campaignWorktreeRetirement("s_person", { operation: "confirm", state: { ...state, worktreeId: "replacement" }, userId: "person", at: Date.now() }), /state changed/);
    await assert.rejects(manager.campaignWorktreeRetirement("s_person", { operation: "confirm", state, userId: "person", at: Number.NaN }), /confirmation/);
    // This is the control plane's audit clock, which need not agree with the runner's clock.
    const confirmedAt = Date.now() + (interrupted ? 7_200_000 : -7_200_000);
    const confirmation = { operation: "confirm" as const, state, userId: "person", at: confirmedAt };
    let finalConfirmation = confirmation;
    let preservedCleanupId: string | undefined;
    if (interrupted) {
      const recovery = manager as unknown as {
        retireWorktreeProcesses(...args: unknown[]): Promise<void>;
        refreshDeferredMergedHead(): Promise<never>;
        reapLiveSafeWorktree(record: WorktreeCleanupRecord): Promise<void>;
      };
      const retireProcesses = recovery.retireWorktreeProcesses;
      recovery.retireWorktreeProcesses = async () => { throw new Error("synthetic interruption after journal admission"); };
      await assert.rejects(manager.campaignWorktreeRetirement("s_person", confirmation), /retained/);
      assert.ok(existsSync(worktree.path));
      const record = new WorktreeCleanupJournal(dataDir).list().find(item => item.worktreeId === handle.id)!;
      assert.deepEqual(record.ownerConfirmation, { state, userId: "person", at: confirmedAt });
      recovery.retireWorktreeProcesses = retireProcesses;
      recovery.refreshDeferredMergedHead = async () => { throw new Error("a person's pinned confirmation never depends on a forge read"); };
      await recovery.reapLiveSafeWorktree(record);
    } else {
      const recovery = manager as unknown as {
        runCleanupTeardown(record: WorktreeCleanupRecord, meta?: unknown): Promise<void>;
        reapLiveSafeWorktree(record: WorktreeCleanupRecord): Promise<void>;
      };
      const teardown = recovery.runCleanupTeardown.bind(manager);
      let wrote = false;
      recovery.runCleanupTeardown = async (...args) => {
        await teardown(...args);
        if (!wrote) { writeFileSync(join(worktree.path, "after-teardown.txt"), "preserve changed work\n"); wrote = true; }
      };
      await assert.rejects(manager.campaignWorktreeRetirement("s_person", confirmation), /uncommitted/);
      const pending = new WorktreeCleanupJournal(dataDir).list().find(item => item.worktreeId === handle.id)!;
      preservedCleanupId = pending.cleanupId;
      assert.ok(pending.processTerminationStartedAt);
      await assert.rejects(manager.discardWorktree("s_person", worktree.path), /person-confirmed retirement is pending/,
        "ordinary discard cannot reuse a person's confirmation");
      await recovery.reapLiveSafeWorktree(pending);
      assert.ok(existsSync(worktree.path), "a replay never follows a dirty, changed checkout");
      await assert.rejects(manager.campaignWorktreeRetirement("s_person", { operation: "inspect", path: worktree.path }), /uncommitted/,
        "inspection must report dirtiness instead of trapping the person behind a stale confirmation");
      // Fixture-only save of the new work: a new clean tip needs a new person confirmation.
      git(worktree.path, "add", "."); git(worktree.path, "commit", "-m", "save post-teardown work");
      await recovery.reapLiveSafeWorktree(pending);
      assert.ok(existsSync(worktree.path), "the old confirmation never follows an advanced clean tip either");
      const next = await manager.campaignWorktreeRetirement("s_person", { operation: "inspect", path: worktree.path });
      assert.notEqual(next.retirementState!.headSha, state.headSha);
      finalConfirmation = { ...confirmation, state: next.retirementState!, at: confirmedAt + 1 };
      const result = await manager.campaignWorktreeRetirement("s_person", finalConfirmation);
      assert.equal(result.retirement?.status, "removed");
    }
    assert.equal(existsSync(worktree.path), false);
    assert.equal(git(repo, "rev-parse", `refs/heads/${worktree.branch}`), finalConfirmation.state.headSha,
      "person retirement never destroys unproved committed work");
    assert.equal(git(repo, "show", `${state.headSha}:unique.txt`), "unique committed work");
    assert.equal(git(repo, "rev-parse", "refs/heads/fix/replacement"), state.headSha);
    assert.equal(store.readMeta("s_person")?.worktreePath, null, "explicit retirement clears the selected checkout");
    const receipt = new WorktreeCleanupJournal(dataDir).history().find(item => item.worktreeId === handle.id);
    assert.deepEqual(receipt?.ownerConfirmation, { state: finalConfirmation.state, userId: "person", at: finalConfirmation.at });
    if (preservedCleanupId) assert.equal(receipt?.cleanupId, preservedCleanupId, "reconfirmation preserves cleanup progress and identity");
  } finally { manager?.shutdownAll(); rmSync(root, { recursive: true, force: true }); }
});
