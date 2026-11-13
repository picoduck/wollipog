import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunnerToControlPlane } from "@wollipog/protocol";
import { createRequestedWorktree, discardWorktreeIfSafe, WorktreeCleanupJournal } from "./worktree.js";
import { proveWorktreePatchDelivery as proveDetailed, patchDeliveryContains } from "./worktree-patch-delivery.js";
import { isolateFromAmbientIgnores } from "./git-test-repo.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";

async function proveWorktreePatchDelivery(...args: Parameters<typeof proveDetailed>) {
  const result = await proveDetailed(...args);
  return result.state === "matched" ? result.proof : undefined;
}

test("same-child candidates prove reapplied commits in a fetched PR head before a squash, never unmatched or dirty work", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-patch-delivery-"));
  const repo = join(root, "repo");
  const remote = join(root, "origin.git");
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  const logs: string[] = [];
  const messages: RunnerToControlPlane[] = [];
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  try {
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["init", "-b", "main", repo]);
    isolateFromAmbientIgnores(repo);
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "work.txt"), "base\n");
    git(repo, "add", "."); git(repo, "commit", "-m", "base");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "main");
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const worktree = await createRequestedWorktree(repo, "s_patch", { branch: "fix/original", baseRef: "HEAD" }, { dataDir });
    writeFileSync(join(worktree.path, "work.txt"), "first\n");
    git(worktree.path, "add", "."); git(worktree.path, "commit", "-m", "first");
    const first = git(worktree.path, "rev-parse", "HEAD");
    writeFileSync(join(worktree.path, "work.txt"), "second\n");
    git(worktree.path, "add", "."); git(worktree.path, "commit", "-m", "second");
    const tip = git(worktree.path, "rev-parse", "HEAD");
    git(repo, "checkout", "-b", "fix/reapplied");
    writeFileSync(join(repo, "prelude.txt"), "different parent\n");
    git(repo, "add", "."); git(repo, "commit", "-m", "prelude");
    git(repo, "cherry-pick", first, tip);
    writeFileSync(join(repo, "extra.txt"), "later PR work\n");
    git(repo, "add", "."); git(repo, "commit", "-m", "extra");
    const mergedHead = git(repo, "rev-parse", "HEAD");
    assert.notEqual(mergedHead, tip);
    git(repo, "push", "origin", "HEAD:refs/pull/700/head");
    git(repo, "checkout", "main"); git(repo, "merge", "--squash", "fix/reapplied"); git(repo, "commit", "-m", "squash");
    git(repo, "push", "origin", "main");
    const defaultHead = git(repo, "rev-parse", "HEAD");
    git(repo, "remote", "set-url", "origin", "https://github.com/picoduck/wollipog.git");
    const candidate = { repository: "picoduck/wollipog", number: 700, headSha: mergedHead };
    const options = { context: { kind: "native" as const }, forgeFetchRepository: remote,
      runForgeCommand: async () => ({ stdout: JSON.stringify({ data: { repository: {
        isPrivate: false,
        defaultBranchRef: { name: "main", target: { oid: defaultHead } },
        pullRequest: { state: "MERGED", headRefOid: mergedHead, baseRefName: "main" },
      } } }), stderr: "" }) };
    assert.equal(await proveWorktreePatchDelivery(worktree.path, worktree.branch, [], options), undefined,
      "no same-child provenance means no patch search");
    assert.equal(await proveWorktreePatchDelivery(worktree.path, worktree.branch,
      [{ ...candidate, headSha: "a".repeat(40) }], options), undefined, "moved admitted head refuses");
    const proof = await proveWorktreePatchDelivery(worktree.path, worktree.branch, [candidate], options);
    assert.ok(proof, "individual pre-squash commits match under different IDs");
    const privateOptions = { ...options, runForgeCommand: async () => {
      const response = await options.runForgeCommand();
      const data = JSON.parse(response.stdout);
      data.data.repository.isPrivate = true;
      return { stdout: JSON.stringify(data), stderr: "" };
    } };
    assert.deepEqual(await proveDetailed(worktree.path, worktree.branch, [candidate], privateOptions),
      { state: "ineligible", reason: "private_repository" });
    assert.deepEqual(await proveDetailed(worktree.path, worktree.branch, [candidate], {
      ...options, runForgeCommand: async () => { throw Object.assign(new Error("missing gh"), { code: "ENOENT" }); },
    }), { state: "ineligible", reason: "missing_gh" });
    assert.deepEqual(await proveDetailed(worktree.path, worktree.branch, [candidate], {
      ...options, runForgeCommand: async () => { throw Object.assign(new Error("auth required"), { code: 4 }); },
    }), { state: "ineligible", reason: "forge_auth_required" });
    assert.deepEqual(await proveDetailed(worktree.path, worktree.branch, [candidate], {
      ...options, runGitCommand: async () => ({ stdout: `${"a".repeat(40)} ${"0".repeat(40)}\n`, stderr: "" }),
    }), { state: "ineligible", reason: "unsupported_git" }, "a mode-unaware implementation cannot authorize proof");
    assert.deepEqual(await proveDetailed(worktree.path, worktree.branch, [candidate], {
      ...options, runGitCommand: async () => { throw Object.assign(new Error("unsupported flag"), { code: 129 }); },
    }), { state: "ineligible", reason: "unsupported_git" });
    const unavailableOptions = { ...options, runForgeCommand: async () => { throw new Error("temporary fixture outage"); } };
    assert.equal((await proveDetailed(worktree.path, worktree.branch, [candidate], unavailableOptions)).state, "unavailable");
    assert.equal((await proveDetailed(worktree.path, worktree.branch, [candidate], {
      ...options, forgeFetchRepository: join(root, "unavailable.git"),
    })).state, "unavailable", "a failed fetch is not a permanent patch mismatch");
    git(worktree.path, "reset", "--hard", first);
    writeFileSync(join(worktree.path, "work.txt"), "first \n");
    git(worktree.path, "add", "."); git(worktree.path, "commit", "--amend", "--no-edit");
    assert.equal(await proveWorktreePatchDelivery(worktree.path, worktree.branch, [candidate], options), undefined,
      "whitespace differences are work, not patch equivalence");
    git(worktree.path, "reset", "--hard", first);
    writeFileSync(join(worktree.path, "work.txt"), "first");
    git(worktree.path, "add", "."); git(worktree.path, "commit", "--amend", "--no-edit");
    assert.equal(await proveWorktreePatchDelivery(worktree.path, worktree.branch, [candidate], options), undefined,
      "a missing final newline is an unmatched content change");
    git(worktree.path, "reset", "--hard", first);
    git(worktree.path, "update-index", "--chmod=+x", "work.txt");
    git(worktree.path, "commit", "--amend", "--no-edit");
    assert.equal(await proveWorktreePatchDelivery(worktree.path, worktree.branch, [candidate], options), undefined,
      "an unmatched executable mode change is retained");
    git(worktree.path, "reset", "--hard", tip);
    git(worktree.path, "commit", "--allow-empty", "-m", "empty");
    assert.equal(await proveWorktreePatchDelivery(worktree.path, worktree.branch, [candidate], options), undefined,
      "batching cannot silently omit an empty commit");
    git(worktree.path, "reset", "--hard", first);
    git(worktree.path, "merge", "--no-ff", tip, "-m", "merge matched work");
    assert.equal(await proveWorktreePatchDelivery(worktree.path, worktree.branch, [candidate], options), undefined,
      "a merge commit cannot disappear from the compared history");
    git(worktree.path, "reset", "--hard", first);
    git(worktree.path, "update-index", "--add", "--cacheinfo", `160000,${first},submodule`);
    git(worktree.path, "commit", "--amend", "--no-edit");
    git(repo, "config", "diff.ignoreSubmodules", "all");
    assert.equal(await proveWorktreePatchDelivery(worktree.path, worktree.branch, [candidate], options), undefined,
      "repository diff configuration cannot hide an unmatched submodule change");
    git(repo, "config", "--unset", "diff.ignoreSubmodules");
    git(worktree.path, "reset", "--hard", tip);
    assert.equal(await patchDeliveryContains(repo, { kind: "native" }, { ...proof, mergedHeadOid: defaultHead }, tip), false,
      "the squash commit alone is not the original commit sequence");
    assert.deepEqual(await discardWorktreeIfSafe(repo, "s_patch", { ...worktree, source: "created" },
      { dataDir, requireDelivered: true, patchDelivery: { ...proof, mergedHeadOid: "f".repeat(40) } }),
    { removed: false, reason: "unavailable" }, "missing immutable proof objects at deletion stay retryable");
    writeFileSync(join(worktree.path, "dirty.txt"), "do not remove\n");
    const dirty = await discardWorktreeIfSafe(repo, "s_patch", { ...worktree, source: "created" },
      { dataDir, requireDelivered: true, patchDelivery: proof });
    assert.equal(dirty.removed, false);
    assert.equal(!dirty.removed && dirty.reason, "dirty");
    rmSync(join(worktree.path, "dirty.txt"));
    writeFileSync(join(worktree.path, "unmatched.txt"), "unique work\n");
    git(worktree.path, "add", "."); git(worktree.path, "commit", "-m", "unmatched");
    assert.equal(await proveWorktreePatchDelivery(worktree.path, worktree.branch, [candidate], options), undefined);
    const unmatched = await discardWorktreeIfSafe(repo, "s_patch", { ...worktree, source: "created" },
      { dataDir, requireDelivered: true, patchDelivery: proof });
    assert.equal(unmatched.removed, false, "old proof never authorizes an advanced tip");
    git(worktree.path, "reset", "--hard", tip); // fixture-only recovery to the previously inspected tip
    const store = new SessionStore(join(dataDir, "sessions"));
    store.create({ sessionId: "s_patch", agentId: "claude", workspaceId: "repo", repoPath: repo,
      worktreePath: null, worktrees: [{ ...worktree, id: "original", source: "created" }],
      driver: "claude-code", command: "claude", args: [], env: {}, context: { kind: "native" },
      agentSessionId: null, status: "idle", title: "Patch Delivery", config: {}, tokensIn: 0, tokensOut: 0,
      costUsd: 0, preview: null, pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1 });
    manager = new SessionManager((message) => messages.push(message), (message) => logs.push(message), store, "runner", undefined, undefined, dataDir);
    const internals = manager as unknown as {
      discoverMergedWorktreePullRequest: () => Promise<null>;
      probeMergedPullRequestContainment: () => Promise<{ state: "not_contained" }>;
      probePatchDelivery: typeof proveDetailed;
      active: Map<string, unknown>;
      deleteActiveSession: (id: string, entry: unknown) => boolean;
    };
    internals.discoverMergedWorktreePullRequest = async () => null;
    internals.probeMergedPullRequestContainment = async () => ({ state: "not_contained" });
    for (const permanent of [privateOptions,
      { ...options, runForgeCommand: async () => { throw Object.assign(new Error("missing gh"), { code: "ENOENT" }); } },
      { ...options, runGitCommand: async () => { throw Object.assign(new Error("unsupported flag"), { code: 129 }); } },
    ]) {
      internals.probePatchDelivery = (cwd, branch, candidates) => proveDetailed(cwd, branch, candidates, permanent);
      await assert.rejects(manager.discardWorktree("s_patch", worktree.path, {
        requireDelivered: true, campaignDeliveredPullRequests: [candidate],
      }), /no upstream/, "known permanent proof failure keeps the ordinary terminal archive refusal");
      assert.equal(new WorktreeCleanupJournal(dataDir).list().length, 0);
    }
    let forgeAvailable = false;
    internals.probePatchDelivery = (cwd, branch, candidates) => {
      const held = store.readWorktreeLease("s_patch");
      assert.ok(!held || held.owner === "fixture-provider", "network proof runs before the cleanup lease");
      return proveDetailed(cwd, branch, candidates, forgeAvailable ? options : unavailableOptions);
    };
    await assert.rejects(manager.discardWorktree("s_patch", worktree.path, { requireDelivered: true }), /no upstream/);
    const leaseOwner = "fixture-provider";
    const active = { sessionId: "s_patch", context: { kind: "native" }, cwd: worktree.path, worktree,
      worktreeLeaseOwner: leaseOwner, queue: [], client: { dispose: () => {} } };
    assert.equal(store.acquireWorktreeLease("s_patch", leaseOwner), true);
    internals.active.set("s_patch", active);
    assert.equal((await manager.discardWorktree("s_patch", worktree.path, {
      campaignDeliveredPullRequests: [candidate],
    })).retirement.status, "deferred");
    const explicitIntent = new WorktreeCleanupJournal(dataDir).list()[0]!;
    assert.equal(explicitIntent.trigger, "explicit_discard");
    assert.equal(internals.deleteActiveSession("s_patch", active), true);
    for (let attempt = 0; attempt < 500 &&
        new WorktreeCleanupJournal(dataDir).list()[0]?.patchUnavailableAttempts !== 1; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(new WorktreeCleanupJournal(dataDir).list()[0]?.patchUnavailableAttempts, 1);
    const replayedExplicitIntent = new WorktreeCleanupJournal(dataDir).list()[0]!;
    assert.equal((await manager.discardWorktree("s_patch", worktree.path, {
      requireDelivered: true, campaignDeliveredPullRequests: [candidate],
    })).retirement.status, "deferred", "archive promotion of a pending explicit intent stays retryable");
    const archiveIntent = new WorktreeCleanupJournal(dataDir).list()[0]!;
    assert.equal(archiveIntent.cleanupId, replayedExplicitIntent.cleanupId);
    assert.equal(archiveIntent.trigger, "archive_retirement");
    assert.equal(archiveIntent.initiatingTrigger, "explicit_discard");
    assert.ok(logs.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line)).some((event) =>
      event.cleanupId === archiveIntent.cleanupId && event.entryPoint === "explicit_discard" && event.requireDelivered === true),
    "promotion preserves the original entry point while reporting the stronger delivery requirement");
    assert.equal(new WorktreeCleanupJournal(dataDir).list()[0]?.patchUnavailableAttempts, 2);
    assert.equal(messages.some((message) => message.type === "session_worktree_retirement_refused"), false);
    await manager.reconcileWorktreePullRequests();
    assert.equal(new WorktreeCleanupJournal(dataDir).list().length, 0, "a permanent unknown outage cannot retry forever");
    assert.ok(messages.some((message) => message.type === "session_worktree_retirement_refused" &&
      /three attempts/.test(message.reason)));
    assert.equal(existsSync(worktree.path), true, "exhaustion never removes unproved work");
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal((await manager.discardWorktree("s_patch", worktree.path, {
        requireDelivered: true, campaignDeliveredPullRequests: [candidate],
      })).retirement.status, "deferred");
    }
    await assert.rejects(manager.discardWorktree("s_patch", worktree.path, {
      campaignDeliveredPullRequests: [candidate],
    }), /three attempts/, "repeated CP requests preserve the existing intent's attempt budget too");
    assert.equal(new WorktreeCleanupJournal(dataDir).list().length, 0);
    forgeAvailable = true;
    assert.equal(store.acquireWorktreeLease("s_patch", leaseOwner), true);
    active.worktreeLeaseOwner = leaseOwner;
    internals.active.set("s_patch", active);
    assert.equal((await manager.discardWorktree("s_patch", worktree.path, {
      requireDelivered: true, campaignDeliveredPullRequests: [candidate],
    })).retirement.status, "deferred");
    assert.deepEqual(new WorktreeCleanupJournal(dataDir).list()[0]?.campaignDeliveredPullRequests, [candidate],
      "same-child candidate provenance survives the provider boundary");
    assert.equal(internals.deleteActiveSession("s_patch", active), true);
    await manager.reconcileWorktreePullRequests();
    for (let attempt = 0; attempt < 500 && (store.readMeta("s_patch")?.worktrees?.length ||
        !new WorktreeCleanupJournal(dataDir).history().some((record) => record.patchDelivery?.tipOid === tip)); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(store.readMeta("s_patch")?.worktrees, [], JSON.stringify({
      journal: new WorktreeCleanupJournal(dataDir).list(), logs: logs.slice(-8),
    }));
    assert.ok(new WorktreeCleanupJournal(dataDir).history().some((record) => record.patchDelivery?.tipOid === tip));
    const diagnostic = logs.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line))
      .find((event) => event.event === "worktree_patch_delivery" && event.outcome === "matched");
    assert.equal(diagnostic?.outcome, "matched");
    assert.equal(diagnostic?.entryPoint, "archive_retirement");
    assert.equal(diagnostic?.candidateCount, 1);
    assert.equal(typeof diagnostic?.cleanupId, "string");
    assert.equal(existsSync(worktree.path), false);
    for (let attempt = 0; attempt < 500 && git(repo, "for-each-ref", "--format=%(refname)", "refs/heads/fix/original"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(git(repo, "for-each-ref", "--format=%(refname)", "refs/heads/fix/original"), "",
      "the retained-ref reclaimer repeats patch proof before deleting the unchanged local branch");
  } finally { manager?.shutdownAll(); rmSync(root, { recursive: true, force: true }); }
});
