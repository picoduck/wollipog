/**
 * Pull request wait (#3081): required checks come from the base branch's rules, an unreported
 * required check is pending, and every outcome returns one bounded summary. `gh` and the clock are
 * stubbed, so no test touches GitHub or sleeps.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhOutcome, GhRunner } from "./campaign-forge-status.js";
import {
  evaluateCommitChecks,
  parsePullRequestRef,
  PULL_REQUEST_WAIT_QUERY,
  requiredCheckNames,
  waitForPullRequest,
  type PullRequestWaitDeps,
} from "./pull-request-wait.js";

const HEAD = "44579c6c25235598f1a28f8ccb0449cb8dbbc810";
const OTHER_HEAD = "55579c6c25235598f1a28f8ccb0449cb8dbbc811";
const GROUP = "66679c6c25235598f1a28f8ccb0449cb8dbbc812";
const MERGE = "dd08b41b0000000000000000000000000000beef";
const AGGREGATOR = "Typecheck, Test & Sidecar Bundle";

function run(name: string, conclusion: string | null, extra: Record<string, unknown> = {}) {
  return {
    __typename: "CheckRun", name, status: conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion,
    startedAt: "2026-10-12T10:00:00Z", detailsUrl: `https://github.com/o/r/actions/runs/1/job/${encodeURIComponent(name)}`,
    isRequired: false, ...extra,
  };
}

function rollup(nodes: unknown[], hasNextPage = false) {
  return { contexts: { pageInfo: { hasNextPage }, nodes } };
}

function pr(overrides: Record<string, unknown> = {}, nodes: unknown[] = []) {
  return {
    data: {
      repository: {
        defaultBranchRef: { name: "main" },
        pullRequest: {
          url: "https://github.com/o/r/pull/7", state: "OPEN", isDraft: false, headRefOid: HEAD, baseRefName: "main",
          mergeStateStatus: "BLOCKED", mergeCommit: null, mergeQueueEntry: null,
          commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: rollup(nodes) } }] },
          ...overrides,
        },
      },
    },
  };
}

const ok = (value: unknown): GhOutcome => ({ stdout: JSON.stringify(value), stderr: "", code: null, timedOut: false });
const failed = (stderr: string, code: number | string = 1): GhOutcome => ({ stdout: "", stderr, code, timedOut: false });

const RULESET = [{ type: "pull_request" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: AGGREGATOR }] } }];

/** A scripted `gh`: each GraphQL read takes the next entry (the last one repeats). */
function fakeGh(reads: GhOutcome[], options: { rules?: GhOutcome; branch?: GhOutcome } = {}) {
  const calls: string[][] = [];
  let index = 0;
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (args.includes("graphql")) return reads[Math.min(index++, reads.length - 1)]!;
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (path.includes("/rules/branches/")) return options.rules ?? ok(RULESET);
    if (path.includes("/branches/")) return options.branch ?? ok({ name: "main", protected: true, protection: { enabled: true } });
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { gh, calls, graphqlCalls: () => calls.filter((args) => args.includes("graphql")).length };
}

function clock(): Required<Pick<PullRequestWaitDeps, "now" | "sleep">> & { sleeps: number[] } {
  let time = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); time += milliseconds; },
  };
}

test("an unreported required check is pending, then passing returns checks_passed", async () => {
  const fake = fakeGh([
    ok(pr({}, [run("Lint", "SUCCESS")])),
    ok(pr({}, [run("Lint", "SUCCESS"), run(AGGREGATOR, null)])),
    ok(pr({ mergeStateStatus: "CLEAN" }, [run("Lint", "SUCCESS"), run(AGGREGATOR, "SUCCESS")])),
  ]);
  const time = clock();
  const result = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 600_000 }, { gh: fake.gh, ...time });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.summary.outcome, "checks_passed");
  assert.equal(result.summary.polls, 3);
  assert.deepEqual(time.sleeps, [30_000, 30_000]);
  assert.deepEqual(result.summary.requiredCheckNames, [AGGREGATOR]);
  assert.deepEqual(result.summary.checks.required.map(({ name, state, reported }) => ({ name, state, reported })),
    [{ name: AGGREGATOR, state: "passed", reported: true }]);
  assert.deepEqual(result.summary.checks.other, { passed: 1, failed: 0, pending: 0 });
  // The rules are read once per base, not once per poll.
  assert.equal(fake.calls.filter((args) => args.some((arg) => arg.includes("/rules/branches/"))).length, 1);
});

test("the first poll reports a missing required check as pending and not reported", async () => {
  const fake = fakeGh([ok(pr({}, [run("Lint", "SUCCESS")]))]);
  const result = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 1 }, { gh: fake.gh, ...clock() });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "timeout");
  assert.deepEqual(result.summary.checks.required, [{ name: AGGREGATOR, state: "pending", reported: false }]);
});

test("a failing required check returns checks_failed with failed jobs and run links, required first", async () => {
  const fake = fakeGh([ok(pr({}, [
    run("Browser End-to-End Tests", "FAILURE"),
    run(AGGREGATOR, "FAILURE"),
    run("Lint", "SUCCESS"),
  ]))]);
  const result = await waitForPullRequest({ repository: "o/r", number: 7 }, { gh: fake.gh, ...clock() });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "checks_failed");
  assert.deepEqual(result.summary.checks.failedJobs.map(({ name, required, conclusion }) => ({ name, required, conclusion })), [
    { name: AGGREGATOR, required: true, conclusion: "FAILURE" },
    { name: "Browser End-to-End Tests", required: false, conclusion: "FAILURE" },
  ]);
  assert.match(result.summary.checks.failedJobs[0]!.url!, /^https:\/\/github\.com\/o\/r\/actions\/runs\//u);
});

test("a non-required failure keeps waiting unless returnOnAnyFailure is set", async () => {
  const nodes = [run("Platform Isolation", "FAILURE"), run(AGGREGATOR, null)];
  const waiting = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 90_000 },
    { gh: fakeGh([ok(pr({}, nodes))]).gh, ...clock() });
  assert.ok(waiting.ok);
  assert.equal(waiting.summary.outcome, "timeout");
  assert.equal(waiting.summary.polls, 4);
  assert.equal(waiting.summary.waitedMs, 90_000);

  const early = await waitForPullRequest({ repository: "o/r", number: 7, returnOnAnyFailure: true },
    { gh: fakeGh([ok(pr({}, nodes))]).gh, ...clock() });
  assert.ok(early.ok);
  assert.equal(early.summary.outcome, "checks_failed");
  assert.equal(early.summary.checks.failedJobs[0]!.name, "Platform Isolation");
});

test("a base without required checks returns no_required_checks at once instead of waiting forever", async () => {
  const fake = fakeGh([ok(pr({ baseRefName: "feature/parent" }, [run("Lint", null)]))], { rules: ok([]) });
  const time = clock();
  const result = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 3_600_000 }, { gh: fake.gh, ...time });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "no_required_checks");
  assert.deepEqual(result.summary.requiredCheckNames, []);
  assert.equal(result.summary.baseRef, "feature/parent");
  assert.equal(result.summary.defaultBranch, "main");
  assert.deepEqual(time.sleeps, []);
  assert.ok(fake.calls.some((args) => args.includes("repos/o/r/rules/branches/feature%2Fparent?per_page=100")));
});

test("required checks are the union of rulesets, classic protection, and GitHub's own isRequired marks", async () => {
  const branch = ok({ protection: { enabled: true, required_status_checks: { contexts: ["ci/legacy"], checks: [{ context: "Build" }] } } });
  const fake = fakeGh([ok(pr({}, [run("Marked", null, { isRequired: true })]))], { branch });
  const names = await requiredCheckNames(fake.gh, "o/r", "main");
  assert.deepEqual(names, { ok: true, names: ["Build", AGGREGATOR, "ci/legacy"] });
  const result = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 1 }, { gh: fake.gh, ...clock() });
  assert.ok(result.ok);
  assert.deepEqual(result.summary.checks.required.map((check) => check.name), ["Build", "Marked", AGGREGATOR, "ci/legacy"]);
});

test("an unreadable base never reads as nothing required", async () => {
  const fake = fakeGh([ok(pr())], { rules: failed("gh: Not Found (HTTP 404)") });
  const result = await waitForPullRequest({ repository: "o/r", number: 7 }, { gh: fake.gh, ...clock() });
  assert.deepEqual(result, { ok: false, error: "could not read the rules for main: http_404 (gh: Not Found (HTTP 404))" });
});

test("of several runs sharing a name, the latest started wins", () => {
  const verdict = evaluateCommitChecks(HEAD, rollup([
    run(AGGREGATOR, "FAILURE", { startedAt: "2026-10-12T09:00:00Z" }),
    run(AGGREGATOR, "SUCCESS", { startedAt: "2026-10-12T11:00:00Z" }),
  ]), [AGGREGATOR]);
  assert.equal(verdict.requiredState, "passed");
  const queued = evaluateCommitChecks(HEAD, rollup([
    run(AGGREGATOR, "SUCCESS", { startedAt: "2026-10-12T09:00:00Z" }),
    run(AGGREGATOR, null, { status: "QUEUED", startedAt: null }),
  ]), [AGGREGATOR]);
  assert.equal(queued.requiredState, "pending");
});

test("status contexts and skipped or neutral check runs follow GitHub's required-check rules", () => {
  const verdict = evaluateCommitChecks(HEAD, rollup([
    { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS", createdAt: "x", targetUrl: "https://ci.example/1" },
    run("Skipped", "SKIPPED"),
    run("Neutral", "NEUTRAL"),
  ]), ["ci/legacy", "Skipped", "Neutral"]);
  assert.equal(verdict.requiredState, "passed");
  const failing = evaluateCommitChecks(HEAD, rollup([
    { __typename: "StatusContext", context: "ci/legacy", state: "ERROR", createdAt: "x", targetUrl: "javascript:alert(1)" },
  ]), ["ci/legacy"]);
  assert.equal(failing.requiredState, "failed");
  assert.deepEqual(failing.summary.failedJobs, [{ name: "ci/legacy", required: true, conclusion: "ERROR" }]);
});

test("the summary stays bounded while the verdict covers every required check", () => {
  const names = Array.from({ length: 60 }, (_, index) => `required-${String(index).padStart(2, "0")}-${"x".repeat(300)}`);
  const nodes = [
    ...names.map((name, index) => run(name, index === 59 ? "FAILURE" : "SUCCESS")),
    ...Array.from({ length: 30 }, (_, index) => run(`optional-${index}`, "FAILURE", { detailsUrl: `https://x/${"y".repeat(900)}` })),
  ];
  const verdict = evaluateCommitChecks(HEAD, rollup(nodes, true), names);
  assert.equal(verdict.requiredState, "failed", "a failure past the listed bound still fails");
  assert.equal(verdict.summary.required.length, 30);
  assert.equal(verdict.summary.failedJobs.length, 20);
  assert.equal(verdict.summary.failedJobs[0]!.required, true);
  assert.equal(verdict.summary.truncated, true);
  assert.ok(verdict.summary.required.every((check) => check.name.length <= 120));
  assert.ok(verdict.summary.failedJobs.every((job) => (job.url?.length ?? 0) <= 300));
  assert.ok(JSON.stringify(verdict.summary).length < 16_000);
});

test("a merge-queue entry waits until the pull request merges", async () => {
  const queued = (state: string, position: number) => ok(pr({
    mergeQueueEntry: { position, state, enqueuedAt: "2026-10-12T10:00:00Z", headCommit: { oid: GROUP, statusCheckRollup: rollup([run(AGGREGATOR, null)]) } },
  }, [run(AGGREGATOR, "SUCCESS")]));
  const fake = fakeGh([
    queued("QUEUED", 2),
    queued("AWAITING_CHECKS", 1),
    ok(pr({ state: "MERGED", mergeCommit: { oid: MERGE } }, [run(AGGREGATOR, "SUCCESS")])),
  ]);
  const result = await waitForPullRequest({ repository: "o/r", number: 7, headSha: HEAD, timeoutMs: 600_000 }, { gh: fake.gh, ...clock() });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "merged");
  assert.equal(result.summary.merged, true);
  assert.equal(result.summary.mergeCommitSha, MERGE);
  assert.equal(fake.graphqlCalls(), 3, "passing PR checks do not end a wait while the pull request is queued");
});

test("the queue summary carries the merge group's checks and a failed group returns queue_failed", async () => {
  const fake = fakeGh([ok(pr({
    mergeQueueEntry: {
      position: 0, state: "UNMERGEABLE", enqueuedAt: "2026-10-12T10:00:00Z",
      headCommit: { oid: GROUP, statusCheckRollup: rollup([run(AGGREGATOR, "FAILURE"), run("Browser End-to-End Tests", "FAILURE")]) },
    },
  }, [run(AGGREGATOR, "SUCCESS")]))]);
  const result = await waitForPullRequest({ repository: "o/r", number: 7 }, { gh: fake.gh, ...clock() });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "queue_failed");
  assert.equal(result.summary.mergeQueue?.state, "UNMERGEABLE");
  assert.equal(result.summary.mergeQueue?.position, 0);
  assert.equal(result.summary.mergeQueue?.checks?.sha, GROUP);
  assert.deepEqual(result.summary.mergeQueue?.checks?.failedJobs.map((job) => job.name), [AGGREGATOR, "Browser End-to-End Tests"]);
});

test("an entry that leaves the queue without merging is an ejection only once confirmed", async () => {
  const entry = { position: 1, state: "AWAITING_CHECKS", enqueuedAt: null, headCommit: null };
  const ejected = fakeGh([ok(pr({ mergeQueueEntry: entry })), ok(pr()), ok(pr())]);
  const time = clock();
  const result = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 600_000 }, { gh: ejected.gh, ...time });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "queue_ejected");
  assert.equal(result.summary.mergeQueue, null);
  assert.deepEqual(time.sleeps, [30_000, 10_000]);

  // GitHub can drop the entry a moment before the pull request reads MERGED.
  const merged = fakeGh([ok(pr({ mergeQueueEntry: entry })), ok(pr()), ok(pr({ state: "MERGED", mergeCommit: { oid: MERGE } }))]);
  const confirmed = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 600_000 }, { gh: merged.gh, ...clock() });
  assert.ok(confirmed.ok);
  assert.equal(confirmed.summary.outcome, "merged");

  // Unconfirmed at the deadline it is a timeout, never a guessed ejection.
  const late = fakeGh([ok(pr({ mergeQueueEntry: entry })), ok(pr())]);
  const unconfirmed = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 30_000 }, { gh: late.gh, ...clock() });
  assert.ok(unconfirmed.ok);
  assert.equal(unconfirmed.summary.outcome, "timeout");
});

test("a head other than the reviewed one returns head_changed, before or during the wait", async () => {
  const stale = await waitForPullRequest({ repository: "o/r", number: 7, headSha: OTHER_HEAD }, { gh: fakeGh([ok(pr())]).gh, ...clock() });
  assert.ok(stale.ok);
  assert.equal(stale.summary.outcome, "head_changed");
  assert.equal(stale.summary.headSha, HEAD);
  assert.equal(stale.summary.requiredCheckNames, null);

  const moved = await waitForPullRequest({ repository: "o/r", number: 7 },
    { gh: fakeGh([ok(pr({}, [run(AGGREGATOR, null)])), ok(pr({ headRefOid: OTHER_HEAD }))]).gh, ...clock() });
  assert.ok(moved.ok);
  assert.equal(moved.summary.outcome, "head_changed");
  assert.equal(moved.summary.headSha, OTHER_HEAD);
});

test("a closed pull request returns closed", async () => {
  const result = await waitForPullRequest({ repository: "o/r", number: 7 }, { gh: fakeGh([ok(pr({ state: "CLOSED" }))]).gh, ...clock() });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "closed");
  assert.equal(result.summary.merged, false);
});

test("transient GitHub failures retry on the same pace; others fail at once", async () => {
  const fake = fakeGh([failed("error connecting to api.github.com"), ok({ errors: [{ type: "RATE_LIMITED", message: "slow down" }] }),
    ok(pr({}, [run(AGGREGATOR, "SUCCESS")]))]);
  const result = await waitForPullRequest({ repository: "o/r", number: 7 }, { gh: fake.gh, ...clock() });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "checks_passed");

  const stuck = fakeGh([failed("error connecting to api.github.com")]);
  const gaveUp = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 3_600_000 }, { gh: stuck.gh, ...clock() });
  assert.equal(gaveUp.ok, false);
  assert.equal(stuck.graphqlCalls(), 4);

  const unauthenticated = await waitForPullRequest({ repository: "o/r", number: 7 },
    { gh: fakeGh([failed("To get started with GitHub CLI, please run:  gh auth login", 4)]).gh, ...clock() });
  assert.equal(unauthenticated.ok, false);
  assert.match(!unauthenticated.ok ? unauthenticated.error : "", /forge_unauthenticated/u);

  const missing = await waitForPullRequest({ repository: "o/r", number: 7 },
    { gh: fakeGh([ok({ data: { repository: { pullRequest: null } }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest with the number of 7." }] })]).gh, ...clock() });
  assert.deepEqual(missing, { ok: false, error: "could not read o/r#7: Could not resolve to a PullRequest with the number of 7." });
});

test("the polling interval and timeout are clamped", async () => {
  const time = clock();
  const result = await waitForPullRequest({ repository: "o/r", number: 7, intervalMs: 1, timeoutMs: 25_000 },
    { gh: fakeGh([ok(pr({}, [run(AGGREGATOR, null)]))]).gh, ...time });
  assert.ok(result.ok);
  assert.deepEqual(time.sleeps, [10_000, 10_000, 5_000]);

  const capped = clock();
  const long = await waitForPullRequest({ repository: "o/r", number: 7, intervalMs: 10_000_000, timeoutMs: 99_999_999 },
    { gh: fakeGh([ok(pr({}, [run(AGGREGATOR, null)]))]).gh, ...capped });
  assert.ok(long.ok);
  assert.equal(long.summary.waitedMs, 10_800_000);
  assert.ok(capped.sleeps.every((milliseconds) => milliseconds <= 600_000));
});

test("cancellation ends the wait without another read", async () => {
  const controller = new AbortController();
  const fake = fakeGh([ok(pr({}, [run(AGGREGATOR, null)]))]);
  const result = await waitForPullRequest({ repository: "o/r", number: 7 }, {
    gh: fake.gh,
    now: () => 0,
    sleep: () => new Promise(() => { controller.abort(); }),
    signal: controller.signal,
  });
  assert.deepEqual(result, { ok: false, error: "request cancelled" });
  assert.equal(fake.graphqlCalls(), 1);
});

test("reads are GraphQL variables, never interpolated input", async () => {
  const fake = fakeGh([ok(pr({}, [run(AGGREGATOR, "SUCCESS")]))]);
  await waitForPullRequest({ repository: "o/r", number: 7 }, { gh: fake.gh, ...clock() });
  const read = fake.calls.find((args) => args.includes("graphql"))!;
  assert.deepEqual(read.slice(0, 4), ["api", "graphql", "--hostname", "github.com"]);
  assert.ok(read.includes(`query=${PULL_REQUEST_WAIT_QUERY}`));
  assert.ok(read.includes("owner=o") && read.includes("name=r") && read.includes("number=7"));
  assert.ok(fake.calls.every((args) => !args.some((arg) => /^-X$|--method|POST|PATCH|PUT|DELETE/u.test(arg))), "reads only");
  const invalid = await waitForPullRequest({ repository: "o/r\"){x}", number: 7 }, { gh: fake.gh, ...clock() });
  assert.equal(invalid.ok, false);
});

test("a check run and a status context sharing a required name must both pass", () => {
  const verdict = evaluateCommitChecks(HEAD, rollup([
    run("CI", "FAILURE", { startedAt: "2026-10-12T09:00:00Z" }),
    { __typename: "StatusContext", context: "CI", state: "SUCCESS", createdAt: "2026-10-12T11:00:00Z", targetUrl: "https://ci.example/1" },
  ]), ["CI"]);
  assert.equal(verdict.requiredState, "failed");
  assert.deepEqual(verdict.summary.failedJobs.map(({ name, required }) => ({ name, required })), [{ name: "CI", required: true }]);
  const waiting = evaluateCommitChecks(HEAD, rollup([
    run("CI", "SUCCESS"),
    { __typename: "StatusContext", context: "CI", state: "PENDING", createdAt: "x" },
  ]), ["CI"]);
  assert.equal(waiting.requiredState, "pending");
});

test("a partial GraphQL answer is never trusted, so a nulled queue entry cannot read as unqueued", async () => {
  const partial: GhOutcome = {
    stdout: JSON.stringify({ ...pr({ mergeQueueEntry: null }, [run(AGGREGATOR, "SUCCESS")]),
      errors: [{ type: "INTERNAL", message: "Something went wrong", path: ["repository", "pullRequest", "mergeQueueEntry"] }] }),
    stderr: "gh: Something went wrong", code: 1, timedOut: false,
  };
  const queued = ok(pr({ mergeQueueEntry: { position: 1, state: "AWAITING_CHECKS", enqueuedAt: null, headCommit: null } }, [run(AGGREGATOR, "SUCCESS")]));
  const fake = fakeGh([partial, queued, ok(pr({ state: "MERGED", mergeCommit: { oid: MERGE } }))]);
  const recovered = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 600_000 }, { gh: fake.gh, ...clock() });
  assert.ok(recovered.ok);
  assert.equal(recovered.summary.outcome, "merged", "the partial read was retried, not taken as checks_passed");

  const persistent = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 600_000 }, { gh: fakeGh([partial]).gh, ...clock() });
  assert.deepEqual(persistent, { ok: false, error: "could not read o/r#7: Something went wrong" });
});

test("the full base branch name reaches GitHub even when the summary clips it", async () => {
  const base = `release/${"b".repeat(140)}`;
  const fake = fakeGh([ok(pr({ baseRefName: base }, [run(AGGREGATOR, null)]))]);
  const result = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 1 }, { gh: fake.gh, ...clock() });
  assert.ok(result.ok);
  assert.ok(result.summary.baseRef.length <= 120);
  const paths = fake.calls.flatMap((args) => args.filter((arg) => arg.startsWith("repos/")));
  assert.deepEqual(paths, [
    `repos/o/r/rules/branches/${encodeURIComponent(base)}?per_page=100`,
    `repos/o/r/branches/${encodeURIComponent(base)}`,
  ]);
});

test("while queued, a failing merge-group check returns queue_failed without waiting for the ejection", async () => {
  const entry = (nodes: unknown[]) => ok(pr({
    mergeQueueEntry: { position: 0, state: "AWAITING_CHECKS", enqueuedAt: null, headCommit: { oid: GROUP, statusCheckRollup: rollup(nodes) } },
  }, [run(AGGREGATOR, "SUCCESS")]));
  const required = await waitForPullRequest({ repository: "o/r", number: 7 },
    { gh: fakeGh([entry([run(AGGREGATOR, "FAILURE")])]).gh, ...clock() });
  assert.ok(required.ok);
  assert.equal(required.summary.outcome, "queue_failed");

  const optional = [run(AGGREGATOR, null), run("Platform Isolation", "FAILURE")];
  const flagged = await waitForPullRequest({ repository: "o/r", number: 7, returnOnAnyFailure: true },
    { gh: fakeGh([entry(optional)]).gh, ...clock() });
  assert.ok(flagged.ok);
  assert.equal(flagged.summary.outcome, "queue_failed");
  const unflagged = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 60_000 },
    { gh: fakeGh([entry(optional)]).gh, ...clock() });
  assert.ok(unflagged.ok);
  assert.equal(unflagged.summary.outcome, "timeout");
});

test("HTTP 403 rate limits and 5xx answers retry; an ordinary 403 does not", async () => {
  for (const stderr of ["gh: API rate limit exceeded for user ID 1. (HTTP 403)", "gh: Bad Gateway (HTTP 502)"]) {
    const fake = fakeGh([ok(pr({}, [run(AGGREGATOR, "SUCCESS")]))]);
    let calls = 0;
    const flaky: GhRunner = async (args) => args.some((arg) => arg.includes("/rules/branches/")) && calls++ === 0
      ? failed(stderr)
      : fake.gh(args);
    const result = await waitForPullRequest({ repository: "o/r", number: 7 }, { gh: flaky, ...clock() });
    assert.ok(result.ok, stderr);
    assert.equal(result.summary.outcome, "checks_passed");
  }
  const forbidden = await waitForPullRequest({ repository: "o/r", number: 7 },
    { gh: fakeGh([ok(pr())], { rules: failed("gh: Resource not accessible by integration (HTTP 403)") }).gh, ...clock() });
  assert.deepEqual(forbidden, { ok: false, error: "could not read the rules for main: http_403 (gh: Resource not accessible by integration (HTTP 403))" });
});

test("pull request references parse from numbers, short refs, and github.com URLs", () => {
  assert.deepEqual(parsePullRequestRef("3081", "picoduck/wollipog"), { repository: "picoduck/wollipog", number: 3081 });
  assert.deepEqual(parsePullRequestRef(3081, "picoduck/wollipog"), { repository: "picoduck/wollipog", number: 3081 });
  assert.deepEqual(parsePullRequestRef("#12", "o/r"), { repository: "o/r", number: 12 });
  assert.deepEqual(parsePullRequestRef("picoduck/wollipog#5", undefined), { repository: "picoduck/wollipog", number: 5 });
  assert.deepEqual(parsePullRequestRef("https://github.com/picoduck/wollipog/pull/3087/files", undefined),
    { repository: "picoduck/wollipog", number: 3087 });
  assert.match((parsePullRequestRef("12", undefined) as { error: string }).error, /repository/u);
  assert.match((parsePullRequestRef("https://github.com/a/b/pull/1", "c/d") as { error: string }).error, /not in repository/u);
  assert.match((parsePullRequestRef("https://gitlab.com/a/b/-/merge_requests/1", undefined) as { error: string }).error, /must be/u);
  assert.match((parsePullRequestRef("0", "o/r") as { error: string }).error, /positive/u);
  assert.match((parsePullRequestRef("1", "../etc") as { error: string }).error, /invalid GitHub repository/u);
});
