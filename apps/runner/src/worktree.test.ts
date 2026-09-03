import assert from "node:assert/strict";
import { execFileSync } from "./test-support/bounded-child-process.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { attachRequestedWorktree, createRequestedWorktree, createWorktree, isGitRepo, nativeRepositoryPathIsUnavailable, removeWorktree, resolveWorktreeRoot, reuseRegisteredLegacyWslWorktree, setStatfsForTests, WorktreeCleanupJournal } from "./worktree.js";
import { randomUUID } from "node:crypto";
import { runContextCommand } from "./context-command.js";
import { SessionStore } from "./session-store.js";
import { SessionManager } from "./session-manager.js";
import { setGitRunnerForTests, type GitRunOpts } from "./git-ops.js";

function haveGit(): boolean {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

test("git preflight distinguishes a non-repo from a broken context/path", { skip: !haveGit() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-git-preflight-"));
  try {
    assert.equal(await isGitRepo(dir), false);
    await assert.rejects(isGitRepo(join(dir, "missing")), /git preflight failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native repository availability recognizes only terminal filesystem states", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-native-repo-availability-"));
  const file = join(root, "repo-file");
  const missing = join(root, "missing");
  const unreachableRoot = join(root, "offline-mounted-root");
  const unreachableRepo = join(unreachableRoot, "repo");
  try {
    writeFileSync(file, "not a directory");
    assert.equal(nativeRepositoryPathIsUnavailable({ kind: "native" }, root), false);
    assert.equal(nativeRepositoryPathIsUnavailable({ kind: "native" }, file), true);
    assert.equal(nativeRepositoryPathIsUnavailable({ kind: "native" }, missing), true,
      "a missing leaf below a reachable parent is terminal");
    assert.equal(nativeRepositoryPathIsUnavailable({ kind: "native" }, unreachableRepo), false,
      "an unreachable immediate root retains ownership for a later UNC, mapped-drive, or mount retry");
    assert.equal(nativeRepositoryPathIsUnavailable({ kind: "wsl", distro: "Ubuntu" }, missing), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persisted legacy WSL worktree reuse fails closed unless the exact path is registered and healthy", async () => {
  const expected = "/home/me/.agent-manager/worktrees/repo-key/session-one";
  const porcelain = [
    "worktree /repo",
    "HEAD " + "a".repeat(40),
    "",
    `worktree ${expected}/`,
    "HEAD " + "b".repeat(40),
    "",
  ].join("\n");
  let healthChecks = 0;
  assert.deepEqual(
    await reuseRegisteredLegacyWslWorktree(
      `${expected}/`, expected, "session-one", porcelain,
      async () => { healthChecks++; return true; },
    ),
    { path: expected, branch: "agent/session-one", created: false },
  );
  assert.equal(healthChecks, 1);

  await assert.rejects(
    reuseRegisteredLegacyWslWorktree("/unexpected/session-one", expected, "session-one", porcelain, async () => true),
    /outside the expected legacy session path/,
  );
  await assert.rejects(
    reuseRegisteredLegacyWslWorktree(expected, expected, "session-one", "worktree /other\n", async () => true),
    /no longer registered/,
  );
  await assert.rejects(
    reuseRegisteredLegacyWslWorktree(expected, expected, "session-one", porcelain, async () => false),
    /not healthy/,
  );
  await assert.rejects(
    reuseRegisteredLegacyWslWorktree(expected, expected, "session-one", porcelain, async () => { throw new Error("offline"); }),
    /not healthy/,
  );
});

test("native worktrees live under the external runner data root and clean up", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wt-external-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "runner-data");
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const handle = await createWorktree(repo, "s_external", { dataDir });
    assert.ok(handle.path.startsWith(join(dataDir, "worktrees")));
    assert.equal(handle.created, true);
    assert.ok(!handle.path.startsWith(repo + "\\"), "worktree must not be nested inside the base repo");
    assert.equal(execFileSync("git", ["-C", handle.path, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).trim(), "true");
    const reused = await createWorktree(repo, "s_external", { dataDir });
    assert.equal(reused.path, handle.path, "restart reuses the healthy registered worktree path");
    assert.equal(reused.branch, handle.branch);
    assert.equal(reused.created, false, "restart reports that it did not materialize the reused tree");
    await removeWorktree(repo, handle, { dataDir });
    await removeWorktree(repo, handle, { dataDir });
    assert.throws(() => execFileSync("git", ["-C", handle.path, "status"], { stdio: "ignore" }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requested worktree uses the explicit base and branch instead of primary checkout HEAD", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-requested-wt-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    writeFileSync(join(repo, "state.txt"), "base\n");
    execFileSync("git", ["-C", repo, "add", "state.txt"]);
    execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
    const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", repo, "branch", "refs-for-agent", base]);
    writeFileSync(join(repo, "state.txt"), "primary drift\n");
    execFileSync("git", ["-C", repo, "commit", "-am", "primary drift"]);
    const primaryHead = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const handle = await createRequestedWorktree(repo, "s_requested", {
      baseRef: "refs-for-agent",
      branch: "fix/issue-42-short-slug",
    }, { dataDir });
    assert.equal(handle.baseCommit, base);
    assert.notEqual(handle.baseCommit, primaryHead);
    assert.equal(execFileSync("git", ["-C", handle.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), base);
    assert.equal(execFileSync("git", ["-C", handle.path, "branch", "--show-current"], { encoding: "utf8" }).trim(), "fix/issue-42-short-slug");
    const reused = await createRequestedWorktree(repo, "s_requested", {
      baseRef: "refs-for-agent",
      branch: "fix/issue-42-short-slug",
    }, { dataDir });
    assert.equal(reused.created, false);
    await removeWorktree(repo, handle, { dataDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing worktree attach requires both Git registration and an allowed Location", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-attach-wt-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  const allowed = join(root, "configured-location");
  const outside = join(root, "outside-location", "worktree");
  const existing = join(allowed, "worktree");
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "fix/attach", existing]);
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "fix/outside", outside]);

    const attached = await attachRequestedWorktree(repo, "s_attach", existing, {
      dataDir,
      allowedProjectPaths: [allowed],
    });
    assert.equal(attached.path, existing);
    assert.equal(attached.branch, "fix/attach");
    assert.equal(attached.attached, true);
    setStatfsForTests(async () => {
      throw new Error("capacity probe must not run while attaching an existing worktree");
    });
    const reattached = await attachRequestedWorktree(repo, "s_attach", existing, {
      dataDir,
      allowedProjectPaths: [allowed],
    });
    assert.equal(reattached.path, existing);
    setStatfsForTests();
    await assert.rejects(
      attachRequestedWorktree(repo, "s_attach", outside, { dataDir, allowedProjectPaths: [allowed] }),
      /outside the runner's configured Project Locations/,
    );
    const unregistered = join(allowed, "not-registered");
    await assert.rejects(
      attachRequestedWorktree(repo, "s_attach", unregistered, { dataDir, allowedProjectPaths: [allowed] }),
      /not registered with the session repository/,
    );
    await assert.rejects(
      attachRequestedWorktree(repo, "s_attach", repo, { dataDir, allowedProjectPaths: [root] }),
      /primary workspace cannot be attached/,
    );
  } finally {
    setStatfsForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("already-removed worktree cleanup succeeds even when creation capacity preflight fails", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wt-low-disk-cleanup-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const handle = await createWorktree(repo, "s_low_disk", { dataDir });
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", handle.path]);
    setStatfsForTests(async () => ({ bavail: 1, bsize: 1 }) as never);
    await assert.rejects(resolveWorktreeRoot({ dataDir }), /512 MiB required/);
    await removeWorktree(repo, handle, { dataDir });
  } finally {
    setStatfsForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup journal survives restart and removes records atomically", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wollipog-cleanup-journal-"));
  try {
    const record = { sessionId: "s1", repoPath: "C:\\repo", worktreePath: "C:\\data\\wt", context: { kind: "native" as const } };
    new WorktreeCleanupJournal(dataDir).add(record);
    assert.deepEqual(new WorktreeCleanupJournal(dataDir).list(), [record]);
    new WorktreeCleanupJournal(dataDir).remove("s1");
    assert.deepEqual(new WorktreeCleanupJournal(dataDir).list(), []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("session deletion removes its external worktree and durable store row", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-delete-wt-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const handle = await createWorktree(repo, "s_delete", { dataDir });
    const store = new SessionStore(join(dataDir, "sessions"));
    store.create({
      sessionId: "s_delete", agentId: "claude", workspaceId: "repo", repoPath: repo,
      worktreePath: handle.path, driver: "claude-code", command: "claude", args: [], env: {},
      context: { kind: "native" }, agentSessionId: null, status: "stopped", title: "delete",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: 0, createdAt: 1, updatedAt: 1,
    });
    const manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
    const tree = execFileSync("git", ["-C", repo, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", repo, "update-ref", "refs/mam/s_delete/turn-1", tree]);
    execFileSync("git", ["-C", repo, "update-ref", "refs/wollipog/s_delete/turn-1", tree]);
    execFileSync("git", ["-C", repo, "update-ref", "refs/mam/s_delete/fork-1", tree]);
    execFileSync("git", ["-C", repo, "update-ref", "refs/wollipog/s_delete/fork-1", tree]);
    await manager.delete("s_delete");
    assert.equal(store.has("s_delete"), false);
    assert.deepEqual(new WorktreeCleanupJournal(dataDir).list(), []);
    assert.equal(execFileSync(
      "git", ["-C", repo, "for-each-ref", "--format=%(refname)", "refs/mam/s_delete/"],
      { encoding: "utf8" },
    ).trim(), "");
    assert.equal(execFileSync(
      "git", ["-C", repo, "for-each-ref", "--format=%(refname)", "refs/wollipog/s_delete/"],
      { encoding: "utf8" },
    ).trim(), "");
    assert.throws(() => execFileSync("git", ["-C", handle.path, "status"], { stdio: "ignore" }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent requests retain every created branch and deletion leaves attached worktrees alone", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-multi-wt-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  const attachedPath = join(root, "operator-location", "attached");
  let manager: SessionManager | undefined;
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "operator/attached", attachedPath]);
    const store = new SessionStore(join(dataDir, "sessions"));
    store.create({
      sessionId: "s_multi", agentId: "claude", workspaceId: "repo", repoPath: repo,
      worktreePath: null, driver: "claude-code", command: "claude", args: [], env: {},
      context: { kind: "native" }, agentSessionId: null, status: "idle", title: "multi",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: 0, createdAt: 1, updatedAt: 1,
    });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
    (manager as unknown as { configuredProjectPaths: string[] }).configuredProjectPaths = [join(root, "operator-location")];
    const [first, second] = await Promise.all([
      manager.requestWorktree("s_multi", { baseRef: "HEAD", branch: "fix/first" }),
      manager.requestWorktree("s_multi", { baseRef: "HEAD", branch: "fix/second" }),
    ]);
    const repeated = await manager.requestWorktree("s_multi", { baseRef: "HEAD", branch: "fix/first" });
    assert.equal(repeated.worktree.id, first.worktree.id, "an idempotent retry keeps original ownership metadata");
    const reattachedCreated = await manager.attachWorktree("s_multi", first.worktree.path);
    assert.equal(reattachedCreated.worktree.source, "created",
      "re-attaching a runner-owned path preserves its destructive cleanup ownership");
    await manager.attachWorktree("s_multi", attachedPath);
    assert.equal(store.readMeta("s_multi")?.worktrees?.length, 3);
    await manager.selectWorktree("s_multi", first.worktree.path);
    assert.equal(store.readMeta("s_multi")?.worktreePath, first.worktree.path);
    await manager.linkWorktreePullRequest("s_multi", second.worktree.path, "https://example.test/pull/2");
    assert.equal(store.readMeta("s_multi")?.worktrees?.find((item) => item.path === second.worktree.path)?.pullRequest?.url,
      "https://example.test/pull/2", "PR linkage stays bound to the Git action's exact worktree");
    assert.equal(store.readMeta("s_multi")?.worktrees?.find((item) => item.path === first.worktree.path)?.pullRequest,
      undefined);
    const requestedBoundary = dirname(first.worktree.path);

    await manager.delete("s_multi");
    assert.equal(existsSync(first.worktree.path), false);
    assert.equal(existsSync(second.worktree.path), false);
    assert.equal(existsSync(attachedPath), true, "attached operator worktree remains operator-owned");
    execFileSync("git", ["-C", repo, "show-ref", "--verify", "--quiet", "refs/heads/operator/attached"]);
    assert.throws(() => execFileSync("git", ["-C", repo, "show-ref", "--verify", "--quiet", "refs/heads/fix/first"]));
    assert.throws(() => execFileSync("git", ["-C", repo, "show-ref", "--verify", "--quiet", "refs/heads/fix/second"]));
    assert.equal(existsSync(requestedBoundary), false, "empty runner-owned session boundary is removed");
    assert.deepEqual(new WorktreeCleanupJournal(dataDir).list(), []);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("deletion includes an active legacy worktree missing from a populated inventory", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-union-wt-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const requested = await createRequestedWorktree(repo, "s_union", {
      baseRef: "HEAD",
      branch: "fix/inventory",
    }, { dataDir });
    const legacy = await createWorktree(repo, "s_union", { dataDir });
    const store = new SessionStore(join(dataDir, "sessions"));
    store.create({
      sessionId: "s_union", agentId: "claude", workspaceId: "repo", repoPath: repo,
      worktreePath: legacy.path, worktreeBranch: legacy.branch,
      worktrees: [{
        id: "requested", path: requested.path, branch: requested.branch,
        baseRef: requested.baseRef, baseCommit: requested.baseCommit, source: "created",
      }],
      driver: "claude-code", command: "claude", args: [], env: {}, context: { kind: "native" },
      agentSessionId: null, status: "stopped", title: "union", config: {}, tokensIn: 0,
      tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null, seq: 0,
      createdAt: 1, updatedAt: 1,
    });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);

    await manager.delete("s_union");
    assert.equal(existsSync(requested.path), false);
    assert.equal(existsSync(legacy.path), false);
    assert.throws(() => execFileSync("git", ["-C", repo, "show-ref", "--verify", "--quiet", "refs/heads/fix/inventory"]));
    assert.throws(() => execFileSync("git", ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${legacy.branch}`]));
    assert.deepEqual(new WorktreeCleanupJournal(dataDir).list(), []);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository-gone deletion terminally reclaims the external worktree", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-delete-gone-repo-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  const logs: string[] = [];
  let manager: SessionManager | undefined;
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const handle = await createWorktree(repo, "s_repo_gone", { dataDir });
    const store = new SessionStore(join(dataDir, "sessions"));
    store.create({
      sessionId: "s_repo_gone", agentId: "claude", workspaceId: "repo", repoPath: repo,
      worktreePath: handle.path, driver: "claude-code", command: "claude", args: [], env: {},
      context: { kind: "native" }, agentSessionId: null, status: "stopped", title: "delete",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: 0, createdAt: 1, updatedAt: 1,
    });
    manager = new SessionManager(() => {}, (line) => logs.push(line), store, "runner", undefined, undefined, dataDir);

    rmSync(repo, { recursive: true, force: true });
    await manager.delete("s_repo_gone");

    assert.equal(store.has("s_repo_gone"), false);
    assert.equal(existsSync(handle.path), false, "disk reclamation continues after ref enumeration fails");
    assert.deepEqual(new WorktreeCleanupJournal(dataDir).list(), []);
    assert.equal(logs.some((line) => line.includes("worktree cleanup") && line.includes("needs retry")), false);
    assert.equal(logs.some((line) => line.includes(repo) || line.includes(handle.path)), false,
      "cleanup diagnostics do not expose repository or worktree values");
    assert.ok(logs.every((line) => line.length <= 160), "cleanup diagnostics remain bounded");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("session deletion waits for startup checkpoint synchronization before sweeping both namespaces", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-sync-delete-race-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  let releaseSync = () => {};
  let deletePromise: Promise<void> | undefined;
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const handle = await createWorktree(repo, "s_sync_delete", { dataDir });
    const store = new SessionStore(join(dataDir, "sessions"));
    store.create({
      sessionId: "s_sync_delete", agentId: "claude", workspaceId: "repo", repoPath: repo,
      worktreePath: handle.path, driver: "claude-code", command: "claude", args: [], env: {},
      context: { kind: "native" }, agentSessionId: null, status: "stopped", title: "delete",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: 0, createdAt: 1, updatedAt: 1,
    });
    const tree = execFileSync("git", ["-C", repo, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", repo, "update-ref", "refs/mam/s_sync_delete/turn-1", tree]);

    let syncUpdateStartedResolve!: () => void;
    const syncUpdateStarted = new Promise<void>((resolve) => { syncUpdateStartedResolve = resolve; });
    const syncGate = new Promise<void>((resolve) => { releaseSync = resolve; });
    let deletionEnumerationStarted = false;
    const realGit = async (cwd: string, args: string[], opts?: GitRunOpts): Promise<string> =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: { ...process.env, ...opts?.env },
        input: opts?.stdin,
        timeout: opts?.timeoutMs,
      });
    setGitRunnerForTests(async (cwd, args, opts) => {
      if (args[0] === "update-ref" && opts?.stdin?.includes("create refs/wollipog/s_sync_delete/turn-1")) {
        syncUpdateStartedResolve();
        await syncGate;
      }
      if (args[0] === "for-each-ref" && args[1] === "--format=%(refname)" &&
          args[2]?.endsWith("/s_sync_delete/")) {
        deletionEnumerationStarted = true;
      }
      return realGit(cwd, args, opts);
    });

    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
    manager.reconcileStore();
    await syncUpdateStarted;
    let deleteSettled = false;
    deletePromise = manager.delete("s_sync_delete").finally(() => { deleteSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(deletionEnumerationStarted, false, "deletion must not enumerate a partial pre-sync ref set");
    assert.equal(deleteSettled, false, "deletion must remain fenced while startup synchronization is active");

    releaseSync();
    await deletePromise;
    assert.equal(deletionEnumerationStarted, true);
    assert.equal(execFileSync(
      "git", ["-C", repo, "for-each-ref", "--format=%(refname)", "refs/mam/s_sync_delete/"],
      { encoding: "utf8" },
    ).trim(), "");
    assert.equal(execFileSync(
      "git", ["-C", repo, "for-each-ref", "--format=%(refname)", "refs/wollipog/s_sync_delete/"],
      { encoding: "utf8" },
    ).trim(), "");
  } finally {
    releaseSync();
    await deletePromise?.catch(() => {});
    setGitRunnerForTests();
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restarting a worktree session reuses isolation instead of failing or orphaning it", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-restart-wt-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const store = new SessionStore(join(dataDir, "sessions"));
    const messages: Array<{ type: string; status?: string }> = [];
    const factory = () => ({
      pid: 1, initialize: async () => {}, newSession: async () => {},
      prompt: async () => ({ stopReason: "end_turn" as const }), cancel: () => {}, dispose: () => {},
      setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => null,
    });
    const manager = new SessionManager((message) => messages.push(message as never), () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_restart", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: true, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    const firstPath = store.readMeta("s_restart")?.worktreePath;
    assert.ok(firstPath);
    await manager.start(spec);
    assert.equal(store.readMeta("s_restart")?.worktreePath, firstPath);
    assert.equal(messages.some((message) => message.type === "session_status" && message.status === "failed"), false);
    manager.stop("s_restart");
    await manager.delete("s_restart");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a requested worktree becomes the provider cwd on the next launch", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-requested-cwd-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const store = new SessionStore(join(dataDir, "sessions"));
    const launchedCwds: string[] = [];
    const factory = (_driver: unknown, launch: { cwd: string }) => {
      launchedCwds.push(launch.cwd);
      return {
        pid: 1, initialize: async () => {}, newSession: async () => {},
        prompt: async () => ({ stopReason: "end_turn" as const }), cancel: () => {}, dispose: () => {},
        setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => null,
      };
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_requested_cwd", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    const requested = await manager.requestWorktree(spec.sessionId, { baseRef: "HEAD", branch: "fix/requested-cwd" });
    assert.equal(launchedCwds[0], repo, "the already-running process retains its original OS cwd");
    manager.stop(spec.sessionId);
    execFileSync("git", ["-C", requested.worktree.path, "switch", "-c", "fix/unattributed-drift"]);
    assert.equal(await manager.start(spec), false, "restart fails closed if the persisted branch identity drifted");
    assert.equal(store.readMeta(spec.sessionId)?.worktreePath, null,
      "a failed validation keeps the unverified root fenced from Files and shells");
    assert.deepEqual(launchedCwds, [repo], "branch drift never reaches the provider process");
    execFileSync("git", ["-C", requested.worktree.path, "switch", requested.worktree.branch]);
    await manager.selectWorktree(spec.sessionId, requested.worktree.path);
    assert.equal(await manager.start(spec), true);
    assert.equal(launchedCwds[1], requested.worktree.path, "the next provider launch uses the selected worktree");
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

const wslDistro = process.env.WOLLIPOG_TEST_WSL_DISTRO;
test("WSL worktrees are created, used, and removed inside the selected distro", { skip: !wslDistro }, async () => {
  const context = { kind: "wsl" as const, distro: wslDistro! };
  const repo = `/tmp/wollipog-wsl-wt-${randomUUID()}`;
  const managerRoot = mkdtempSync(join(tmpdir(), "wollipog-wsl-manager-"));
  let manager: SessionManager | undefined;
  try {
    await runContextCommand(context, "git", ["init", repo], { cwd: "/", timeoutMs: 30_000 });
    await runContextCommand(context, "git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await runContextCommand(context, "git", ["config", "user.name", "Test"], { cwd: repo });
    await runContextCommand(context, "git", ["commit", "--allow-empty", "-m", "base"], { cwd: repo });
    const ownerHash = "1".repeat(64);
    const handle = await createWorktree(repo, "s_wsl", { context, ownerHash });
    assert.match(handle.path, new RegExp(`/home/[^/]+/\\.agent-manager/runner-instances/${ownerHash}/worktrees/`));
    assert.equal((await runContextCommand(context, "git", ["rev-parse", "--is-inside-work-tree"], { cwd: handle.path })).stdout.trim(), "true");
    await removeWorktree(repo, handle, { context, ownerHash });
    await assert.rejects(runContextCommand(context, "git", ["status"], { cwd: handle.path }));

    const legacy = await createWorktree(repo, "s_legacy", { context, legacyWslRoot: true });
    await runContextCommand(context, "sh", ["-c", "printf preserved > sentinel.txt"], { cwd: legacy.path });
    const resumed = await createWorktree(repo, "s_legacy", {
      context,
      ownerHash,
      legacyWslWorktreePath: legacy.path,
    });
    assert.equal(resumed.path, legacy.path);
    assert.equal(resumed.created, false);
    assert.equal((await runContextCommand(context, "cat", ["sentinel.txt"], { cwd: resumed.path })).stdout, "preserved");
    await removeWorktree(repo, resumed, { context, legacyWslRoot: true });

    const requested = await createRequestedWorktree(repo, "s_wsl_requested", {
      baseRef: "HEAD",
      branch: "fix/wsl-cleanup",
    }, { context, ownerHash });
    const store = new SessionStore(join(managerRoot, "sessions"));
    store.create({
      sessionId: "s_wsl_requested", agentId: "claude", workspaceId: "repo", repoPath: repo,
      worktreePath: requested.path, worktreeBranch: requested.branch,
      worktrees: [{
        id: "requested", path: requested.path, branch: requested.branch,
        baseRef: requested.baseRef, baseCommit: requested.baseCommit, source: "created",
      }],
      driver: "claude-code", command: "claude", args: [], env: {}, context,
      agentSessionId: null, status: "stopped", title: "wsl cleanup", config: {}, tokensIn: 0,
      tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null, seq: 0,
      createdAt: 1, updatedAt: 1,
    });
    manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, managerRoot, 1,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, [], undefined, undefined, undefined, undefined, undefined, ownerHash,
    );
    await manager.delete("s_wsl_requested");
    await assert.rejects(runContextCommand(
      context,
      "git",
      ["show-ref", "--verify", "--quiet", "refs/heads/fix/wsl-cleanup"],
      { cwd: repo },
    ), "session cleanup removes the exact recorded requested branch inside WSL");
  } finally {
    manager?.shutdownAll();
    rmSync(managerRoot, { recursive: true, force: true });
    await runContextCommand(context, "rm", ["-rf", "--", repo], { cwd: "/" }).catch(() => {});
  }
});
