import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { attachRequestedWorktree, createRequestedWorktree, createWorktree, discardWorktreeIfSafe, fetchRemoteDefaultBase, isGitRepo, nativeRepositoryPathIsUnavailable, parseWorktreePullRequestState, readRepositoryDefaultBranch, removeWorktree, requestedWorktreeBoundary, resolveWorktreeRoot, reuseRegisteredLegacyWslWorktree, setStatfsForTests, WorktreeCleanupJournal } from "./worktree.js";
import { createHash, randomUUID } from "node:crypto";
import { runContextCommand } from "./context-command.js";
import { SessionStore } from "./session-store.js";
import { SessionManager } from "./session-manager.js";
import { anchorTurnRef, captureWorktreeTree, setGitRunnerForTests, type GitRunOpts } from "./git-ops.js";

function haveGit(): boolean {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function initRepoWithOrigin(root: string): { repo: string; remote: string } {
  const repo = join(root, "repo");
  const remote = join(root, "origin.git");
  execFileSync("git", ["init", "--bare", remote]);
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
  execFileSync("git", ["-C", repo, "branch", "-M", "main"]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]);
  execFileSync("git", ["-C", repo, "push", "-u", "origin", "main"]);
  return { repo, remote };
}

test("pull request lifecycle parsing requires an exact GitHub PR URL and terminal vocabulary", () => {
  const url = "https://github.com/picoduck/wollipog/pull/701";
  assert.equal(parseWorktreePullRequestState(JSON.stringify({ url, state: "OPEN" }), url), "open");
  assert.equal(parseWorktreePullRequestState(JSON.stringify({ url, state: "MERGED" }), url), "merged");
  assert.equal(parseWorktreePullRequestState(JSON.stringify({ url, state: "CLOSED" }), url), "closed");
  assert.equal(parseWorktreePullRequestState(JSON.stringify({ url, state: "UNKNOWN" }), url), null);
  assert.equal(parseWorktreePullRequestState(JSON.stringify({ url: `${url}/files`, state: "MERGED" }), url), null);
  assert.equal(parseWorktreePullRequestState(JSON.stringify({ url, state: "MERGED" }), "javascript:alert(1)"), null);
  assert.equal(parseWorktreePullRequestState("not json", url), null);
});

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

test("requested worktree reuse canonicalizes symlinked data roots without deleting live contents", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-requested-realpath-"));
  const repo = join(root, "repo");
  const realData = join(root, "real-data");
  const aliasData = join(root, "alias-data");
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    mkdirSync(realData);
    symlinkSync(realData, aliasData, "dir");
    const first = await createRequestedWorktree(repo, "s_realpath", {
      baseRef: "HEAD",
      branch: "fix/realpath-reuse",
    }, { dataDir: aliasData });
    const sentinel = join(first.path, "sentinel.txt");
    writeFileSync(sentinel, "must survive idempotent registration\n");

    const repeated = await createRequestedWorktree(repo, "s_realpath", {
      baseRef: "HEAD",
      branch: "fix/realpath-reuse",
    }, { dataDir: realData });
    assert.equal(repeated.created, false);
    assert.equal(existsSync(sentinel), true);
    assert.equal(execFileSync("git", ["-C", repeated.path, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim(), repeated.path, "the returned coordinate is Git's canonical registered path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requested worktree creation never recursively removes a path registered by another repository", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-requested-live-path-"));
  const repo = join(root, "repo");
  const foreign = join(root, "foreign");
  const dataDir = join(root, "data");
  const branch = "fix/live-foreign-path";
  try {
    for (const path of [repo, foreign]) {
      execFileSync("git", ["init", path]);
      execFileSync("git", ["-C", path, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", path, "config", "user.name", "Test"]);
      execFileSync("git", ["-C", path, "commit", "--allow-empty", "-m", "base"]);
    }
    const boundary = await requestedWorktreeBoundary(repo, "s_foreign", { dataDir });
    const slot = createHash("sha256").update(branch).digest("hex").slice(0, 16);
    const target = join(boundary, slot);
    execFileSync("git", ["-C", foreign, "worktree", "add", "-b", "foreign/live", target]);
    const sentinel = join(target, "sentinel.txt");
    writeFileSync(sentinel, "live foreign worktree\n");

    await assert.rejects(createRequestedWorktree(repo, "s_foreign", {
      baseRef: "HEAD",
      branch,
    }, { dataDir }), /may still be a registered worktree/);
    assert.equal(existsSync(sentinel), true);
    assert.equal(execFileSync("git", ["-C", target, "branch", "--show-current"], { encoding: "utf8" }).trim(),
      "foreign/live");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attach preserves a bare primary record while permitting its linked worktree", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-attach-bare-"));
  const seed = join(root, "seed");
  const bare = join(root, "repo.git");
  const linked = join(root, "linked");
  try {
    execFileSync("git", ["init", seed]);
    execFileSync("git", ["-C", seed, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", seed, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", seed, "commit", "--allow-empty", "-m", "base"]);
    execFileSync("git", ["clone", "--bare", seed, bare]);
    execFileSync("git", ["--git-dir", bare, "worktree", "add", "-b", "fix/bare-linked", linked, "HEAD"]);

    const attached = await attachRequestedWorktree(bare, "s_bare", linked, {
      dataDir: join(root, "data"),
      allowedProjectPaths: [root],
    });
    assert.equal(attached.path, linked);
    assert.equal(attached.branch, "fix/bare-linked");
    await assert.rejects(attachRequestedWorktree(bare, "s_bare", bare, {
      dataDir: join(root, "data"),
      allowedProjectPaths: [root],
    }), /primary workspace cannot be attached/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("safe discard removes only a clean fully-pushed runner-owned worktree", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-safe-discard-"));
  const dataDir = join(root, "data");
  try {
    const { repo } = initRepoWithOrigin(root);
    const clean = await createRequestedWorktree(repo, "s_safe", {
      baseRef: "HEAD",
      branch: "fix/clean-pushed",
    }, { dataDir });
    execFileSync("git", ["-C", clean.path, "push", "-u", "origin", clean.branch]);
    assert.deepEqual(await discardWorktreeIfSafe(repo, "s_safe", {
      ...clean,
      source: "created",
    }, { dataDir }), { removed: true });
    assert.equal(existsSync(clean.path), false);
    assert.throws(() => execFileSync("git", ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${clean.branch}`]));

    const dirty = await createRequestedWorktree(repo, "s_safe", {
      baseRef: "HEAD",
      branch: "fix/dirty",
    }, { dataDir });
    execFileSync("git", ["-C", dirty.path, "push", "-u", "origin", dirty.branch]);
    writeFileSync(join(dirty.path, "local.txt"), "retain\n");
    assert.deepEqual(await discardWorktreeIfSafe(repo, "s_safe", {
      ...dirty,
      source: "created",
    }, { dataDir }), { removed: false, reason: "dirty" });
    assert.equal(existsSync(dirty.path), true);

    const unpushed = await createRequestedWorktree(repo, "s_safe", {
      baseRef: "HEAD",
      branch: "fix/unpushed",
    }, { dataDir });
    execFileSync("git", ["-C", unpushed.path, "push", "-u", "origin", unpushed.branch]);
    writeFileSync(join(unpushed.path, "commit.txt"), "local commit\n");
    execFileSync("git", ["-C", unpushed.path, "add", "commit.txt"]);
    execFileSync("git", ["-C", unpushed.path, "commit", "-m", "local only"]);
    assert.deepEqual(await discardWorktreeIfSafe(repo, "s_safe", {
      ...unpushed,
      source: "created",
    }, { dataDir }), { removed: false, reason: "unpushed" });
    assert.equal(existsSync(unpushed.path), true);

    const noUpstream = await createRequestedWorktree(repo, "s_safe", {
      baseRef: "HEAD",
      branch: "fix/no-upstream",
    }, { dataDir });
    assert.deepEqual(await discardWorktreeIfSafe(repo, "s_safe", {
      ...noUpstream,
      source: "created",
    }, { dataDir }), { removed: false, reason: "no_upstream" });

    const drifted = await createRequestedWorktree(repo, "s_safe", {
      baseRef: "HEAD",
      branch: "fix/drift-original",
    }, { dataDir });
    execFileSync("git", ["-C", drifted.path, "push", "-u", "origin", drifted.branch]);
    execFileSync("git", ["-C", drifted.path, "switch", "-c", "fix/drift-replacement"]);
    assert.deepEqual(await discardWorktreeIfSafe(repo, "s_safe", {
      ...drifted,
      source: "created",
    }, { dataDir }), { removed: false, reason: "branch_changed" });
    assert.equal(existsSync(drifted.path), true);

    assert.deepEqual(await discardWorktreeIfSafe(repo, "s_safe", {
      path: join(root, "operator-owned"),
      branch: "fix/not-owned",
      source: "created",
    }, { dataDir }), { removed: false, reason: "not_runner_owned" });
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
    execFileSync("git", ["-C", first.worktree.path, "switch", "-c", "fix/reattach-drift"]);
    await assert.rejects(manager.attachWorktree("s_multi", first.worktree.path),
      /branch changed since it was linked/);
    execFileSync("git", ["-C", first.worktree.path, "switch", first.worktree.branch]);
    await manager.attachWorktree("s_multi", attachedPath);
    assert.equal(store.readMeta("s_multi")?.worktrees?.length, 3);
    await manager.selectWorktree("s_multi", first.worktree.path);
    assert.equal(store.readMeta("s_multi")?.worktreePath, first.worktree.path);
    await manager.linkWorktreePullRequest("s_multi", second.worktree.path, "https://example.test/pull/2");
    assert.equal(store.readMeta("s_multi")?.worktrees?.find((item) => item.path === second.worktree.path)?.pullRequest?.url,
      "https://example.test/pull/2", "PR linkage stays bound to the Git action's exact worktree");
    assert.equal(store.readMeta("s_multi")?.worktrees?.find((item) => item.path === first.worktree.path)?.pullRequest,
      undefined);

    writeFileSync(join(first.worktree.path, "first-only.txt"), "checkpoint from first worktree\n");
    const firstTree = await captureWorktreeTree(first.worktree.path);
    await anchorTurnRef(first.worktree.path, "s_multi", 1, firstTree, undefined, first.worktree.id);
    store.patchMeta("s_multi", { checkpointWorktreeIds: { "1": first.worktree.id } });
    await manager.selectWorktree("s_multi", second.worktree.path);
    const secondSentinel = join(second.worktree.path, "second-only.txt");
    writeFileSync(secondSentinel, "must not be overwritten by a first-worktree rewind\n");
    const rewind = await manager.rewind("s_multi", 1);
    assert.equal(rewind.ok, false);
    assert.match(rewind.error ?? "", /belongs to a different session worktree/);
    assert.equal(existsSync(secondSentinel), true);
    await manager.selectWorktree("s_multi", first.worktree.path);
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

test("PR reconciliation and explicit discard retain every unsafe worktree", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-pr-worktree-cleanup-"));
  const dataDir = join(root, "data");
  const operatorRoot = join(root, "operator");
  const attachedPath = join(operatorRoot, "attached");
  let manager: SessionManager | undefined;
  try {
    const { repo } = initRepoWithOrigin(root);
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "operator/attached", attachedPath]);
    const store = new SessionStore(join(dataDir, "sessions"));
    store.create({
      sessionId: "s_pr_cleanup", agentId: "claude", workspaceId: "repo", repoPath: repo,
      worktreePath: null, driver: "claude-code", command: "claude", args: [], env: {},
      context: { kind: "native" }, agentSessionId: null, status: "idle", title: "cleanup",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: 0, createdAt: 1, updatedAt: 1,
    });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
    (manager as unknown as { configuredProjectPaths: string[] }).configuredProjectPaths = [operatorRoot];
    const clean = await manager.requestWorktree("s_pr_cleanup", { baseRef: "HEAD", branch: "fix/pr-clean" });
    const dirty = await manager.requestWorktree("s_pr_cleanup", { baseRef: "HEAD", branch: "fix/pr-dirty" });
    const unverifiable = await manager.requestWorktree("s_pr_cleanup", { baseRef: "HEAD", branch: "fix/pr-unknown" });
    for (const worktree of [clean.worktree, dirty.worktree, unverifiable.worktree]) {
      execFileSync("git", ["-C", worktree.path, "push", "-u", "origin", worktree.branch]);
    }
    writeFileSync(join(dirty.worktree.path, "local.txt"), "retain dirty state\n");
    const attached = await manager.attachWorktree("s_pr_cleanup", attachedPath);
    for (const [worktree, url] of [
      [clean.worktree, "https://github.com/picoduck/wollipog/pull/701"],
      [dirty.worktree, "https://github.com/picoduck/wollipog/pull/702"],
      [unverifiable.worktree, "https://github.com/picoduck/wollipog/pull/703"],
      [attached.worktree, "https://github.com/picoduck/wollipog/pull/704"],
    ] as const) {
      await manager.linkWorktreePullRequest("s_pr_cleanup", worktree.path, url);
    }
    (manager as unknown as {
      resolveWorktreePullRequestState: (path: string) => Promise<"merged" | "closed" | null>;
    }).resolveWorktreePullRequestState = async (path) => {
      if (path === clean.worktree.path || path === attached.worktree.path) return "merged";
      if (path === dirty.worktree.path) return "closed";
      return null;
    };

    await manager.reconcileWorktreePullRequests();
    assert.equal(existsSync(clean.worktree.path), false, "a definitively merged clean pushed worktree is removed");
    assert.equal(existsSync(dirty.worktree.path), true, "dirty terminal-PR worktree is retained");
    assert.equal(existsSync(unverifiable.worktree.path), true, "unverifiable forge state is retained");
    assert.equal(existsSync(attachedPath), true, "attached operator-owned worktree is retained");
    const retained = store.readMeta("s_pr_cleanup")?.worktrees ?? [];
    assert.equal(retained.some((item) => item.path === clean.worktree.path), false);
    assert.equal(retained.find((item) => item.path === dirty.worktree.path)?.pullRequest?.state, "closed");
    assert.equal(retained.find((item) => item.path === unverifiable.worktree.path)?.pullRequest?.state, "open");
    assert.equal(retained.find((item) => item.path === attachedPath)?.pullRequest?.state, "merged");

    await assert.rejects(manager.discardWorktree("s_pr_cleanup", dirty.worktree.path), /uncommitted changes/);
    await assert.rejects(manager.discardWorktree("s_pr_cleanup", attachedPath), /operator-owned/);
    execFileSync("git", ["-C", dirty.worktree.path, "clean", "-fd"]);
    await manager.discardWorktree("s_pr_cleanup", dirty.worktree.path);
    assert.equal(existsSync(dirty.worktree.path), false, "explicit discard uses the same safe removal checks");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal PR cleanup waits until the provider releases its exact cwd", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-active-pr-worktree-"));
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  try {
    const { repo } = initRepoWithOrigin(root);
    const store = new SessionStore(join(dataDir, "sessions"));
    store.create({
      sessionId: "s_active_pr", agentId: "claude", workspaceId: "repo", repoPath: repo,
      worktreePath: null, driver: "claude-code", command: "claude", args: [], env: {},
      context: { kind: "native" }, agentSessionId: null, status: "idle", title: "active",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: 0, createdAt: 1, updatedAt: 1,
    });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
    const active = await manager.requestWorktree("s_active_pr", { baseRef: "HEAD", branch: "fix/active-pr" });
    execFileSync("git", ["-C", active.worktree.path, "push", "-u", "origin", active.worktree.branch]);
    await manager.linkWorktreePullRequest(
      "s_active_pr",
      active.worktree.path,
      "https://github.com/picoduck/wollipog/pull/705",
    );
    (manager as unknown as {
      resolveWorktreePullRequestState: () => Promise<"merged">;
    }).resolveWorktreePullRequestState = async () => "merged";
    const activeEntries = (manager as unknown as { active: Map<string, unknown> }).active;
    activeEntries.set("s_active_pr", {
      cwd: active.worktree.path,
      worktree: { path: active.worktree.path, branch: active.worktree.branch },
    });
    await manager.reconcileWorktreePullRequests();
    assert.equal(existsSync(active.worktree.path), true);
    assert.equal(store.readMeta("s_active_pr")?.worktrees?.[0]?.pullRequest?.state, "merged",
      "terminal state is durable while cleanup waits for the live process");

    activeEntries.delete("s_active_pr");
    const siblingStore = new SessionStore(join(dataDir, "sessions"));
    assert.equal(siblingStore.acquireWorktreeLease("s_active_pr", "sibling-provider"), true);
    await manager.reconcileWorktreePullRequests();
    assert.equal(existsSync(active.worktree.path), true,
      "a provider lease held through another store instance is also authoritative");
    siblingStore.releaseWorktreeLease("s_active_pr", "sibling-provider");
    await manager.reconcileWorktreePullRequests();
    assert.equal(existsSync(active.worktree.path), false, "durable terminal state retries without another forge call");
    assert.equal(store.readMeta("s_active_pr")?.worktreePath, null);
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

test("launch finalization cannot overwrite a worktree selected while launch is preparing", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-launch-worktree-race-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  let releaseFinalization = () => {};
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
    const lane = manager as unknown as {
      runWorktreeOperation: (sessionId: string, operation: () => Promise<unknown>) => Promise<unknown>;
    };
    const originalLane = lane.runWorktreeOperation.bind(manager);
    let laneCalls = 0;
    let finalizationReachedResolve!: () => void;
    const finalizationReached = new Promise<void>((resolve) => { finalizationReachedResolve = resolve; });
    const finalizationGate = new Promise<void>((resolve) => { releaseFinalization = resolve; });
    lane.runWorktreeOperation = async (sessionId, operation) => {
      laneCalls++;
      if (laneCalls === 2) {
        finalizationReachedResolve();
        await finalizationGate;
      }
      return originalLane(sessionId, operation);
    };

    const spec = {
      sessionId: "s_launch_race", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    const launch = manager.start(spec);
    await finalizationReached;
    const selected = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD",
      branch: "fix/launch-race-selection",
    });
    await assert.rejects(manager.discardWorktree(spec.sessionId, selected.worktree.path),
      /still being launched by a provider process/);
    releaseFinalization();
    assert.equal(await launch, true);
    assert.equal(store.readMeta(spec.sessionId)?.worktreePath, selected.worktree.path);
    assert.deepEqual(launchedCwds, [selected.worktree.path],
      "provider construction uses the mutation lane's winning selection");
  } finally {
    releaseFinalization();
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a requested worktree safely rebinds the provider before its next queued turn", { skip: !haveGit() }, async () => {
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
    const prompts: Array<{ cwd: string; text: string }> = [];
    let firstPromptStarted!: () => void;
    const firstPromptRunning = new Promise<void>((resolve) => { firstPromptStarted = resolve; });
    let finishFirstPrompt!: () => void;
    const firstPromptGate = new Promise<void>((resolve) => { finishFirstPrompt = resolve; });
    const factory = (_driver: unknown, launch: { cwd: string }) => {
      launchedCwds.push(launch.cwd);
      return {
        pid: 1, initialize: async () => {}, newSession: async () => {},
        prompt: async (text: string) => {
          prompts.push({ cwd: launch.cwd, text });
          if (text === "first") {
            firstPromptStarted();
            await firstPromptGate;
          }
          return "end_turn" as const;
        },
        cancel: () => {}, dispose: () => {}, setConfig: () => {}, resolvePermission: () => false,
        agentSessionId: () => "provider-session-id",
      };
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_requested_cwd", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    manager.prompt(spec.sessionId, "first");
    await firstPromptRunning;
    const requested = await manager.requestWorktree(spec.sessionId, { baseRef: "HEAD", branch: "fix/requested-cwd" });
    assert.equal(launchedCwds[0], repo, "the already-running process retains its original OS cwd");
    manager.prompt(spec.sessionId, "second");
    finishFirstPrompt();
    for (let attempt = 0; attempt < 500 && prompts.length < 2; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(prompts, [
      { cwd: repo, text: "first" },
      { cwd: requested.worktree.path, text: "second" },
    ], "the current turn completes in place and the preserved FIFO resumes in the selected worktree");
    assert.deepEqual(launchedCwds, [repo, requested.worktree.path]);
    manager.stop(spec.sessionId);
    execFileSync("git", ["-C", requested.worktree.path, "switch", "-c", "fix/unattributed-drift"]);
    assert.equal(await manager.start(spec), false, "restart fails closed if the persisted branch identity drifted");
    assert.equal(store.readMeta(spec.sessionId)?.worktreePath, null,
      "a failed validation keeps the unverified root fenced from Files and shells");
    assert.deepEqual(launchedCwds, [repo, requested.worktree.path], "branch drift never reaches a new provider process");
    execFileSync("git", ["-C", requested.worktree.path, "switch", requested.worktree.branch]);
    await manager.selectWorktree(spec.sessionId, requested.worktree.path);
    assert.equal(await manager.start(spec), true);
    assert.equal(launchedCwds[2], requested.worktree.path, "a later explicit launch also uses the selected worktree");
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed retired drain cannot cancel the replacement worktree FIFO", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-retired-drain-rebind-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  let releaseFirstPrompt!: () => void;
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const store = new SessionStore(join(dataDir, "sessions"));
    const launchedCwds: string[] = [];
    const prompts: Array<{ cwd: string; text: string }> = [];
    const cancelledCwds: string[] = [];
    const factory = (_driver: unknown, launch: { cwd: string }) => {
      launchedCwds.push(launch.cwd);
      return {
        pid: launchedCwds.length, initialize: async () => {}, newSession: async () => {}, close: async () => {},
        prompt: async (text: string) => { prompts.push({ cwd: launch.cwd, text }); return "end_turn" as const; },
        cancel: () => { cancelledCwds.push(launch.cwd); }, dispose: () => {}, setConfig: () => {},
        resolvePermission: () => false, agentSessionId: () => "provider-session-id",
      };
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_retired_drain", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    const firstPromptStarted = new Promise<void>((resolve) => {
      const internals = manager as unknown as {
        runPrompt: (sessionId: string, prompt: unknown) => Promise<void>;
      };
      const originalRunPrompt = internals.runPrompt.bind(manager);
      let failFirstPrompt = true;
      internals.runPrompt = async (sessionId, prompt) => {
        if (failFirstPrompt) {
          failFirstPrompt = false;
          resolve();
          await new Promise<void>((release) => { releaseFirstPrompt = release; });
          throw new Error("unexpected retired drain failure");
        }
        await originalRunPrompt(sessionId, prompt);
      };
    });
    assert.equal(manager.prompt(spec.sessionId, "first"), true);
    await firstPromptStarted;
    const requested = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/retired-drain-rebind",
    });
    assert.equal(manager.prompt(spec.sessionId, "second"), true);
    releaseFirstPrompt();
    await waitForCondition(() => prompts.some((prompt) => prompt.text === "second") &&
      store.readMeta(spec.sessionId)?.status === "idle",
    "the replacement provider did not retain and finish draining its FIFO");
    assert.deepEqual(prompts, [{ cwd: requested.worktree.path, text: "second" }]);
    assert.deepEqual(launchedCwds, [repo, requested.worktree.path]);
    assert.deepEqual(cancelledCwds, [], "the retired drain must not cancel the replacement provider");
    assert.equal(store.readMeta(spec.sessionId)?.status, "idle");
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
    releaseFirstPrompt?.();
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an idle worktree rebind settles back to idle without inventing a prompt", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-idle-worktree-rebind-"));
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
        pid: 1, initialize: async () => {}, newSession: async () => {}, close: async () => {},
        prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => {}, setConfig: () => {},
        resolvePermission: () => false, agentSessionId: () => "provider-session-id",
      };
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_idle_rebind", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    const requested = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/idle-rebind",
    });
    await waitForCondition(() => launchedCwds.length === 2, "idle rebind did not relaunch the provider");
    assert.deepEqual(launchedCwds, [repo, requested.worktree.path]);
    assert.equal(store.readMeta(spec.sessionId)?.status, "idle");
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a worktree rebind fails closed when the selected branch drifts before replacement launch", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-drifted-worktree-rebind-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  let releaseClose = () => {};
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const store = new SessionStore(join(dataDir, "sessions"));
    const sent: Array<{ type: string; payload?: { kind?: string; message?: string } }> = [];
    const launchedCwds: string[] = [];
    let closeStartedResolve!: () => void;
    const closeStarted = new Promise<void>((resolve) => { closeStartedResolve = resolve; });
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const factory = (_driver: unknown, launch: { cwd: string }) => {
      launchedCwds.push(launch.cwd);
      return {
        pid: launchedCwds.length, initialize: async () => {}, newSession: async () => {},
        close: async () => { closeStartedResolve(); await closeGate; },
        prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => {}, setConfig: () => {},
        resolvePermission: () => false, agentSessionId: () => "provider-session-id",
      };
    };
    manager = new SessionManager((message) => sent.push(message as never), () => {}, store,
      "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_drifted_rebind", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    const requested = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/drifted-rebind",
    });
    await closeStarted;
    execFileSync("git", ["-C", requested.worktree.path, "switch", "-c", "fix/drifted-after-selection"]);
    releaseClose();
    await waitForCondition(() => sent.some((message) => message.type === "session_event" &&
      message.payload?.kind === "error" && /branch changed/.test(message.payload.message ?? "")),
    "branch drift was not reported before replacement launch");
    assert.deepEqual(launchedCwds, [repo], "branch drift must not reach a replacement provider process");
    assert.equal(store.readMeta(spec.sessionId)?.status, "idle");
    execFileSync("git", ["-C", requested.worktree.path, "switch", requested.worktree.branch]);
    await manager.delete(spec.sessionId);
  } finally {
    releaseClose();
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a governance hold defers worktree rebind and its queued prompt until rearm", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-governance-worktree-rebind-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  let releasePrompt = () => {};
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const store = new SessionStore(join(dataDir, "sessions"));
    const launchedCwds: string[] = [];
    const prompts: Array<{ cwd: string; text: string }> = [];
    let promptStartedResolve!: () => void;
    const promptStarted = new Promise<void>((resolve) => { promptStartedResolve = resolve; });
    const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const factory = (_driver: unknown, launch: { cwd: string }) => {
      launchedCwds.push(launch.cwd);
      return {
        pid: 1, initialize: async () => {}, newSession: async () => {}, close: async () => {},
        prompt: async (text: string) => {
          prompts.push({ cwd: launch.cwd, text });
          if (text === "first") {
            promptStartedResolve();
            await promptGate;
          }
          return "end_turn" as const;
        },
        cancel: () => {}, dispose: () => {}, setConfig: () => {}, resolvePermission: () => false,
        agentSessionId: () => "provider-session-id",
      };
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_governance_rebind", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    manager.prompt(spec.sessionId, "first");
    await promptStarted;
    const requested = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/governance-rebind",
    });
    manager.prompt(spec.sessionId, "held");
    const internals = manager as unknown as {
      active: Map<string, { governanceTripped?: "cost_budget" | "max_tool_calls" }>;
    };
    internals.active.get(spec.sessionId)!.governanceTripped = "max_tool_calls";
    releasePrompt();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(launchedCwds, [repo], "the governance boundary must defer provider replacement");
    assert.deepEqual(prompts, [{ cwd: repo, text: "first" }],
      "queued work must remain held before governance is re-armed");
    manager.rearmGovernance(spec.sessionId, { maxToolCalls: 2 });
    await waitForCondition(() => prompts.length === 2, "re-armed queue did not resume after worktree rebind");
    assert.deepEqual(launchedCwds, [repo, requested.worktree.path]);
    assert.deepEqual(prompts[1], { cwd: requested.worktree.path, text: "held" });
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
    releasePrompt();
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a control-plane hold survives rebind and its release resumes an empty deferred rebind", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-control-plane-worktree-rebind-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  let releasePrompt = () => {};
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const store = new SessionStore(join(dataDir, "sessions"));
    const launchedCwds: string[] = [];
    const prompts: Array<{ cwd: string; text: string }> = [];
    let promptStartedResolve!: () => void;
    const promptStarted = new Promise<void>((resolve) => { promptStartedResolve = resolve; });
    const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const factory = (_driver: unknown, launch: { cwd: string }) => {
      launchedCwds.push(launch.cwd);
      return {
        pid: 1, initialize: async () => {}, newSession: async () => {}, close: async () => {},
        prompt: async (text: string) => {
          prompts.push({ cwd: launch.cwd, text });
          if (text === "first") {
            promptStartedResolve();
            await promptGate;
          }
          return "end_turn" as const;
        },
        cancel: () => {}, dispose: () => {}, setConfig: () => {}, resolvePermission: () => false,
        agentSessionId: () => "provider-session-id",
      };
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_control_plane_rebind", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    manager.prompt(spec.sessionId, "first");
    await promptStarted;
    const firstRequested = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/control-plane-held-rebind",
    });
    manager.prompt(spec.sessionId, "held");
    manager.rearmGovernance(spec.sessionId, {}, "control_plane");
    releasePrompt();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(launchedCwds, [repo], "the control-plane card must defer provider replacement");
    assert.deepEqual(prompts, [{ cwd: repo, text: "first" }],
      "queued work must remain parked behind the control-plane card");

    manager.rearmGovernance(spec.sessionId, {});
    await waitForCondition(() => prompts.length === 2, "card release did not resume the held FIFO after rebind");
    assert.deepEqual(launchedCwds, [repo, firstRequested.worktree.path]);
    assert.deepEqual(prompts[1], { cwd: firstRequested.worktree.path, text: "held" });
    await waitForCondition(() => store.readMeta(spec.sessionId)?.status === "idle", "held prompt did not settle");

    manager.rearmGovernance(spec.sessionId, {}, "control_plane");
    const emptyRequested = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/control-plane-empty-rebind",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(launchedCwds.length, 2, "an empty held queue must still defer provider replacement");
    manager.rearmGovernance(spec.sessionId, {});
    await waitForCondition(() => launchedCwds.length === 3, "card release did not resume the empty rebind");
    assert.equal(launchedCwds[2], emptyRequested.worktree.path);
    assert.equal(prompts.length, 2, "an empty rebind must not invent a prompt");
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
    releasePrompt();
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an interrupt hold defers worktree rebind until an explicit prompt resumes the queue", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-interrupt-worktree-rebind-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  let releasePrompt = () => {};
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const store = new SessionStore(join(dataDir, "sessions"));
    const launchedCwds: string[] = [];
    const prompts: Array<{ cwd: string; text: string }> = [];
    let interrupted = false;
    let promptStartedResolve!: () => void;
    const promptStarted = new Promise<void>((resolve) => { promptStartedResolve = resolve; });
    const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const factory = (_driver: unknown, launch: { cwd: string }) => {
      launchedCwds.push(launch.cwd);
      return {
        pid: 1, initialize: async () => {}, newSession: async () => {}, close: async () => {},
        prompt: async (text: string) => {
          prompts.push({ cwd: launch.cwd, text });
          if (text === "first") {
            promptStartedResolve();
            await promptGate;
            return interrupted ? "cancelled" as const : "end_turn" as const;
          }
          return "end_turn" as const;
        },
        cancel: () => { interrupted = true; }, dispose: () => {}, setConfig: () => {},
        resolvePermission: () => false, agentSessionId: () => "provider-session-id",
      };
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_interrupt_rebind", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    manager.prompt(spec.sessionId, "first");
    await promptStarted;
    const requested = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/interrupt-rebind",
    });
    manager.prompt(spec.sessionId, "held");
    assert.equal(manager.interruptTurn(spec.sessionId), "applied");
    releasePrompt();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(launchedCwds, [repo], "the interrupt hold must defer provider replacement");
    assert.deepEqual(prompts, [{ cwd: repo, text: "first" }],
      "the preserved FIFO must not run until a later explicit prompt");
    manager.prompt(spec.sessionId, "resume");
    await waitForCondition(() => prompts.length === 3, "explicit resume did not drain the preserved FIFO");
    assert.deepEqual(launchedCwds, [repo, requested.worktree.path]);
    assert.deepEqual(prompts.slice(1), [
      { cwd: requested.worktree.path, text: "held" },
      { cwd: requested.worktree.path, text: "resume" },
    ]);
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
    releasePrompt();
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an authentication hold defers worktree rebind and preserves its FIFO until an explicit prompt", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-auth-worktree-rebind-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  let releasePrompt = () => {};
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const store = new SessionStore(join(dataDir, "sessions"));
    const launchedCwds: string[] = [];
    const prompts: Array<{ cwd: string; text: string }> = [];
    let promptStartedResolve!: () => void;
    const promptStarted = new Promise<void>((resolve) => { promptStartedResolve = resolve; });
    const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const factory = (_driver: unknown, launch: { cwd: string }) => {
      launchedCwds.push(launch.cwd);
      return {
        pid: 1, initialize: async () => {}, newSession: async () => {}, close: async () => {},
        prompt: async (text: string) => {
          prompts.push({ cwd: launch.cwd, text });
          if (text === "first") {
            promptStartedResolve();
            await promptGate;
          }
          return "end_turn" as const;
        },
        cancel: () => {}, dispose: () => {}, setConfig: () => {}, resolvePermission: () => false,
        agentSessionId: () => "provider-session-id",
      };
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_auth_rebind", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    manager.prompt(spec.sessionId, "first");
    await promptStarted;
    const requested = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/auth-rebind",
    });
    manager.prompt(spec.sessionId, "held");
    const internals = manager as unknown as {
      active: Map<string, { authenticationBlocked?: boolean }>;
    };
    internals.active.get(spec.sessionId)!.authenticationBlocked = true;
    releasePrompt();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(launchedCwds, [repo], "authentication containment must defer provider replacement");
    assert.deepEqual(prompts, [{ cwd: repo, text: "first" }], "held work must remain intact");
    manager.prompt(spec.sessionId, "resume");
    await waitForCondition(() => prompts.length === 3, "explicit auth revalidation did not resume the FIFO");
    assert.deepEqual(launchedCwds, [repo, requested.worktree.path]);
    assert.deepEqual(prompts.slice(1), [
      { cwd: requested.worktree.path, text: "held" },
      { cwd: requested.worktree.path, text: "resume" },
    ]);
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
    releasePrompt();
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("history-integrity containment prevents an implicit worktree rebind", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-history-worktree-rebind-"));
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
        pid: 1, initialize: async () => {}, newSession: async () => {}, close: async () => {},
        prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => {}, setConfig: () => {},
        resolvePermission: () => false, agentSessionId: () => "provider-session-id",
      };
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_history_rebind", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    const internals = manager as unknown as {
      active: Map<string, { historyIntegrityFailure?: string; pendingWorktreeRebind?: string }>;
    };
    internals.active.get(spec.sessionId)!.historyIntegrityFailure = "contained history failure";
    const requested = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/history-rebind",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(launchedCwds, [repo], "history containment must not relaunch the provider");
    assert.equal(internals.active.get(spec.sessionId)?.pendingWorktreeRebind, requested.worktree.path,
      "the selection remains pending for an explicit recovery path");
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a never-prompted live session moves worktrees by launching a fresh conversation", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-fresh-worktree-rebind-"));
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
        pid: launchedCwds.length, initialize: async () => {}, newSession: async () => {}, close: async () => {},
        prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => {}, setConfig: () => {},
        resolvePermission: () => false, agentSessionId: () => null,
      };
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_fresh_rebind", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    const requested = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/fresh-rebind",
    });
    await waitForCondition(() => launchedCwds.length === 2, "fresh provider was not moved into the requested worktree");
    assert.deepEqual(launchedCwds, [repo, requested.worktree.path]);
    assert.equal(store.readMeta(spec.sessionId)?.agentSessionId, null);
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a root session with history but no provider id cannot rebind as a fresh conversation", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-unresumable-root-rebind-"));
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
        pid: launchedCwds.length, initialize: async () => {}, newSession: async () => {}, close: async () => {},
        prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => {}, setConfig: () => {},
        resolvePermission: () => false, agentSessionId: () => null,
      };
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_unresumable_root", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    assert.equal(manager.prompt(spec.sessionId, "first"), true);
    await waitForCondition(() => store.readMeta(spec.sessionId)?.status === "idle",
      "the root-cwd prompt did not settle");
    assert.ok((store.readMeta(spec.sessionId)?.seq ?? 0) > 0);
    assert.equal(store.readMeta(spec.sessionId)?.turnCount, 0,
      "root-cwd history intentionally has no worktree checkpoint count");

    await assert.rejects(manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/unresumable-root",
    }), /has not established a resumable conversation/);
    assert.deepEqual(launchedCwds, [repo], "history without a provider id must not relaunch fresh");
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unexpected replacement launch throw settles rebind and retires its client", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-throwing-launch-rebind-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const store = new SessionStore(join(dataDir, "sessions"));
    const sent: Array<{ type: string; payload?: { kind?: string; message?: string } }> = [];
    const launchedCwds: string[] = [];
    const disposedCwds: string[] = [];
    const prompts: Array<{ cwd: string; text: string }> = [];
    const factory = (_driver: unknown, launch: { cwd: string }) => {
      launchedCwds.push(launch.cwd);
      return {
        pid: launchedCwds.length, initialize: async () => {}, newSession: async () => {}, close: async () => {},
        prompt: async (text: string) => { prompts.push({ cwd: launch.cwd, text }); return "end_turn" as const; },
        cancel: () => {}, dispose: () => { disposedCwds.push(launch.cwd); }, setConfig: () => {},
        resolvePermission: () => false, agentSessionId: () => "provider-session-id",
      };
    };
    manager = new SessionManager((message) => sent.push(message as never), () => {}, store,
      "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_throwing_launch", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    const internals = manager as unknown as {
      active: Map<string, unknown>;
      worktreeRebindings: Map<string, unknown>;
      launch(meta: unknown, resumeId: string | undefined, generation: number): Promise<boolean>;
    };
    const originalLaunch = internals.launch.bind(manager);
    let throwAfterReplacement = true;
    internals.launch = async (meta, resumeId, generation) => {
      const launched = await originalLaunch(meta, resumeId, generation);
      if (launched && throwAfterReplacement) {
        throwAfterReplacement = false;
        throw new Error("unexpected launch completion failure");
      }
      return launched;
    };
    const requested = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/throwing-launch-rebind",
    });
    await waitForCondition(() => sent.some((message) => message.type === "session_event" &&
      message.payload?.kind === "error" && /could not resume/.test(message.payload.message ?? "")) &&
      !internals.worktreeRebindings.has(spec.sessionId),
    "the throwing replacement launch left rebind unsettled");
    assert.equal(internals.active.has(spec.sessionId), false,
      "the partially published replacement must be retired");
    assert.equal(disposedCwds.includes(requested.worktree.path), true);
    assert.equal(manager.prompt(spec.sessionId, "retry"), true);
    await waitForCondition(() => prompts.length === 1, "a later prompt did not resume after launch containment");
    assert.deepEqual(prompts, [{ cwd: requested.worktree.path, text: "retry" }]);
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider sign-out defers worktree rebind until credential mutation settles", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-logout-worktree-rebind-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  let releaseLogout = () => {};
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const store = new SessionStore(join(dataDir, "sessions"));
    const launchedCwds: string[] = [];
    let closeCalls = 0;
    let logoutStartedResolve!: () => void;
    const logoutStarted = new Promise<void>((resolve) => { logoutStartedResolve = resolve; });
    const logoutGate = new Promise<void>((resolve) => { releaseLogout = resolve; });
    const factory = (_driver: unknown, launch: { cwd: string }) => {
      const launchNumber = launchedCwds.push(launch.cwd);
      return {
        pid: launchNumber, initialize: async () => {}, newSession: async () => {},
        close: async () => { closeCalls += 1; },
        logout: async () => {
          if (launchNumber === 1) {
            logoutStartedResolve();
            await logoutGate;
          }
        },
        prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => {}, setConfig: () => {},
        resolvePermission: () => false, agentSessionId: () => "provider-session-id",
      };
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_logout_rebind", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    const logout = manager.logoutAgent(spec.sessionId);
    await logoutStarted;
    const requested = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/logout-rebind",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(launchedCwds, [repo], "sign-out must retain exclusive use of the live provider");
    assert.equal(closeCalls, 0, "the provider must not be retired while sign-out is pending");
    releaseLogout();
    assert.deepEqual(await logout, { ok: true });
    await waitForCondition(() => launchedCwds.length === 2, "deferred rebind did not resume after sign-out");
    assert.deepEqual(launchedCwds, [repo, requested.worktree.path]);
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
    releaseLogout();
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stop fences and cancels a worktree rebind while its old provider is closing", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-stop-worktree-rebind-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  let releaseClose = () => {};
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const store = new SessionStore(join(dataDir, "sessions"));
    const launchedCwds: string[] = [];
    let closeStartedResolve!: () => void;
    const closeStarted = new Promise<void>((resolve) => { closeStartedResolve = resolve; });
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const factory = (_driver: unknown, launch: { cwd: string }) => {
      launchedCwds.push(launch.cwd);
      return {
        pid: 1, initialize: async () => {}, newSession: async () => {},
        close: async () => { closeStartedResolve(); await closeGate; },
        prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => {}, setConfig: () => {},
        resolvePermission: () => false, agentSessionId: () => "provider-session-id",
      };
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_stop_rebind", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    const requested = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/stop-rebind",
    });
    await closeStarted;
    const internals = manager as unknown as {
      liveWorktreeUsesPath: (sessionId: string, path: string) => boolean;
      worktreeRebindings: Map<string, unknown>;
    };
    assert.equal(internals.liveWorktreeUsesPath(spec.sessionId, requested.worktree.path), true,
      "cleanup must treat the selected target as live during the provider handoff");
    const replacement = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/stop-rebind-replacement",
    });
    assert.equal(internals.liveWorktreeUsesPath(spec.sessionId, replacement.worktree.path), true,
      "cleanup must also fence a replacement selection made during the provider handoff");
    assert.equal(manager.fenceRewind(spec.sessionId), false,
      "rewind must not enter while the selected-worktree provider handoff is in progress");
    manager.stop(spec.sessionId);
    assert.equal(manager.prompt(spec.sessionId, "raced prompt"), false,
      "a prompt cannot bypass the invalidated rebind generation while its provider is retiring");
    assert.deepEqual(launchedCwds, [repo]);
    releaseClose();
    await waitForCondition(() => !internals.worktreeRebindings.has(spec.sessionId), "stopped rebind did not settle");
    assert.deepEqual(launchedCwds, [repo], "stop must prevent the retiring generation from resurrecting a provider");
    assert.equal(store.readMeta(spec.sessionId)?.status, "stopped");
    await manager.delete(spec.sessionId);
  } finally {
    releaseClose();
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a selection made during replacement launch is fenced and receives a follow-up rebind", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-overlap-worktree-rebind-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  let releaseClose = () => {};
  let releaseLaunch = () => {};
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const store = new SessionStore(join(dataDir, "sessions"));
    const launchedCwds: string[] = [];
    let closeStartedResolve!: () => void;
    const closeStarted = new Promise<void>((resolve) => { closeStartedResolve = resolve; });
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    let launchStartedResolve!: () => void;
    const launchStarted = new Promise<void>((resolve) => { launchStartedResolve = resolve; });
    const launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
    let launches = 0;
    const factory = (_driver: unknown, launch: { cwd: string }) => {
      const launchNumber = ++launches;
      launchedCwds.push(launch.cwd);
      return {
        pid: launchNumber,
        initialize: async () => {
          if (launchNumber === 2) {
            launchStartedResolve();
            await launchGate;
          }
        },
        newSession: async () => {},
        close: async () => {
          if (launchNumber === 1) {
            closeStartedResolve();
            await closeGate;
          }
        },
        prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => {}, setConfig: () => {},
        resolvePermission: () => false, agentSessionId: () => "provider-session-id",
      };
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_overlap_rebind", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    await manager.requestWorktree(spec.sessionId, { baseRef: "HEAD", branch: "fix/overlap-first" });
    await closeStarted;
    const launching = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/overlap-launching",
    });
    releaseClose();
    await launchStarted;
    const latest = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/overlap-latest",
    });
    await assert.rejects(manager.discardWorktree(spec.sessionId, launching.worktree.path),
      /still active in a provider process/,
      "cleanup must fence the target already captured by an in-flight launch");
    const internals = manager as unknown as {
      active: Map<string, {
        governanceTripped?: "cost_budget" | "max_tool_calls";
        pendingWorktreeRebind?: string;
      }>;
      liveWorktreeUsesPath: (sessionId: string, path: string) => boolean;
    };
    releaseLaunch();
    for (let attempt = 0; attempt < 500 &&
        internals.active.get(spec.sessionId)?.pendingWorktreeRebind !== latest.worktree.path; attempt++) {
      await Promise.resolve();
    }
    const rebound = internals.active.get(spec.sessionId);
    assert.equal(rebound?.pendingWorktreeRebind, latest.worktree.path);
    rebound!.governanceTripped = "max_tool_calls";
    store.patchMeta(spec.sessionId, { status: "idle", worktreePending: false });
    assert.equal(internals.liveWorktreeUsesPath(spec.sessionId, latest.worktree.path), true,
      "the pending target itself must remain fenced after launch status settles");
    await assert.rejects(manager.discardWorktree(spec.sessionId, latest.worktree.path),
      /still active in a provider process/,
      "cleanup must fence the newest target while its follow-up rebind is deferred");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(launchedCwds, [repo, launching.worktree.path],
      "the governance boundary must defer the follow-up handoff");
    manager.rearmGovernance(spec.sessionId, { maxToolCalls: 2 });
    await waitForCondition(() => launchedCwds.length === 3, "latest selection did not trigger a follow-up rebind");
    assert.deepEqual(launchedCwds, [repo, launching.worktree.path, latest.worktree.path]);
    assert.equal(store.readMeta(spec.sessionId)?.worktreePath, latest.worktree.path);
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
    releaseClose();
    releaseLaunch();
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a queued prompt follows a newer selection made during rebind launch preparation", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-prelaunch-selection-rebind-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  let releasePreparation = () => {};
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const store = new SessionStore(join(dataDir, "sessions"));
    const launchedCwds: string[] = [];
    const prompts: Array<{ cwd: string; text: string }> = [];
    const factory = (_driver: unknown, launch: { cwd: string }) => {
      launchedCwds.push(launch.cwd);
      return {
        pid: launchedCwds.length, initialize: async () => {}, newSession: async () => {}, close: async () => {},
        prompt: async (text: string) => { prompts.push({ cwd: launch.cwd, text }); return "end_turn" as const; },
        cancel: () => {}, dispose: () => {}, setConfig: () => {}, resolvePermission: () => false,
        agentSessionId: () => "provider-session-id",
      };
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_prelaunch_selection", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    let preparationStartedResolve!: () => void;
    const preparationStarted = new Promise<void>((resolve) => { preparationStartedResolve = resolve; });
    const preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
    let preparationCalls = 0;
    (manager as unknown as {
      prepareLaunch?: () => Promise<void>;
    }).prepareLaunch = async () => {
      if (++preparationCalls === 1) {
        preparationStartedResolve();
        await preparationGate;
      }
    };

    const launching = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/prelaunch-selection-first",
    });
    await preparationStarted;
    assert.equal(manager.prompt(spec.sessionId, "queued for newest worktree"), true);
    const latest = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/prelaunch-selection-latest",
    });
    releasePreparation();

    await waitForCondition(() => prompts.length === 1 && store.readMeta(spec.sessionId)?.status === "idle",
      "queued prompt remained stalled after follow-up rebind");
    assert.deepEqual(launchedCwds, [repo, launching.worktree.path, latest.worktree.path]);
    assert.deepEqual(prompts, [{ cwd: latest.worktree.path, text: "queued for newest worktree" }]);
    assert.equal(store.readMeta(spec.sessionId)?.status, "idle");
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
    releasePreparation();
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a sibling runner lock prevents rebind from retiring the live provider", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-locked-worktree-rebind-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const store = new SessionStore(join(dataDir, "sessions"));
    const siblingStore = new SessionStore(join(dataDir, "sessions"));
    const sent: Array<{ type: string; payload?: { kind?: string; message?: string } }> = [];
    const launchedCwds: string[] = [];
    const prompts: Array<{ cwd: string; text: string }> = [];
    let closeCalls = 0;
    const factory = (_driver: unknown, launch: { cwd: string }) => {
      launchedCwds.push(launch.cwd);
      return {
        pid: launchedCwds.length, initialize: async () => {}, newSession: async () => {},
        close: async () => { closeCalls += 1; },
        prompt: async (text: string) => { prompts.push({ cwd: launch.cwd, text }); return "end_turn" as const; },
        cancel: () => {}, dispose: () => {}, setConfig: () => {}, resolvePermission: () => false,
        agentSessionId: () => "provider-session-id",
      };
    };
    manager = new SessionManager((message) => sent.push(message as never), () => {}, store,
      "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_locked_rebind", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    assert.equal(siblingStore.acquireLock(spec.sessionId, "sibling-runner"), true);
    const requested = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/locked-rebind",
    });
    await waitForCondition(() => sent.some((message) =>
      message.type === "session_event" && message.payload?.kind === "error" &&
      /another dashboard/.test(message.payload.message ?? "")), "rebind did not report sibling lock ownership");
    assert.equal(closeCalls, 0, "lock refusal must happen before retiring the live provider");
    assert.deepEqual(launchedCwds, [repo]);

    siblingStore.releaseLock(spec.sessionId, "sibling-runner");
    assert.equal(manager.prompt(spec.sessionId, "retry after lock release"), true);
    await waitForCondition(() => prompts.length === 1, "released sibling lock did not allow deferred rebind");
    assert.deepEqual(launchedCwds, [repo, requested.worktree.path]);
    assert.deepEqual(prompts, [{ cwd: requested.worktree.path, text: "retry after lock release" }]);
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a throwing provider dispose fences rebind admission until the exact client exits", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-dispose-worktree-rebind-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const store = new SessionStore(join(dataDir, "sessions"));
    const sent: Array<{ type: string; payload?: { kind?: string; message?: string } }> = [];
    const launchedCwds: string[] = [];
    const prompts: string[] = [];
    let closeStartedResolve!: () => void;
    const closeStarted = new Promise<void>((resolve) => { closeStartedResolve = resolve; });
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    let disposeAttemptedResolve!: () => void;
    const disposeAttempted = new Promise<void>((resolve) => { disposeAttemptedResolve = resolve; });
    let reportFirstExit!: (code: number | null) => void;
    let firstClient: unknown;
    let launches = 0;
    const factory = (
      _driver: unknown,
      launch: { cwd: string },
      callbacks: { onExit(code: number | null): void },
    ) => {
      const launchNumber = ++launches;
      launchedCwds.push(launch.cwd);
      const client = {
        pid: launchNumber, initialize: async () => {}, newSession: async () => {},
        close: async () => {
          if (launchNumber === 1) {
            closeStartedResolve();
            await closeGate;
          }
        },
        prompt: async (text: string) => { prompts.push(text); return "end_turn" as const; },
        cancel: () => {},
        dispose: () => {
          if (launchNumber === 1) {
            disposeAttemptedResolve();
            throw new Error("dispose failed");
          }
        },
        setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => "provider-session-id",
      };
      if (launchNumber === 1) {
        reportFirstExit = callbacks.onExit;
        firstClient = client;
      }
      return client;
    };
    manager = new SessionManager((message) => sent.push(message as never), () => {}, store,
      "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_dispose_rebind", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    const requested = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/dispose-rebind",
    });
    const internals = manager as unknown as {
      admitted: Set<string>;
      launchGenerations: Map<string, number>;
      preLaunchAdmissionGenerations: Map<string, number>;
      worktreeRebindings: Map<string, unknown>;
      closing: Map<string, { client: unknown }>;
    };
    await closeStarted;
    manager.stop(spec.sessionId);
    releaseClose();
    await disposeAttempted;
    await waitForCondition(() => !internals.worktreeRebindings.has(spec.sessionId),
      "failed provider disposal did not settle the rebind");
    assert.equal(sent.some((message) => message.type === "session_event" &&
      message.payload?.kind === "error" && /could not switch/.test(message.payload.message ?? "")), true,
    "provider disposal failure must be visible to the session");
    assert.equal(internals.launchGenerations.has(spec.sessionId), false);
    assert.equal(internals.preLaunchAdmissionGenerations.has(spec.sessionId), false);
    assert.equal(internals.closing.get(spec.sessionId)?.client, firstClient);
    assert.equal(internals.admitted.has(spec.sessionId), true,
      "a failed disposal must retain admission until exact exit proof");
    assert.equal(store.readMeta(spec.sessionId)?.status, "stopped",
      "rebind cleanup must not overwrite a concurrent stop with idle");
    assert.equal(manager.prompt(spec.sessionId, "before exit proof"), false,
      "a replacement must remain fenced while the retired provider may still be alive");
    reportFirstExit(1);
    assert.equal(internals.closing.has(spec.sessionId), false);
    assert.equal(internals.admitted.has(spec.sessionId), false);
    assert.equal(manager.prompt(spec.sessionId, "after failure"), true);
    await waitForCondition(() => prompts.length === 1, "a later prompt remained stranded after disposal failure");
    assert.deepEqual(launchedCwds, [repo, requested.worktree.path]);
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("delete does not wait forever for a disposed replacement whose initialization never settles", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-hung-launch-delete-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const store = new SessionStore(join(dataDir, "sessions"));
    let launchNumber = 0;
    let replacementInitializeResolve!: () => void;
    const replacementInitializeStarted = new Promise<void>((resolve) => {
      replacementInitializeResolve = resolve;
    });
    const never = new Promise<void>(() => {});
    let replacementDisposed = false;
    const factory = () => {
      const currentLaunch = ++launchNumber;
      return {
        pid: currentLaunch,
        initialize: async () => {
          if (currentLaunch === 2) {
            replacementInitializeResolve();
            await never;
          }
        },
        newSession: async () => {}, close: async () => {}, prompt: async () => "end_turn" as const,
        cancel: () => {}, dispose: () => { if (currentLaunch === 2) replacementDisposed = true; },
        setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => "provider-session-id",
      };
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_hung_rebind_delete", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    const requested = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/hung-rebind-delete",
    });
    await replacementInitializeStarted;
    const internals = manager as unknown as { worktreeRebindings: Map<string, unknown> };
    await Promise.race([
      manager.delete(spec.sessionId),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("delete remained blocked")), 1_000)),
    ]);
    assert.equal(replacementDisposed, true);
    assert.equal(internals.worktreeRebindings.has(spec.sessionId), false,
      "deletion must release a rebind whose disposed replacement never settles");
    assert.equal(store.has(spec.sessionId), false);
    assert.equal(existsSync(requested.worktree.path), false);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("delete waits for a rebinding provider before removing its selected worktree", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-delete-worktree-rebind-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  let releaseClose = () => {};
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const store = new SessionStore(join(dataDir, "sessions"));
    let closeStartedResolve!: () => void;
    const closeStarted = new Promise<void>((resolve) => { closeStartedResolve = resolve; });
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const factory = () => ({
      pid: 1, initialize: async () => {}, newSession: async () => {},
      close: async () => { closeStartedResolve(); await closeGate; },
      prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => {}, setConfig: () => {},
      resolvePermission: () => false, agentSessionId: () => "provider-session-id",
    });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_delete_rebind", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    const requested = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/delete-rebind",
    });
    await closeStarted;
    let deletionSettled = false;
    const deletion = manager.delete(spec.sessionId).finally(() => { deletionSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(store.isDeleted(spec.sessionId), true, "delete must fail closed to new callers immediately");
    assert.equal(store.has(spec.sessionId), true,
      "the tombstoned row retains cleanup provenance until the retiring provider settles");
    assert.equal(deletionSettled, false, "delete must still be waiting for the retiring provider");
    assert.equal(existsSync(requested.worktree.path), true,
      "the provider's selected worktree must survive until its close settles");
    releaseClose();
    await deletion;
    assert.equal(existsSync(requested.worktree.path), false);
  } finally {
    releaseClose();
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart waits for a worktree rebind and preserves prompts queued for the replacement", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-restart-worktree-rebind-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  let releaseClose = () => {};
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const store = new SessionStore(join(dataDir, "sessions"));
    const launchedCwds: string[] = [];
    const prompts: Array<{ cwd: string; text: string }> = [];
    let closeStartedResolve!: () => void;
    const closeStarted = new Promise<void>((resolve) => { closeStartedResolve = resolve; });
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    let launches = 0;
    const factory = (_driver: unknown, launch: { cwd: string }) => {
      const launchNumber = ++launches;
      launchedCwds.push(launch.cwd);
      return {
        pid: launchNumber, initialize: async () => {}, newSession: async () => {},
        close: async () => {
          if (launchNumber === 1) { closeStartedResolve(); await closeGate; }
        },
        prompt: async (text: string) => { prompts.push({ cwd: launch.cwd, text }); return "end_turn" as const; },
        cancel: () => {}, dispose: () => {}, setConfig: () => {}, resolvePermission: () => false,
        agentSessionId: () => "provider-session-id",
      };
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_restart_rebind", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    const requested = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/restart-rebind",
    });
    await closeStarted;
    const restarted = manager.start(spec);
    manager.prompt(spec.sessionId, "replacement prompt");
    releaseClose();
    assert.equal(await restarted, true);
    await waitForCondition(() => prompts.length === 1, "replacement prompt did not leave the pre-launch queue");
    assert.deepEqual(launchedCwds, [repo, requested.worktree.path],
      "the replacement must wait until the retiring provider is closed");
    assert.deepEqual(prompts, [{ cwd: requested.worktree.path, text: "replacement prompt" }]);
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
    releaseClose();
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

test("the repository default branch is read from the tracked remote HEAD, never the network", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-default-branch-"));
  const origin = join(root, "origin");
  const clone = join(root, "clone");
  try {
    // A repository whose default is deliberately NOT `main` or `master`: the exact case the name
    // heuristic in the web client gets wrong (#679).
    execFileSync("git", ["init", "--bare", "--initial-branch=develop", origin]);
    const seed = join(root, "seed");
    execFileSync("git", ["init", "--initial-branch=develop", seed]);
    execFileSync("git", ["-C", seed, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", seed, "config", "user.name", "Test"]);
    writeFileSync(join(seed, "state.txt"), "base\n");
    execFileSync("git", ["-C", seed, "add", "state.txt"]);
    execFileSync("git", ["-C", seed, "commit", "-m", "base"]);
    execFileSync("git", ["-C", seed, "remote", "add", "origin", origin]);
    execFileSync("git", ["-C", seed, "push", "origin", "develop"]);
    execFileSync("git", ["clone", origin, clone]);

    // `git clone` records the remote HEAD, so the read is a local ref lookup with no round trip.
    assert.equal(await readRepositoryDefaultBranch(clone), "develop");

    // With the remote HEAD removed the repository has no locally known default, and the caller
    // must get `undefined` rather than a guess it would then present as fact.
    execFileSync("git", ["-C", clone, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
    assert.equal(await readRepositoryDefaultBranch(clone), undefined);

    // A repository that was never cloned has no remote HEAD either, and must not throw.
    assert.equal(await readRepositoryDefaultBranch(seed), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a default branch whose tracking ref is gone reads as unknown, not as a name", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-dangling-head-"));
  const origin = join(root, "origin.git");
  const clone = join(root, "clone");
  try {
    execFileSync("git", ["init", "--bare", "--initial-branch=develop", origin]);
    const seed = join(root, "seed");
    execFileSync("git", ["init", "--initial-branch=develop", seed]);
    execFileSync("git", ["-C", seed, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", seed, "config", "user.name", "Test"]);
    writeFileSync(join(seed, "state.txt"), "base\n");
    execFileSync("git", ["-C", seed, "add", "state.txt"]);
    execFileSync("git", ["-C", seed, "commit", "-m", "base"]);
    execFileSync("git", ["-C", seed, "remote", "add", "origin", origin]);
    execFileSync("git", ["-C", seed, "push", "origin", "develop"]);
    execFileSync("git", ["clone", origin, clone]);
    assert.equal(await readRepositoryDefaultBranch(clone), "develop");

    // The symbolic ref outlives the branch it names. Reporting `develop` here would have the Inbox
    // hide a base ref on the strength of a tracking ref that no longer exists.
    execFileSync("git", ["-C", clone, "update-ref", "-d", "refs/remotes/origin/develop"]);
    assert.equal(await readRepositoryDefaultBranch(clone), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a remote that moves its default is not tracked by fetch, so the advertised branch wins", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-stale-head-"));
  const origin = join(root, "origin.git");
  const clone = join(root, "clone");
  try {
    execFileSync("git", ["init", "--bare", "--initial-branch=release-2027", origin]);
    const seed = join(root, "seed");
    execFileSync("git", ["init", "--initial-branch=release-2027", seed]);
    execFileSync("git", ["-C", seed, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", seed, "config", "user.name", "Test"]);
    writeFileSync(join(seed, "state.txt"), "base\n");
    execFileSync("git", ["-C", seed, "add", "state.txt"]);
    execFileSync("git", ["-C", seed, "commit", "-m", "base"]);
    execFileSync("git", ["-C", seed, "remote", "add", "origin", origin]);
    execFileSync("git", ["-C", seed, "push", "origin", "release-2027"]);
    execFileSync("git", ["-C", seed, "branch", "develop"]);
    execFileSync("git", ["-C", seed, "push", "origin", "develop"]);
    execFileSync("git", ["clone", origin, clone]);
    execFileSync("git", ["-C", origin, "symbolic-ref", "HEAD", "refs/heads/develop"]);
    execFileSync("git", ["-C", clone, "fetch", "--all"]);

    // This is the whole reason the create path prefers what the remote advertises: a plain fetch
    // leaves the tracked HEAD on the old default indefinitely.
    assert.equal(await readRepositoryDefaultBranch(clone), "release-2027");
    const advertised = await fetchRemoteDefaultBase(clone);
    assert.equal(advertised.branch, "develop");
    assert.equal(advertised.ref, "origin/develop");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
