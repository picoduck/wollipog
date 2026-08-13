import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GitOpError,
  commitAll,
  computeDiffHash,
  extractHunkPatch,
  extractSelectedLinePatch,
  hunkIsStaged,
  markStagedHunks,
  parseDiff,
  runGitAction,
  setGitRunnerForTests,
  stageHunk,
  type GitRunOpts,
} from "./git-ops.js";

/** Strip supported leading global options so responders/assertions can key off the git verb. */
function gitVerb(args: string[]): string {
  let i = 0;
  while (true) {
    if (args[i] === "-c") {
      i += 2;
      continue;
    }
    if (args[i] === "--no-optional-locks") {
      i += 1;
      continue;
    }
    break;
  }
  return args[i] ?? "";
}

/** The non-worktree action context used by pure-argv tests (skips assertWorktree). */
const CTX = { useWorktree: false };

/** Two-file fixture: a.ts has two hunks; b.ts has one hunk ending without a newline. */
const RAW =
  "diff --git a/a.ts b/a.ts\n" +
  "index 1111111..2222222 100644\n" +
  "--- a/a.ts\n" +
  "+++ b/a.ts\n" +
  "@@ -1,3 +1,3 @@\n" +
  " ctx1\n" +
  "-old1\n" +
  "+new1\n" +
  " ctx2\n" +
  "@@ -10,3 +10,4 @@\n" +
  " ctx3\n" +
  "+added\n" +
  " ctx4\n" +
  " ctx5\n" +
  "diff --git a/b.ts b/b.ts\n" +
  "index 3333333..4444444 100644\n" +
  "--- a/b.ts\n" +
  "+++ b/b.ts\n" +
  "@@ -1 +1 @@\n" +
  "-x\n" +
  "+y\n" +
  "\\ No newline at end of file\n";

const A_HEADER = "diff --git a/a.ts b/a.ts\nindex 1111111..2222222 100644\n--- a/a.ts\n+++ b/a.ts\n";
const A_HUNK0 = "@@ -1,3 +1,3 @@\n ctx1\n-old1\n+new1\n ctx2\n";
const A_HUNK1 = "@@ -10,3 +10,4 @@\n ctx3\n+added\n ctx4\n ctx5\n";

test("extractHunkPatch: extracts header block + the exact hunk, verbatim", () => {
  assert.equal(extractHunkPatch(RAW, "a.ts", 0), A_HEADER + A_HUNK0);
  assert.equal(extractHunkPatch(RAW, "a.ts", 1), A_HEADER + A_HUNK1);
});

test("extractHunkPatch: last file's hunk keeps the no-newline marker and ends with one terminator", () => {
  const p = extractHunkPatch(RAW, "b.ts", 0)!;
  assert.ok(p.endsWith("+y\n\\ No newline at end of file\n"));
  assert.ok(!p.endsWith("\n\n"), "exactly one trailing newline");
});

test("extractHunkPatch: CR bytes inside content lines survive byte-for-byte", () => {
  const crRaw = "diff --git a/c.ts b/c.ts\n--- a/c.ts\n+++ b/c.ts\n@@ -1 +1 @@\n-a\r\n+b\r\n";
  const p = extractHunkPatch(crRaw, "c.ts", 0)!;
  assert.ok(p.includes("-a\r\n+b\r\n"), "CRs preserved");
});

test("extractHunkPatch: unknown path, out-of-range index, binary, and renamed files yield null", () => {
  assert.equal(extractHunkPatch(RAW, "nope.ts", 0), null);
  assert.equal(extractHunkPatch(RAW, "a.ts", 2), null);
  assert.equal(extractHunkPatch(RAW, "a.ts", -1), null);
  const binRaw = "diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n";
  assert.equal(extractHunkPatch(binRaw, "img.png", 0), null);
  const renRaw =
    "diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-a\n+b\n";
  assert.equal(extractHunkPatch(renRaw, "new.ts", 0), null);
});

test("extractHunkPatch: context lines that look like diff headers don't break section boundaries", () => {
  const tricky =
    "diff --git a/t.ts b/t.ts\n--- a/t.ts\n+++ b/t.ts\n@@ -1,3 +1,3 @@\n ctx\n-diff --git a/fake b/fake\n+@@ -9 +9 @@ not a header\n ctx\n" +
    "diff --git a/u.ts b/u.ts\n--- a/u.ts\n+++ b/u.ts\n@@ -1 +1 @@\n-p\n+q\n";
  const p = extractHunkPatch(tricky, "t.ts", 0)!;
  assert.ok(p.includes("-diff --git a/fake b/fake\n"));
  assert.ok(!p.includes("u.ts"), "stops at the next real file section");
  assert.equal(extractHunkPatch(tricky, "u.ts", 0)!.split("\n")[0], "diff --git a/u.ts b/u.ts");
});

test("extractSelectedLinePatch keeps source context and omits unselected additions", () => {
  const raw = [
    "diff --git a/a.ts b/a.ts",
    "index 1111111..2222222 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,4 +1,4 @@ function demo()",
    " keep1",
    "-oldA",
    "+newA",
    "-oldB",
    "+newB",
    " keep2",
    "",
  ].join("\n");
  assert.equal(extractSelectedLinePatch(raw, "a.ts", 0, [1, 2], "stage"), [
    "diff --git a/a.ts b/a.ts",
    "index 1111111..2222222 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,4 +1,4 @@ function demo()",
    " keep1",
    "-oldA",
    "+newA",
    " oldB",
    " keep2",
    "",
  ].join("\n"));
  assert.equal(extractSelectedLinePatch(raw, "a.ts", 0, [0], "stage"), null, "context cannot be selected");
  assert.equal(extractSelectedLinePatch(raw, "a.ts", 0, [1, 1], "stage"), null, "duplicates are rejected");
  assert.equal(extractSelectedLinePatch(RAW, "b.ts", 0, [0], "stage"), null, "missing-final-newline hunks fail closed");
});

test("extractSelectedLinePatch mirrors unselected context for reverse unstaging", () => {
  const raw = [
    "diff --git a/a.ts b/a.ts",
    "index 1111111..2222222 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,4 +1,4 @@ function demo()",
    " keep1",
    "-oldA",
    "+newA",
    "-oldB",
    "+newB",
    " keep2",
    "",
  ].join("\n");
  assert.equal(extractSelectedLinePatch(raw, "a.ts", 0, [2], "unstage"), [
    "diff --git a/a.ts b/a.ts",
    "index 1111111..2222222 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,3 +1,4 @@ function demo()",
    " keep1",
    "+newA",
    " newB",
    " keep2",
    "",
  ].join("\n"));
});

test("hunkIsStaged/markStagedHunks: exact match on HEAD-side position + lines; new-side drift ignored", () => {
  const worktree = parseDiff(RAW);
  // Cached diff holds only a.ts hunk 0, with a drifted NEW-side start (as after partial staging).
  const cachedRaw = A_HEADER + "@@ -1,3 +4,3 @@\n ctx1\n-old1\n+new1\n ctx2\n";
  const cached = parseDiff(cachedRaw);
  assert.equal(hunkIsStaged(cached, "a.ts", worktree[0]!.hunks[0]!), true, "new-side drift still matches");
  assert.equal(hunkIsStaged(cached, "a.ts", worktree[0]!.hunks[1]!), false);
  assert.equal(hunkIsStaged(cached, "b.ts", worktree[1]!.hunks[0]!), false);

  markStagedHunks(worktree, cached);
  assert.equal(worktree[0]!.hunks[0]!.staged, true);
  assert.equal(worktree[0]!.hunks[1]!.staged, undefined);
  assert.equal(worktree[1]!.hunks[0]!.staged, undefined);
});

test("hunkIsStaged: identical hunk bodies at different HEAD positions do not cross-match", () => {
  const body = " ctx\n-old\n+new\n";
  const wt = parseDiff(
    "diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -1,3 +1,3 @@\n" + body + "@@ -20,3 +20,3 @@\n" + body,
  );
  const cached = parseDiff("diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -20,3 +20,3 @@\n" + body);
  assert.equal(hunkIsStaged(cached, "f.ts", wt[0]!.hunks[0]!), false, "twin body at oldStart 1 is not the staged one");
  assert.equal(hunkIsStaged(cached, "f.ts", wt[0]!.hunks[1]!), true);
});

/** Stub for stageHunk flows: worktree diff = RAW, cached diff configurable, apply recorded. */
function stubStage(cachedRaw: string) {
  const applies: { args: string[]; stdin?: string }[] = [];
  const calls: string[][] = [];
  setGitRunnerForTests(async (_cwd, args, opts?: GitRunOpts) => {
    calls.push(args);
    const verb = gitVerb(args);
    if (verb === "apply") {
      applies.push({ args, stdin: opts?.stdin });
      return "";
    }
    if (verb === "diff" && args.includes("--cached") && args.includes("--name-only")) return "";
    if (verb === "diff" && args.includes("--cached")) return cachedRaw;
    if (verb === "diff") return RAW;
    return "";
  });
  return { applies, calls };
}

const RAW_HASH = computeDiffHash(RAW); // no untracked files in the stub → manifest is empty

test("stageHunk: happy stage applies the extracted patch via stdin with --whitespace=nowarn", async (t) => {
  t.after(() => setGitRunnerForTests());
  const { applies } = stubStage("");
  const data = await stageHunk("/repo", { direction: "stage", filePath: "a.ts", hunkIndex: 0, diffHash: RAW_HASH }, CTX);
  assert.equal(applies.length, 1);
  assert.deepEqual(applies[0]!.args, ["apply", "--cached", "--whitespace=nowarn", "-"]);
  assert.equal(applies[0]!.stdin, A_HEADER + A_HUNK0);
  assert.ok(data.status, "returns a fresh status");
  assert.ok(data.diff && data.diff.scope === "uncommitted", "returns a fresh uncommitted diff");
});

test("stageHunk: unstage of a staged hunk reverse-applies", async (t) => {
  t.after(() => setGitRunnerForTests());
  const { applies } = stubStage(A_HEADER + A_HUNK0);
  await stageHunk("/repo", { direction: "unstage", filePath: "a.ts", hunkIndex: 0, diffHash: RAW_HASH }, CTX);
  assert.equal(applies.length, 1);
  assert.deepEqual(applies[0]!.args, ["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"]);
});

test("stageHunk: a stale diffHash rejects with GIT_STALE before any apply", async (t) => {
  t.after(() => setGitRunnerForTests());
  const { applies } = stubStage("");
  await assert.rejects(
    () => stageHunk("/repo", { direction: "stage", filePath: "a.ts", hunkIndex: 0, diffHash: "0".repeat(64) }, CTX),
    (err: unknown) => err instanceof GitOpError && err.code === "GIT_STALE",
  );
  assert.equal(applies.length, 0);
});

test("stageHunk: staging an already-staged hunk is a no-op success (no apply)", async (t) => {
  t.after(() => setGitRunnerForTests());
  const { applies } = stubStage(A_HEADER + A_HUNK0);
  const data = await stageHunk("/repo", { direction: "stage", filePath: "a.ts", hunkIndex: 0, diffHash: RAW_HASH }, CTX);
  assert.equal(applies.length, 0);
  assert.ok(data.diff, "still returns the fresh read");
});

test("stageHunk: unstaging a hunk that isn't staged fails honestly without touching the index", async (t) => {
  t.after(() => setGitRunnerForTests());
  const { applies } = stubStage("");
  await assert.rejects(
    () => stageHunk("/repo", { direction: "unstage", filePath: "a.ts", hunkIndex: 0, diffHash: RAW_HASH }, CTX),
    (err: unknown) => err instanceof GitOpError && err.code === "GIT_APPLY_FAILED",
  );
  assert.equal(applies.length, 0);
});

test("stageHunk: an apply rejection surfaces as GIT_APPLY_FAILED with the stderr first line", async (t) => {
  t.after(() => setGitRunnerForTests());
  setGitRunnerForTests(async (_cwd, args) => {
    const verb = gitVerb(args);
    if (verb === "apply") throw Object.assign(new Error("exit 1"), { stderr: "error: patch does not apply\nmore" });
    if (verb === "diff" && args.includes("--cached")) return "";
    if (verb === "diff") return RAW;
    return "";
  });
  await assert.rejects(
    () => stageHunk("/repo", { direction: "stage", filePath: "a.ts", hunkIndex: 0, diffHash: RAW_HASH }, CTX),
    (err: unknown) => err instanceof GitOpError && err.code === "GIT_APPLY_FAILED" && /patch does not apply/.test(err.message),
  );
});

test("stageHunk: unknown path and out-of-range hunk are plain errors (no code)", async (t) => {
  t.after(() => setGitRunnerForTests());
  stubStage("");
  await assert.rejects(
    () => stageHunk("/repo", { direction: "stage", filePath: "nope.ts", hunkIndex: 0, diffHash: RAW_HASH }, CTX),
    (err: unknown) => err instanceof Error && !(err instanceof GitOpError) && /file not found/.test(err.message),
  );
  await assert.rejects(
    () => stageHunk("/repo", { direction: "stage", filePath: "a.ts", hunkIndex: 9, diffHash: RAW_HASH }, CTX),
    (err: unknown) => err instanceof Error && !(err instanceof GitOpError) && /hunk 9 not found/.test(err.message),
  );
});

/* ---------------------- staged-aware commit + open_pr --------------------- */

test("commitAll: with staged hunks commits ONLY the index (no add -A) and reports stagedOnly", async (t) => {
  t.after(() => setGitRunnerForTests());
  const calls: string[][] = [];
  setGitRunnerForTests(async (_cwd, args) => {
    calls.push(args);
    if (gitVerb(args) === "diff" && args.includes("--name-only")) return "a.ts\n";
    if (gitVerb(args) === "rev-parse") return "abcdef12345\n";
    return "";
  });
  const info = await commitAll("/repo", "partial commit");
  assert.ok(!calls.some((a) => gitVerb(a) === "add"), "no git add -A");
  assert.equal(info.stagedOnly, true);
  assert.equal(info.filesChanged, 1);
});

test("commitAll: with a clean index falls back to add -A (legacy commit-everything)", async (t) => {
  t.after(() => setGitRunnerForTests());
  let added = false;
  const calls: string[][] = [];
  setGitRunnerForTests(async (_cwd, args) => {
    calls.push(args);
    if (gitVerb(args) === "add") {
      added = true;
      return "";
    }
    if (gitVerb(args) === "diff" && args.includes("--name-only")) return added ? "a.ts\nb.ts\n" : "";
    if (gitVerb(args) === "rev-parse") return "abcdef12345\n";
    return "";
  });
  const info = await commitAll("/repo", "everything");
  assert.ok(calls.some((a) => gitVerb(a) === "add" && a.includes("-A")));
  assert.equal(info.stagedOnly, false);
  assert.equal(info.filesChanged, 2);
});

test("commitAll: all=true forces add -A even when hunks are staged", async (t) => {
  t.after(() => setGitRunnerForTests());
  const calls: string[][] = [];
  setGitRunnerForTests(async (_cwd, args) => {
    calls.push(args);
    if (gitVerb(args) === "diff" && args.includes("--name-only")) return "a.ts\n";
    if (gitVerb(args) === "rev-parse") return "abcdef12345\n";
    return "";
  });
  const info = await commitAll("/repo", "override", true);
  assert.ok(calls.some((a) => gitVerb(a) === "add" && a.includes("-A")));
  assert.equal(info.stagedOnly, false);
});

test("runGitAction open_pr: refuses a partially staged change-set before committing anything", async (t) => {
  t.after(() => setGitRunnerForTests());
  const calls: string[][] = [];
  setGitRunnerForTests(async (_cwd, args) => {
    calls.push(args);
    const verb = gitVerb(args);
    if (verb === "rev-parse" && args.includes("--is-inside-work-tree")) return "true\n";
    if (verb === "rev-parse" && args.includes("--git-dir")) return "/repo/.git/worktrees/s1\n";
    if (verb === "status") return " M a.ts\n M b.ts\n";
    if (verb === "diff" && args.includes("--cached") && args.includes("--name-only")) return "a.ts\n";
    if (verb === "diff" && args.includes("--name-only")) return "b.ts\n";
    return "";
  });
  await assert.rejects(
    () => runGitAction("/repo", { kind: "open_pr", title: "t", body: "" }, { useWorktree: true }),
    /partially staged change-set/,
  );
  assert.ok(!calls.some((a) => gitVerb(a) === "commit"), "nothing was committed");
  assert.ok(!calls.some((a) => gitVerb(a) === "push"), "nothing was pushed");
});

/* ------------------------- review-fix regressions ------------------------ */

test("extractHunkPatch: chmod lines are stripped so per-hunk patches are content-only", () => {
  const modeRaw =
    "diff --git a/f.sh b/f.sh\n" +
    "old mode 100644\n" +
    "new mode 100755\n" +
    "index 1111111..2222222\n" +
    "--- a/f.sh\n" +
    "+++ b/f.sh\n" +
    "@@ -1 +1 @@\n" +
    "-a\n" +
    "+b\n";
  const p = extractHunkPatch(modeRaw, "f.sh", 0)!;
  assert.ok(!p.includes("old mode"), "old mode dropped");
  assert.ok(!p.includes("new mode"), "new mode dropped");
  assert.ok(p.includes("--- a/f.sh\n+++ b/f.sh\n"), "content headers kept");
});

test("extractHunkPatch: new-file and deleted-file mode lines are KEPT (added/deleted files need them)", () => {
  const addRaw = "diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+x\n";
  assert.ok(extractHunkPatch(addRaw, "n.ts", 0)!.includes("new file mode 100644\n"));
  const delRaw = "diff --git a/d.ts b/d.ts\ndeleted file mode 100644\n--- a/d.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n";
  assert.ok(extractHunkPatch(delRaw, "d.ts", 0)!.includes("deleted file mode 100644\n"));
});

const ADDED_RAW = "diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+worktree content\n";

test("stageHunk: staging an added file's hunk uses `git add` (apply --cached refuses existing index entries)", async (t) => {
  t.after(() => setGitRunnerForTests());
  const calls: string[][] = [];
  setGitRunnerForTests(async (_cwd, args) => {
    calls.push(args);
    const verb = gitVerb(args);
    if (verb === "apply") throw new Error("must not apply");
    if (verb === "diff" && args.includes("--cached")) return "";
    if (verb === "diff") return ADDED_RAW;
    return "";
  });
  await stageHunk("/repo", { direction: "stage", filePath: "new.ts", hunkIndex: 0, diffHash: computeDiffHash(ADDED_RAW) }, CTX);
  const add = calls.find((a) => gitVerb(a) === "add")!;
  assert.deepEqual(add, ["add", "--", "new.ts"]);
});

test("runGitAction commit: a stale expectStaged belief rejects with GIT_STALE before committing", async (t) => {
  t.after(() => setGitRunnerForTests());
  const calls: string[][] = [];
  setGitRunnerForTests(async (_cwd, args) => {
    calls.push(args);
    const verb = gitVerb(args);
    if (verb === "rev-parse" && args.includes("--is-inside-work-tree")) return "true\n";
    if (verb === "rev-parse" && args.includes("--git-dir")) return "/repo/.git/worktrees/s1\n";
    // The panel believed something was staged, but the index moved (external reset): nothing is.
    if (verb === "diff" && args.includes("--cached") && args.includes("--name-only")) return "";
    return "";
  });
  await assert.rejects(
    () => runGitAction("/repo", { kind: "commit", message: "m", expectStaged: true }, { useWorktree: true }),
    (err: unknown) => err instanceof GitOpError && err.code === "GIT_STALE",
  );
  assert.ok(!calls.some((a) => gitVerb(a) === "commit"), "nothing committed");

  // A matching belief proceeds (add -A path since nothing is staged).
  const info = await runGitAction("/repo", { kind: "commit", message: "m", expectStaged: false }, { useWorktree: true }).catch(
    (e: Error) => e,
  );
  // With an empty stub index the add -A path throws "nothing to commit" — the guard itself passed.
  assert.match((info as Error).message, /nothing to commit/);
});
