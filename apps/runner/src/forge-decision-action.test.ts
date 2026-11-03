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
  return JSON.stringify({ data: { repository: { id: "R_1", nameWithOwner: "picoduck/wollipog",
    pullRequest: { number: 4067, state: "MERGED", headRefName: "agent/s_child", headRefOid: HEAD, isCrossRepository: false,
      mergeCommit: { oid: MERGE }, ...overrides.pr },
    ref: overrides.ref === undefined ? { target: { oid: HEAD } } : overrides.ref,
    pullRequests: { totalCount: overrides.dependents ?? 0 } } } });
}

const refAfter = (ref: unknown) => JSON.stringify({ data: { repository: { nameWithOwner: "picoduck/wollipog", ref } } });

/** A fake `gh`: the full read, the `updateRefs` mutation, and the re-read after a refused update. */
function forge(read: string | GhOutcome, mutation: GhOutcome = ok(JSON.stringify({ data: { updateRefs: { clientMutationId: null } } })),
  reread: GhOutcome = ok(refAfter({ target: { oid: HEAD } }))) {
  const calls: string[][] = [];
  return {
    calls,
    gh: async (args: string[]) => {
      calls.push(args);
      const query = args.find((arg) => arg.startsWith("query=")) ?? "";
      if (query.includes("updateRefs")) return mutation;
      if (query.includes("pullRequests(states")) return typeof read === "string" ? ok(read) : read;
      return reread;
    },
  };
}
const mutations = (calls: string[][]) => calls.filter((args) => args.some((arg) => arg.includes("updateRefs")));

test("a merged branch whose tip is the approved head is deleted by a compare-and-delete pinned to that head (#4067)", async () => {
  const f = forge(repository());
  assert.deepEqual(await executeBranchDeletion(deletion, f.gh), { outcome: "deleted" });
  const [mutation] = mutations(f.calls);
  assert.ok(mutation, "one updateRefs call");
  for (const field of ["repositoryId=R_1", "ref=refs/heads/agent/s_child", `before=${HEAD}`, `after=${"0".repeat(40)}`]) {
    assert.ok(mutation.includes(field), field);
  }
  assert.ok(f.calls.every((args) => args[0] === "api"), "only gh api against the explicit repository; no git");
});

test("a deletion is refused, and nothing is deleted, when the tip moved or a dependent pull request is open (#4067)", async () => {
  const moved = forge(repository({ ref: { target: { oid: "f".repeat(40) } } }));
  assert.equal((await executeBranchDeletion(deletion, moved.gh)).refusal?.reason, "tip_moved");
  assert.equal(mutations(moved.calls).length, 0);

  const dependent = forge(repository({ dependents: 1 }));
  assert.equal((await executeBranchDeletion(deletion, dependent.gh)).refusal?.reason, "dependent_pull_request_open");
  assert.equal(mutations(dependent.calls).length, 0);

  // GitHub applies beforeOid: a tip that moves after the read refuses the update itself.
  const raced = forge(repository(), failed("GraphQL: A ref update failed"), ok(refAfter({ target: { oid: "f".repeat(40) } })));
  assert.equal((await executeBranchDeletion(deletion, raced.gh)).refusal?.reason, "tip_moved");

  for (const pr of [{ state: "OPEN" }, { headRefOid: "f".repeat(40) }, { headRefName: "other" }, { isCrossRepository: true },
    { mergeCommit: { oid: "d".repeat(40) } }]) {
    const mismatch = forge(repository({ pr }));
    assert.equal((await executeBranchDeletion(deletion, mismatch.gh)).refusal?.reason, "pull_request_mismatch", JSON.stringify(pr));
    assert.equal(mutations(mismatch.calls).length, 0);
  }
});

test("an already deleted branch, an unreachable forge, or a protected branch change nothing (#4067)", async () => {
  const gone = forge(repository({ ref: null }));
  assert.deepEqual(await executeBranchDeletion(deletion, gone.gh), { outcome: "already_deleted" });
  assert.equal(mutations(gone.calls).length, 0);

  const offline = forge(failed("error connecting to api.github.com"));
  assert.equal((await executeBranchDeletion(deletion, offline.gh)).refusal?.reason, "forge_unavailable");

  const protectedBranch = forge(repository(), failed("GraphQL: Cannot delete this protected ref"));
  assert.equal((await executeBranchDeletion(deletion, protectedBranch.gh)).refusal?.reason, "forge_refused");

  const deletedMeanwhile = forge(repository(), failed("GraphQL: A ref update failed"), ok(refAfter(null)));
  assert.deepEqual(await executeBranchDeletion(deletion, deletedMeanwhile.gh), { outcome: "already_deleted" });

  const slow = forge(repository(), failed("", "SIGKILL", true));
  assert.deepEqual(await executeBranchDeletion(deletion, slow.gh), { outcome: "uncertain" });

  const unsafe = forge(repository());
  assert.equal((await executeBranchDeletion({ ...deletion, branch: "--delete" }, unsafe.gh)).refusal?.reason, "pull_request_mismatch");
  assert.equal(unsafe.calls.length, 0, "an unsafe ref is never put in a command");
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
  // A transport failure may follow an accepted enqueue: uncertain, never a retryable refusal.
  for (const stderr of ["Post \"https://api.github.com/graphql\": read tcp: connection reset by peer", "HTTP 502: Bad Gateway",
    "something unexpected happened"]) {
    const ambiguous = answer({}, failed(stderr));
    assert.deepEqual(await executePullRequestEnqueue(enqueue, ambiguous.gh), { outcome: "uncertain" }, stderr);
  }
  const limited = answer({}, failed("GraphQL: API rate limit exceeded"));
  assert.equal((await executePullRequestEnqueue(enqueue, limited.gh)).refusal?.reason, "forge_unavailable");
});
