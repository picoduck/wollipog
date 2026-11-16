/**
 * Merge-queue facts for a session's pull request (#604): one read of the wait's own query, mapped to
 * the protocol facts that the Review panel and Inbox rows show. `gh` is stubbed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeQueueStatus } from "@wollipog/protocol";
import type { GhOutcome, GhRunner } from "./campaign-forge-status.js";
import { githubMergeQueueFacts, githubPullRequestFromUrl, mergeQueueFactsFromRead } from "./pull-request-queue.js";
import { PULL_REQUEST_WAIT_QUERY, readPullRequestQueue } from "./pull-request-wait.js";

const HEAD = "44579c6c25235598f1a28f8ccb0449cb8dbbc810";
const GROUP = "66679c6c25235598f1a28f8ccb0449cb8dbbc812";
const BRANCH = "feature";
const URL = "https://github.com/o/r/pull/7";

function run(name: string, conclusion: string | null, extra: Record<string, unknown> = {}) {
  return {
    __typename: "CheckRun", name, status: conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion,
    startedAt: "2026-10-12T10:00:00Z", detailsUrl: "https://github.com/o/r/actions/runs/1/job/2",
    checkSuite: { databaseId: 100, app: { databaseId: 15368 }, branch: { name: BRANCH }, createdAt: "2026-10-12T10:00:00Z" },
    isRequired: false, ...extra,
  };
}

const rollup = (nodes: unknown[]) => ({ contexts: { pageInfo: { hasNextPage: false }, nodes } });

function pr(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      repository: {
        defaultBranchRef: { name: "main" },
        pullRequest: {
          url: URL, state: "OPEN", isDraft: false, headRefOid: HEAD, headRefName: BRANCH, baseRefName: "main",
          mergeStateStatus: "CLEAN", isMergeQueueEnabled: true, mergeCommit: null, mergeQueueEntry: null,
          queueEvents: { nodes: [] }, forcePushes: { nodes: [] },
          commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: rollup([run("CI", "SUCCESS")]) } }] },
          ...overrides,
        },
      },
    },
  };
}

const ok = (value: unknown): GhOutcome => ({ stdout: JSON.stringify(value), stderr: "", code: null, timedOut: false });

function fakeGh(outcome: GhOutcome) {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    return outcome;
  };
  return { gh, calls };
}

const entry = (state: string, nodes: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  mergeQueueEntry: {
    state, position: 2, enqueuedAt: "2026-10-12T11:00:00Z",
    headCommit: { oid: GROUP, statusCheckRollup: rollup(nodes) }, ...extra,
  },
});

test("a queued pull request reports its entry, position and merge-group checks in one read", async () => {
  const fake = fakeGh(ok(pr(entry("AWAITING_CHECKS", [run("CI", null, { isRequired: true })]))));
  const read = await readPullRequestQueue("o/r", 7, fake.gh);
  assert.ok(read.ok);
  assert.deepEqual(read.value, {
    state: "open", headSha: HEAD, mergeQueueEnabled: true, removal: null,
    entry: { state: "AWAITING_CHECKS", position: 2, enqueuedAt: "2026-10-12T11:00:00Z", groupChecks: "pending" },
  });
  assert.equal(fake.calls.length, 1, "one GraphQL read, no rules or wait loop");
  assert.ok(fake.calls[0]!.includes(`query=${PULL_REQUEST_WAIT_QUERY}`));
  assert.ok(fake.calls[0]!.every((arg) => !/mutation|enqueuePullRequest|mergePullRequest/u.test(arg)), "read only");
  assert.deepEqual(mergeQueueFactsFromRead(read.value), {
    enabled: true, removal: null,
    entry: { state: "awaiting_checks", position: 2, enqueuedAt: Date.parse("2026-10-12T11:00:00Z"), groupChecks: "pending" },
  });
});

test("merge-group checks fold to one word", async () => {
  const cases: Array<[unknown[], string | null]> = [
    [[], null],
    [[run("CI", "SUCCESS")], "passing"],
    [[run("CI", "FAILURE")], "failing"],
    [[run("Lint", "SUCCESS"), run("CI", null)], "pending"],
    // A required check decides, whatever optional checks say.
    [[run("Optional", "FAILURE"), run("CI", "SUCCESS", { isRequired: true })], "passing"],
  ];
  for (const [nodes, expected] of cases) {
    const read = await readPullRequestQueue("o/r", 7, fakeGh(ok(pr(entry("AWAITING_CHECKS", nodes)))).gh);
    assert.ok(read.ok);
    assert.equal(read.value.entry?.groupChecks, expected, JSON.stringify(nodes));
  }
});

test("a removal of the current head is reported with GitHub's reason; one of an earlier head is not", async () => {
  const removed = { __typename: "RemovedFromMergeQueueEvent", createdAt: "2026-10-12T12:00:00Z", reason: "failed_checks" };
  const read = await readPullRequestQueue("o/r", 7, fakeGh(ok(pr({ queueEvents: { nodes: [removed] } }))).gh);
  assert.ok(read.ok);
  assert.deepEqual(read.value.removal, { reason: "failed_checks", removedAt: "2026-10-12T12:00:00Z" });
  const facts = mergeQueueFactsFromRead(read.value);
  assert.deepEqual(facts, { enabled: true, entry: null, removal: { reason: "failed_checks", removedAt: Date.parse("2026-10-12T12:00:00Z") } });
  assert.equal(mergeQueueStatus(facts, "OPEN")?.attention, true);

  // A head pushed after the removal reports its checks later, so the removal was an earlier head's.
  const later = run("CI", "SUCCESS", { checkSuite: { databaseId: 101, app: { databaseId: 15368 }, branch: { name: BRANCH }, createdAt: "2026-10-12T12:30:00Z" } });
  const pushed = await readPullRequestQueue("o/r", 7, fakeGh(ok(pr({
    queueEvents: { nodes: [removed] },
    commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: rollup([later]) } }] },
  }))).gh);
  assert.ok(pushed.ok);
  assert.equal(pushed.value.removal, null);
});

test("merge-group checks past the first page of contexts are unknown unless a failure is already seen", async () => {
  const paged = (nodes: unknown[]) => ({
    mergeQueueEntry: {
      state: "AWAITING_CHECKS", position: 1, enqueuedAt: "2026-10-12T11:00:00Z",
      headCommit: { oid: GROUP, statusCheckRollup: { contexts: { pageInfo: { hasNextPage: true }, nodes } } },
    },
  });
  const passingSoFar = await readPullRequestQueue("o/r", 7, fakeGh(ok(pr(paged([run("CI", "SUCCESS", { isRequired: true })])))).gh);
  assert.ok(passingSoFar.ok);
  assert.equal(passingSoFar.value.entry?.groupChecks, null, "never passing from a partial page");
  const pendingSoFar = await readPullRequestQueue("o/r", 7, fakeGh(ok(pr(paged([run("CI", null)])))).gh);
  assert.ok(pendingSoFar.ok);
  assert.equal(pendingSoFar.value.entry?.groupChecks, null);
  const failingSoFar = await readPullRequestQueue("o/r", 7, fakeGh(ok(pr(paged([run("CI", "FAILURE", { isRequired: true })])))).gh);
  assert.ok(failingSoFar.ok);
  assert.equal(failingSoFar.value.entry?.groupChecks, "failing", "a failure already seen is real");
});

test("a removal from a queue the base no longer has is never recorded or shown", async () => {
  const removed = { __typename: "RemovedFromMergeQueueEvent", createdAt: "2026-10-12T12:00:00Z", reason: "failed_checks" };
  const read = await readPullRequestQueue("o/r", 7, fakeGh(ok(pr({ isMergeQueueEnabled: false, queueEvents: { nodes: [removed] } }))).gh);
  assert.ok(read.ok);
  assert.notEqual(read.value.removal, null, "the read still attributes it to the current head");
  const facts = mergeQueueFactsFromRead(read.value);
  assert.deepEqual(facts, { enabled: false, entry: null, removal: null });
  assert.equal(mergeQueueStatus(facts, "OPEN"), null, "no queue UI");
});

test("a merged or closed pull request carries no queue facts", async () => {
  for (const state of ["MERGED", "CLOSED"]) {
    const read = await readPullRequestQueue("o/r", 7, fakeGh(ok(pr({ state, ...entry("LOCKED") }))).gh);
    assert.ok(read.ok);
    assert.equal(read.value.entry, null);
    assert.equal(mergeQueueFactsFromRead(read.value), undefined);
  }
});

test("a repository without a queue, an unknown entry state, or a failed read never claims a queue", async () => {
  const plain = await githubMergeQueueFacts(URL, fakeGh(ok(pr({ isMergeQueueEnabled: false }))).gh);
  assert.deepEqual(plain, { enabled: false, entry: null, removal: null });
  assert.equal(mergeQueueStatus(plain, "OPEN"), null, "no queue UI");

  const unknown = await githubMergeQueueFacts(URL, fakeGh(ok(pr(entry("SOMETHING_NEW")))).gh);
  assert.deepEqual(unknown, { enabled: true, entry: null, removal: null });

  const failed = await githubMergeQueueFacts(URL, fakeGh({ stdout: "", stderr: "HTTP 502", code: 1, timedOut: false }).gh);
  assert.equal(failed, undefined, "unknown, never 'not queued'");
  const errors = await githubMergeQueueFacts(URL, fakeGh(ok({ errors: [{ message: "nope" }] })).gh);
  assert.equal(errors, undefined);
});

test("only github.com pull request URLs are read", async () => {
  assert.deepEqual(githubPullRequestFromUrl("https://github.com/o/r/pull/7"), { repository: "o/r", number: 7 });
  assert.deepEqual(githubPullRequestFromUrl("https://github.com/o/r.js/pull/12/"), { repository: "o/r.js", number: 12 });
  for (const url of [
    "http://github.com/o/r/pull/7", "https://gitlab.com/o/r/-/merge_requests/7", "https://github.com/o/r/issues/7",
    "https://github.com/o/../pull/7", "https://github.example.com/o/r/pull/7", "not a url", "https://github.com/o/r/pull/0",
  ]) {
    assert.equal(githubPullRequestFromUrl(url), null, url);
  }
  const fake = fakeGh(ok(pr()));
  assert.equal(await githubMergeQueueFacts("https://gitlab.com/o/r/-/merge_requests/7", fake.gh), undefined);
  assert.equal(fake.calls.length, 0);
});
