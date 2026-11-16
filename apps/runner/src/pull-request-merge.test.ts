/**
 * Gated enqueue or direct merge (#604): facts from the wait's own evaluation plus the repository's
 * merge settings, the gate re-run on a fresh read, one pinned mutation, and the result read back.
 * `gh` is stubbed; nothing touches GitHub.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhOutcome, GhRunner } from "./campaign-forge-status.js";
import { directMergeMethod, mergePullRequest, readPullRequestMergeFacts, requiredChecksFromWait } from "./pull-request-merge.js";
import { PULL_REQUEST_WAIT_QUERY, type PullRequestWaitSummary } from "./pull-request-wait.js";

const HEAD = "44579c6c25235598f1a28f8ccb0449cb8dbbc810";
const OTHER = "55579c6c25235598f1a28f8ccb0449cb8dbbc811";
const URL = "https://github.com/o/r/pull/7";
const AGGREGATOR = "Typecheck, Test & Sidecar Bundle";

const ok = (value: unknown): GhOutcome => ({ stdout: JSON.stringify(value), stderr: "", code: null, timedOut: false });

function check(conclusion: string | null) {
  return {
    __typename: "CheckRun", name: AGGREGATOR, status: conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion,
    startedAt: "2026-10-12T10:00:00Z", detailsUrl: "https://github.com/o/r/actions/runs/1/job/2",
    checkSuite: { databaseId: 100, app: { databaseId: 15368 } }, isRequired: true,
  };
}

function pr(overrides: Record<string, unknown> = {}, conclusion: string | null = "SUCCESS") {
  return {
    data: { repository: { defaultBranchRef: { name: "main" }, pullRequest: {
      url: URL, state: "OPEN", isDraft: false, headRefOid: HEAD, headRefName: "feature", baseRefName: "main",
      mergeStateStatus: "CLEAN", isMergeQueueEnabled: true, mergeCommit: null, mergeQueueEntry: null,
      queueEvents: { nodes: [] }, forcePushes: { nodes: [] },
      commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [check(conclusion)] } } } }] },
      ...overrides,
    } } },
  };
}

function settings(overrides: Record<string, unknown> = {}, pullRequest: Record<string, unknown> = {}) {
  return { data: { repository: {
    nameWithOwner: "o/r", viewerPermission: "WRITE", viewerDefaultMergeMethod: "SQUASH", deleteBranchOnMerge: false,
    squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: false,
    pullRequest: { id: "PR_node", number: 7, headRefOid: HEAD, isMergeQueueEnabled: true, isInMergeQueue: false, ...pullRequest },
    ...overrides,
  } } };
}

const RULES = [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: AGGREGATOR }] } }];

/** A scripted gh: the wait query answers `before` until a mutation runs, then `after`. */
function fakeGh(options: {
  settings?: GhOutcome; before?: GhOutcome; after?: GhOutcome; mutation?: GhOutcome;
}) {
  const calls: string[][] = [];
  let mutated = false;
  const gh: GhRunner = async (args) => {
    calls.push(args);
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (/enqueuePullRequest|mergePullRequest\(/u.test(query)) {
      mutated = true;
      return options.mutation ?? ok({ data: {} });
    }
    if (query.includes("viewerPermission")) return options.settings ?? ok(settings());
    if (query === `query=${PULL_REQUEST_WAIT_QUERY}`) return (mutated ? options.after : undefined) ?? options.before ?? ok(pr());
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (path.includes("/rules/branches/")) return ok(RULES);
    if (path.includes("/branches/")) return ok({ name: "main", protection: { enabled: true } });
    if (path.includes("/actions/runs")) return ok({ total_count: 0, workflow_runs: [] });
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { gh, calls, mutations: () => calls.filter((args) => args.some((arg) => /^query=mutation/u.test(arg))) };
}

const queued = (state = "QUEUED", position = 3) => ok(pr({ mergeQueueEntry: {
  state, position, enqueuedAt: "2026-10-12T11:00:00Z", headCommit: null,
} }));

test("facts combine the wait's required-check evaluation with the repository's merge settings", async () => {
  const read = await readPullRequestMergeFacts(URL, fakeGh({}).gh, () => 42);
  assert.ok(read.ok);
  assert.equal(read.nodeId, "PR_node");
  assert.deepEqual(read.facts, {
    url: URL, repository: "o/r", number: 7, state: "open", headSha: HEAD, isDraft: false, baseRef: "main",
    mergeQueueEnabled: true, inMergeQueue: false, mergeStateStatus: "CLEAN",
    requiredChecks: { state: "passed", failing: [], pending: [] }, viewerPermission: "write",
    mergeMethod: "squash", deleteBranchOnMerge: false, observedAt: 42,
  });
  const pending = await readPullRequestMergeFacts(URL, fakeGh({ before: ok(pr({}, null)) }).gh);
  assert.ok(pending.ok);
  assert.deepEqual(pending.facts.requiredChecks, { state: "pending", failing: [], pending: [AGGREGATOR] });
  const failing = await readPullRequestMergeFacts(URL, fakeGh({ before: ok(pr({}, "FAILURE")) }).gh);
  assert.ok(failing.ok);
  assert.deepEqual(failing.facts.requiredChecks, { state: "failed", failing: [AGGREGATOR], pending: [] });
});

test("a read refuses anything but a readable github.com pull request", async () => {
  const gitlab = await readPullRequestMergeFacts("https://gitlab.com/o/r/-/merge_requests/7", fakeGh({}).gh);
  assert.deepEqual(gitlab, { ok: false, reason: "Merging from Wollipog supports github.com pull requests only." });
  const unauthenticated = await readPullRequestMergeFacts(URL, fakeGh({ settings: { stdout: "", stderr: "gh auth login", code: 4, timedOut: false } }).gh);
  assert.equal(unauthenticated.ok, false);
  const other = await readPullRequestMergeFacts(URL, fakeGh({ settings: ok(settings({ nameWithOwner: "x/y" })) }).gh);
  assert.deepEqual(other, { ok: false, reason: "GitHub returned an unexpected answer for the pull request." });
});

test("an enqueue is pinned to the confirmed head, deletes nothing, and is proven by the read-back entry", async () => {
  const fake = fakeGh({ after: queued() });
  const result = await mergePullRequest({ pullRequestUrl: URL, headSha: HEAD, mode: "enqueue" }, fake.gh);
  assert.deepEqual(result, {
    outcome: "enqueued", message: "Added to the merge queue at position 3.", mode: "enqueue", headSha: HEAD, state: "open", queuePosition: 3,
  });
  assert.equal(fake.mutations().length, 1);
  const args = fake.mutations()[0]!;
  assert.ok(args.some((arg) => arg.includes("enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head})")));
  assert.ok(args.includes("id=PR_node"));
  assert.ok(args.includes(`head=${HEAD}`));
  assert.ok(fake.calls.every((call) => !call.some((arg) => /--delete-branch|deleteRef|enablePullRequestAutoMerge|--auto\b|-X\s*DELETE/iu.test(arg))),
    "never deletes a branch or arms auto-merge");
  assert.ok(fake.mutations().every((call) => !call.some((arg) => /delete/iu.test(arg))));
  assert.ok(fake.calls.every((call) => call[0] === "api" && call[1] !== "-X" && !call.includes("pr")), "GraphQL and REST reads only, never gh pr merge");
});

test("without a queue, a direct merge uses the repository's method and is proven by the read-back state", async () => {
  const fake = fakeGh({
    settings: ok(settings({ viewerDefaultMergeMethod: "REBASE", squashMergeAllowed: false }, { isMergeQueueEnabled: false })),
    after: ok(pr({ state: "MERGED", mergeCommit: { oid: OTHER } })),
  });
  const result = await mergePullRequest({ pullRequestUrl: URL, headSha: HEAD, mode: "merge" }, fake.gh);
  assert.equal(result.outcome, "merged");
  assert.equal(result.state, "merged");
  assert.equal(result.message, "Merged with the repository's merge method.");
  const args = fake.mutations()[0]!;
  assert.ok(args.some((arg) => arg.includes("mergePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head,mergeMethod:$method})")));
  assert.ok(args.includes("method=MERGE"), "rebase is not allowed, so the first allowed method");
});

test("a moved head, a changed queue setting, or a failing gate refuses before any mutation", async () => {
  const cases: Array<[Parameters<typeof fakeGh>[0], { headSha: string; mode: "enqueue" | "merge" }, RegExp]> = [
    [{ before: ok(pr({ headRefOid: OTHER, commits: { nodes: [{ commit: { oid: OTHER, statusCheckRollup: null } }] } })) },
      { headSha: HEAD, mode: "enqueue" }, /head changed since you confirmed/u],
    [{}, { headSha: HEAD, mode: "merge" }, /merge queue setting changed/u],
    [{ before: ok(pr({}, null)) }, { headSha: HEAD, mode: "enqueue" }, /^Required checks haven't passed/u],
    [{ settings: ok(settings({ viewerPermission: "READ" })) }, { headSha: HEAD, mode: "enqueue" }, /can't merge into o\/r/u],
    [{ before: queued() }, { headSha: HEAD, mode: "enqueue" }, /already in the merge queue/u],
    [{ before: ok(pr({ state: "MERGED" })) }, { headSha: HEAD, mode: "enqueue" }, /already merged/u],
  ];
  for (const [options, request, message] of cases) {
    const fake = fakeGh(options);
    const result = await mergePullRequest({ pullRequestUrl: URL, ...request }, fake.gh);
    assert.equal(result.outcome, "refused", message.source);
    assert.match(result.message, message);
    assert.equal(fake.mutations().length, 0, message.source);
  }
});

test("GitHub's own refusal is reported, and an unconfirmed request is uncertain rather than a success", async () => {
  const refused = fakeGh({ mutation: { stdout: JSON.stringify({ errors: [{ message: "Pull request is not mergeable" }] }), stderr: "gh: error", code: 1, timedOut: false } });
  const refusal = await mergePullRequest({ pullRequestUrl: URL, headSha: HEAD, mode: "enqueue" }, refused.gh);
  assert.deepEqual([refusal.outcome, refusal.message, refusal.state], ["refused", "GitHub refused: Pull request is not mergeable", "open"]);

  const lost = fakeGh({ mutation: { stdout: "", stderr: "connection reset", code: "ECONNRESET", timedOut: false } });
  const uncertain = await mergePullRequest({ pullRequestUrl: URL, headSha: HEAD, mode: "enqueue" }, lost.gh);
  assert.equal(uncertain.outcome, "uncertain");
  assert.match(uncertain.message, /Check the pull request before trying again\.$/u);

  // A transport failure whose request landed anyway is proven by the read-back.
  const landed = fakeGh({ mutation: { stdout: "", stderr: "timeout", code: "ETIMEDOUT", timedOut: true }, after: queued("AWAITING_CHECKS", 1) });
  assert.equal((await mergePullRequest({ pullRequestUrl: URL, headSha: HEAD, mode: "enqueue" }, landed.gh)).outcome, "enqueued");

  const quiet = fakeGh({});
  const accepted = await mergePullRequest({ pullRequestUrl: URL, headSha: HEAD, mode: "enqueue" }, quiet.gh);
  assert.equal(accepted.outcome, "uncertain", "accepted but not seen in the queue is not reported as enqueued");
});

test("a merge of another head after the gate is never reported as this request's success", async () => {
  const fake = fakeGh({
    mutation: { stdout: JSON.stringify({ errors: [{ message: "Head branch was modified. Review and try the merge again." }] }), stderr: "", code: 1, timedOut: false },
    after: ok(pr({ state: "MERGED", headRefOid: OTHER, mergeCommit: { oid: OTHER },
      commits: { nodes: [{ commit: { oid: OTHER, statusCheckRollup: null } }] } })),
  });
  const result = await mergePullRequest({ pullRequestUrl: URL, headSha: HEAD, mode: "enqueue" }, fake.gh);
  assert.equal(result.outcome, "refused");
  assert.equal(result.state, "merged");
  assert.match(result.message, /merged at another head than the one you confirmed/u);
  // Without any refusal from GitHub, a merge at another head still is not this request's.
  const quiet = fakeGh({ after: ok(pr({ state: "MERGED", headRefOid: OTHER, commits: { nodes: [{ commit: { oid: OTHER, statusCheckRollup: null } }] } })) });
  assert.equal((await mergePullRequest({ pullRequestUrl: URL, headSha: HEAD, mode: "enqueue" }, quiet.gh)).outcome, "refused");
});

test("the direct merge method prefers the login's default when the repository allows it", () => {
  assert.equal(directMergeMethod({ viewerDefaultMergeMethod: "SQUASH", squashMergeAllowed: true, mergeCommitAllowed: true }), "squash");
  assert.equal(directMergeMethod({ viewerDefaultMergeMethod: "REBASE", squashMergeAllowed: true, rebaseMergeAllowed: false }), "squash");
  assert.equal(directMergeMethod({ viewerDefaultMergeMethod: "MERGE", rebaseMergeAllowed: true }), "rebase");
  assert.equal(directMergeMethod({}), null);
});

test("required checks pass only on GitHub's decisive pass or a complete, all-passing read", () => {
  const summary = (overrides: Partial<PullRequestWaitSummary>, required: PullRequestWaitSummary["checks"]["required"], truncated = false) => ({
    outcome: "timeout", requiredCheckNames: [AGGREGATOR],
    checks: { sha: HEAD, required, other: { passed: 0, failed: 0, pending: 0 }, failedJobs: [], ...(truncated ? { truncated: true as const } : {}) },
    ...overrides,
  }) as PullRequestWaitSummary;
  const passed = [{ name: AGGREGATOR, state: "passed" as const, reported: true }];
  assert.equal(requiredChecksFromWait(summary({ outcome: "checks_passed" }, [])).state, "passed");
  assert.equal(requiredChecksFromWait(summary({ outcome: "no_required_checks", requiredCheckNames: [] }, [])).state, "none");
  // A removed or queued pull request's head checks still count, read from the list.
  assert.equal(requiredChecksFromWait(summary({ outcome: "timeout" }, passed)).state, "passed");
  assert.equal(requiredChecksFromWait(summary({}, passed, true)).state, "pending", "a cut list is never passed");
  assert.equal(requiredChecksFromWait(summary({}, [{ name: AGGREGATOR, state: "pending", reported: false }])).state, "pending");
  assert.equal(requiredChecksFromWait(summary({}, [])).state, "pending", "required by rules but not listed");
  assert.deepEqual(requiredChecksFromWait(summary({}, [...passed, { name: "lint", state: "failed", reported: true }])),
    { state: "failed", failing: ["lint"], pending: [] });
});
