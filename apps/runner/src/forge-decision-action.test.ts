import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhOutcome } from "./campaign-forge-status.js";
import { executeBranchDeletion, executePullRequestEnqueue } from "./forge-decision-action.js";

const HEAD = "a".repeat(40);
const MERGE = "c".repeat(40);
const ok = (stdout = ""): GhOutcome => ({ stdout, stderr: "", code: null, timedOut: false });
const failed = (stderr: string, code: number | string = 1, timedOut = false): GhOutcome => ({ stdout: "", stderr, code, timedOut });

const deletion = { kind: "branch_deletion" as const, repository: "picoduck/wollipog", branch: "agent/s_child",
  pullRequest: 4067, headSha: HEAD, mergeCommitSha: MERGE };

function repository(overrides: { pr?: Record<string, unknown>; ref?: unknown; dependents?: number } = {}) {
  return JSON.stringify({ data: { repository: { nameWithOwner: "picoduck/wollipog",
    pullRequest: { number: 4067, state: "MERGED", headRefName: "agent/s_child", headRefOid: HEAD, isCrossRepository: false,
      mergeCommit: { oid: MERGE }, ...overrides.pr },
    ref: overrides.ref === undefined ? { target: { oid: HEAD } } : overrides.ref,
    pullRequests: { totalCount: overrides.dependents ?? 0 } } } });
}

/** A fake `gh` answering the read, and a fake `git` whose push outcome the test chooses. */
function forge(read: string | GhOutcome, push: GhOutcome = ok(), origin = "git@github.com:picoduck/wollipog.git") {
  const gh: string[][] = [];
  const git: string[][] = [];
  return {
    gh, git,
    ghRunner: async (args: string[]) => { gh.push(args); return typeof read === "string" ? ok(read) : read; },
    gitRunner: async (args: string[]) => {
      git.push(args);
      return args[0] === "remote" ? ok(`${origin}\n`) : push;
    },
  };
}

test("a merged branch whose tip is the approved head is deleted by a push pinned to that head (#4067)", async () => {
  const f = forge(repository());
  assert.deepEqual(await executeBranchDeletion(deletion, f.ghRunner, f.gitRunner), { outcome: "deleted" });
  assert.deepEqual(f.git.at(-1), ["push", "--porcelain", "--no-verify",
    `--force-with-lease=refs/heads/agent/s_child:${HEAD}`, "origin", ":refs/heads/agent/s_child"]);
  assert.ok(f.gh[0]!.includes("ref=refs/heads/agent/s_child") && f.gh[0]!.includes("branch=agent/s_child"));
});

test("a deletion is refused, and nothing is pushed, when the tip moved or a dependent pull request is open (#4067)", async () => {
  const moved = forge(repository({ ref: { target: { oid: "f".repeat(40) } } }));
  assert.equal((await executeBranchDeletion(deletion, moved.ghRunner, moved.gitRunner)).refusal?.reason, "tip_moved");
  assert.equal(moved.git.length, 0);

  const dependent = forge(repository({ dependents: 1 }));
  assert.equal((await executeBranchDeletion(deletion, dependent.ghRunner, dependent.gitRunner)).refusal?.reason, "dependent_pull_request_open");
  assert.equal(dependent.git.length, 0);

  // The remote applies the lease: a tip that moves after the read refuses the push itself.
  const raced = forge(repository(), failed(" ! [rejected] (stale info)"));
  assert.equal((await executeBranchDeletion(deletion, raced.ghRunner, raced.gitRunner)).refusal?.reason, "tip_moved");

  for (const pr of [{ state: "OPEN" }, { headRefOid: "f".repeat(40) }, { headRefName: "other" }, { isCrossRepository: true },
    { mergeCommit: { oid: "d".repeat(40) } }]) {
    const mismatch = forge(repository({ pr }));
    assert.equal((await executeBranchDeletion(deletion, mismatch.ghRunner, mismatch.gitRunner)).refusal?.reason,
      "pull_request_mismatch", JSON.stringify(pr));
    assert.equal(mismatch.git.length, 0);
  }
});

test("an already deleted branch, another origin, or an unreachable forge change nothing (#4067)", async () => {
  const gone = forge(repository({ ref: null }));
  assert.deepEqual(await executeBranchDeletion(deletion, gone.ghRunner, gone.gitRunner), { outcome: "already_deleted" });
  assert.equal(gone.git.length, 0);

  const elsewhere = forge(repository(), ok(), "git@github.com:someone/fork.git");
  assert.equal((await executeBranchDeletion(deletion, elsewhere.ghRunner, elsewhere.gitRunner)).refusal?.reason, "repository_mismatch");
  assert.ok(!elsewhere.git.some((args) => args[0] === "push"));

  const offline = forge(failed("error connecting to api.github.com"));
  assert.equal((await executeBranchDeletion(deletion, offline.ghRunner, offline.gitRunner)).refusal?.reason, "forge_unavailable");

  const protectedBranch = forge(repository(), failed("remote: error: GH006: Protected branch update failed"));
  assert.equal((await executeBranchDeletion(deletion, protectedBranch.ghRunner, protectedBranch.gitRunner)).refusal?.reason, "forge_refused");

  const slow = forge(repository(), failed("", "SIGKILL", true));
  assert.deepEqual(await executeBranchDeletion(deletion, slow.ghRunner, slow.gitRunner), { outcome: "uncertain" });

  const unsafe = forge(repository());
  assert.equal((await executeBranchDeletion({ ...deletion, branch: "--delete" }, unsafe.ghRunner, unsafe.gitRunner)).refusal?.reason,
    "pull_request_mismatch");
  assert.equal(unsafe.gh.length, 0, "an unsafe ref is never put in a command");
});

const enqueue = { kind: "pr_merge_enqueue" as const, repository: "picoduck/wollipog", pullRequest: 4067, headSha: HEAD };
const pullRequest = (pr: Record<string, unknown>) => JSON.stringify({ data: { repository: { nameWithOwner: "picoduck/wollipog",
  pullRequest: { number: 4067, state: "OPEN", headRefOid: HEAD, mergeQueueEntry: null, ...pr } } } });

test("an approved enqueue runs the canonical pinned command, never --delete-branch (#4067)", async () => {
  const calls: string[][] = [];
  const gh = async (args: string[]) => { calls.push(args); return args[0] === "api" ? ok(pullRequest({})) : ok(); };
  assert.deepEqual(await executePullRequestEnqueue(enqueue, gh), { outcome: "enqueued" });
  assert.deepEqual(calls.at(-1), ["pr", "merge", "https://github.com/picoduck/wollipog/pull/4067", "--squash", "--match-head-commit", HEAD]);
  assert.ok(!calls.flat().includes("--delete-branch"));
});

test("an enqueue already in effect is reported, and a stale or refused one runs nothing more (#4067)", async () => {
  const answer = (pr: Record<string, unknown>, merge: GhOutcome = ok()) => {
    const calls: string[][] = [];
    return { calls, gh: async (args: string[]) => { calls.push(args); return args[0] === "api" ? ok(pullRequest(pr)) : merge; } };
  };
  const queued = answer({ mergeQueueEntry: { state: "QUEUED" } });
  assert.deepEqual(await executePullRequestEnqueue(enqueue, queued.gh), { outcome: "already_queued" });
  assert.equal(queued.calls.length, 1);
  const merged = answer({ state: "MERGED" });
  assert.deepEqual(await executePullRequestEnqueue(enqueue, merged.gh), { outcome: "already_merged" });
  const moved = answer({ headRefOid: "f".repeat(40) });
  assert.equal((await executePullRequestEnqueue(enqueue, moved.gh)).refusal?.reason, "pull_request_mismatch");
  assert.equal(moved.calls.length, 1);
  const closed = answer({ state: "CLOSED" });
  assert.equal((await executePullRequestEnqueue(enqueue, closed.gh)).refusal?.reason, "pull_request_mismatch");
  const unmergeable = answer({}, failed("GraphQL: Pull request is not mergeable"));
  assert.equal((await executePullRequestEnqueue(enqueue, unmergeable.gh)).refusal?.reason, "forge_refused");
  const signedOut = answer({}, failed("To get started with GitHub CLI, please run:  gh auth login", 4));
  assert.equal((await executePullRequestEnqueue(enqueue, signedOut.gh)).refusal?.reason, "forge_unavailable");
  const timedOut = answer({}, failed("", "SIGKILL", true));
  assert.deepEqual(await executePullRequestEnqueue(enqueue, timedOut.gh), { outcome: "uncertain" });
});
