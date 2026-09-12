import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { attachRequestedWorktree, createRequestedWorktree, createWorktree, discardWorktreeIfSafe, isLegacyWslSessionWorktreePath, fetchRemoteDefaultBase, isGitRepo, mergedWorktreePullRequestForBranch, nativeRepositoryPathIsUnavailable, parseMergedWorktreePullRequestForBranch, parseWorktreePullRequestState, readRepositoryDefaultBranch, removeWorktree, requestedWorktreeBoundary, resolveWorktreeRoot, reuseRegisteredLegacyWslWorktree, sessionWorktreeBranch, setStatfsForTests, WorktreeCleanupJournal } from "./worktree.js";
import { createHash, randomUUID } from "node:crypto";
import { runContextCommand } from "./context-command.js";
import { SessionStore } from "./session-store.js";
import { SessionManager } from "./session-manager.js";
import { anchorTurnRef, captureWorktreeTree, setGitRunnerForTests, type GitRunOpts } from "./git-ops.js";

function haveGit(): boolean {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

async function waitForCondition(predicate: () => boolean, message: string, attempts = 500): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
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

test("change-request lifecycle parsing requires an exact forge URL and terminal vocabulary", () => {
  const url = "https://github.com/picoduck/wollipog/pull/701";
  const githubHead = "A".repeat(40);
  assert.deepEqual(parseWorktreePullRequestState(JSON.stringify({ url, state: "OPEN", headRefOid: githubHead }), url),
    { state: "open", headOid: githubHead.toLowerCase() });
  assert.deepEqual(parseWorktreePullRequestState(JSON.stringify({ url, state: "MERGED", headRefOid: githubHead }), url),
    { state: "merged", headOid: githubHead.toLowerCase() });
  assert.deepEqual(parseWorktreePullRequestState(JSON.stringify({ url, state: "CLOSED", headRefOid: githubHead }), url),
    { state: "closed", headOid: githubHead.toLowerCase() });
  assert.equal(parseWorktreePullRequestState(JSON.stringify({ url, state: "UNKNOWN", headRefOid: githubHead }), url), null);
  assert.equal(parseWorktreePullRequestState(JSON.stringify({ url: `${url}/files`, state: "MERGED", headRefOid: githubHead }), url), null);
  assert.equal(parseWorktreePullRequestState(JSON.stringify({ url, state: "MERGED", headRefOid: githubHead }), "javascript:alert(1)"), null);
  assert.deepEqual(parseWorktreePullRequestState(JSON.stringify({ url, state: "MERGED" }), url),
    { state: "merged" }, "lifecycle proof remains usable without deletion proof");
  assert.deepEqual(parseWorktreePullRequestState(JSON.stringify({ url, state: "MERGED", headRefOid: "not-an-oid" }), url),
    { state: "merged" }, "a malformed OID is never exposed as deletion proof");
  assert.equal(parseWorktreePullRequestState("not json", url), null);

  const gitlab = "https://gitlab.example.test/team/sub/repo/-/merge_requests/19";
  const gitlabHead = "b".repeat(64);
  assert.deepEqual(parseWorktreePullRequestState(JSON.stringify({ web_url: gitlab, state: "opened", sha: gitlabHead }), gitlab),
    { state: "open", headOid: gitlabHead });
  assert.deepEqual(parseWorktreePullRequestState(JSON.stringify({ web_url: gitlab, state: "merged", sha: gitlabHead }), gitlab),
    { state: "merged", headOid: gitlabHead });
  assert.deepEqual(parseWorktreePullRequestState(JSON.stringify({ web_url: gitlab, state: "closed", sha: gitlabHead }), gitlab),
    { state: "closed", headOid: gitlabHead });
  assert.equal(parseWorktreePullRequestState(JSON.stringify({ web_url: `${gitlab}.evil.test`, state: "merged", sha: gitlabHead }), gitlab), null);
  assert.equal(parseWorktreePullRequestState(JSON.stringify({ web_url: gitlab, state: "merged", sha: gitlabHead }),
    "https://token@gitlab.example.test/team/sub/repo/-/merge_requests/19"), null);
});

test("merged branch discovery requires the exact branch and head", () => {
  const branch = "fix/external-pr";
  const head = "a".repeat(40);
  const exact = { url: "https://github.com/picoduck/wollipog/pull/983", state: "MERGED", headRefOid: head.toUpperCase(), headRefName: branch };
  assert.deepEqual(parseMergedWorktreePullRequestForBranch(JSON.stringify([exact]), branch, head), {
    url: exact.url,
    state: "merged",
    headOid: head,
    provider: "github",
    kind: "pull_request",
  });
  assert.equal(parseMergedWorktreePullRequestForBranch(JSON.stringify([{ ...exact, state: "CLOSED" }]), branch, head), null);
  assert.equal(parseMergedWorktreePullRequestForBranch(JSON.stringify([{ ...exact, headRefName: "fix/other" }]), branch, head), null);
  assert.equal(parseMergedWorktreePullRequestForBranch(JSON.stringify([{ ...exact, headRefOid: "b".repeat(40) }]), branch, head), null);
  assert.equal(parseMergedWorktreePullRequestForBranch(JSON.stringify([{ ...exact, url: "https://example.test/pull/983" }]), branch, head), null);
  assert.equal(parseMergedWorktreePullRequestForBranch("{}", branch, head), null);
});

test("missing-upstream discovery exercises every production Git gate before the forge", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-missing-upstream-discovery-"));
  try {
    const { repo } = initRepoWithOrigin(root);
    const branch = "fix/git-backed-discovery";
    execFileSync("git", ["-C", repo, "switch", "-c", branch]);
    let forgeOutput: string | Error = "[]";
    const forgeCalls: Array<{ command: string; args: string[]; timeoutMs?: number }> = [];
    const runForgeCommand: typeof runContextCommand = async (_context, command, args, options) => {
      forgeCalls.push({ command, args, timeoutMs: options.timeoutMs });
      if (forgeOutput instanceof Error) throw forgeOutput;
      return { stdout: forgeOutput, stderr: "" };
    };
    const discover = (options: Parameters<typeof mergedWorktreePullRequestForBranch>[2] = {}) =>
      mergedWorktreePullRequestForBranch(repo, branch, { ...options, runForgeCommand });

    let ineligible = 0;
    assert.equal(await discover({ onIneligible: () => { ineligible++; } }), null,
      "a never-pushed branch is ineligible");
    assert.equal(ineligible, 1, "missing branch configuration is an authoritative ineligible state");
    assert.equal(forgeCalls.length, 0);

    execFileSync("git", ["-C", repo, "push", "-u", "origin", branch]);
    assert.equal(await discover(), null, "a live upstream is ineligible");
    assert.equal(forgeCalls.length, 0);

    execFileSync("git", ["-C", repo, "push", "origin", "--delete", branch]);
    const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const exact = {
      url: "https://github.com/picoduck/wollipog/pull/1020",
      state: "MERGED",
      headRefOid: head,
      headRefName: branch,
    };
    forgeOutput = JSON.stringify([exact]);
    assert.deepEqual(await discover(), {
      url: exact.url,
      state: "merged",
      headOid: head,
      provider: "github",
      kind: "pull_request",
    });
    assert.equal(forgeCalls.length, 1);
    assert.equal(forgeCalls[0]?.command, "gh");
    assert.deepEqual(forgeCalls[0]?.args, [
      "pr", "list", "--head", branch, "--state", "merged", "--limit", "100",
      "--json", "url,state,headRefOid,headRefName",
    ]);
    assert.equal(forgeCalls[0]?.timeoutMs, 30_000, "a stuck forge has a fixed deadline");

    assert.equal(await discover({ onForgeAttempt: () => false }), null,
      "the reconciliation governor can stop before spawning the forge");
    assert.equal(forgeCalls.length, 1);

    for (const rejected of [
      [{ ...exact, headRefName: "fix/other" }],
      [{ ...exact, headRefOid: "b".repeat(40) }],
      [{ ...exact, state: "CLOSED" }],
      { malformed: true },
    ]) {
      forgeOutput = JSON.stringify(rejected);
      assert.equal(await discover(), null);
    }
    forgeOutput = new Error("forge unavailable");
    let forgeUnavailable = 0;
    assert.equal(await discover({ onForgeUnavailable: () => { forgeUnavailable++; } }), null,
      "command failure is fail-closed");
    assert.equal(forgeUnavailable, 1, "transport failure is distinguishable from an empty result");

    const callsBeforeLocalRemote = forgeCalls.length;
    execFileSync("git", ["-C", repo, "config", `branch.${branch}.remote`, "."]);
    assert.equal(await discover(), null, "a local remote is ineligible");
    assert.equal(forgeCalls.length, callsBeforeLocalRemote);
    execFileSync("git", ["-C", repo, "config", `branch.${branch}.remote`, "origin"]);
    execFileSync("git", ["-C", repo, "config", `branch.${branch}.merge`, "refs/heads/fix/other"]);
    assert.equal(await discover(), null, "a differently named merge ref is ineligible");
    assert.equal(forgeCalls.length, callsBeforeLocalRemote);

    let transientGitFailureReportedIneligible = 0;
    assert.equal(await mergedWorktreePullRequestForBranch(join(repo, "missing"), branch, {
      runForgeCommand,
      onIneligible: () => { transientGitFailureReportedIneligible++; },
    }), null, "a failed Git preflight is fail-closed");
    assert.equal(transientGitFailureReportedIneligible, 0,
      "Git execution failure does not invalidate an authoritative negative cache");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

    const phases: string[] = [];
    const handle = await createRequestedWorktree(repo, "s_requested", {
      baseRef: "refs-for-agent",
      branch: "fix/issue-42-short-slug",
    }, { dataDir, onProgress: (phase) => phases.push(phase) });
    assert.equal(phases[0], "validating");
    assert.equal(phases.at(-1), "materializing");
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

    const mismatchedMerged = await createRequestedWorktree(repo, "s_safe", {
      baseRef: "HEAD",
      branch: "fix/mismatched-merged-head",
    }, { dataDir });
    assert.deepEqual(await discardWorktreeIfSafe(repo, "s_safe", {
      ...mismatchedMerged,
      source: "created",
    }, { dataDir, verifiedMergedHead: "0".repeat(40) }), { removed: false, reason: "unpushed" });
    assert.equal(existsSync(mismatchedMerged.path), true,
      "a merge proof for any other commit cannot authorize cleanup");
    assert.deepEqual(await discardWorktreeIfSafe(repo, "s_safe", {
      ...mismatchedMerged,
      source: "created",
    }, { dataDir, verifiedMergedHead: "not-an-oid" }), { removed: false, reason: "no_upstream" });

    const verifiedMerged = await createRequestedWorktree(repo, "s_safe", {
      baseRef: "HEAD",
      branch: "fix/verified-merged-head",
    }, { dataDir });
    const verifiedMergedHead = execFileSync("git", ["-C", verifiedMerged.path, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    assert.deepEqual(await discardWorktreeIfSafe(repo, "s_safe", {
      ...verifiedMerged,
      source: "created",
    }, { dataDir, verifiedMergedHead }), { removed: true });
    assert.equal(existsSync(verifiedMerged.path), false,
      "the exact forge-verified merged head replaces only the missing upstream proof");

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

test("existing worktree attach requires Git registration by a configured Location's repository", { skip: !haveGit() }, async () => {
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
    // The repository is NOT inside the one configured Location here, and neither is `outside`, so
    // nothing ties that path to a configured project.
    await assert.rejects(
      attachRequestedWorktree(repo, "s_attach", outside, { dataDir, allowedProjectPaths: [allowed] }),
      /matched none of the runner's configured Project Locations/,
    );
    const unregistered = join(allowed, "not-registered");
    await assert.rejects(
      attachRequestedWorktree(repo, "s_attach", unregistered, { dataDir, allowedProjectPaths: [allowed] }),
      /not registered by the repository it was matched against/,
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

test("attach accepts a worktree the configured Location's repository registers outside every Location", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-attach-external-wt-"));
  const repo = join(root, "repo");
  const other = join(root, "other-repo");
  const dataDir = join(root, "data");
  // The issue-workflow skill's fallback layout: beside the repository, inside no Project Location.
  const beside = join(root, "repo-worktrees", "example");
  const detached = join(root, "repo-worktrees", "detached");
  const foreign = join(root, "other-repo-worktrees", "example");
  try {
    for (const path of [repo, other]) {
      execFileSync("git", ["init", path]);
      execFileSync("git", ["-C", path, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", path, "config", "user.name", "Test"]);
      execFileSync("git", ["-C", path, "commit", "--allow-empty", "-m", "base"]);
    }
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "fix/example", beside]);
    execFileSync("git", ["-C", repo, "worktree", "add", "--detach", detached]);
    execFileSync("git", ["-C", other, "worktree", "add", "-b", "fix/foreign", foreign]);
    const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    // The repository IS the only configured Project Location; its worktree is not inside one.
    const attached = await attachRequestedWorktree(repo, "s_external", beside, {
      dataDir,
      allowedProjectPaths: [repo],
    });
    assert.equal(attached.path, beside);
    assert.equal(attached.branch, "fix/example");
    assert.equal(attached.baseCommit, head);
    assert.equal(attached.attached, true);

    await assert.rejects(
      attachRequestedWorktree(repo, "s_external", detached, { dataDir, allowedProjectPaths: [repo] }),
      /detached worktree cannot be attached/,
    );
    await assert.rejects(
      attachRequestedWorktree(repo, "s_external", repo, { dataDir, allowedProjectPaths: [repo] }),
      /primary workspace cannot be attached/,
    );
    // Registration is what ties a path to a project, so a second configured repository's worktree
    // stays out of reach: this session's repository does not register it.
    const foreignRefusal = await attachRequestedWorktree(repo, "s_external", foreign, {
      dataDir,
      allowedProjectPaths: [repo, other],
    }).then(() => undefined, (error: Error) => error.message);
    assert.match(foreignRefusal ?? "", /not registered by the repository it was matched against/);
    assert.ok(foreignRefusal?.includes("repo"), `refusal names the repository: ${foreignRefusal}`);

    const absentRefusal = await attachRequestedWorktree(repo, "s_external", join(root, "repo-worktrees", "absent"), {
      dataDir,
      allowedProjectPaths: [repo],
    }).then(() => undefined, (error: Error) => error.message);
    assert.match(absentRefusal ?? "", /not registered by the repository it was matched against \(/);

    // With no Project Location covering the repository, the refusal says so rather than implying
    // the worktree itself is the problem.
    const unconfigured = await attachRequestedWorktree(repo, "s_external", beside, {
      dataDir,
      allowedProjectPaths: [],
    }).then(() => undefined, (error: Error) => error.message);
    assert.match(unconfigured ?? "", /matched none of the runner's configured Project Locations/);
    assert.ok(unconfigured?.includes("repo"), `refusal names the repository: ${unconfigured}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attach refuses a registered path whose tree is now a different repository", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-attach-foreign-tree-"));
  const repo = join(root, "repo");
  const other = join(root, "other-repo");
  const dataDir = join(root, "data");
  const beside = join(root, "repo-worktrees", "example");
  try {
    for (const path of [repo, other]) {
      execFileSync("git", ["init", path]);
      execFileSync("git", ["-C", path, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", path, "config", "user.name", "Test"]);
      execFileSync("git", ["-C", path, "commit", "--allow-empty", "-m", "base"]);
    }
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "fix/example", beside]);

    // The registration in `repo` outlives the directory it names. Git keeps reporting the path with
    // the branch and head it recorded, and a work-tree health check at that path still passes —
    // because a DIFFERENT repository is there now. Accepting it would hand the session a repository
    // its own never registered, and bind it writable at the next launch.
    rmSync(beside, { recursive: true, force: true });
    symlinkSync(other, beside);
    assert.match(
      execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" }),
      /fix\/example/,
      "the stale registration is still advertised by the repository",
    );

    const refusal = await attachRequestedWorktree(repo, "s_foreign_tree", beside, {
      dataDir,
      allowedProjectPaths: [repo],
    }).then(() => undefined, (error: Error) => error.message);
    assert.match(refusal ?? "", /belongs to a different repository than the session/);
  } finally {
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

test("a session attaches a worktree beside its repository and states the isolation boundary", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-external-wt-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  // The reproduction from the issue: the repository is the only configured Project Location and
  // the worktree lives beside it, in no Location at all.
  const beside = join(root, "repo-worktrees", "example");
  let manager: SessionManager | undefined;
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "fix/example", beside]);
    const store = new SessionStore(join(dataDir, "sessions"));
    store.create({
      sessionId: "s_ext", agentId: "claude", workspaceId: "repo", repoPath: repo,
      worktreePath: null, driver: "claude-code", command: "claude", args: [], env: {},
      context: { kind: "native" }, agentSessionId: null, status: "idle", title: "external",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: 0, createdAt: 1, updatedAt: 1,
    });
    manager = new SessionManager(
      () => {}, () => {}, store, "runner", undefined, undefined, dataDir, 1,
      undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "bwrap", network: "deny" },
    );
    const internals = manager as unknown as {
      configuredProjectPaths: string[];
      active: Map<string, {
        sessionId: string;
        cwd: string;
        context: { kind: "native" | "wsl" };
        seatbeltWritableRoots?: string[];
      }>;
      executionIsolation: { mode: string; network: string };
      attachIsolationNotice(meta: unknown, path: string): Promise<unknown>;
      requestedWorktreeIsolation(meta: unknown): Promise<string[]>;
    };
    internals.configuredProjectPaths = [repo];

    const attached = await manager.attachWorktree("s_ext", beside);
    assert.equal(attached.worktree.path, beside);
    assert.equal(attached.worktree.branch, "fix/example");
    assert.equal(attached.worktree.source, "attached");
    assert.equal(attached.snapshot.worktreePath, beside);
    assert.equal(attached.snapshot.useWorktree, true);
    const listed = attached.snapshot.worktrees?.find((item) => item.path === beside);
    assert.equal(listed?.branch, "fix/example");
    assert.equal(listed?.source, "attached");
    assert.equal(typeof listed?.baseCommit, "string");
    assert.equal(store.readMeta("s_ext")?.worktreePath, beside);
    assert.equal(store.readMeta("s_ext")?.worktreeBranch, "fix/example");
    // The PR surface reads the same record, so it is no longer blind to this session.
    await manager.linkWorktreePullRequest("s_ext", beside, "https://example.test/pull/9");
    assert.equal(store.readMeta("s_ext")?.worktrees?.find((item) => item.path === beside)?.pullRequest?.url,
      "https://example.test/pull/9");
    // Nothing is running, so the next launch binds the path before anything can write to it.
    assert.deepEqual(attached.isolation, { writableNow: true, writableAtNextLaunch: true });

    // That next launch really does carry the external path into the writable boundary.
    const boundary = await requestedWorktreeBoundary(repo, "s_ext", { dataDir }, false);
    assert.deepEqual(await internals.requestedWorktreeIsolation(store.readMeta("s_ext")), [boundary, beside]);

    // A live provider keeps the boundary it launched with, and the response says so rather than
    // letting the agent meet it as a mid-turn write denial.
    internals.active.set("s_ext", { sessionId: "s_ext", cwd: repo, context: { kind: "native" } });
    assert.deepEqual(await internals.attachIsolationNotice(store.readMeta("s_ext"), beside), {
      writableNow: false,
      writableAtNextLaunch: true,
    });

    // Direct WSL read-only-binds `/` and makes only the launch cwd writable, and it never carries
    // the requested-worktree boundary, so a live WSL session must not be told it can already write
    // here — an agent that believed it would meet permission failures instead.
    const wslMeta = { ...store.readMeta("s_ext"), context: { kind: "wsl" } };
    internals.active.set("s_ext", { sessionId: "s_ext", cwd: repo, context: { kind: "wsl" } });
    assert.deepEqual(await internals.attachIsolationNotice(wslMeta, beside), {
      writableNow: false,
      writableAtNextLaunch: true,
    });

    // Seatbelt grants the native temporary directory outright, so a worktree under it is writable
    // already and reporting otherwise would send the agent into a pointless relaunch.
    // Seatbelt also grants the provider's transcript leaf. The notice reads the profile's own list
    // rather than restating it, so a worktree under that leaf is reported writable too. This fake
    // active session carries the same launch snapshot a real Seatbelt process retains.
    const providerHome = join(root, "provider-home");
    internals.active.set("s_ext", {
      sessionId: "s_ext",
      cwd: repo,
      context: { kind: "native" },
      seatbeltWritableRoots: [repo, dataDir, tmpdir(), join(providerHome, ".claude", "projects")],
    });
    internals.executionIsolation = { mode: "seatbelt", network: "deny" };
    assert.deepEqual(await internals.attachIsolationNotice(store.readMeta("s_ext"), beside), {
      writableNow: true,
      writableAtNextLaunch: true,
    });
    const providerMeta = { ...store.readMeta("s_ext"), env: { HOME: providerHome } };
    assert.deepEqual(
      await internals.attachIsolationNotice(providerMeta, join(providerHome, ".claude", "projects", "wt")),
      { writableNow: true, writableAtNextLaunch: true },
    );
    internals.executionIsolation = { mode: "bwrap", network: "deny" };
    internals.active.delete("s_ext");

    await manager.delete("s_ext");
    assert.equal(existsSync(beside), true, "an attached worktree is never runner-owned");
    execFileSync("git", ["-C", repo, "show-ref", "--verify", "--quiet", "refs/heads/fix/example"]);
  } finally {
    manager?.shutdownAll();
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
    const firstPhases: string[] = [];
    const retryPhases: string[] = [];
    const firstPromise = manager.requestWorktree(
      "s_multi",
      { baseRef: "HEAD", branch: "fix/first" },
      (phase) => firstPhases.push(phase),
    );
    const retryPromise = manager.requestWorktree(
      "s_multi",
      { baseRef: "HEAD", branch: "fix/first" },
      (phase) => retryPhases.push(phase),
    );
    assert.equal(retryPromise, firstPromise, "an exact in-flight retry joins the original promise");
    const [first, repeated, second] = await Promise.all([
      firstPromise,
      retryPromise,
      manager.requestWorktree("s_multi", { baseRef: "HEAD", branch: "fix/second" }),
    ]);
    assert.equal(firstPhases[0], "validating");
    assert.deepEqual(firstPhases.slice(-2), ["materializing", "activating"]);
    assert.deepEqual(retryPhases, firstPhases, "joined callers observe the same bounded phases");
    assert.equal(repeated.worktree.id, first.worktree.id,
      "an in-flight idempotent retry keeps original ownership metadata");
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
      resolveWorktreePullRequestState: (path: string) => Promise<{ state: "merged" | "closed"; headOid: string } | null>;
    }).resolveWorktreePullRequestState = async (path) => {
      const headOid = execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      if (path === clean.worktree.path || path === attached.worktree.path) return { state: "merged", headOid };
      if (path === dirty.worktree.path) return { state: "closed", headOid };
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

test("merged PR worktrees remain discardable after their remote branches are deleted", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-merged-pr-no-upstream-"));
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  try {
    const { repo } = initRepoWithOrigin(root);
    const store = new SessionStore(join(dataDir, "sessions"));
    store.create({
      sessionId: "s_merged_no_upstream", agentId: "claude", workspaceId: "repo", repoPath: repo,
      worktreePath: null, driver: "claude-code", command: "claude", args: [], env: {},
      context: { kind: "native" }, agentSessionId: null, status: "idle", title: "cleanup",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: 0, createdAt: 1, updatedAt: 1,
    });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
    const automatic = await manager.requestWorktree(
      "s_merged_no_upstream",
      { baseRef: "HEAD", branch: "fix/merged-automatic" },
    );
    const explicit = await manager.requestWorktree(
      "s_merged_no_upstream",
      { baseRef: "HEAD", branch: "fix/merged-explicit" },
    );
    const legacyMerged = await manager.requestWorktree(
      "s_merged_no_upstream",
      { baseRef: "HEAD", branch: "fix/legacy-merged-explicit" },
    );
    const unprovenMerged = await manager.requestWorktree(
      "s_merged_no_upstream",
      { baseRef: "HEAD", branch: "fix/unproven-merged" },
    );
    const discoveredAutomatic = await manager.requestWorktree(
      "s_merged_no_upstream",
      { baseRef: "HEAD", branch: "fix/discovered-merged-automatic" },
    );
    const discoveredExplicit = await manager.requestWorktree(
      "s_merged_no_upstream",
      { baseRef: "HEAD", branch: "fix/discovered-merged-explicit" },
    );
    const unmergedMissingUpstream = await manager.requestWorktree(
      "s_merged_no_upstream",
      { baseRef: "HEAD", branch: "fix/discovered-unmerged" },
    );
    const neverPushed = await manager.requestWorktree(
      "s_merged_no_upstream",
      { baseRef: "HEAD", branch: "fix/never-pushed" },
    );
    for (const worktree of [
      automatic.worktree,
      explicit.worktree,
      legacyMerged.worktree,
      unprovenMerged.worktree,
      discoveredAutomatic.worktree,
      discoveredExplicit.worktree,
      unmergedMissingUpstream.worktree,
    ]) {
      execFileSync("git", ["-C", worktree.path, "push", "-u", "origin", worktree.branch]);
      if (![legacyMerged.worktree, discoveredAutomatic.worktree, discoveredExplicit.worktree,
        unmergedMissingUpstream.worktree].includes(worktree)) {
        await manager.linkWorktreePullRequest(
          "s_merged_no_upstream",
          worktree.path,
          `https://github.com/picoduck/wollipog/pull/${worktree === automatic.worktree
            ? "710"
            : worktree === explicit.worktree ? "711" : "713"}`,
        );
      }
      execFileSync("git", ["-C", worktree.path, "push", "origin", "--delete", worktree.branch]);
    }
    const forgeCalls = new Map<string, number>();
    const discoveryCalls = new Map<string, number>();
    let enableExplicitDiscovery = false;
    let forgeUnavailablePath: string | undefined;
    let removeSiblingOnResolve: string | undefined;
    (manager as unknown as {
      resolveWorktreePullRequestState: (path: string) => Promise<{ state: "merged"; headOid?: string } | null>;
    }).resolveWorktreePullRequestState = async (path) => {
      forgeCalls.set(path, (forgeCalls.get(path) ?? 0) + 1);
      if (removeSiblingOnResolve) {
        const latest = store.readMeta("s_merged_no_upstream")!;
        store.patchMeta("s_merged_no_upstream", {
          worktrees: latest.worktrees?.filter((item) => item.path !== removeSiblingOnResolve),
        });
        removeSiblingOnResolve = undefined;
      }
      if (path === forgeUnavailablePath) return null;
      if (path === unprovenMerged.worktree.path) return { state: "merged" };
      return {
        state: "merged",
        headOid: execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      };
    };
    (manager as unknown as {
      discoverMergedWorktreePullRequest: (
        path: string,
        branch: string,
      ) => Promise<{
        url: string;
        state: "merged";
        headOid: string;
        provider: "github";
        kind: "pull_request";
      } | null>;
    }).discoverMergedWorktreePullRequest = async (path, branch) => {
      discoveryCalls.set(path, (discoveryCalls.get(path) ?? 0) + 1);
      const isDiscoverable = path === discoveredAutomatic.worktree.path ||
        (enableExplicitDiscovery && path === discoveredExplicit.worktree.path);
      if (!isDiscoverable) return null;
      return {
        url: `https://github.com/picoduck/wollipog/pull/${path === discoveredAutomatic.worktree.path ? "714" : "715"}`,
        state: "merged",
        headOid: execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        provider: "github",
        kind: "pull_request",
      };
    };

    const activeEntries = (manager as unknown as { active: Map<string, unknown> }).active;
    activeEntries.set("s_merged_no_upstream", {
      context: { kind: "native" },
      cwd: explicit.worktree.path,
      worktree: { path: explicit.worktree.path, branch: explicit.worktree.branch },
    });
    const beforeReconciliation = store.readMeta("s_merged_no_upstream")!;
    const reconciliationSiblingPath = join(root, "reconciliation-sibling");
    store.patchMeta("s_merged_no_upstream", {
      worktrees: [
        ...(beforeReconciliation.worktrees ?? []),
        {
          id: "reconciliation-sibling",
          path: reconciliationSiblingPath,
          branch: "fix/reconciliation-sibling",
          source: "created",
        },
      ],
    });
    removeSiblingOnResolve = reconciliationSiblingPath;
    await manager.reconcileWorktreePullRequests();

    assert.equal(existsSync(automatic.worktree.path), false,
      "automatic reconciliation removes the inactive merged worktree without its remote branch");
    assert.equal(existsSync(discoveredAutomatic.worktree.path), false,
      "automatic reconciliation discovers and removes an externally opened merged PR worktree");
    assert.equal(existsSync(discoveredExplicit.worktree.path), true,
      "an unlinked worktree remains until forge discovery provides exact merged-head proof");
    assert.equal(existsSync(unmergedMissingUpstream.worktree.path), true,
      "a deleted upstream without merged-head proof remains protected");
    assert.equal(existsSync(neverPushed.worktree.path), true,
      "a never-pushed worktree remains protected");
    assert.equal(existsSync(explicit.worktree.path), true,
      "the worktree still used by a provider remains protected");
    const persistedExplicit = store.readMeta("s_merged_no_upstream")?.worktrees
      ?.find((item) => item.path === explicit.worktree.path)?.pullRequest;
    assert.equal(persistedExplicit?.state, "merged",
      "the terminal forge proof remains available for a later explicit discard",
    );
    assert.equal(persistedExplicit?.headOid,
      execFileSync("git", ["-C", explicit.worktree.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      "the exact merged head survives the durable session-store round trip");
    assert.equal(forgeCalls.get(unprovenMerged.worktree.path), 1,
      "a reconciliation pass does not repeat a forge lookup that returned no head proof");
    assert.equal(existsSync(unprovenMerged.worktree.path), true,
      "a merged lifecycle state without head proof cannot replace the missing upstream");
    assert.equal(store.readMeta("s_merged_no_upstream")?.worktrees
      ?.some((item) => item.id === "reconciliation-sibling"), false,
      "automatic reconciliation cannot resurrect a sibling record removed during forge I/O");

    const discoveryCallsBeforeActiveDiscard = discoveryCalls.get(discoveredExplicit.worktree.path) ?? 0;
    activeEntries.set("s_merged_no_upstream", {
      context: { kind: "native" },
      cwd: discoveredExplicit.worktree.path,
      worktree: { path: discoveredExplicit.worktree.path, branch: discoveredExplicit.worktree.branch },
    });
    await assert.rejects(
      manager.discardWorktree("s_merged_no_upstream", discoveredExplicit.worktree.path),
      /still active in a provider process/,
    );
    assert.equal(discoveryCalls.get(discoveredExplicit.worktree.path) ?? 0, discoveryCallsBeforeActiveDiscard,
      "explicit discard rejects an active unlinked worktree before forge discovery");
    activeEntries.delete("s_merged_no_upstream");
    store.patchMeta("s_merged_no_upstream", {
      status: "starting",
      worktreePath: discoveredExplicit.worktree.path,
      worktreeBranch: discoveredExplicit.worktree.branch,
      worktreePending: true,
    });
    await assert.rejects(
      manager.discardWorktree("s_merged_no_upstream", discoveredExplicit.worktree.path),
      /still being launched by a provider process/,
    );
    assert.equal(discoveryCalls.get(discoveredExplicit.worktree.path) ?? 0, discoveryCallsBeforeActiveDiscard,
      "explicit discard rejects a launching unlinked worktree before forge discovery");
    store.patchMeta("s_merged_no_upstream", {
      status: "idle",
      worktreePath: null,
      worktreeBranch: undefined,
      worktreePending: false,
    });
    await manager.discardWorktree("s_merged_no_upstream", explicit.worktree.path);
    assert.equal(existsSync(explicit.worktree.path), false,
      "explicit discard also accepts the verified merged worktree without its remote branch");

    enableExplicitDiscovery = true;
    await manager.discardWorktree("s_merged_no_upstream", discoveredExplicit.worktree.path);
    assert.equal(existsSync(discoveredExplicit.worktree.path), false,
      "explicit discard discovers an externally opened merged PR before applying the same head proof");
    await assert.rejects(
      manager.discardWorktree("s_merged_no_upstream", unmergedMissingUpstream.worktree.path),
      /branch has no upstream/,
    );
    await assert.rejects(
      manager.discardWorktree("s_merged_no_upstream", neverPushed.worktree.path),
      /branch has no upstream/,
    );
    assert.ok((discoveryCalls.get(discoveredAutomatic.worktree.path) ?? 0) >= 1);
    assert.ok((discoveryCalls.get(unmergedMissingUpstream.worktree.path) ?? 0) >= 1);

    await manager.linkWorktreePullRequest(
      "s_merged_no_upstream",
      legacyMerged.worktree.path,
      "https://github.com/picoduck/wollipog/pull/712",
    );
    const beforeUpgrade = store.readMeta("s_merged_no_upstream")!;
    store.patchMeta("s_merged_no_upstream", {
      worktrees: [
        ...(beforeUpgrade.worktrees?.map((item) => item.path === legacyMerged.worktree.path
          ? { ...item, pullRequest: { ...item.pullRequest!, state: "merged", headOid: undefined } }
          : item) ?? []),
        {
          id: "concurrently-removed-sibling",
          path: join(root, "concurrently-removed-sibling"),
          branch: "fix/concurrently-removed-sibling",
          source: "created",
        },
      ],
    });
    removeSiblingOnResolve = join(root, "concurrently-removed-sibling");
    await manager.discardWorktree("s_merged_no_upstream", legacyMerged.worktree.path);
    assert.equal(existsSync(legacyMerged.worktree.path), false,
      "explicit discard refreshes a merged record persisted by a pre-proof runner");
    assert.equal(store.readMeta("s_merged_no_upstream")?.worktrees
      ?.some((item) => item.id === "concurrently-removed-sibling"), false,
      "forge re-verification cannot resurrect a sibling record removed by another runner");

    forgeUnavailablePath = unprovenMerged.worktree.path;
    await assert.rejects(manager.discardWorktree("s_merged_no_upstream", unprovenMerged.worktree.path),
      /branch has no upstream/);
    assert.equal(existsSync(unprovenMerged.worktree.path), true,
      "a legacy merged record remains fail-closed when forge proof is unavailable");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing-upstream reconciliation is bounded, fair, identity-aware, and lane-independent", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-bounded-pr-discovery-"));
  const dataDir = join(root, "data");
  const candidatePaths = Array.from({ length: 20 }, (_, index) =>
    join(root, `candidate-${index.toString().padStart(2, "0")}`));
  const heads = new Map(candidatePaths.map((path, index) => [path, index.toString(16).padStart(40, "0")]));
  const laneProbePath = join(root, "lane-probe-attached");
  let manager: SessionManager | undefined;
  let releaseFirstWave: (() => void) | undefined;
  try {
    const store = new SessionStore(join(dataDir, "sessions"));
    store.create({
      sessionId: "s_bounded_discovery", agentId: "claude", workspaceId: "repo", repoPath: root,
      worktreePath: null, driver: "claude-code", command: "claude", args: [], env: {},
      context: { kind: "native" }, agentSessionId: null, status: "idle", title: "bounded",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      worktrees: [
        ...[...candidatePaths].reverse().map((path) => {
          const index = candidatePaths.indexOf(path);
          return {
            id: `candidate-${index}`, path, branch: `fix/candidate-${index}`, source: "created" as const,
          };
        }),
        { id: "lane-probe", path: laneProbePath, branch: "fix/lane-probe", source: "attached" as const },
      ],
      seq: 0, createdAt: 1, updatedAt: 1,
    });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
    let now = 1_000_000;
    let holdFirstWave = true;
    const firstWave = new Promise<void>((resolve) => { releaseFirstWave = resolve; });
    let active = 0;
    let highWater = 0;
    const attempts: string[] = [];
    let mergedPath: string | undefined;
    let ineligiblePath: string | undefined;
    let forgeUnavailablePath: string | undefined;
    const internals = manager as unknown as {
      discoverMergedWorktreePullRequest: typeof mergedWorktreePullRequestForBranch;
      resolveWorktreePullRequestState: () => Promise<null>;
      discardSessionWorktreeIfSafe: () => Promise<{ removed: false; reason: "unavailable" }>;
      worktreePullRequestDiscoveryNow: () => number;
      worktreePullRequestDiscoveryCursor: number;
      worktreePullRequestDiscoveryRetryAt: Map<string, { identity: string; retryAt: number }>;
    };
    internals.worktreePullRequestDiscoveryNow = () => now;
    internals.resolveWorktreePullRequestState = async () => null;
    internals.discardSessionWorktreeIfSafe = async () => ({ removed: false, reason: "unavailable" });
    internals.discoverMergedWorktreePullRequest = async (path, branch, options = {}) => {
      assert.equal(options.preflightTimeoutMs, 8_000, "periodic discovery uses the bounded Git preflight");
      if (path === ineligiblePath) {
        options.onIneligible?.();
        return null;
      }
      const headOid = heads.get(path)!;
      if (!options.onForgeAttempt?.({ remote: "origin", merge: `refs/heads/${branch}`, headOid })) return null;
      attempts.push(path);
      if (path === forgeUnavailablePath) {
        options.onForgeUnavailable?.();
        return null;
      }
      active++;
      highWater = Math.max(highWater, active);
      if (holdFirstWave) await firstWave;
      active--;
      return path === mergedPath
        ? {
          url: "https://github.com/picoduck/wollipog/pull/1019",
          state: "merged",
          headOid,
          provider: "github",
          kind: "pull_request",
        }
        : null;
    };

    const firstPass = manager.reconcileWorktreePullRequests();
    await waitForCondition(() => attempts.length === 4, "the fixed first discovery wave did not start");
    assert.equal(active, 4);
    assert.equal(attempts.length, 4, "the fifth forge lookup waits for a worker slot");
    await manager.linkWorktreePullRequest(
      "s_bounded_discovery",
      laneProbePath,
      "https://github.com/picoduck/wollipog/pull/999",
    );
    assert.equal(store.readMeta("s_bounded_discovery")?.worktrees
      ?.find((worktree) => worktree.path === laneProbePath)?.pullRequest?.state, "open",
      "forge I/O does not hold even the candidate-owning session's worktree lane");
    holdFirstWave = false;
    releaseFirstWave();
    await firstPass;
    assert.equal(attempts.length, 8, "one pass admits only the documented candidate budget");
    assert.deepEqual(attempts, candidatePaths.slice(0, 8),
      "candidate admission is deterministic even when persisted worktrees are reversed");
    assert.equal(highWater, 4, "forge subprocess concurrency has a fixed ceiling");

    await manager.reconcileWorktreePullRequests();
    assert.equal(attempts.length, 16, "the rotating cursor advances to the next candidate slice");
    await manager.reconcileWorktreePullRequests();
    assert.equal(attempts.length, 20, "every candidate is eventually inspected despite the smaller pass budget");
    await manager.reconcileWorktreePullRequests();
    assert.equal(attempts.length, 20, "unchanged negative identities reuse their backoff");

    heads.set(candidatePaths[12]!, "f".repeat(40));
    heads.set(candidatePaths[15]!, "e".repeat(40));
    ineligiblePath = candidatePaths[14];
    forgeUnavailablePath = candidatePaths[15];
    await manager.reconcileWorktreePullRequests();
    assert.equal(attempts.length, 22, "changed heads invalidate only their prior negative identities");
    assert.equal(internals.worktreePullRequestDiscoveryRetryAt.has(
      JSON.stringify(["s_bounded_discovery", ineligiblePath]),
    ), false, "a changed upstream eligibility invalidates its negative cache entry");
    assert.equal(internals.worktreePullRequestDiscoveryRetryAt.has(
      JSON.stringify(["s_bounded_discovery", forgeUnavailablePath]),
    ), false, "forge unavailability is not cached as an authoritative negative");
    forgeUnavailablePath = undefined;
    internals.worktreePullRequestDiscoveryCursor = 12;
    await manager.reconcileWorktreePullRequests();
    assert.equal(attempts.length, 23, "an unavailable forge is retried on the candidate's next eligible pass");
    ineligiblePath = undefined;

    const linkedPath = candidatePaths[13]!;
    const linkedCacheKey = JSON.stringify(["s_bounded_discovery", linkedPath]);
    assert.equal(internals.worktreePullRequestDiscoveryRetryAt.has(linkedCacheKey), true);
    await manager.linkWorktreePullRequest(
      "s_bounded_discovery",
      linkedPath,
      "https://github.com/picoduck/wollipog/pull/1000",
    );
    assert.equal(internals.worktreePullRequestDiscoveryRetryAt.has(linkedCacheKey), false,
      "explicit linkage invalidates its negative cache entry immediately");

    mergedPath = candidatePaths[0];
    now += 31 * 60 * 1_000;
    await manager.reconcileWorktreePullRequests();
    assert.equal(store.readMeta("s_bounded_discovery")?.worktrees
      ?.find((worktree) => worktree.path === mergedPath)?.pullRequest?.state, "merged",
      "an expired negative is retried and a later merge is discovered");

    store.patchMeta("s_bounded_discovery", { worktrees: [] });
    now += 31 * 60 * 1_000;
    await manager.reconcileWorktreePullRequests();
    assert.equal(internals.worktreePullRequestDiscoveryRetryAt.size, 0,
      "expired negatives are purged even when no discovery candidates remain");
  } finally {
    releaseFirstWave?.();
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy merged-worktree discard refreshes launch state and reports vanished records", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-legacy-discard-refresh-"));
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  try {
    const { repo } = initRepoWithOrigin(root);
    const store = new SessionStore(join(dataDir, "sessions"));
    store.create({
      sessionId: "s_legacy_discard_refresh", agentId: "claude", workspaceId: "repo", repoPath: repo,
      worktreePath: null, driver: "claude-code", command: "claude", args: [], env: {},
      context: { kind: "native" }, agentSessionId: null, status: "idle", title: "cleanup",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: 0, createdAt: 1, updatedAt: 1,
    });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
    const launching = await manager.requestWorktree(
      "s_legacy_discard_refresh",
      { baseRef: "HEAD", branch: "fix/legacy-discard-launching" },
    );
    const vanished = await manager.requestWorktree(
      "s_legacy_discard_refresh",
      { baseRef: "HEAD", branch: "fix/legacy-discard-vanished" },
    );
    for (const [worktree, pullRequest] of [
      [launching.worktree, "https://github.com/picoduck/wollipog/pull/720"],
      [vanished.worktree, "https://github.com/picoduck/wollipog/pull/721"],
    ] as const) {
      execFileSync("git", ["-C", worktree.path, "push", "-u", "origin", worktree.branch]);
      await manager.linkWorktreePullRequest("s_legacy_discard_refresh", worktree.path, pullRequest);
      execFileSync("git", ["-C", worktree.path, "push", "origin", "--delete", worktree.branch]);
    }
    const beforeLegacyPatch = store.readMeta("s_legacy_discard_refresh")!;
    store.patchMeta("s_legacy_discard_refresh", {
      status: "idle",
      worktreePath: null,
      worktreePending: false,
      worktrees: beforeLegacyPatch.worktrees?.map((item) => ({
        ...item,
        pullRequest: item.pullRequest
          ? { ...item.pullRequest, state: "merged" as const, headOid: undefined }
          : undefined,
      })),
    });

    const internals = manager as unknown as {
      resolveWorktreePullRequestState: (path: string) => Promise<{ state: "merged"; headOid: string }>;
    };
    const deferForgeResolution = (expectedPath: string) => {
      let signalStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { signalStarted = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      internals.resolveWorktreePullRequestState = async (path) => {
        assert.equal(path, expectedPath);
        const headOid = execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        signalStarted();
        await gate;
        return { state: "merged", headOid };
      };
      return { started, release };
    };

    const launchingResolution = deferForgeResolution(launching.worktree.path);
    const launchingDiscard = manager.discardWorktree("s_legacy_discard_refresh", launching.worktree.path);
    await launchingResolution.started;
    store.patchMeta("s_legacy_discard_refresh", {
      status: "starting",
      worktreePath: launching.worktree.path,
      worktreeBranch: launching.worktree.branch,
      worktreePending: true,
    });
    launchingResolution.release();
    await assert.rejects(launchingDiscard, /still being launched by a provider process/);
    assert.equal(existsSync(launching.worktree.path), true,
      "a launch recorded during forge verification keeps the merged worktree intact");
    assert.equal(store.readMeta("s_legacy_discard_refresh")?.worktrees
      ?.find((item) => item.path === launching.worktree.path)?.pullRequest?.headOid,
      execFileSync("git", ["-C", launching.worktree.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      "the refreshed merge proof is retained while launch state blocks cleanup");

    store.patchMeta("s_legacy_discard_refresh", {
      status: "idle",
      worktreePath: null,
      worktreeBranch: undefined,
      worktreePending: false,
    });
    const vanishedResolution = deferForgeResolution(vanished.worktree.path);
    const vanishedDiscard = manager.discardWorktree("s_legacy_discard_refresh", vanished.worktree.path);
    await vanishedResolution.started;
    const beforeRemoval = store.readMeta("s_legacy_discard_refresh")!;
    store.patchMeta("s_legacy_discard_refresh", {
      worktrees: beforeRemoval.worktrees?.filter((item) => item.path !== vanished.worktree.path),
    });
    vanishedResolution.release();
    await assert.rejects(vanishedDiscard, /worktree record was removed while checking forge state/);
    assert.equal(existsSync(vanished.worktree.path), true,
      "a vanished metadata record is not misreported as a filesystem removal");
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
      resolveWorktreePullRequestState: (path: string) => Promise<{ state: "merged"; headOid: string }>;
    }).resolveWorktreePullRequestState = async (path) => ({
      state: "merged",
      headOid: execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    });
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

test("an interrupt hold defers worktree rebind until settlement then resumes the queue automatically", { skip: !haveGit() }, async () => {
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
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(launchedCwds, [repo], "the interrupt hold must defer provider replacement before settlement");
    assert.deepEqual(prompts, [{ cwd: repo, text: "first" }],
      "the preserved FIFO must not run before cancellation settles");
    releasePrompt();
    await waitForCondition(() => prompts.length === 2, "settlement did not drain the preserved FIFO");
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

test("pending Claude background work defers rebind until its automatic continuation is recorded", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-background-worktree-rebind-"));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  let releaseFirst = () => {};
  try {
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const store = new SessionStore(join(dataDir, "sessions"));
    const launchedCwds: string[] = [];
    const prompts: Array<{ cwd: string; text: string }> = [];
    const callbacksByLaunch: Array<{
      onBackgroundWork?: (update: {
        state: "running" | "orphaned" | null;
        pendingTaskIds: string[];
        jobs?: Array<{ id: string; launchType: "agent"; startedAt: number }>;
        terminalJobs?: Array<{
          id: string;
          launchType: "agent";
          startedAt: number;
          status: "completed";
          terminalAt: number;
          continuationRequired: boolean;
        }>;
      }) => void;
      onPromptAccepted?: () => void;
      onEvent: (event: { kind: "agent_message"; text: string }) => void;
    }> = [];
    let firstStartedResolve!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstStartedResolve = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const factory = (
      _driver: unknown,
      launch: { cwd: string },
      callbacks: (typeof callbacksByLaunch)[number],
    ) => {
      launchedCwds.push(launch.cwd);
      callbacksByLaunch.push(callbacks);
      return {
        pid: launchedCwds.length, initialize: async () => {}, newSession: async () => {}, close: async () => {},
        prompt: async (text: string) => {
          prompts.push({ cwd: launch.cwd, text });
          if (text === "first") {
            callbacks.onBackgroundWork?.({
              state: "running",
              pendingTaskIds: ["task-1"],
              jobs: [{ id: "task-1", launchType: "agent", startedAt: 1 }],
            });
            firstStartedResolve();
            await firstGate;
          } else if (/Managed background jobs reached their terminal barrier/.test(text)) {
            callbacks.onPromptAccepted?.();
            callbacks.onEvent({ kind: "agent_message", text: "Background task completed." });
          }
          return "end_turn" as const;
        },
        cancel: () => {}, dispose: () => {}, setConfig: () => {}, resolvePermission: () => false,
        agentSessionId: () => "provider-session-id",
      };
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_background_rebind", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    manager.prompt(spec.sessionId, "first");
    await firstStarted;
    const requested = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/background-rebind",
    });
    manager.prompt(spec.sessionId, "second");
    releaseFirst();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(launchedCwds, [repo], "the task-owning provider must stay alive after its turn ends");
    assert.equal(store.readMeta(spec.sessionId)?.backgroundWorkState, "running");

    callbacksByLaunch[0]!.onBackgroundWork?.({
      state: null,
      pendingTaskIds: [],
      terminalJobs: [{
        id: "task-1",
        launchType: "agent",
        startedAt: 1,
        status: "completed",
        terminalAt: 2,
        continuationRequired: true,
      }],
    });
    await waitForCondition(() => prompts.length === 3, "the background continuation and held prompt were not submitted", 3_000);
    await waitForCondition(() => launchedCwds.length === 2, "rebind did not resume after background delivery", 3_000);
    assert.equal(prompts.length, 3);
    assert.equal(prompts[1]!.cwd, repo, "the task notification is consumed by its owning provider");
    assert.match(prompts[1]!.text, /Managed background jobs reached their terminal barrier/);
    assert.deepEqual(prompts[2], { cwd: requested.worktree.path, text: "second" },
      "ordinary queued work remains FIFO-held until the rebind finishes");
    assert.equal(store.readEvents(spec.sessionId).some((event) =>
      event.payload.kind === "agent_message" && event.payload.text === "Background task completed."), true);
    assert.deepEqual(launchedCwds, [repo, requested.worktree.path]);
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
    releaseFirst();
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a spent one-shot orphan recovery does not hold a worktree rebind forever", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-spent-orphan-worktree-rebind-"));
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
        resolvePermission: () => false, agentSessionId: () => "provider-session-id",
      };
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const spec = {
      sessionId: "s_spent_orphan_rebind", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    await manager.start(spec);
    store.patchMeta(spec.sessionId, {
      backgroundWorkState: "orphaned",
      pendingBackgroundTaskIds: ["task-1"],
      orphanedWork: {
        pendingTaskIds: ["task-1"],
        markedAt: 1,
        reason: "process_exit",
        recoveryAttemptedAt: 2,
      },
    });
    const requested = await manager.requestWorktree(spec.sessionId, {
      baseRef: "HEAD", branch: "fix/spent-orphan-rebind",
    });
    await waitForCondition(() => launchedCwds.length === 2, "terminal orphan metadata held the rebind");
    assert.deepEqual(launchedCwds, [repo, requested.worktree.path]);
    assert.equal(store.readMeta(spec.sessionId)?.orphanedWork?.recoveryAttemptedAt, 2,
      "the retained diagnostic still proves that billing-safe recovery was spent");
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
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
    const phases: string[] = [];
    const advertised = await fetchRemoteDefaultBase(clone, { onProgress: (phase) => phases.push(phase) });
    assert.deepEqual(phases, ["resolving_remote", "fetching_remote"]);
    assert.equal(advertised.branch, "develop");
    assert.equal(advertised.ref, "origin/develop");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an idempotent retry applies the default branch the remote just advertised", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-retry-default-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "clone");
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  try {
    execFileSync("git", ["init", "--bare", "--initial-branch=release-2027", origin]);
    const seed = join(root, "seed");
    execFileSync("git", ["init", "--initial-branch=release-2027", seed]);
    execFileSync("git", ["-C", seed, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", seed, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", seed, "commit", "--allow-empty", "-m", "base"]);
    execFileSync("git", ["-C", seed, "remote", "add", "origin", origin]);
    execFileSync("git", ["-C", seed, "push", "origin", "release-2027"]);
    execFileSync("git", ["-C", seed, "branch", "develop"]);
    execFileSync("git", ["-C", seed, "push", "origin", "develop"]);
    execFileSync("git", ["clone", origin, repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);

    const store = new SessionStore(join(dataDir, "sessions"));
    store.create({
      sessionId: "s_retry", agentId: "claude", workspaceId: "repo", repoPath: repo,
      worktreePath: null, driver: "claude-code", command: "claude", args: [], env: {},
      context: { kind: "native" }, agentSessionId: null, status: "idle", title: "retry",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: 0, createdAt: 1, updatedAt: 1,
    });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);

    const first = await manager.requestWorktree("s_retry", { branch: "fix/issue-679-retry" });
    assert.equal(first.worktree.defaultBranch, "release-2027");

    // The remote moves its default. A plain fetch never updates the tracked HEAD, so only the
    // retry's own `ls-remote` can notice — and it must write what it learned to the record.
    execFileSync("git", ["-C", origin, "symbolic-ref", "HEAD", "refs/heads/develop"]);
    const retried = await manager.requestWorktree("s_retry", { branch: "fix/issue-679-retry" });
    assert.equal(retried.worktree.id, first.worktree.id, "the retry is still the same worktree");
    assert.equal(retried.worktree.defaultBranch, "develop", "a retry must not preserve a stale default");
  } finally {
    await manager?.shutdown?.().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("a running session discards its own finished worktrees despite the per-session provider lease", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-own-lease-discard-"));
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  try {
    const { repo } = initRepoWithOrigin(root);
    const store = new SessionStore(join(dataDir, "sessions"));
    store.create({
      sessionId: "s_own_lease", agentId: "claude", workspaceId: "repo", repoPath: repo,
      worktreePath: null, driver: "claude-code", command: "claude", args: [], env: {},
      context: { kind: "native" }, agentSessionId: null, status: "idle", title: "own lease",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: 0, createdAt: 1, updatedAt: 1,
    });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
    const finished = await manager.requestWorktree("s_own_lease", { baseRef: "HEAD", branch: "fix/finished" });
    const current = await manager.requestWorktree("s_own_lease", { baseRef: "HEAD", branch: "fix/current" });
    const third = await manager.requestWorktree("s_own_lease", { baseRef: "HEAD", branch: "fix/third" });
    const fourth = await manager.requestWorktree("s_own_lease", { baseRef: "HEAD", branch: "fix/fourth" });
    const fifth = await manager.requestWorktree("s_own_lease", { baseRef: "HEAD", branch: "fix/fifth" });
    for (const worktree of [finished.worktree, current.worktree, third.worktree, fourth.worktree, fifth.worktree]) {
      execFileSync("git", ["-C", worktree.path, "push", "-u", "origin", worktree.branch]);
    }
    // The session's provider is running in `current` and holds the per-session lease, exactly as
    // launch records it on the active entry.
    const providerOwner = "runner:provider:1:test";
    assert.equal(store.acquireWorktreeLease("s_own_lease", providerOwner), true);
    const activeEntries = (manager as unknown as { active: Map<string, unknown> }).active;
    activeEntries.set("s_own_lease", {
      sessionId: "s_own_lease",
      context: { kind: "native" },
      cwd: current.worktree.path,
      worktree: { path: current.worktree.path, branch: current.worktree.branch },
      worktreeLeaseOwner: providerOwner,
    });

    // While cleanup runs, the lease belongs to cleanup (never unheld), and the provider gets it back.
    const internals = manager as unknown as { discardSessionWorktreeIfSafe: (...args: unknown[]) => Promise<unknown> };
    const originalDiscard = internals.discardSessionWorktreeIfSafe.bind(manager);
    let leaseDuringCleanup: { owner: string; pid: number } | null = null;
    internals.discardSessionWorktreeIfSafe = async (...args: unknown[]) => {
      leaseDuringCleanup = store.readWorktreeLease("s_own_lease");
      assert.equal(store.acquireWorktreeLease("s_own_lease", "sibling-runner:launch", process.ppid), false,
        "a sibling runner cannot take the lease while cleanup is in flight");
      return originalDiscard(...args);
    };
    await manager.discardWorktree("s_own_lease", finished.worktree.path);
    assert.equal(existsSync(finished.worktree.path), false, "the finished sibling worktree is removed while the session runs");
    assert.ok(leaseDuringCleanup && leaseDuringCleanup.owner !== providerOwner && leaseDuringCleanup.pid === process.pid,
      "cleanup held the lease under its own owner while removing the worktree");
    assert.deepEqual(store.readWorktreeLease("s_own_lease"), { owner: providerOwner, pid: process.pid },
      "the provider's lease is handed back after cleanup");

    // If handing the lease back fails (disk error), it stays held and tied to the running provider.
    const originalTransfer = store.transferWorktreeLease.bind(store);
    store.transferWorktreeLease = (id, fromOwner, toOwner) => toOwner === providerOwner ? false : originalTransfer(id, fromOwner, toOwner);
    await manager.discardWorktree("s_own_lease", third.worktree.path);
    store.transferWorktreeLease = originalTransfer;
    assert.equal(existsSync(third.worktree.path), false);
    const keptLease = store.readWorktreeLease("s_own_lease");
    assert.ok(keptLease && keptLease.owner !== providerOwner && keptLease.pid === process.pid, "the lease is still held after a failed hand-back");
    const entryAfter = activeEntries.get("s_own_lease") as { worktreeLeaseOwner?: string };
    assert.equal(entryAfter.worktreeLeaseOwner, keptLease!.owner, "the running provider now owns the cleanup lease, so retirement releases it");
    assert.equal(store.acquireWorktreeLease("s_own_lease", "sibling-runner:launch", process.ppid), false, "a sibling still cannot take the lease");
    store.releaseWorktreeLease("s_own_lease", entryAfter.worktreeLeaseOwner!);
    assert.equal(store.readWorktreeLease("s_own_lease"), null, "the provider's retirement release still frees it");
    assert.equal(store.acquireWorktreeLease("s_own_lease", providerOwner), true);
    entryAfter.worktreeLeaseOwner = providerOwner;

    // If the provider exits during cleanup, its release is a no-op and cleanup frees the lease.
    internals.discardSessionWorktreeIfSafe = async (...args: unknown[]) => {
      store.releaseWorktreeLease("s_own_lease", providerOwner);
      activeEntries.delete("s_own_lease");
      return originalDiscard(...args);
    };
    await manager.discardWorktree("s_own_lease", fourth.worktree.path);
    assert.equal(existsSync(fourth.worktree.path), false);
    assert.equal(store.readWorktreeLease("s_own_lease"), null, "a lease whose provider left mid-cleanup is released, not leaked");
    internals.discardSessionWorktreeIfSafe = originalDiscard;
    assert.equal(store.acquireWorktreeLease("s_own_lease", providerOwner), true);
    activeEntries.set("s_own_lease", {
      sessionId: "s_own_lease",
      context: { kind: "native" },
      cwd: current.worktree.path,
      worktree: { path: current.worktree.path, branch: current.worktree.branch },
      worktreeLeaseOwner: providerOwner,
    });
    await assert.rejects(manager.discardWorktree("s_own_lease", current.worktree.path), /still active in a provider process/,
      "the worktree the provider runs in is still protected");

    // A launch that holds the lease but has not published its active entry yet still blocks.
    store.releaseWorktreeLease("s_own_lease", providerOwner);
    assert.equal(store.acquireWorktreeLease("s_own_lease", "runner:provider:2:launching"), true);
    await assert.rejects(manager.discardWorktree("s_own_lease", fifth.worktree.path), /provider process of this session that is still starting/);
    store.releaseWorktreeLease("s_own_lease", "runner:provider:2:launching");

    // A lease held by another live process (a sibling runner) still blocks with the original reason.
    assert.equal(store.acquireWorktreeLease("s_own_lease", "sibling-runner:provider", process.ppid), true);
    await assert.rejects(manager.discardWorktree("s_own_lease", fifth.worktree.path), /leased by another runner process/);
    store.releaseWorktreeLease("s_own_lease", "sibling-runner:provider");
    assert.equal(existsSync(fifth.worktree.path), true);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-merge cleanup keeps the worktree the running session still selects", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-selected-cleanup-"));
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  try {
    const { repo } = initRepoWithOrigin(root);
    const store = new SessionStore(join(dataDir, "sessions"));
    store.create({
      sessionId: "s_selected_cleanup", agentId: "claude", workspaceId: "repo", repoPath: repo,
      worktreePath: null, driver: "claude-code", command: "claude", args: [], env: {},
      context: { kind: "native" }, agentSessionId: null, status: "running", title: "cleanup",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: 0, createdAt: 1, updatedAt: 1,
    });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
    const merged = await manager.requestWorktree("s_selected_cleanup", { baseRef: "HEAD", branch: "fix/merged-work" });
    // Exactly the post-merge state routine cleanup runs in: clean, fully pushed, nothing to lose.
    execFileSync("git", ["-C", merged.worktree.path, "push", "-u", "origin", merged.worktree.branch]);
    assert.equal(store.readMeta("s_selected_cleanup")?.worktreePath, merged.worktree.path);

    const providerOwner = "runner:provider:1:selected";
    assert.equal(store.acquireWorktreeLease("s_selected_cleanup", providerOwner), true);
    const activeEntries = (manager as unknown as { active: Map<string, unknown> }).active;
    activeEntries.set("s_selected_cleanup", {
      sessionId: "s_selected_cleanup",
      context: { kind: "native" },
      cwd: merged.worktree.path,
      worktree: { path: merged.worktree.path, branch: merged.worktree.branch },
      worktreeLeaseOwner: providerOwner,
    });

    // The agent performing its own post-merge cleanup asks for the worktree it is running in.
    await assert.rejects(
      manager.discardWorktree("s_selected_cleanup", merged.worktree.path),
      /worktree retained: the worktree is still active in a provider process/,
      "the managed API reports the deferral instead of removing the session's own worktree",
    );
    assert.equal(existsSync(merged.worktree.path), true, "the directory survives the refused cleanup");
    const retained = store.readMeta("s_selected_cleanup");
    assert.equal(retained?.worktreePath, merged.worktree.path, "the durable selection is left intact");
    assert.equal(retained?.worktrees?.some((item) => item.path === merged.worktree.path), true,
      "and so is the worktree's attribution record");

    // Once the provider that selected it is gone, the same inactive clean pushed tree discards.
    activeEntries.delete("s_selected_cleanup");
    store.releaseWorktreeLease("s_selected_cleanup", providerOwner);
    await manager.discardWorktree("s_selected_cleanup", merged.worktree.path);
    assert.equal(existsSync(merged.worktree.path), false);
    assert.equal(store.readMeta("s_selected_cleanup")?.worktreePath, null,
      "the managed path clears the selection with the directory, leaving no dangling reference");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a worktree removed between turns fails the resume instead of spawning a provider in it", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-resume-removed-wt-"));
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  try {
    const { repo } = initRepoWithOrigin(root);
    const store = new SessionStore(join(dataDir, "sessions"));
    const messages: Array<{ type: string; status?: string; payload?: { kind?: string; message?: string } }> = [];
    const launchedCwds: string[] = [];
    const prompts: string[] = [];
    const factory = (_driver: unknown, launch: { cwd: string }) => {
      launchedCwds.push(launch.cwd);
      return {
        pid: 1, initialize: async () => {}, newSession: async () => {},
        prompt: async (text: string) => { prompts.push(text); return "end_turn" as const; },
        cancel: () => {}, dispose: () => {}, setConfig: () => {}, resolvePermission: () => false,
        agentSessionId: () => "provider-session-id",
      };
    };
    manager = new SessionManager(
      (message) => messages.push(message as never), () => {}, store, "runner", undefined,
      factory as never, dataDir, 1,
    );
    const spec = {
      sessionId: "s_removed_resume", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: true, driver: "claude-code" as const,
      context: { kind: "native" as const },
    };
    assert.equal(await manager.start(spec), true);
    const worktreePath = store.readMeta(spec.sessionId)?.worktreePath;
    assert.ok(worktreePath);
    manager.prompt(spec.sessionId, "first");
    await waitForCondition(() => prompts.length === 1, "the first turn never reached the provider");
    manager.stop(spec.sessionId);
    await waitForCondition(() => !(manager as unknown as { active: Map<string, unknown> }).active.has(spec.sessionId),
      "the provider never released the session");

    // The bypass this guards: a raw Git removal of a session-linked worktree between turns.
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", worktreePath]);
    assert.equal(existsSync(worktreePath), false);

    const before = launchedCwds.length;
    manager.prompt(spec.sessionId, "second");
    await waitForCondition(
      () => messages.some((message) => message.payload?.kind === "error" &&
        /could not be verified before provider launch/.test(message.payload.message ?? "")),
      "the resume never reported the invalid worktree",
    );
    assert.equal(launchedCwds.length, before, "no provider process was created for the removed worktree");
    assert.deepEqual(prompts, ["first"], "and the resumed turn never reached a provider");
    assert.equal(messages.some((message) => message.type === "session_status" && message.status === "failed"), true,
      "the affected session fails with a durable status");
    const meta = store.readMeta(spec.sessionId);
    assert.equal(meta?.worktreePath, worktreePath,
      "the selection is retained rather than silently falling back to the primary workspace");
    assert.equal(launchedCwds.includes(repo), false, "the primary repository was never used as a substitute cwd");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("queued app-server recovery refuses to relaunch into a removed worktree", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-recovery-removed-wt-"));
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  try {
    const { repo } = initRepoWithOrigin(root);
    const store = new SessionStore(join(dataDir, "sessions"));
    const messages: Array<{ type: string; status?: string; payload?: { kind?: string; message?: string } }> = [];
    const launchedCwds: string[] = [];
    const factory = (_driver: unknown, launch: { cwd: string }) => {
      launchedCwds.push(launch.cwd);
      return {
        pid: 1, initialize: async () => {}, newSession: async () => {},
        prompt: async () => "end_turn" as const,
        cancel: () => {}, dispose: () => {}, setConfig: () => {}, resolvePermission: () => false,
        agentSessionId: () => "thread-1",
      };
    };
    store.create({
      sessionId: "s_recovery_wt", agentId: "codex", workspaceId: "repo", repoPath: repo,
      worktreePath: null, driver: "codex-app-server", command: "codex", args: [], env: {},
      context: { kind: "native" }, agentSessionId: "thread-1", status: "idle", title: "recovery",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: 0, createdAt: 1, updatedAt: 1,
    });
    manager = new SessionManager(
      (message) => messages.push(message as never), () => {}, store, "runner", undefined,
      factory as never, dataDir, 1,
    );
    const selected = await manager.requestWorktree("s_recovery_wt", { baseRef: "HEAD", branch: "fix/recovery-removed" });
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", selected.worktree.path]);

    const internals = manager as unknown as {
      recoveryQueues: Map<string, unknown[]>;
      recoverQueuedAppServer: (sessionId: string) => Promise<void>;
    };
    const queued = [{ id: "q1", text: "held", images: [], queuedAt: 1 }];
    internals.recoveryQueues.set("s_recovery_wt", queued);
    await internals.recoverQueuedAppServer("s_recovery_wt");

    assert.deepEqual(launchedCwds, [], "recovery never spawned a provider in the removed worktree");
    assert.equal(messages.some((message) => message.payload?.kind === "error" &&
      /could not be verified before provider launch/.test(message.payload.message ?? "")), true,
      "recovery reported the invalid worktree state");
    assert.equal(internals.recoveryQueues.get("s_recovery_wt"), queued, "the queued prompts stay held");
    assert.equal(messages.some((message) => message.payload?.kind === "error" &&
      /queued prompt\(s\) remain held/.test(message.payload.message ?? "")), true,
      "and the session is told they were not lost");
    assert.equal(store.readMeta("s_recovery_wt")?.worktreePath, selected.worktree.path,
      "the selection is retained rather than silently falling back to the primary workspace");
    // The refusal happens before any lease is taken, and the caller's ordinary unwind gives the
    // session lock back, so another runner can still pick this session up.
    assert.equal(store.readWorktreeLease("s_recovery_wt"), null, "no worktree lease was left held");
    assert.equal(store.acquireLock("s_recovery_wt", "another-runner"), true, "the session lock was released");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a launch refused by worktree verification retains the tree it could not identify", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-refused-launch-retain-"));
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  try {
    const { repo } = initRepoWithOrigin(root);
    const store = new SessionStore(join(dataDir, "sessions"));
    const launchedCwds: string[] = [];
    const factory = (_driver: unknown, launch: { cwd: string }) => {
      launchedCwds.push(launch.cwd);
      return {
        pid: 1, initialize: async () => {}, newSession: async () => {},
        prompt: async () => "end_turn" as const,
        cancel: () => {}, dispose: () => {}, setConfig: () => {}, resolvePermission: () => false,
        agentSessionId: () => null,
      };
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const worktreePath = join(root, "materialized");
    // Materialization publishes the worktree to the Native TUI, shells, and Files before capacity
    // admission resolves. Reproduce a user who used that window: a different branch and an
    // uncommitted edit, both made in a tree this launch created and would otherwise reap.
    (manager as unknown as { createSessionWorktree: (...args: unknown[]) => Promise<unknown> })
      .createSessionWorktree = async () => {
        execFileSync("git", ["-C", repo, "worktree", "add", "-b", "agent/s_refused_retain", worktreePath]);
        execFileSync("git", ["-C", worktreePath, "switch", "-c", "user/kept-work"]);
        writeFileSync(join(worktreePath, "uncommitted.txt"), "work the user has not pushed\n");
        return { path: worktreePath, branch: "agent/s_refused_retain" };
      };

    const started = await manager.start({
      sessionId: "s_refused_retain", workspaceId: "repo", workspacePath: repo, agentId: "claude",
      command: "claude", args: [], env: {}, useWorktree: true, driver: "claude-code" as const,
      context: { kind: "native" as const },
    });
    assert.equal(started, false, "the launch fails closed on the drifted branch");
    assert.deepEqual(launchedCwds, [], "and never reaches provider construction");
    assert.equal(existsSync(worktreePath), true, "the unverifiable worktree is retained, not reaped");
    assert.equal(existsSync(join(worktreePath, "uncommitted.txt")), true, "so the user's uncommitted work survives");
    assert.equal(store.readMeta("s_refused_retain")?.worktreePath, worktreePath,
      "and the selection still names the tree the error is about");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-host execution target verifies its host worktree before the adapter is reached", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-target-worktree-verify-"));
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  try {
    const { repo } = initRepoWithOrigin(root);
    const store = new SessionStore(join(dataDir, "sessions"));
    const messages: Array<{ type: string; status?: string; payload?: { kind?: string; message?: string } }> = [];
    const launchedCwds: string[] = [];
    const factory = (_driver: unknown, launch: { cwd: string }) => {
      launchedCwds.push(launch.cwd);
      return {
        pid: 1, initialize: async () => {}, newSession: async () => {},
        prompt: async () => "end_turn" as const,
        cancel: () => {}, dispose: () => {}, setConfig: () => {}, resolvePermission: () => false,
        agentSessionId: () => "thread-1",
      };
    };
    store.create({
      sessionId: "s_container_wt", agentId: "codex", workspaceId: "repo", repoPath: repo,
      worktreePath: null, driver: "codex-app-server", command: "codex", args: [], env: {},
      context: { kind: "native" }, agentSessionId: "thread-1", status: "idle", title: "target",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: 0, createdAt: 1, updatedAt: 1,
    });
    manager = new SessionManager(
      (message) => messages.push(message as never), () => {}, store, "runner", undefined,
      factory as never, dataDir, 1,
    );
    const selected = await manager.requestWorktree("s_container_wt", { baseRef: "HEAD", branch: "fix/container-target" });
    // A container target bind-mounts this exact host directory into the guest, so the local tree is
    // as load-bearing there as it is for a host launch.
    store.patchMeta("s_container_wt", {
      executionTarget: {
        id: "runner:container:test", runnerId: "runner", kind: "container",
        workspaceStrategy: "worktree", adapter: "container",
        boundaries: { filesystem: "container", network: "deny", secrets: "none", billing: "none" },
      },
    });
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", selected.worktree.path]);

    const internals = manager as unknown as {
      recoveryQueues: Map<string, unknown[]>;
      recoverQueuedAppServer: (sessionId: string) => Promise<void>;
    };
    internals.recoveryQueues.set("s_container_wt", [{ id: "q1", text: "held", images: [], queuedAt: 1 }]);
    await internals.recoverQueuedAppServer("s_container_wt");

    assert.deepEqual(launchedCwds, [], "no driver was constructed for the removed mount source");
    assert.equal(messages.some((message) => message.payload?.kind === "error" &&
      /could not be verified before provider launch/.test(message.payload.message ?? "")), true,
      "the worktree is proved before any adapter-specific preparation runs");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("conversation fork refuses to spawn its temporary provider in a removed worktree", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-fork-removed-wt-"));
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  try {
    const { repo } = initRepoWithOrigin(root);
    const store = new SessionStore(join(dataDir, "sessions"));
    const launchedCwds: string[] = [];
    const factory = (_driver: unknown, launch: { cwd: string }) => {
      launchedCwds.push(launch.cwd);
      return {
        pid: 1, initialize: async () => {}, newSession: async () => {},
        prompt: async () => "end_turn" as const, forkConversation: async () => "forked-thread",
        cancel: () => {}, dispose: () => {}, setConfig: () => {}, resolvePermission: () => false,
        agentSessionId: () => "thread-1",
      };
    };
    store.create({
      sessionId: "s_fork_source", agentId: "codex", workspaceId: "repo", repoPath: repo,
      worktreePath: null, driver: "codex-app-server", command: "codex", args: [], env: {},
      context: { kind: "native" }, agentSessionId: "thread-1", status: "idle", title: "fork source",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      turnCount: 1, seq: 0, createdAt: 1, updatedAt: 1,
    });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const selected = await manager.requestWorktree("s_fork_source", { baseRef: "HEAD", branch: "fix/fork-source" });
    const head = execFileSync("git", ["-C", selected.worktree.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["-C", selected.worktree.path, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    store.patchMeta("s_fork_source", {
      forkPoints: { "1": { tree, baseCommit: head, agentTurnId: "turn-1", eventSeq: 1 } },
    });
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", selected.worktree.path]);

    const forked = await manager.forkConversation("s_fork_source", "s_fork_target", 1, "Forked");
    assert.equal(forked.ok, false);
    assert.match(forked.error ?? "", /source worktree could not be verified before fork/);
    assert.deepEqual(launchedCwds, [], "the temporary provider was never constructed");
    assert.equal(store.has("s_fork_target"), false, "and no target session row was published");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a legacy row without a recorded branch still fails closed when its worktree switches", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-legacy-branch-verify-"));
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  try {
    const { repo } = initRepoWithOrigin(root);
    const store = new SessionStore(join(dataDir, "sessions"));
    const messages: Array<{ type: string; status?: string; payload?: { kind?: string; message?: string } }> = [];
    const launchedCwds: string[] = [];
    const factory = (_driver: unknown, launch: { cwd: string }) => {
      launchedCwds.push(launch.cwd);
      return {
        pid: 1, initialize: async () => {}, newSession: async () => {},
        prompt: async () => "end_turn" as const,
        cancel: () => {}, dispose: () => {}, setConfig: () => {}, resolvePermission: () => false,
        agentSessionId: () => "thread-1",
      };
    };
    // Metadata predating worktreeBranch: only worktreePath, on the runner's deterministic legacy
    // name for this session. Absence is not permission to skip the identity check.
    const legacy = await createWorktree(repo, "s_legacy_branch", { dataDir });
    assert.equal(legacy.branch, "agent/s_legacy_branch");
    store.create({
      sessionId: "s_legacy_branch", agentId: "codex", workspaceId: "repo", repoPath: repo,
      worktreePath: legacy.path, driver: "codex-app-server", command: "codex", args: [], env: {},
      context: { kind: "native" }, agentSessionId: "thread-1", status: "idle", title: "legacy",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: 0, createdAt: 1, updatedAt: 1,
    });
    assert.equal(store.readMeta("s_legacy_branch")?.worktreeBranch, undefined);
    manager = new SessionManager(
      (message) => messages.push(message as never), () => {}, store, "runner", undefined,
      factory as never, dataDir, 1,
    );
    execFileSync("git", ["-C", legacy.path, "switch", "-c", "operator/other-work"]);

    const internals = manager as unknown as {
      recoveryQueues: Map<string, unknown[]>;
      recoverQueuedAppServer: (sessionId: string) => Promise<void>;
    };
    internals.recoveryQueues.set("s_legacy_branch", [{ id: "q1", text: "held", images: [], queuedAt: 1 }]);
    await internals.recoverQueuedAppServer("s_legacy_branch");

    assert.deepEqual(launchedCwds, [], "a switched legacy worktree never reaches a provider");
    assert.equal(messages.some((message) => message.payload?.kind === "error" &&
      /instead of agent\/s_legacy_branch/.test(message.payload.message ?? "")), true,
      "and the error names the identity the legacy row implies");

    // An owner-hashed runner derives the prefixed name only for a WSL owner root. Switching a
    // native legacy tree to that form is still a switch, not an alternative spelling of itself.
    (manager as unknown as { runnerOwnerHash?: string }).runnerOwnerHash = "f".repeat(64);
    const ownerBranch = `agent/${"f".repeat(16)}/s_legacy_branch`;
    execFileSync("git", ["-C", legacy.path, "switch", "-c", ownerBranch]);
    internals.recoveryQueues.set("s_legacy_branch", [{ id: "q2", text: "held", images: [], queuedAt: 2 }]);
    await internals.recoverQueuedAppServer("s_legacy_branch");
    assert.deepEqual(launchedCwds, [], "the owner-prefixed form is not accepted for a native row");
    assert.equal(messages.some((message) => message.payload?.kind === "error" &&
      message.payload.message?.includes(`now on branch ${ownerBranch} instead of agent/s_legacy_branch`)), true,
      "and the refusal names the one branch the path's creation mode implies");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the derived session worktree branch follows the root that created the path", () => {
  const hash = "a".repeat(64);
  const wsl = { kind: "wsl" as const, distro: "Ubuntu" };
  const native = { kind: "native" as const };
  const prefixed = `agent/${"a".repeat(16)}/s1`;
  assert.equal(
    sessionWorktreeBranch("s1", `/home/me/.agent-manager/runner-instances/${hash}/worktrees/repo/s1`, wsl, hash),
    prefixed, "an owner-instance root carries the hash prefix, exactly as createWorktree names it");
  assert.equal(
    sessionWorktreeBranch("s1", "/home/me/.agent-manager/worktrees/repo/s1", wsl, hash),
    "agent/s1", "a pre-attestation legacy root keeps the plain name even on an owner-hashed runner");
  assert.equal(
    sessionWorktreeBranch("s1", "/home/me/.agent-manager/worktrees/repo/s1", wsl, undefined),
    "agent/s1", "and so does a runner with no owner hash at all");
  assert.equal(
    sessionWorktreeBranch("s1", `/data/runners/wollipog/worktrees/repo/s1`, native, hash),
    "agent/s1", "a native worktree is never owner-prefixed, whatever the runner's hash");
  // A HOME that itself contains the legacy segment must not demote a real owner-rooted path: the
  // owner root is matched positively rather than by ruling the legacy root out.
  assert.equal(
    sessionWorktreeBranch(
      "s1",
      `/home/.agent-manager/worktrees/me/.agent-manager/runner-instances/${hash}/worktrees/repo/s1`,
      wsl,
      hash,
    ),
    prefixed, "an owner root under an unusual HOME is still owner-rooted");
  assert.equal(
    sessionWorktreeBranch("s1", `/home/me/.agent-manager/runner-instances/${"b".repeat(64)}/worktrees/repo/s1`, wsl, hash),
    "agent/s1", "another owner's root is not this runner's, so no prefix is claimed for it");
});

test("legacy WSL worktree classification keys on the whole session suffix, not a bare segment", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-legacy-wsl-classify-"));
  try {
    const repo = join(root, "repo");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "base"]);
    // Let production name the path, so the repository key under test is the real one rather than a
    // second copy of its hashing rule.
    const created = await createWorktree(repo, "s_legacy", { dataDir: join(root, "data") });
    const key = created.path.split(/[\\/]/u).at(-2)!;
    const owner = "a".repeat(64);

    for (const [path, expected, why] of [
      [`/home/dev/.agent-manager/worktrees/${key}/s_legacy`, true,
        "the legacy root, this repository's key, and this session id"],
      [`/home/dev/.agent-manager/worktrees/${key}/s_legacy/`, true,
        "a trailing slash names the same worktree"],
      [`/home/dev/.agent-manager/runner-instances/${owner}/worktrees/${key}/s_legacy`, false,
        "an owner-instance root is never legacy"],
      // The reported failure: the owner root nested under a distro HOME that itself contains the
      // legacy segment. A bare substring test reads this as legacy and fails the restart closed.
      [`/home/.agent-manager/worktrees/dev/.agent-manager/runner-instances/${owner}/worktrees/${key}/s_legacy`,
        false, "an owner root under a legacy-looking HOME stays owner-rooted"],
      [`/home/dev/.agent-manager/worktrees/other-repo-key/s_legacy`, false,
        "another repository's legacy worktree is not this session's"],
      [`/home/dev/.agent-manager/worktrees/${key}/s_other`, false,
        "another session's legacy worktree is not this one"],
    ] as const) {
      assert.equal(isLegacyWslSessionWorktreePath(path, repo, "s_legacy"), expected, why);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the shells and Files root is re-proved without the boundary's side effects", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-files-root-verify-"));
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  try {
    const { repo } = initRepoWithOrigin(root);
    const store = new SessionStore(join(dataDir, "sessions"));
    // A legacy-layout worktree sits beside the `<sessionId>.requested` boundary rather than inside
    // it, so whether re-proving the root creates that directory is observable.
    const worktree = await createWorktree(repo, "s_files_root", { dataDir });
    const boundary = `${worktree.path}.requested`;
    store.create({
      sessionId: "s_files_root", agentId: "claude", workspaceId: "repo", repoPath: repo,
      worktreePath: worktree.path, worktreeBranch: worktree.branch,
      driver: "claude-code", command: "claude", args: [], env: {},
      context: { kind: "native" }, agentSessionId: null, status: "idle", title: "files",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: 0, createdAt: 1, updatedAt: 1,
    });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
    // A standing proof is reused for a couple of seconds, so retire it between the steps below that
    // deliberately change Git state behind the runner's back.
    const proofs = (manager as unknown as { verifiedWorktreeRoots: Map<string, { at: number }> })
      .verifiedWorktreeRoots;
    const verify = () => {
      proofs.delete("s_files_root");
      return manager!.sessionWorktreeRootFailure(store.readMeta("s_files_root")!);
    };

    assert.equal(await verify(), null, "a healthy selected worktree resolves with no complaint");
    assert.equal(existsSync(boundary), false,
      "re-proving a read path creates no worktree boundary directory");

    execFileSync("git", ["-C", worktree.path, "switch", "-c", "operator/elsewhere"]);
    assert.match(await verify() ?? "", /instead of agent\/s_files_root/,
      "a switched branch is reported as the drift it is");

    execFileSync("git", ["-C", worktree.path, "switch", worktree.branch]);
    assert.equal(await verify(), null);
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", worktree.path]);
    assert.match(await verify() ?? "", /not registered by the repository it was matched against \(/,
      "a worktree removed outside Wollipog is named, not surfaced as a bare filesystem error");

    // A session with no worktree keeps using the repository root, with nothing to prove.
    store.patchMeta("s_files_root", { worktreePath: null, worktreeBranch: undefined });
    assert.equal(await verify(), null);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree reconciliation records the identity a legacy row implied, and only that", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-branch-backfill-"));
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  try {
    const { repo } = initRepoWithOrigin(root);
    const store = new SessionStore(join(dataDir, "sessions"));
    const legacyRow = (sessionId: string, worktreePath: string) => ({
      sessionId, agentId: "claude", workspaceId: "repo", repoPath: repo,
      worktreePath, driver: "claude-code" as const, command: "claude", args: [], env: {},
      context: { kind: "native" as const }, agentSessionId: null, status: "idle" as const,
      title: sessionId, config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null,
      pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1,
    });

    const converges = await createWorktree(repo, "s_converges", { dataDir });
    const switched = await createWorktree(repo, "s_switched", { dataDir });
    const gone = await createWorktree(repo, "s_gone", { dataDir });
    store.create(legacyRow("s_converges", converges.path));
    store.create(legacyRow("s_switched", switched.path));
    store.create(legacyRow("s_gone", gone.path));
    // A row written since the field existed must not be touched, even if it disagrees with Git.
    const recorded = await createWorktree(repo, "s_recorded", { dataDir });
    store.create({ ...legacyRow("s_recorded", recorded.path), worktreeBranch: "fix/recorded-by-hand" });

    execFileSync("git", ["-C", switched.path, "switch", "-c", "operator/elsewhere"]);
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", gone.path]);

    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
    await manager.reconcileWorktreePullRequests();

    assert.equal(store.readMeta("s_converges")?.worktreeBranch, "agent/s_converges",
      "a legacy row whose worktree still matches its layout records that identity");
    assert.equal(store.readMeta("s_switched")?.worktreeBranch, undefined,
      "a switched worktree is never blessed by the backfill");
    assert.equal(store.readMeta("s_gone")?.worktreeBranch, undefined,
      "an unreachable worktree simply does not converge this pass");
    assert.equal(store.readMeta("s_recorded")?.worktreeBranch, "fix/recorded-by-hand",
      "an already recorded identity is left exactly as it was");

    // The switched row must still fail closed at launch: the backfill did not retire that check.
    const failure = await manager.sessionWorktreeRootFailure(store.readMeta("s_switched")!);
    assert.match(failure ?? "", /instead of agent\/s_switched/);

    // Converged rows make the pass a no-op rather than a repeating git cost.
    const before = store.readMeta("s_converges")?.updatedAt;
    await manager.reconcileWorktreePullRequests();
    assert.equal(store.readMeta("s_converges")?.updatedAt, before, "a converged row is not rewritten");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an interactive root proof is memoized against its own identity, never past a change", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-root-proof-memo-"));
  const dataDir = join(root, "data");
  let manager: SessionManager | undefined;
  try {
    const { repo } = initRepoWithOrigin(root);
    const store = new SessionStore(join(dataDir, "sessions"));
    store.create({
      sessionId: "s_memo", agentId: "claude", workspaceId: "repo", repoPath: repo,
      worktreePath: null, driver: "claude-code", command: "claude", args: [], env: {},
      context: { kind: "native" }, agentSessionId: null, status: "idle", title: "memo",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: 0, createdAt: 1, updatedAt: 1,
    });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
    const first = await manager.requestWorktree("s_memo", { baseRef: "HEAD", branch: "fix/memo-one" });
    const second = await manager.requestWorktree("s_memo", { baseRef: "HEAD", branch: "fix/memo-two" });

    // Count the git work the proof actually does, rather than inferring it from timings.
    const internals = manager as unknown as { verifiedWorktreeRoots: Map<string, unknown> };
    let proofs = 0;
    const original = (manager as unknown as { sessionWorktreeRootFailure: unknown })
      .sessionWorktreeRootFailure as (meta: SessionMeta) => Promise<string | null>;
    const counted = async (meta: SessionMeta) => {
      const before = internals.verifiedWorktreeRoots.get("s_memo");
      const result = await original.call(manager, meta);
      if (internals.verifiedWorktreeRoots.get("s_memo") !== before) proofs++;
      return result;
    };

    const meta = () => store.readMeta("s_memo")!;
    assert.equal(await counted(meta()), null);
    assert.equal(proofs, 1, "the first request proves the root");
    assert.equal(await counted(meta()), null);
    assert.equal(await counted(meta()), null);
    assert.equal(proofs, 1, "an overlapping burst on the same identity reuses that proof");

    // A selection this runner makes changes the identity, so the memo cannot answer for it.
    await manager.selectWorktree("s_memo", first.worktree.path);
    assert.equal(await counted(meta()), null);
    assert.equal(proofs, 2, "switching worktrees re-proves rather than reusing the previous root");

    // Drift introduced outside Wollipog changes nothing the memo is keyed on, so it is answered by
    // the standing proof until that proof ages out. This is the documented bound on the window.
    execFileSync("git", ["-C", first.worktree.path, "switch", "-c", "operator/elsewhere"]);
    assert.equal(await counted(meta()), null, "a fresh proof still stands within its window");

    const entry = internals.verifiedWorktreeRoots.get("s_memo") as { at: number };
    entry.at -= 60_000;
    assert.match(await counted(meta()) ?? "", /instead of fix\/memo-one/,
      "once the proof ages out the drift is reported");
    assert.match(await counted(meta()) ?? "", /instead of fix\/memo-one/,
      "and a failure is never memoized, so it is re-checked every time");

    execFileSync("git", ["-C", first.worktree.path, "switch", first.worktree.branch]);
    assert.equal(await counted(meta()), null, "so a repair is seen on the very next request");

    // The requests this memo exists for overlap, so a burst can arrive entirely before the first
    // proof returns. Hold one open and confirm the others join it instead of each proving again.
    const prover = manager as unknown as {
      proveRegisteredWorktree: (...args: unknown[]) => Promise<unknown>;
    };
    const real = prover.proveRegisteredWorktree.bind(manager);
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    prover.proveRegisteredWorktree = async (...args: unknown[]) => {
      started++;
      await gate;
      return real(...args);
    };
    internals.verifiedWorktreeRoots.delete("s_memo");
    const burst = [meta(), meta(), meta()].map((snapshot) => manager!.sessionWorktreeRootFailure(snapshot));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(started, 1, "three overlapping requests start one proof between them");
    release();
    assert.deepEqual(await Promise.all(burst), [null, null, null], "and every one of them is answered");
    assert.equal(started, 1, "with no second proof started behind the first");
    void second;
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});
