import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anchorForkRef,
  anchorTurnRef,
  deleteTurnRefs,
  GitOpError,
  commitAll,
  computeDiffHash,
  extractHunkPatch,
  githubSlug,
  gitDiff,
  gitStatus,
  hunkIsStaged,
  isLinkedWorktreeGitDir,
  isMissingGitRepositoryError,
  markStagedHunks,
  MAX_GIT_STATUS_FILES,
  mapWithConcurrency,
  parseDiff,
  parseGitHubReviewPage,
  parsePorcelain,
  parsePorcelainCategories,
  parseRevListPair,
  pickPrUrl,
  readTurnRef,
  resolveGitActionExecution,
  runGitAction,
  setGitPathMetadataReaderForTests,
  setRemoteRefsMetadataReaderForTests,
  setGitRunnerForTests,
  stageHunk,
  summarizeCheckRollup,
  synchronizeCheckpointRefs,
  validatePodReconciliationMetadata,
  withGitExecutionContext,
  type GitRunOpts,
} from "./git-ops.js";

test("checkpoint anchors atomically dual-write the current and legacy namespaces", async (t) => {
  t.after(() => setGitRunnerForTests());
  const calls: Array<{ args: string[]; opts?: GitRunOpts }> = [];
  setGitRunnerForTests(async (_cwd, args, opts) => {
    calls.push({ args, opts });
    return "";
  });
  const turnTree = "a".repeat(40);
  const forkTree = "b".repeat(40);

  await anchorTurnRef("/repo", "session-one", 2, turnTree);
  await anchorForkRef("/repo", "session-one", 2, forkTree);

  assert.deepEqual(calls.map((call) => call.args), [
    ["update-ref", "--stdin"],
    ["update-ref", "--stdin"],
  ]);
  assert.equal(calls.some((call) => call.args.includes("--batch-updates")), false);
  assert.equal(calls[0]?.opts?.stdin,
    `update refs/mam/session-one/turn-2 ${turnTree}\nupdate refs/wollipog/session-one/turn-2 ${turnTree}\n`);
  assert.equal(calls[1]?.opts?.stdin,
    `update refs/mam/session-one/fork-2 ${forkTree}\nupdate refs/wollipog/session-one/fork-2 ${forkTree}\n`);
  await assert.rejects(anchorTurnRef("/repo", "bad\nsession", 1, turnTree), /invalid checkpoint session id/);
  assert.equal(calls.length, 2, "invalid ids fail before transaction input is constructed");
});

test("checkpoint cleanup validates the session id before enumerating refs", async (t) => {
  t.after(() => setGitRunnerForTests());
  let calls = 0;
  setGitRunnerForTests(async () => {
    calls++;
    return "";
  });

  await assert.rejects(deleteTurnRefs("/repo", "bad\nsession"), /invalid checkpoint session id/);
  await assert.rejects(deleteTurnRefs("/repo", "owners"), /invalid checkpoint session id/);
  assert.equal(calls, 0);
});

test("checkpoint reads are soft on transport failure", async (t) => {
  t.after(() => setGitRunnerForTests());
  setGitRunnerForTests(async () => {
    throw new Error("repository transport unavailable");
  });

  assert.equal(await readTurnRef("/repo", "session-one", 2), null);
});

test("checkpoint synchronization retries a conditional-create collision without overwriting it", async (t) => {
  t.after(() => setGitRunnerForTests());
  const legacyOid = "a".repeat(40);
  const competingOid = "b".repeat(40);
  let currentOid: string | null = null;
  let updateAttempts = 0;
  setGitRunnerForTests(async (_cwd, args, opts) => {
    if (args[0] === "for-each-ref") {
      const prefix = args[2] ?? "";
      if (prefix === "refs/wollipog/session-one/" && currentOid) {
        return `refs/wollipog/session-one/turn-1\t${currentOid}`;
      }
      if (prefix === "refs/mam/session-one/") {
        return `refs/mam/session-one/turn-1\t${legacyOid}`;
      }
      return "";
    }
    if (args[0] === "update-ref") {
      updateAttempts++;
      assert.equal(opts?.stdin,
        `verify refs/mam/session-one/turn-1 ${legacyOid}\n` +
        `create refs/wollipog/session-one/turn-1 ${legacyOid}\n`);
      currentOid = competingOid;
      throw new Error("conditional create collided with a concurrent writer");
    }
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  });

  assert.deepEqual(await synchronizeCheckpointRefs("/repo", "session-one"), {
    mirroredToCurrent: 0,
    mirroredToLegacy: 0,
    conflicts: ["turn-1"],
  });
  assert.equal(updateAttempts, 1);
  assert.equal(currentOid, competingOid, "the concurrent value is never overwritten on retry");
});

test("missing repository classification excludes retryable Git failures", () => {
  assert.equal(isMissingGitRepositoryError(Object.assign(new Error("spawn git failed"), { code: "ENOENT" })), false);
  assert.equal(isMissingGitRepositoryError(Object.assign(new Error("git failed"), {
    stderr: "fatal: not a git repository (or any of the parent directories): .git",
  })), true);
  assert.equal(isMissingGitRepositoryError(Object.assign(new Error("git failed"), {
    stderr: "fatal: cannot change to '/gone/repo': No such file or directory",
  })), true);
  assert.equal(isMissingGitRepositoryError(new Error("permission denied")), false);
  assert.equal(isMissingGitRepositoryError(new Error("cannot lock ref; another process holds the lock")), false);
  assert.equal(isMissingGitRepositoryError(new Error("operation timed out")), false);
});

test("pod reconciliation metadata fails closed across paths, workspaces, and execution contexts", () => {
  const target = { workspaceId: "ws-1", worktreePath: "C:/repo/target", context: { kind: "wsl" as const, distro: "Ubuntu" } };
  const source = { workspaceId: "ws-1", worktreePath: "C:/repo/source", context: { kind: "wsl" as const, distro: "Ubuntu" } };
  assert.deepEqual(validatePodReconciliationMetadata("c:\\repo\\target\\", target, source), {
    sourceWorktreePath: "C:/repo/source",
    context: { kind: "wsl", distro: "Ubuntu" },
  });
  assert.throws(() => validatePodReconciliationMetadata("C:/repo/other", target, source), /runner-owned session metadata/);
  assert.throws(() => validatePodReconciliationMetadata("C:/repo/target", target, { ...source, worktreePath: null }), /no runner-owned worktree/);
  assert.throws(() => validatePodReconciliationMetadata("C:/repo/target", target, { ...source, worktreePath: "c:\\repo\\target" }), /distinct/);
  assert.throws(() => validatePodReconciliationMetadata("C:/repo/target", target, { ...source, workspaceId: "ws-2" }), /same workspace/);
  assert.throws(() => validatePodReconciliationMetadata("C:/repo/target", target, {
    ...source, context: { kind: "wsl", distro: "Debian" },
  }), /same execution context/);
  assert.throws(() => validatePodReconciliationMetadata("C:/repo/target", target, {
    ...source, context: { kind: "native" },
  }), /same execution context/);
});

test("parseGitHubReviewPage: preserves remote provenance and falls back to originalLine for outdated threads", () => {
  const raw = JSON.stringify({ data: { repository: { pullRequest: {
    headRefOid: "a".repeat(40),
    baseRefOid: "d".repeat(40),
    reviewThreads: {
      pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
      nodes: [{
        id: "PRRT_thread",
        isResolved: false,
        isOutdated: true,
        subjectType: "LINE",
        path: "src/a.ts",
        line: null,
        originalLine: 42,
        diffSide: "LEFT",
        comments: { nodes: [{
          databaseId: 123,
          body: "  preserve this invariant  ",
          url: "https://github.com/acme/repo/pull/7#discussion_r123",
          createdAt: "2026-07-01T00:00:00Z",
          updatedAt: "2026-07-02T00:00:00Z",
          author: { login: "reviewer" },
          commit: { oid: "b".repeat(40) },
          originalCommit: { oid: "c".repeat(40) },
          replyTo: null,
        }, {
          databaseId: 124,
          body: "reply",
          replyTo: { databaseId: 123 },
        }] },
      }],
    },
  } } } });
  const page = parseGitHubReviewPage(raw);
  assert.equal(page.pullRequestHeadOid, "a".repeat(40));
  assert.equal(page.pullRequestBaseOid, "d".repeat(40));
  assert.equal(page.endCursor, "cursor-2");
  assert.deepEqual(page.threads, [{
    threadId: "PRRT_thread",
    commentId: 123,
    url: "https://github.com/acme/repo/pull/7#discussion_r123",
    path: "src/a.ts",
    side: "left",
    line: 42,
    body: "preserve this invariant",
    author: "reviewer",
    createdAt: Date.parse("2026-07-01T00:00:00Z"),
    updatedAt: Date.parse("2026-07-02T00:00:00Z"),
    commitId: "c".repeat(40),
    subjectType: "line",
    resolved: false,
    outdated: true,
  }]);
});

test("parseGitHubReviewPage: rejects partial or unsafe authoritative snapshots", () => {
  assert.throws(() => parseGitHubReviewPage("not json"), /malformed/);
  assert.throws(() => parseGitHubReviewPage(JSON.stringify({ errors: [{ message: "denied" }] })), /could not read/);
  const invalid = { data: { repository: { pullRequest: {
    headRefOid: "a".repeat(40),
    baseRefOid: "d".repeat(40),
    reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
      id: "thread", isResolved: false, isOutdated: false, subjectType: "LINE", path: "../secret", line: 1,
      originalLine: 1, diffSide: "RIGHT", comments: { nodes: [] },
    }] },
  } } } };
  assert.throws(() => parseGitHubReviewPage(JSON.stringify(invalid)), /invalid review-thread anchor/);
});

test("parseGitHubReviewPage: file-level threads remain explicit and cannot masquerade as line anchors", () => {
  const raw = JSON.stringify({ data: { repository: { pullRequest: {
    headRefOid: "a".repeat(40), baseRefOid: "b".repeat(40),
    reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
      id: "PRRT_file", isResolved: false, isOutdated: false, subjectType: "FILE",
      path: "src/a.ts", line: null, originalLine: null, diffSide: "RIGHT",
      comments: { nodes: [{
        databaseId: 7, body: "File-wide concern", url: "https://github.com/acme/repo/pull/7#discussion_r7",
        createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z",
        author: { login: "reviewer" }, commit: { oid: "c".repeat(40) }, originalCommit: null, replyTo: null,
      }] },
    }] },
  } } } });
  const thread = parseGitHubReviewPage(raw).threads[0]!;
  assert.equal(thread.subjectType, "file");
  assert.equal(thread.line, 1, "storage keeps its positive-line invariant while subjectType prevents attachment");
});

test("mapWithConcurrency preserves order and enforces its in-flight ceiling", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
    return value * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14]);
  assert.equal(peak, 3);
});

/** Every parsed raw-diff read is prefixed with the prefix-forcing config. */
const DIFF_CFG = ["-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false"];

/** Strip leading `-c <val>` pairs so responders/assertions can key off the git verb. */
function gitVerb(args: string[]): string {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i] ?? "";
}

/** The non-worktree action context used by pure-argv tests (skips assertWorktree). */
const CTX = { useWorktree: false };

test("summarizeCheckRollup: CheckRuns and StatusContexts combine; failing names are captured", () => {
  const r = summarizeCheckRollup([
    { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "test", status: "COMPLETED", conclusion: "FAILURE" },
    { name: "lint", status: "IN_PROGRESS" },
    { name: "e2e", status: "QUEUED" },
    { context: "ci/legacy", state: "SUCCESS" },
    { context: "ci/broken", state: "ERROR" },
    { context: "ci/waiting", state: "PENDING" },
  ]);
  assert.deepEqual(r, { failing: 2, pending: 3, passing: 2, failingNames: ["test", "ci/broken"] });
});

test("summarizeCheckRollup: skipped/neutral pass; cancelled/timed-out/action-required/stale fail", () => {
  const r = summarizeCheckRollup([
    { name: "docs", status: "COMPLETED", conclusion: "SKIPPED" },
    { name: "opt", status: "COMPLETED", conclusion: "NEUTRAL" },
    { name: "slow", status: "COMPLETED", conclusion: "TIMED_OUT" },
    { name: "halted", status: "COMPLETED", conclusion: "CANCELLED" },
    { name: "gate", status: "COMPLETED", conclusion: "ACTION_REQUIRED" },
    { name: "old", status: "COMPLETED", conclusion: "STALE" },
  ]);
  assert.equal(r.passing, 2);
  assert.deepEqual(r.failingNames, ["slow", "halted", "gate", "old"]);
});

test("summarizeCheckRollup: never throws; unknown SHAPES are pending, but a COMPLETED run with an unrecognized conclusion FAILS closed", () => {
  assert.deepEqual(summarizeCheckRollup(undefined), { failing: 0, pending: 0, passing: 0, failingNames: [] });
  assert.deepEqual(summarizeCheckRollup("garbage"), { failing: 0, pending: 0, passing: 0, failingNames: [] });
  const r = summarizeCheckRollup([{ mystery: true }, { name: "odd", status: "COMPLETED", conclusion: "WAT" }]);
  assert.equal(r.pending, 1, "an unrecognizable node shape stays pending (can't be judged)");
  assert.deepEqual(r.failingNames, ["odd"], "a terminal non-pass conclusion must not be labeled 'running'");
});

test("summarizeCheckRollup: failing names are bounded to 8", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `c${i}`, status: "COMPLETED", conclusion: "FAILURE" }));
  const r = summarizeCheckRollup(many);
  assert.equal(r.failing, 20);
  assert.equal(r.failingNames.length, 8);
});

test("parsePorcelain splits status codes from paths", () => {
  const out = " M src/a.ts\n?? new.txt\nA  added.ts\n D gone.ts\n";
  assert.deepEqual(parsePorcelain(out), [
    { status: "M", path: "src/a.ts" },
    { status: "??", path: "new.txt" },
    { status: "A", path: "added.ts" },
    { status: "D", path: "gone.ts" },
  ]);
});

test("parsePorcelain on empty output is an empty list", () => {
  assert.deepEqual(parsePorcelain(""), []);
  assert.deepEqual(parsePorcelain("\n"), []);
});

test("raw porcelain categories preserve staged, modified, and conflict overlaps", () => {
  assert.deepEqual(parsePorcelainCategories([
    "M  staged.ts",
    " M modified.ts",
    "MM both.ts",
    "UU conflict.ts",
    "?? new.ts",
    " D deleted.ts",
  ].join("\n")), {
    stagedCount: 3,
    modifiedCount: 4,
    untrackedCount: 1,
    conflictedCount: 1,
  });
});

test("rev-list pairs parse atomically and fail closed on partial output", () => {
  assert.deepEqual(parseRevListPair("12\t3\n"), { left: 12, right: 3 });
  assert.equal(parseRevListPair("12"), null);
  assert.equal(parseRevListPair("fatal: shallow boundary"), null);
});

test("runner-owned routing permits only primary status/summary and rejects path injection", () => {
  const primary = { repoPath: "C:/repo", worktreePath: null, context: { kind: "native" as const } };
  assert.deepEqual(resolveGitActionExecution(undefined, { kind: "status" }, primary), {
    cwd: "C:/repo",
    context: { useWorktree: false, lastTurnBaseTree: undefined, context: primary.context },
  });
  assert.throws(
    () => resolveGitActionExecution("C:/other", { kind: "summary" }, primary),
    /cannot supply a caller-selected path/,
  );
  assert.throws(
    () => resolveGitActionExecution(undefined, { kind: "commit", message: "m" }, primary),
    /requires a runner-owned linked worktree/,
  );
  assert.throws(
    () => resolveGitActionExecution(undefined, { kind: "status" }, { ...primary, worktreePending: true }),
    /worktree is still being prepared/,
  );

  const linked = { ...primary, worktreePath: "C:/repo/.agent-worktrees/s_1" };
  assert.equal(resolveGitActionExecution(undefined, { kind: "status" }, linked).cwd, linked.worktreePath);
  assert.throws(
    () => resolveGitActionExecution("C:/repo/.agent-worktrees/other", { kind: "status" }, linked),
    /does not match runner-owned session metadata/,
  );
});

test("status fails closed when authoritative porcelain fails", async (t) => {
  t.after(() => setGitRunnerForTests());
  setGitRunnerForTests(async (_cwd, args) => {
    if (args[0] === "--no-optional-locks" && args[1] === "status") throw new Error("git status timed out");
    return "";
  });
  await assert.rejects(() => gitStatus("/repo"), /git status timed out/);
});

test("status bounds the file payload while preserving complete dirty counts", async (t) => {
  t.after(() => setGitRunnerForTests());
  const porcelain = Array.from({ length: MAX_GIT_STATUS_FILES + 7 }, (_, index) => `?? file-${index}.txt`).join("\n");
  setGitRunnerForTests(async (_cwd, args) => {
    const command = args.join(" ");
    if (command === "rev-parse --abbrev-ref HEAD") return "main\n";
    if (command === "symbolic-ref --quiet --short HEAD") return "main\n";
    if (command === "--no-optional-locks status --porcelain=v1 --untracked-files=all") return porcelain;
    return "";
  });
  const status = await gitStatus("/repo");
  assert.equal(status.files.length, MAX_GIT_STATUS_FILES);
  assert.equal(status.filesTruncated, true);
  assert.equal(status.untrackedCount, MAX_GIT_STATUS_FILES + 7);
  assert.equal(status.hasChanges, true);
});

test("legacy ahead and behind retain upstream fallback when default-base facts are unavailable", async (t) => {
  t.after(() => setGitRunnerForTests());
  setGitRunnerForTests(async (_cwd, args) => {
    const command = args.join(" ");
    if (command === "rev-parse --abbrev-ref HEAD") return "develop\n";
    if (command === "symbolic-ref --quiet --short HEAD") return "develop\n";
    if (command === "rev-parse --short=12 HEAD") return "abcdef123456\n";
    if (command === "--no-optional-locks status --porcelain=v1 --untracked-files=all") return "";
    if (command === "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") return "origin/develop\n";
    if (command === "rev-list --left-right --count @{upstream}...HEAD") return "2\t3\n";
    return "";
  });
  const status = await gitStatus("/repo");
  assert.equal(status.baseRef, null);
  assert.equal(status.aheadUpstream, 3);
  assert.equal(status.behindUpstream, 2);
  assert.equal(status.ahead, 3);
});

test("porcelain staged overlap and the commit stale gate agree for conflicted paths", async (t) => {
  t.after(() => setGitRunnerForTests());
  setGitRunnerForTests(async (_cwd, args) => {
    const command = args.join(" ");
    if (command === "rev-parse --is-inside-work-tree") return "true\n";
    if (command === "rev-parse --git-dir") return "/repo/.git/worktrees/s_1\n";
    if (command === "rev-parse --is-bare-repository") return "false\n";
    if (command === "rev-parse --abbrev-ref HEAD") return "feature\n";
    if (command === "symbolic-ref --quiet --short HEAD") return "feature\n";
    if (command === "--no-optional-locks status --porcelain=v1 --untracked-files=all") return "UU conflict.ts\n";
    if (command === "diff --cached --name-only") return "conflict.ts\n";
    if (command === "commit -m blocked") throw new Error("cannot commit with unmerged files");
    return "";
  });
  const status = await gitStatus("/repo-worktree");
  assert.equal(status.stagedCount, 1);
  await assert.rejects(
    () => runGitAction(
      "/repo-worktree",
      { kind: "commit", message: "blocked", expectStaged: true },
      { useWorktree: true },
    ),
    (error: unknown) => {
      assert.equal(error instanceof GitOpError && error.code === "GIT_STALE", false);
      assert.match(String(error), /unmerged files/);
      return true;
    },
  );
});

test("v76 facts use atomic pairs, git-path operation markers, and the WSL metadata seam", async (t) => {
  t.after(() => {
    setGitRunnerForTests();
    setGitPathMetadataReaderForTests();
    setRemoteRefsMetadataReaderForTests();
  });
  const calls: string[] = [];
  setGitRunnerForTests(async (_cwd, args) => {
    const command = args.join(" ");
    calls.push(command);
    if (command === "rev-parse --abbrev-ref HEAD") return "feature\n";
    if (command === "symbolic-ref --quiet --short HEAD") return "feature\n";
    if (command === "rev-parse --short=12 HEAD") return "abcdef123456\n";
    if (command === "--no-optional-locks status --porcelain=v1 --untracked-files=all") return "MM both.ts\n?? new.ts\n";
    if (command === "remote get-url origin") return "https://example.test/repo.git\n";
    if (command === "rev-parse --git-dir") return "/repo/.git/worktrees/s_1\n";
    if (command === "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") return "origin/feature\n";
    if (command === "rev-parse --is-shallow-repository") return "false\n";
    if (command === "symbolic-ref refs/remotes/origin/HEAD") return "refs/remotes/origin/main\n";
    if (command === "rev-list --left-right --count origin/main...HEAD") return "4\t2\n";
    if (command === "rev-list --left-right --count @{upstream}...HEAD") return "0\t0\n";
    if (command === "for-each-ref --count=1 --format=%(refname) refs/remotes") return "refs/remotes/origin/main\n";
    if (command === "rev-parse --git-common-dir") return "/repo/.git\n";
    if (command.startsWith("rev-parse --git-path ")) return "/git/" + args.at(-1) + "\n";
    if (command === "--no-optional-locks diff HEAD --numstat") return "3\t1\tboth.ts\n";
    return "";
  });
  const metadataCalls: Array<{ path: string; context: string }> = [];
  let activeMarker = "REVERT_HEAD";
  setGitPathMetadataReaderForTests(async (_cwd, path, context) => {
    metadataCalls.push({ path, context: context.kind });
    if (path.endsWith("/" + activeMarker)) return { exists: true, mtimeMs: null };
    return { exists: false, mtimeMs: null };
  });
  const remoteMetadataCalls: Array<{ commonDir: string; context: string }> = [];
  setRemoteRefsMetadataReaderForTests(async (_cwd, commonDir, context) => {
    remoteMetadataCalls.push({ commonDir, context: context.kind });
    return { exists: true, mtimeMs: 1_765_432_100_000 };
  });

  const status = await withGitExecutionContext(
    { kind: "wsl", distro: "Ubuntu" },
    () => gitStatus("/repo"),
  );
  assert.equal(status.baseRef, "origin/main");
  assert.equal(status.ahead, 2);
  assert.equal(status.behindUpstream, 0);
  assert.equal(status.aheadUpstream, 0);
  assert.equal(status.operation, "revert");
  assert.equal(status.remoteRefsAt, 1_765_432_100_000);
  assert.equal(status.worktreeKind, "linked");
  assert.equal(status.stagedCount, 1);
  assert.equal(status.modifiedCount, 1);
  assert.equal(status.untrackedCount, 1);
  assert.equal(status.conflictedCount, 0);
  assert.ok(calls.includes("--no-optional-locks status --porcelain=v1 --untracked-files=all"));
  assert.ok(calls.includes("--no-optional-locks diff HEAD --numstat"));
  assert.ok(calls.includes("rev-list --left-right --count origin/main...HEAD"));
  assert.ok(calls.includes("rev-list --left-right --count @{upstream}...HEAD"));
  assert.equal(calls.some((call) => call.startsWith("rev-parse --git-path ")), false,
    "operation markers derive from the already-resolved worktree git dir");
  assert.ok(metadataCalls.every((call) => call.context === "wsl"));
  assert.ok(metadataCalls.some((call) => call.path.endsWith("/REVERT_HEAD")));
  assert.deepEqual(remoteMetadataCalls[0], { commonDir: "/repo/.git", context: "wsl" });

  for (const [marker, expected] of [
    ["MERGE_HEAD", "merge"],
    ["rebase-apply", "rebase"],
    ["CHERRY_PICK_HEAD", "cherry_pick"],
    ["BISECT_LOG", "bisect"],
  ] as const) {
    activeMarker = marker;
    assert.equal((await withGitExecutionContext(
      { kind: "wsl", distro: "Ubuntu" },
      () => gitStatus("/repo"),
    )).operation, expected);
  }
});

test("githubSlug parses ssh and https remotes", () => {
  assert.equal(githubSlug("git@github.com:picoduck/wollipog.git"), "picoduck/wollipog");
  assert.equal(githubSlug("https://github.com/picoduck/wollipog.git"), "picoduck/wollipog");
  assert.equal(githubSlug("https://github.com/picoduck/wollipog"), "picoduck/wollipog");
  assert.equal(githubSlug("ssh://git@github.com/owner/repo.git"), "owner/repo");
});

test("githubSlug returns null for non-github remotes", () => {
  assert.equal(githubSlug("https://gitlab.com/owner/repo.git"), null);
  assert.equal(githubSlug(""), null);
});

test("pickPrUrl finds a pull URL anywhere in gh output", () => {
  assert.equal(
    pickPrUrl("Creating pull request...\nhttps://github.com/picoduck/wollipog/pull/7\n"),
    "https://github.com/picoduck/wollipog/pull/7",
  );
  // gh prints an existing-PR URL to stderr on the "already exists" error
  assert.equal(
    pickPrUrl("a pull request for branch already exists:\nhttps://github.com/o/r/pull/3"),
    "https://github.com/o/r/pull/3",
  );
});

test("isLinkedWorktreeGitDir distinguishes a linked worktree from the main repo", () => {
  // linked worktree git dir (what a healthy session worktree reports)
  assert.equal(isLinkedWorktreeGitDir("/repo/.git/worktrees/s_abc"), true);
  assert.equal(isLinkedWorktreeGitDir("C:\\repo\\.git\\worktrees\\s_abc"), true);
  // main repo (what a stale/removed worktree resolves up to) — flagged
  assert.equal(isLinkedWorktreeGitDir(".git"), false);
  assert.equal(isLinkedWorktreeGitDir("/repo/.git"), false);
});

test("pickPrUrl returns null for non-PR URLs (a docs/login/error URL is not a created PR)", () => {
  // strict: only a real /pull/<n> URL counts — otherwise a failed `gh pr create`
  // whose error contains a docs/status URL would be misreported as "PR opened".
  assert.equal(pickPrUrl("see https://example.com/x for details"), null);
  assert.equal(pickPrUrl("https://docs.github.com/authentication"), null);
  assert.equal(pickPrUrl("https://github.com/o/r/issues/5"), null);
  assert.equal(pickPrUrl("no url here"), null);
  assert.equal(pickPrUrl(""), null);
});

/* -------------------------------- parseDiff ------------------------------- */

test("parseDiff on empty input is an empty list", () => {
  assert.deepEqual(parseDiff(""), []);
  assert.deepEqual(parseDiff("\n"), []);
});

test("parseDiff: single added file", () => {
  const raw = [
    "diff --git a/new.ts b/new.ts",
    "new file mode 100644",
    "index 0000000..e69de29",
    "--- /dev/null",
    "+++ b/new.ts",
    "@@ -0,0 +1,2 @@",
    "+export const a = 1;",
    "+export const b = 2;",
    "",
  ].join("\n");
  assert.deepEqual(parseDiff(raw), [
    {
      path: "new.ts",
      status: "added",
      binary: false,
      hunks: [
        {
          header: "@@ -0,0 +1,2 @@",
          oldStart: 0,
          oldCount: 0,
          newStart: 1,
          newCount: 2,
          lines: [
            { status: "+", text: "export const a = 1;" },
            { status: "+", text: "export const b = 2;" },
          ],
        },
      ],
    },
  ]);
});

test("parseDiff: multi-file modify (context + add + remove lines, stats-relevant)", () => {
  const raw = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,3 @@ function f()",
    " const x = 1;",
    "-const y = 2;",
    "+const y = 3;",
    " const z = 4;",
    "diff --git a/src/b.ts b/src/b.ts",
    "index 3333333..4444444 100644",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -10 +10 @@",
    "-old();",
    "+new();",
    "",
  ].join("\n");
  const files = parseDiff(raw);
  assert.equal(files.length, 2);
  assert.equal(files[0]!.path, "src/a.ts");
  assert.equal(files[0]!.status, "modified");
  assert.ok(!("oldPath" in files[0]!), "unchanged-path modify carries no oldPath");
  assert.equal(files[0]!.hunks[0]!.header, "@@ -1,3 +1,3 @@ function f()");
  assert.deepEqual(files[0]!.hunks[0]!.lines, [
    { status: " ", text: "const x = 1;" },
    { status: "-", text: "const y = 2;" },
    { status: "+", text: "const y = 3;" },
    { status: " ", text: "const z = 4;" },
  ]);
  // omitted counts default to 1
  assert.deepEqual(
    { oldStart: files[1]!.hunks[0]!.oldStart, oldCount: files[1]!.hunks[0]!.oldCount, newStart: files[1]!.hunks[0]!.newStart, newCount: files[1]!.hunks[0]!.newCount },
    { oldStart: 10, oldCount: 1, newStart: 10, newCount: 1 },
  );
});

test("parseDiff: deleted file", () => {
  const raw = [
    "diff --git a/gone.ts b/gone.ts",
    "deleted file mode 100644",
    "index 5555555..0000000",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1,1 +0,0 @@",
    "-was here",
    "",
  ].join("\n");
  const [f] = parseDiff(raw);
  assert.equal(f!.path, "gone.ts");
  assert.equal(f!.status, "deleted");
  assert.ok(!("oldPath" in f!), "deleted file collapses redundant oldPath");
  assert.deepEqual(f!.hunks[0]!.lines, [{ status: "-", text: "was here" }]);
});

test("parseDiff: rename WITH content change carries oldPath + hunks", () => {
  const raw = [
    "diff --git a/old.ts b/new.ts",
    "similarity index 80%",
    "rename from old.ts",
    "rename to new.ts",
    "index 6666666..7777777 100644",
    "--- a/old.ts",
    "+++ b/new.ts",
    "@@ -1,2 +1,2 @@",
    " kept",
    "-before",
    "+after",
    "",
  ].join("\n");
  const [f] = parseDiff(raw);
  assert.equal(f!.status, "renamed");
  assert.equal(f!.oldPath, "old.ts");
  assert.equal(f!.path, "new.ts");
  assert.equal(f!.hunks.length, 1);
  assert.deepEqual(f!.hunks[0]!.lines, [
    { status: " ", text: "kept" },
    { status: "-", text: "before" },
    { status: "+", text: "after" },
  ]);
});

test("parseDiff: pure rename (no content) has empty hunks", () => {
  const raw = [
    "diff --git a/old.ts b/moved/new.ts",
    "similarity index 100%",
    "rename from old.ts",
    "rename to moved/new.ts",
    "",
  ].join("\n");
  const [f] = parseDiff(raw);
  assert.equal(f!.status, "renamed");
  assert.equal(f!.oldPath, "old.ts");
  assert.equal(f!.path, "moved/new.ts");
  assert.deepEqual(f!.hunks, []);
});

test("parseDiff: mode-only change has empty hunks", () => {
  const raw = [
    "diff --git a/run.sh b/run.sh",
    "old mode 100644",
    "new mode 100755",
    "",
  ].join("\n");
  const [f] = parseDiff(raw);
  assert.equal(f!.path, "run.sh");
  assert.equal(f!.status, "modified");
  assert.equal(f!.binary, false);
  assert.deepEqual(f!.hunks, []);
});

test("parseDiff: binary file is flagged with empty hunks", () => {
  const raw = [
    "diff --git a/logo.png b/logo.png",
    "index 8888888..9999999 100644",
    "Binary files a/logo.png and b/logo.png differ",
    "",
  ].join("\n");
  const [f] = parseDiff(raw);
  assert.equal(f!.path, "logo.png");
  assert.equal(f!.binary, true);
  assert.deepEqual(f!.hunks, []);
});

test("parseDiff: EOF-with-no-newline sets noNewlineAtEof", () => {
  const raw = [
    "diff --git a/x.txt b/x.txt",
    "index aaaaaaa..bbbbbbb 100644",
    "--- a/x.txt",
    "+++ b/x.txt",
    "@@ -1 +1 @@",
    "-old",
    "\\ No newline at end of file",
    "+new",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  const [f] = parseDiff(raw);
  assert.equal(f!.hunks[0]!.noNewlineAtEof, true);
  assert.deepEqual(f!.hunks[0]!.lines, [
    { status: "-", text: "old" },
    { status: "+", text: "new" },
  ]);
});

test("parseDiff: preserves empty context lines but ignores the trailing split artifact", () => {
  const raw = [
    "diff --git a/x.ts b/x.ts",
    "index 1..2 100644",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,3 +1,3 @@",
    " a",
    " ", // a genuine blank context line: leading space + nothing
    "-b",
    "+c",
    "", // trailing artifact from the final newline — must NOT become a context line
  ].join("\n");
  const [f] = parseDiff(raw);
  assert.deepEqual(f!.hunks[0]!.lines, [
    { status: " ", text: "a" },
    { status: " ", text: "" },
    { status: "-", text: "b" },
    { status: "+", text: "c" },
  ]);
});

/* ------------------------------ computeDiffHash --------------------------- */

test("computeDiffHash is deterministic for identical input", () => {
  const raw = "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n";
  assert.equal(computeDiffHash(raw), computeDiffHash(raw));
});

test("computeDiffHash changes when a single line changes", () => {
  const a = "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n";
  const b = "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+c\n";
  assert.notEqual(computeDiffHash(a), computeDiffHash(b));
});

test("computeDiffHash normalizes CRLF vs LF to the same hash", () => {
  const lf = "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n";
  const crlf = "diff --git a/x b/x\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n";
  assert.equal(computeDiffHash(lf), computeDiffHash(crlf));
});

test("computeDiffHash treats a missing trailing newline as present", () => {
  const withNl = "abc\n";
  const withoutNl = "abc";
  assert.equal(computeDiffHash(withNl), computeDiffHash(withoutNl));
});

/* -------------------------- gitDiff argv (mocked) ------------------------- */

/** Record every git invocation and return canned stdout keyed by a substring of the argv. */
function stubGit(responder: (args: string[]) => string): string[][] {
  const calls: string[][] = [];
  setGitRunnerForTests(async (_cwd, args) => {
    calls.push(args);
    return responder(args);
  });
  return calls;
}

test("gitDiff uncommitted runs the prefix-forced `git diff … HEAD --` + collects untracked", async (t) => {
  t.after(() => setGitRunnerForTests());
  const calls = stubGit((args) => {
    if (gitVerb(args) === "diff" && !args.includes("--cached")) {
      return "diff --git a/tracked.ts b/tracked.ts\nindex 1..2 100644\n--- a/tracked.ts\n+++ b/tracked.ts\n@@ -1 +1 @@\n-a\n+b\n";
    }
    if (gitVerb(args) === "ls-files") return "untracked-new.ts\n";
    return "";
  });
  // useWorktree=false so we don't invoke the assertWorktree git calls in this pure-argv test.
  const info = await gitDiff("/repo", "uncommitted", CTX);

  const diffCall = calls.find((a) => gitVerb(a) === "diff" && !a.includes("--cached"))!;
  assert.deepEqual(diffCall, [...DIFF_CFG, "diff", "--no-ext-diff", "--unified=3", "HEAD", "--"]);
  const cachedCall = calls.find((a) => gitVerb(a) === "diff" && a.includes("--cached"))!;
  assert.deepEqual(cachedCall, [...DIFF_CFG, "diff", "--no-ext-diff", "--unified=3", "--cached", "--"]);
  assert.ok(
    calls.some((a) => gitVerb(a) === "ls-files" && a.includes("--others") && a.includes("--exclude-standard")),
    "queries untracked files",
  );
  assert.equal(info.scope, "uncommitted");
  const untracked = info.files.find((f) => f.status === "untracked");
  assert.ok(untracked, "untracked file is synthesized");
  assert.equal(untracked!.path, "untracked-new.ts");
  assert.deepEqual(untracked!.hunks, []);
  assert.equal(info.stats.filesChanged, 2);
  assert.equal(info.stats.insertions, 1);
  assert.equal(info.stats.deletions, 1);
});

test("gitDiff uncommitted: untracked paths keep literal spaces — only the line terminator is stripped", async (t) => {
  t.after(() => setGitRunnerForTests());
  stubGit((args) => (gitVerb(args) === "ls-files" ? " spaced.ts \r\nplain.ts\n" : ""));
  const info = await gitDiff("/repo", "uncommitted", CTX);
  assert.deepEqual(
    info.files.map((f) => f.path),
    [" spaced.ts ", "plain.ts"],
  );
});

test("gitDiff uncommitted exposes canonical staged/unstaged panes and a stronger index-aware hash", async (t) => {
  t.after(() => setGitRunnerForTests());
  const combined = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const stagedA = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+stage-one\n";
  const stagedB = stagedA.replace("stage-one", "stage-two");
  const unstaged = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-stage-one\n+new\n";
  let cached = stagedA;
  setGitRunnerForTests(async (_cwd, args) => {
    if (gitVerb(args) === "ls-files") return "";
    if (gitVerb(args) !== "diff") return "";
    if (args.includes("HEAD")) return combined;
    if (args.includes("--cached")) return cached;
    return unstaged;
  });
  const first = await gitDiff("/repo", "uncommitted", CTX);
  assert.equal(first.stagedFiles?.[0]?.hunks[0]?.lines.find((line) => line.status === "+")?.text, "stage-one");
  assert.equal(first.unstagedFiles?.[0]?.hunks[0]?.lines.find((line) => line.status === "+")?.text, "new");
  assert.ok(first.fineDiffHash);
  assert.ok(first.stagedDiffHash);
  assert.ok(first.unstagedDiffHash);

  cached = stagedB;
  const movedIndex = await gitDiff("/repo", "uncommitted", CTX);
  assert.equal(movedIndex.diffHash, first.diffHash, "legacy worktree identity remains index-stable");
  assert.notEqual(movedIndex.fineDiffHash, first.fineDiffHash, "fine mutation identity detects index-only movement");
  assert.notEqual(movedIndex.stagedDiffHash, first.stagedDiffHash, "staged-pane anchors move with staged content");
  assert.equal(movedIndex.unstagedDiffHash, first.unstagedDiffHash, "unstaged-pane anchors remain tied to their own content");
});

test("gitDiff uncommitted: diffHash covers the untracked manifest, not just the raw tracked diff", async (t) => {
  t.after(() => setGitRunnerForTests());
  // The tracked diff stays byte-identical (empty) throughout — only the untracked set varies.
  let untracked = "only-untracked.ts\n";
  stubGit((args) => (gitVerb(args) === "ls-files" ? untracked : ""));

  const first = await gitDiff("/repo", "uncommitted", CTX);
  const same = await gitDiff("/repo", "uncommitted", CTX);
  assert.equal(same.diffHash, first.diffHash, "an identical change-set hashes identically");

  untracked = "only-untracked.ts\nsecond.ts\n";
  const grown = await gitDiff("/repo", "uncommitted", CTX);
  assert.notEqual(grown.diffHash, first.diffHash, "adding an untracked file changes the hash");

  untracked = "";
  const empty = await gitDiff("/repo", "uncommitted", CTX);
  assert.notEqual(empty.diffHash, first.diffHash, "an untracked-only change-set differs from an empty one");
});

test("gitDiff all_branch merge-bases against the fallback chain (origin/HEAD → … → master)", async (t) => {
  t.after(() => setGitRunnerForTests());
  // Only `master` exists — every earlier candidate's rev-parse --verify rejects (non-zero exit).
  const calls = stubGit((args) => {
    if (gitVerb(args) === "rev-parse" && args.includes("--verify")) {
      const ref = args[args.length - 1];
      if (ref === "master^{commit}") return "deadbeef\n";
      throw new Error("bad ref");
    }
    if (gitVerb(args) === "merge-base") return "basecommit\n";
    return "";
  });
  const info = await gitDiff("/repo", "all_branch", CTX);

  // Walked the whole chain: origin/HEAD, origin/main, origin/master, main all rejected; master won.
  const verified = calls.filter((a) => gitVerb(a) === "rev-parse" && a.includes("--verify")).map((a) => a[a.length - 1]);
  assert.deepEqual(verified, ["origin/HEAD^{commit}", "origin/main^{commit}", "origin/master^{commit}", "main^{commit}", "master^{commit}"]);
  const mb = calls.find((a) => gitVerb(a) === "merge-base")!;
  assert.deepEqual(mb, ["merge-base", "master", "HEAD"]);
  const diffCall = calls.find((a) => gitVerb(a) === "diff")!;
  assert.deepEqual(diffCall, [...DIFF_CFG, "diff", "--no-ext-diff", "--unified=3", "basecommit..HEAD", "--"]);
  assert.equal(info.scope, "all_branch");
});

test("gitDiff all_branch throws a clear error when no base ref exists", async (t) => {
  t.after(() => setGitRunnerForTests());
  stubGit((args) => {
    if (gitVerb(args) === "rev-parse" && args.includes("--verify")) throw new Error("bad ref");
    return "";
  });
  await assert.rejects(() => gitDiff("/repo", "all_branch", CTX), /could not determine a base branch/);
});

/* ------------------------------- last_turn -------------------------------- */

test("gitDiff last_turn: never-captured vs capture-failed produce distinct errors without git calls", async (t) => {
  t.after(() => setGitRunnerForTests());
  const calls = stubGit(() => "");
  await assert.rejects(
    () => gitDiff("/repo", "last_turn", { useWorktree: false }),
    /no last-turn snapshot exists for this session yet/,
  );
  await assert.rejects(
    () => gitDiff("/repo", "last_turn", { useWorktree: false, lastTurnBaseTree: null }),
    /could not be captured/,
  );
  assert.equal(calls.length, 0, "fails before any git invocation");
});

test("gitDiff last_turn: probes the snapshot tree, snapshots the worktree now, and diffs tree-to-tree", async (t) => {
  t.after(() => setGitRunnerForTests());
  const opts: (GitRunOpts | undefined)[] = [];
  const calls: string[][] = [];
  setGitRunnerForTests(async (_cwd, args, o) => {
    calls.push(args);
    opts.push(o);
    if (gitVerb(args) === "write-tree") return "nowtree123\n";
    if (gitVerb(args) === "diff") {
      return "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
    }
    return "";
  });
  const info = await gitDiff("/repo", "last_turn", { useWorktree: false, lastTurnBaseTree: "snaptree456" });

  const probe = calls.find((a) => gitVerb(a) === "rev-parse")!;
  assert.deepEqual(probe, ["rev-parse", "--verify", "--quiet", "snaptree456^{tree}"]);
  // The now-tree is built on a throwaway index: seed, capture every path, force-rehash tracked
  // paths, then write-tree — all with the SAME GIT_INDEX_FILE env, which no other call carries.
  const treeCalls = calls.filter((a) => ["read-tree", "add", "write-tree"].includes(gitVerb(a)));
  assert.deepEqual(
    treeCalls.map((a) => gitVerb(a)),
    ["read-tree", "add", "add", "write-tree"],
  );
  assert.deepEqual(treeCalls[1], ["add", "-A"]);
  assert.deepEqual(treeCalls[2], ["add", "--renormalize", "-u"]);
  const idxFiles = new Set(
    opts.filter((o, i) => ["read-tree", "add", "write-tree"].includes(gitVerb(calls[i]!))).map((o) => o?.env?.GIT_INDEX_FILE),
  );
  assert.equal(idxFiles.size, 1, "one shared temp index file");
  assert.ok([...idxFiles][0], "GIT_INDEX_FILE is set");
  const diffCall = calls.find((a) => gitVerb(a) === "diff")!;
  assert.deepEqual(diffCall, [...DIFF_CFG, "diff", "--no-ext-diff", "--unified=3", "snaptree456", "nowtree123", "--"]);
  assert.ok(!calls.some((a) => gitVerb(a) === "ls-files"), "no untracked synthesis — content lives in the trees");
  assert.equal(info.scope, "last_turn");
  assert.equal(info.files.length, 1);
  assert.equal(info.diffHash, computeDiffHash("diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n"));
});

test("gitDiff last_turn: a pruned snapshot tree yields the gc guidance error", async (t) => {
  t.after(() => setGitRunnerForTests());
  stubGit((args) => {
    if (gitVerb(args) === "rev-parse") throw new Error("fatal: bad object");
    return "";
  });
  await assert.rejects(
    () => gitDiff("/repo", "last_turn", { useWorktree: false, lastTurnBaseTree: "gone" }),
    /pruned by git \(gc\)/,
  );
});
