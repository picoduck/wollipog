/**
 * Pull request wait (#3081): required checks come from the base branch's rules, an unreported
 * required check is pending, and every outcome returns one bounded summary. `gh` and the clock are
 * stubbed, so no test touches GitHub or sleeps.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhOutcome, GhRunner } from "./campaign-forge-status.js";
import { runContextCommand } from "./context-command.js";
import {
  evaluateCommitChecks,
  parsePullRequestRef,
  PULL_REQUEST_CONTEXTS_QUERY,
  PULL_REQUEST_WAIT_QUERY,
  requiredCheckNames,
  waitForPullRequest,
  type PullRequestWaitDeps,
} from "./pull-request-wait.js";

const HEAD = "44579c6c25235598f1a28f8ccb0449cb8dbbc810";
const OTHER_HEAD = "55579c6c25235598f1a28f8ccb0449cb8dbbc811";
const GROUP = "66679c6c25235598f1a28f8ccb0449cb8dbbc812";
const REBUILT = "77779c6c25235598f1a28f8ccb0449cb8dbbc813";
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

const READY_AT = "2026-10-12T09:00:00Z";
const RUN_AT = "2026-10-12T10:00:00Z";
function admission(readyAt = READY_AT) {
  return { createdAt: "2026-10-11T10:00:00Z", timelineItems: { nodes: [{ createdAt: readyAt }] } };
}
function provenance(checkId = 200) {
  return { databaseId: checkId, checkSuite: { app: { databaseId: 15368 } } };
}
function actionRuns(overrides: Record<string, unknown> = {}, additional: Record<string, unknown>[] = []) {
  return { total_count: 1 + additional.length, workflow_runs: [{
    id: 20, workflow_id: 30, check_suite_id: 100, head_sha: HEAD, event: "pull_request", run_attempt: 1,
    created_at: RUN_AT, status: "completed", ...overrides,
  }, ...additional.map((run, index) => ({ check_suite_id: 101 + index, ...run }))] };
}

/** A scripted `gh`: each GraphQL read takes the next entry (the last one repeats). */
function fakeGh(reads: GhOutcome[], options: { rules?: GhOutcome; branch?: GhOutcome; pages?: GhOutcome[]; runs?: GhOutcome; jobs?: GhOutcome; check?: GhOutcome } = {}) {
  const calls: string[][] = [];
  let index = 0;
  let page = 0;
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (args.includes(`query=${PULL_REQUEST_CONTEXTS_QUERY}`)) return options.pages![Math.min(page++, options.pages!.length - 1)]!;
    if (args.includes("graphql")) return reads[Math.min(index++, reads.length - 1)]!;
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (path.includes("/check-runs/")) return options.check ?? ok({
      id: Number(path.split("/").at(-1)), head_sha: HEAD, name: options.rules ? "Conditional CI" : AGGREGATOR,
      status: "completed", conclusion: "skipped", check_suite: { id: 100 },
    });
    if (path.includes("/attempts/")) return options.jobs ?? ok({ total_count: 1, jobs: [{
      name: options.rules ? "Conditional CI" : AGGREGATOR, check_run_url: "https://api.github.com/repos/o/r/check-runs/200", run_attempt: 1, status: "completed", conclusion: "skipped",
    }] });
    if (path.includes("/actions/runs?")) return options.runs ?? ok(actionRuns());
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

for (const conclusion of ["SUCCESS", "FAILURE"]) {
  test(`draft → ready on the same head waits past the skipped aggregator for admitted ${conclusion}`, async () => {
    // The draft run already completed; ready_for_review admits new jobs on this same HEAD,
    // but its required aggregator does not exist until its dependencies finish.
    const skipped = run(AGGREGATOR, "SKIPPED", { databaseId: 10, isRequired: true });
    const browser = run("Browser End-to-End Tests", null, { databaseId: 11 });
    const fake = fakeGh([
      ok(pr({}, [skipped, browser])),
      ok(pr({}, [skipped, browser, run(AGGREGATOR, null, { databaseId: 12, status: "QUEUED", startedAt: null })])),
      ok(pr({}, [skipped, run("Browser End-to-End Tests", conclusion, { databaseId: 11 }),
        run(AGGREGATOR, conclusion, { databaseId: 12 })])),
    ]);
    const time = clock();
    const result = await waitForPullRequest({ repository: "o/r", number: 7, headSha: HEAD, timeoutMs: 600_000 },
      { gh: fake.gh, ...time });
    assert.ok(result.ok);
    assert.equal(result.summary.outcome, conclusion === "SUCCESS" ? "checks_passed" : "checks_failed");
    assert.equal(result.summary.polls, 3, "the skipped draft aggregator must not certify the admitted run");
    assert.deepEqual(time.sleeps, [30_000, 30_000]);
    assert.equal(result.summary.headSha, HEAD);
    assert.equal(result.summary.checks.required[0]!.state, conclusion === "SUCCESS" ? "passed" : "failed");
  });
}

test("a current admitted required skip passes behind an outstanding review", async () => {
  const fake = fakeGh([ok(pr({ reviewDecision: "REVIEW_REQUIRED", ...admission() }, [
    run("Conditional CI", "SKIPPED", { isRequired: true, ...provenance() }),
  ]))], { rules: ok([{ type: "pull_request" }, { type: "required_status_checks", parameters: {
    required_status_checks: [{ context: "Conditional CI" }],
  } }]), runs: ok(actionRuns()) });
  const result = await waitForPullRequest({ repository: "o/r", number: 7, headSha: HEAD, timeoutMs: 1_000 },
    { gh: fake.gh, ...clock() });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "checks_passed");
  assert.equal(result.summary.merged, false);
  assert.equal(result.summary.mergeStateStatus, "BLOCKED");
  assert.deepEqual(result.summary.checks.required, [{ name: "Conditional CI", state: "passed", reported: true }]);
  assert.equal(fake.calls.filter((args) => args.some((arg) => arg.includes("/actions/runs"))).length, 2);
});

test("a PR that was never a draft uses creation as its admission boundary", async () => {
  const fake = fakeGh([ok(pr({ createdAt: READY_AT, timelineItems: { nodes: [] } }, [
    run(AGGREGATOR, "SKIPPED", provenance()),
  ]))]);
  const result = await waitForPullRequest({ repository: "o/r", number: 7 }, { gh: fake.gh, ...clock() });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "checks_passed");
});

test("required skip job identity accepts canonical repository casing and redirects", async () => {
  const fake = fakeGh([ok(pr(admission(), [run(AGGREGATOR, "SKIPPED", provenance())]))], {
    jobs: ok({ total_count: 1, jobs: [{ name: AGGREGATOR, run_attempt: 1,
      check_run_url: "https://api.github.com/repos/canonical-owner/renamed-repo/check-runs/200",
      status: "completed", conclusion: "skipped" }] }),
  });
  const result = await waitForPullRequest({ repository: "O/R", number: 7, timeoutMs: 1_000 }, { gh: fake.gh, ...clock() });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "checks_passed");
});

test("a completed rerun skip must belong to the exact current attempt", async () => {
  const metadata = provenance();
  const fake = fakeGh([ok(pr(admission(), [run(AGGREGATOR, "SKIPPED", metadata)]))], {
    runs: ok(actionRuns({ run_attempt: 2 })),
    jobs: ok({ total_count: 1, jobs: [{ name: AGGREGATOR, run_attempt: 2,
      check_run_url: "https://api.github.com/repos/o/r/check-runs/200", status: "completed", conclusion: "skipped" }] }),
  });
  const result = await waitForPullRequest({ repository: "o/r", number: 7 }, { gh: fake.gh, ...clock() });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "checks_passed");
  assert.ok(fake.calls.some((args) => args.some((arg) => arg.includes("/attempts/2/jobs"))));
});

for (const [label, overrides] of [
  ["missing timeline", { createdAt: READY_AT }],
  ["missing creation and empty timeline", { timelineItems: { nodes: [] } }],
  ["malformed ready event", { ...admission(), timelineItems: { nodes: [null] } }],
  ["currently draft PR", { ...admission(), isDraft: true }],
] as const) {
  test(`required skip stays pending with ${label}`, async () => {
    const fake = fakeGh([ok(pr(overrides, [run(AGGREGATOR, "SKIPPED", provenance())]))]);
    const result = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 1_000 }, { gh: fake.gh, ...clock() });
    assert.ok(result.ok);
    assert.equal(result.summary.outcome, "timeout");
    assert.equal(fake.calls.some((args) => args.some((arg) => arg.includes("/actions/runs"))), false);
  });
}

for (const [label, jobs] of [
  ["old job absent from current attempt", ok({ total_count: 0, jobs: [] })],
  ["wrong job attempt", ok({ total_count: 1, jobs: [{ name: AGGREGATOR, run_attempt: 2,
    check_run_url: "https://api.github.com/repos/o/r/check-runs/200", status: "completed", conclusion: "skipped" }] })],
  ["incomplete jobs list", ok({ total_count: 101, jobs: [] })],
  ["unreadable jobs", failed("gh: Forbidden (HTTP 403)")],
] as const) {
  test(`a required skip stays pending with ${label}`, async () => {
    const fake = fakeGh([ok(pr(admission(), [run(AGGREGATOR, "SKIPPED", provenance())]))], { jobs });
    const result = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 1_000 }, { gh: fake.gh, ...clock() });
    assert.ok(result.ok);
    assert.equal(result.summary.outcome, "timeout");
  });
}

test("required skip provenance preserves every required app restriction", async () => {
  const fake = fakeGh([ok(pr(admission(), [run(AGGREGATOR, "SKIPPED", provenance())]))], {
    rules: ok([{ type: "required_status_checks", parameters: { required_status_checks: [
      { context: AGGREGATOR, integration_id: 15368 }, { context: AGGREGATOR, integration_id: 99 },
    ] } }]),
  });
  const result = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 1_000 }, { gh: fake.gh, ...clock() });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "timeout");
  assert.equal(result.summary.checks.required[0]!.reported, false);
  assert.equal(fake.calls.some((args) => args.some((arg) => arg.includes("/actions/runs"))), false);
});

test("ordinary check outcomes add no Actions provenance requests", async () => {
  for (const nodes of [
    [run(AGGREGATOR, "SUCCESS"), run("Optional", "SKIPPED", provenance())],
    [run(AGGREGATOR, "FAILURE"), run("Optional", "SKIPPED", provenance())],
    [run("Optional", "SKIPPED", provenance())],
    [run(AGGREGATOR, null)],
  ]) {
    const fake = fakeGh([ok(pr(admission(), nodes))]);
    await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 1_000 }, { gh: fake.gh, ...clock() });
    assert.equal(fake.calls.some((args) => args.some((arg) => arg.includes("/actions/runs"))), false);
  }
});

for (const conclusion of ["SUCCESS", "FAILURE", "SKIPPED"]) {
  test(`restricted Actions access preserves ${conclusion} waiter semantics`, async () => {
    const response = pr(admission(), [run(AGGREGATOR, conclusion, provenance())]);
    const fake = fakeGh([ok(response)], { runs: failed("gh: Resource not accessible by token (HTTP 403)") });
    const gh: GhRunner = async (args, signal) => {
      if (args.some((arg) => arg.startsWith("query=") && arg.includes("workflowRun"))) {
        return ok({ ...response, errors: [{ type: "FORBIDDEN", message: "Actions read access denied" }] });
      }
      return fake.gh(args, signal);
    };
    const result = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 1_000 }, { gh, ...clock() });
    assert.ok(result.ok, "Actions permissions must never make common PR observations fail");
    assert.equal(result.summary.outcome, conclusion === "SUCCESS" ? "checks_passed" : conclusion === "FAILURE" ? "checks_failed" : "timeout");
    if (conclusion !== "SKIPPED") {
      assert.equal(fake.calls.some((args) => args.some((arg) => arg.includes("/actions/"))), false);
    } else {
      assert.deepEqual(result.summary.checks.required, [{ name: AGGREGATOR, state: "pending", reported: true }]);
    }
  });
}

test("common query fields never require workflow-run access, including queue and pagination observations", () => {
  assert.doesNotMatch(PULL_REQUEST_WAIT_QUERY, /workflowRun/u);
  assert.doesNotMatch(PULL_REQUEST_CONTEXTS_QUERY, /workflowRun/u);
});

for (const [label, reads] of [
  ["denied check lookup", { check: failed("gh: Forbidden (HTTP 403)") }],
  ["failed Actions lookup", { runs: failed("gh: Bad Gateway (HTTP 502)") }],
  ["partial Actions lookup", { runs: ok({ ...actionRuns(), errors: [{ message: "Actions unavailable" }] }) }],
  ["partial check lookup", { check: ok({ id: 200, check_suite: { id: 100 } }) }],
  ["unmatched check suite", { runs: ok(actionRuns({ check_suite_id: 999 })) }],
] as const) {
  test(`${label} leaves a required skip pending without failing the wait`, async () => {
    const fake = fakeGh([ok(pr(admission(), [run(AGGREGATOR, "SKIPPED", provenance())]))], reads);
    const result = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 1_000 }, { gh: fake.gh, ...clock() });
    assert.ok(result.ok);
    assert.equal(result.summary.outcome, "timeout");
    assert.deepEqual(result.summary.checks.required, [{ name: AGGREGATOR, state: "pending", reported: true }]);
  });
}

test("a thrown provenance transport failure leaves a skip pending", async () => {
  const fake = fakeGh([ok(pr(admission(), [run(AGGREGATOR, "SKIPPED", provenance())]))]);
  const gh: GhRunner = (args, signal) => {
    if (args.some((arg) => arg.includes("/actions/runs?"))) throw new Error("transport unavailable");
    return fake.gh(args, signal);
  };
  const result = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 1_000 }, { gh, ...clock() });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "timeout");
});

test("optional skips do not consume the required-skip provenance budget", async () => {
  const fake = fakeGh([ok(pr(admission(), [run(AGGREGATOR, "SKIPPED", provenance()),
    ...Array.from({ length: 20 }, (_, i) => run(`Optional ${i}`, "SKIPPED", provenance(300 + i))),
  ]))]);
  const result = await waitForPullRequest({ repository: "o/r", number: 7 }, { gh: fake.gh, ...clock() });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "checks_passed");
  assert.equal(fake.calls.filter((args) => args.some((arg) => arg.includes("/check-runs/"))).length, 1);
});

test("cancelling provenance stops before any further GitHub read", async () => {
  const controller = new AbortController();
  const fake = fakeGh([ok(pr(admission(), [run(AGGREGATOR, "SKIPPED", provenance())]))]);
  let afterCancellation = 0;
  const gh: GhRunner = (args, signal) => {
    if (controller.signal.aborted) afterCancellation++;
    if (args.some((arg) => arg.includes("/check-runs/"))) controller.abort();
    return fake.gh(args, signal);
  };
  const result = await waitForPullRequest({ repository: "o/r", number: 7 }, { gh, signal: controller.signal, ...clock() });
  assert.equal(result.ok, false);
  assert.equal(afterCancellation, 0);
});

for (const [label, metadata, runs] of [
  ["older draft run", provenance(), actionRuns({ created_at: "2026-10-12T08:00:00Z" })],
  ["same-second admission", provenance(), actionRuns({ created_at: READY_AT })],
  ["newer queued run without any check nodes", provenance(), actionRuns({}, [{
    id: 21, workflow_id: 30, head_sha: HEAD, event: "pull_request", run_attempt: 1,
    created_at: "2026-10-12T11:00:00Z", status: "queued",
  }])],
  ["in-progress current run", provenance(), actionRuns({ status: "in_progress" })],
  ["newer attempt", provenance(), actionRuns({ run_attempt: 2 })],
  ["wrong head", provenance(), actionRuns({ head_sha: OTHER_HEAD })],
  ["ineligible event", provenance(), actionRuns({ event: "workflow_dispatch" })],
  ["missing run", provenance(), { total_count: 0, workflow_runs: [] }],
  ["incomplete run list", provenance(), { ...actionRuns(), total_count: 101 }],
  ["missing provenance", {}, actionRuns()],
] as const) {
  test(`a blocked required skip stays pending with ${label}`, async () => {
    const fake = fakeGh([ok(pr(admission(), [run(AGGREGATOR, "SKIPPED", metadata)]))], { runs: ok(runs) });
    const result = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 1_000 },
      { gh: fake.gh, ...clock() });
    assert.ok(result.ok);
    assert.equal(result.summary.outcome, "timeout");
    assert.deepEqual(result.summary.checks.required, [{ name: AGGREGATOR, state: "pending", reported: true }]);
  });
}

for (const conclusion of ["SUCCESS", "FAILURE"]) {
  test(`provenance keeps a draft skip pending until the admitted aggregator reports ${conclusion}`, async () => {
    const skipped = run(AGGREGATOR, "SKIPPED", { ...provenance(10) });
    const current = provenance();
    const fake = fakeGh([
      ok(pr(admission(), [skipped])),
      ok(pr(admission(), [skipped, run("Browser", null, { ...current, databaseId: 11 })])),
      ok(pr(admission(), [skipped, run(AGGREGATOR, conclusion, { ...current, databaseId: 12 })])),
    ], { runs: ok(actionRuns({ created_at: "2026-10-12T08:00:00Z" }, [{
      id: 21, workflow_id: 30, head_sha: HEAD, event: "pull_request", run_attempt: 1,
      created_at: RUN_AT, status: "in_progress",
    }])) });
    const time = clock();
    const result = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 600_000 }, { gh: fake.gh, ...time });
    assert.ok(result.ok);
    assert.equal(result.summary.outcome, conclusion === "SUCCESS" ? "checks_passed" : "checks_failed");
    assert.equal(result.summary.polls, 3);
  });
}

test("a skipped required check stays pending while GitHub blocks the ready PR", async () => {
  const fake = fakeGh([ok(pr({}, [run(AGGREGATOR, "SKIPPED"), run("Browser End-to-End Tests", null)]))]);
  const result = await waitForPullRequest({ repository: "o/r", number: 7, headSha: HEAD, timeoutMs: 1 },
    { gh: fake.gh, ...clock() });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "timeout");
  assert.deepEqual(result.summary.checks.required, [{ name: AGGREGATOR, state: "pending", reported: true }]);
  assert.deepEqual(result.summary.checks.failedJobs, []);
});

test("optional skips and genuine required successes pass even when another gate blocks the PR", async () => {
  const fake = fakeGh([ok(pr({}, [run(AGGREGATOR, "SUCCESS"), run("Optional", "SKIPPED"), run("Other", null)]))]);
  const time = clock();
  const result = await waitForPullRequest({ repository: "o/r", number: 7, returnOnAnyFailure: true }, { gh: fake.gh, ...time });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "checks_passed");
  assert.deepEqual(result.summary.checks.other, { passed: 1, failed: 0, pending: 1 });
  assert.deepEqual(time.sleeps, []);
});

for (const mergeStateStatus of ["CLEAN", "HAS_HOOKS", "UNSTABLE"]) {
  test(`a required skip can pass when GitHub confirms requirements are met (${mergeStateStatus})`, async () => {
    const result = await waitForPullRequest({ repository: "o/r", number: 7 },
      { gh: fakeGh([ok(pr({ mergeStateStatus }, [run(AGGREGATOR, "SKIPPED")]))]).gh, ...clock() });
    assert.ok(result.ok);
    assert.equal(result.summary.outcome, "checks_passed");
    assert.equal(result.summary.checks.required[0]!.state, "passed");
  });
}

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
  assert.deepEqual(names, { ok: true, names: ["Build", AGGREGATOR, "ci/legacy"], apps: {} });
  const result = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 1 }, { gh: fake.gh, ...clock() });
  assert.ok(result.ok);
  assert.deepEqual(result.summary.checks.required.map((check) => check.name), ["Build", "Marked", AGGREGATOR, "ci/legacy"]);
});

test("an unreadable base never reads as nothing required", async () => {
  const fake = fakeGh([ok(pr())], { rules: failed("gh: Not Found (HTTP 404)") });
  const result = await waitForPullRequest({ repository: "o/r", number: 7 }, { gh: fake.gh, ...clock() });
  assert.deepEqual(result, { ok: false, error: "could not read the rules for main: http_404 (gh: Not Found (HTTP 404))" });
});

test("of several runs sharing a name, the newest wins", () => {
  const verdict = evaluateCommitChecks(HEAD, rollup([
    run(AGGREGATOR, "FAILURE", { startedAt: "2026-10-12T09:00:00Z" }),
    run(AGGREGATOR, "SUCCESS", { startedAt: "2026-10-12T11:00:00Z" }),
  ]), [AGGREGATOR]);
  assert.equal(verdict.requiredState, "passed");
  // Check run ids grow in creation order, so a re-run that has not started yet is still newer...
  const queued = evaluateCommitChecks(HEAD, rollup([
    run(AGGREGATOR, "SUCCESS", { databaseId: 10, startedAt: "2026-10-12T09:00:00Z" }),
    run(AGGREGATOR, null, { databaseId: 11, status: "QUEUED", startedAt: null }),
  ]), [AGGREGATOR]);
  assert.equal(queued.requiredState, "pending");
  // ...while an older run cancelled before it started never displaces a newer success.
  const cancelled = evaluateCommitChecks(HEAD, rollup([
    run(AGGREGATOR, "CANCELLED", { databaseId: 10, startedAt: null }),
    run(AGGREGATOR, "SUCCESS", { databaseId: 11, startedAt: "2026-10-12T11:00:00Z" }),
  ]), [AGGREGATOR]);
  assert.equal(cancelled.requiredState, "passed");
  const untimed = evaluateCommitChecks(HEAD, rollup([
    run(AGGREGATOR, "SUCCESS", { startedAt: "2026-10-12T11:00:00Z" }),
    run(AGGREGATOR, "CANCELLED", { startedAt: null }),
  ]), [AGGREGATOR]);
  assert.equal(untimed.requiredState, "passed", "an unknown time never displaces a known one");
});

test("a required check restricted to an app counts only that app's runs", async () => {
  const appRun = (app: number, conclusion: string | null, databaseId: number) =>
    run("CI", conclusion, { databaseId, checkSuite: { app: { databaseId: app } } });
  const rules = ok([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "CI", integration_id: 123 }] } }]);
  const names = await requiredCheckNames(fakeGh([], { rules }).gh, "o/r", "main");
  assert.deepEqual(names, { ok: true, names: ["CI"], apps: { CI: [123] } });

  const impostor = evaluateCommitChecks(HEAD, rollup([appRun(999, "SUCCESS", 2)]), ["CI"], { CI: [123] });
  assert.equal(impostor.requiredState, "pending");
  assert.deepEqual(impostor.summary.required, [{ name: "CI", state: "pending", reported: false }]);
  assert.deepEqual(impostor.summary.other, { passed: 1, failed: 0, pending: 0 });
  const genuine = evaluateCommitChecks(HEAD, rollup([appRun(123, "SUCCESS", 1), appRun(999, "FAILURE", 2)]), ["CI"], { CI: [123] });
  assert.equal(genuine.requiredState, "passed", "another app's newer run neither replaces nor fails the required one");

  const branch = ok({ protection: { enabled: true, required_status_checks: { contexts: ["CI"], checks: [{ context: "CI", app_id: 77 }, { context: "Any", app_id: null }] } } });
  const classic = await requiredCheckNames(fakeGh([], { rules: ok([]), branch }).gh, "o/r", "main");
  assert.deepEqual(classic, { ok: true, names: ["Any", "CI"], apps: { CI: [77] } });

  const waited = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 1 },
    { gh: fakeGh([ok(pr({}, [appRun(999, "SUCCESS", 2)]))], { rules }).gh, ...clock() });
  assert.ok(waited.ok);
  assert.equal(waited.summary.outcome, "timeout");
});

test("past one page of contexts a pass also needs GitHub's merge state to confirm it", async () => {
  const page = (status: string) => ({ data: { repository: { defaultBranchRef: { name: "main" }, pullRequest: {
    ...pr().data.repository.pullRequest, mergeStateStatus: status,
    commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: rollup([run(AGGREGATOR, "SUCCESS")], true) } }] },
  } } } });
  const unconfirmed = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 60_000 },
    { gh: fakeGh([ok(page("BLOCKED"))]).gh, ...clock() });
  assert.ok(unconfirmed.ok);
  assert.equal(unconfirmed.summary.outcome, "timeout");
  assert.equal(unconfirmed.summary.checks.truncated, true);
  const confirmed = await waitForPullRequest({ repository: "o/r", number: 7 }, { gh: fakeGh([ok(page("CLEAN"))]).gh, ...clock() });
  assert.ok(confirmed.ok);
  assert.equal(confirmed.summary.outcome, "checks_passed");
});

test("a persistent required-rules outage exhausts the retry budget instead of the whole timeout", async () => {
  const fake = fakeGh([ok(pr({}, [run(AGGREGATOR, null)]))], { rules: failed("gh: Bad Gateway (HTTP 502)") });
  const result = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 10_800_000 }, { gh: fake.gh, ...clock() });
  assert.deepEqual(result, { ok: false, error: "could not read the rules for main: forge_unreachable (gh: Bad Gateway (HTTP 502))" });
  assert.equal(fake.graphqlCalls(), 4);
});

test("an ejection needs the entry missing for the whole confirmation interval", async () => {
  const entry = { position: 1, state: "AWAITING_CHECKS", enqueuedAt: null, headCommit: null };
  const time = clock();
  const early = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 30_001 },
    { gh: fakeGh([ok(pr({ mergeQueueEntry: entry })), ok(pr())]).gh, ...time });
  assert.ok(early.ok);
  assert.equal(early.summary.outcome, "timeout", "1 ms of absence is not a confirmed ejection");
  assert.deepEqual(time.sleeps, [30_000, 1]);
});

test("cancellation during a GitHub read stops before any further read", async () => {
  const controller = new AbortController();
  const fake = fakeGh([ok(pr({}, [run(AGGREGATOR, "SUCCESS")]))]);
  const gh: GhRunner = async (args) => {
    const answer = await fake.gh(args);
    controller.abort();
    return answer;
  };
  const result = await waitForPullRequest({ repository: "o/r", number: 7 }, { gh, ...clock(), signal: controller.signal });
  assert.deepEqual(result, { ok: false, error: "request cancelled" });
  assert.equal(fake.calls.length, 1, "no rules read after the cancelled GraphQL read");
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

test("the queue summary carries the merge group's checks and an UNMERGEABLE entry returns queue_failed", async () => {
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

test("a failed merge group whose entry GitHub rebuilds keeps waiting until it merges", async () => {
  // #3121: an entry ahead fails, so this entry's group fails too; GitHub drops the entry ahead and
  // rebuilds this one's group on a new commit, and it merges from there.
  const entry = (oid: string, nodes: unknown[], position = 1) => ok(pr({
    mergeQueueEntry: { position, state: "AWAITING_CHECKS", enqueuedAt: null, headCommit: { oid, statusCheckRollup: rollup(nodes) } },
  }, [run(AGGREGATOR, "SUCCESS")]));
  const fake = fakeGh([
    entry(GROUP, [run(AGGREGATOR, "FAILURE")]),
    entry(REBUILT, [run(AGGREGATOR, null)], 0),
    entry(REBUILT, [run(AGGREGATOR, "SUCCESS")], 0),
    ok(pr({ state: "MERGED", mergeCommit: { oid: MERGE } }, [run(AGGREGATOR, "SUCCESS")])),
  ]);
  const result = await waitForPullRequest({ repository: "o/r", number: 7, headSha: HEAD, timeoutMs: 600_000 }, { gh: fake.gh, ...clock() });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "merged");
  assert.equal(result.summary.mergeCommitSha, MERGE);
  assert.equal(fake.graphqlCalls(), 4);

  // Until GitHub acts, a failed group is only reported: the summary carries it on a timeout.
  const stalled = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 60_000 },
    { gh: fakeGh([entry(GROUP, [run(AGGREGATOR, "FAILURE")])]).gh, ...clock() });
  assert.ok(stalled.ok);
  assert.equal(stalled.summary.outcome, "timeout");
  assert.equal(stalled.summary.mergeQueue?.checks?.sha, GROUP);
  assert.deepEqual(stalled.summary.mergeQueue?.checks?.failedJobs.map(({ name, required }) => ({ name, required })),
    [{ name: AGGREGATOR, required: true }]);

  // returnOnAnyFailure covers the head's checks only; it never pre-empts GitHub's verdict on the entry.
  const flagged = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 60_000, returnOnAnyFailure: true },
    { gh: fakeGh([entry(GROUP, [run(AGGREGATOR, null), run("Platform Isolation", "FAILURE")])]).gh, ...clock() });
  assert.ok(flagged.ok);
  assert.equal(flagged.summary.outcome, "timeout");
});

test("a failed merge group ends the wait only once GitHub gives up on the entry", async () => {
  const entry = (state: string) => ok(pr({
    mergeQueueEntry: { position: 0, state, enqueuedAt: null, headCommit: { oid: GROUP, statusCheckRollup: rollup([run(AGGREGATOR, "FAILURE")]) } },
  }, [run(AGGREGATOR, "SUCCESS")]));
  const unmergeable = fakeGh([entry("AWAITING_CHECKS"), entry("UNMERGEABLE")]);
  const failedGroup = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 600_000 }, { gh: unmergeable.gh, ...clock() });
  assert.ok(failedGroup.ok);
  assert.equal(failedGroup.summary.outcome, "queue_failed");
  assert.equal(unmergeable.graphqlCalls(), 2);

  const removed = fakeGh([entry("AWAITING_CHECKS"), ok(pr()), ok(pr())]);
  const time = clock();
  const ejected = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 600_000 }, { gh: removed.gh, ...time });
  assert.ok(ejected.ok);
  assert.equal(ejected.summary.outcome, "queue_ejected");
  assert.deepEqual(time.sleeps, [30_000, 10_000], "the ejection is confirmed over the whole interval");
});

const ENQUEUED_AT = "2026-10-12T11:00:00Z";
const REMOVED_AT = "2026-10-12T12:00:00Z";
const added = (createdAt = ENQUEUED_AT) => ({ __typename: "AddedToMergeQueueEvent", createdAt });
const removedEvent = (reason: string | null, createdAt = REMOVED_AT) => ({ __typename: "RemovedFromMergeQueueEvent", createdAt, reason });
const forcePushed = (createdAt: string) => ({ __typename: "HeadRefForcePushedEvent", createdAt });
const BRANCH = "feature";
/** A head check run, by default created for the pull request's own branch before the removal. */
const headCheck = (startedAt = RUN_AT, branch = BRANCH, name = AGGREGATOR) =>
  run(name, "SUCCESS", { startedAt, checkSuite: { app: { databaseId: 15368 }, branch: { name: branch } } });
/** An open, unqueued pull request whose head checks passed, with its latest queue event and force pushes. */
const afterQueue = (events: unknown[], nodes: unknown[] = [headCheck()], pushes: unknown[] = []) =>
  ok(pr({ headRefName: BRANCH, queueEvents: { nodes: events.slice(-1) }, forcePushes: { nodes: pushes.slice(-1) } }, nodes));

for (const reason of ["checks_timed_out", "failed_checks", "manual"]) {
  test(`a call that starts after GitHub removed the head's entry (${reason}) returns queue_ejected`, async () => {
    // #3712: the entry left between two calls, so this call never sees it and its head checks pass.
    const fake = fakeGh([afterQueue([added(), removedEvent(reason)])]);
    const time = clock();
    const result = await waitForPullRequest({ repository: "o/r", number: 7, headSha: HEAD, timeoutMs: 600_000 }, { gh: fake.gh, ...time });
    assert.ok(result.ok);
    assert.equal(result.summary.outcome, "queue_ejected");
    assert.deepEqual(result.summary.mergeQueueRemoval, { reason, removedAt: REMOVED_AT });
    assert.equal(result.summary.mergeQueue, null);
    assert.equal(result.summary.merged, false);
    assert.equal(result.summary.state, "open");
    assert.deepEqual(time.sleeps, [10_000], "the removal is confirmed over the whole ejection interval");
    assert.equal(fake.graphqlCalls(), 2);
    assert.ok(fake.calls.every((args) => !args.some((arg) => /^-X$|--method|^query=\s*mutation|enqueuePullRequest/u.test(arg))), "reads only, never re-enqueues");
  });
}

test("a pull request that was never enqueued keeps returning checks_passed", async () => {
  for (const events of [undefined, { nodes: [] }]) {
    const fake = fakeGh([ok(pr(events ? { queueEvents: events } : {}, [run(AGGREGATOR, "SUCCESS")]))]);
    const time = clock();
    const result = await waitForPullRequest({ repository: "o/r", number: 7, headSha: HEAD }, { gh: fake.gh, ...time });
    assert.ok(result.ok);
    assert.equal(result.summary.outcome, "checks_passed");
    assert.equal(result.summary.mergeQueueRemoval, null);
    assert.deepEqual(time.sleeps, []);
    assert.equal(fake.graphqlCalls(), 1);
  }
  assert.match(PULL_REQUEST_WAIT_QUERY, /REMOVED_FROM_MERGE_QUEUE_EVENT/u);
  assert.match(PULL_REQUEST_WAIT_QUERY, /HEAD_REF_FORCE_PUSHED_EVENT/u);
});

test("a removal that belongs to an earlier head keeps current behavior", async () => {
  const cases: Array<[string, unknown[], unknown[]?, unknown[]?]> = [
    ["force-pushed after the removal", [removedEvent("manual")], undefined, [forcePushed("2026-10-12T12:05:00Z")]],
    ["force-pushed in the removal's second", [removedEvent("manual")], undefined, [forcePushed(REMOVED_AT)]],
    // A fast-forward push after the removal (even of an older commit) reports its checks later.
    ["pushed after the removal", [added(), removedEvent("checks_timed_out")], [headCheck("2026-10-12T12:10:00Z")]],
    ["checks reported in the removal's second", [added(), removedEvent("failed_checks")], [headCheck(REMOVED_AT)]],
    // A descendant already tested on another branch, fast-forwarded in after the removal.
    ["tested earlier on another branch", [added(), removedEvent("checks_timed_out")],
      [headCheck("2026-10-12T12:10:00Z"), headCheck(RUN_AT, "stacked-child", "Optional Lint")]],
    // A commit this branch had before a force push, restored by a later fast-forward.
    ["checked on this branch only before a force push", [added(), removedEvent("manual")], [headCheck(RUN_AT)], [forcePushed("2026-10-12T10:30:00Z")]],
    ["only status contexts before the removal", [added(), removedEvent("manual")],
      [{ __typename: "StatusContext", context: AGGREGATOR, state: "SUCCESS", createdAt: RUN_AT, targetUrl: "https://ci.example/1" }]],
    ["no suite branch reported", [added(), removedEvent("manual")], [run(AGGREGATOR, "SUCCESS")]],
    ["queued again since", [removedEvent("checks_timed_out"), added("2026-10-12T12:30:00Z")]],
    ["unreadable removal time", [added(), removedEvent("manual", "not a time")]],
    ["unreadable force-push time", [added(), removedEvent("manual")], undefined, [forcePushed("not a time")]],
  ];
  for (const [label, events, nodes, pushes] of cases) {
    const result = await waitForPullRequest({ repository: "o/r", number: 7, headSha: HEAD },
      { gh: fakeGh([afterQueue(events, nodes, pushes)]).gh, ...clock() });
    assert.ok(result.ok, label);
    assert.equal(result.summary.outcome, "checks_passed", label);
    assert.equal(result.summary.mergeQueueRemoval, null, label);
  }

  // Missing force-push or head-branch fields decline attribution rather than guess.
  const unread = await waitForPullRequest({ repository: "o/r", number: 7 },
    { gh: fakeGh([ok(pr({ queueEvents: { nodes: [removedEvent("manual")] } }, [headCheck()]))]).gh, ...clock() });
  assert.ok(unread.ok);
  assert.equal(unread.summary.outcome, "checks_passed");

  // A force push before the head's on-branch check does not void the removal.
  const rebased = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 600_000 },
    { gh: fakeGh([afterQueue([added(), removedEvent("manual")], [headCheck()], [forcePushed("2026-10-12T09:30:00Z")])]).gh, ...clock() });
  assert.ok(rebased.ok);
  assert.equal(rebased.summary.outcome, "queue_ejected");
});

test("a different removal restarts the confirmation interval", async () => {
  // The old removal is replaced during confirmation: the entry was queued again and GitHub's own
  // merge removed it, a second before the pull request reads MERGED.
  const LATER = "2026-10-12T12:20:00Z";
  const fake = fakeGh([
    afterQueue([added(), removedEvent("checks_timed_out")]),
    afterQueue([added("2026-10-12T12:10:00Z"), removedEvent("merged", LATER)]),
    ok(pr({ state: "MERGED", mergeCommit: { oid: MERGE } })),
  ]);
  const time = clock();
  const result = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 600_000 }, { gh: fake.gh, ...time });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "merged");
  assert.deepEqual(time.sleeps, [10_000, 10_000]);

  const replaced = fakeGh([
    afterQueue([added(), removedEvent("checks_timed_out")]),
    afterQueue([added("2026-10-12T12:10:00Z"), removedEvent("failed_checks", LATER)]),
  ]);
  const clockTwo = clock();
  const ejected = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 600_000 }, { gh: replaced.gh, ...clockTwo });
  assert.ok(ejected.ok);
  assert.equal(ejected.summary.outcome, "queue_ejected");
  assert.deepEqual(ejected.summary.mergeQueueRemoval, { reason: "failed_checks", removedAt: LATER });
  assert.deepEqual(clockTwo.sleeps, [10_000, 10_000], "the new removal is confirmed over its own whole interval");
});

test("a removal immediately followed by a merge still reports merged", async () => {
  // GitHub records the queue's own removal (reason `merged`) a second before the pull request reads MERGED.
  const fake = fakeGh([
    afterQueue([added(), removedEvent("merged")]),
    ok(pr({ state: "MERGED", mergeCommit: { oid: MERGE }, queueEvents: { nodes: [added(), removedEvent("merged")] } })),
  ]);
  const time = clock();
  const result = await waitForPullRequest({ repository: "o/r", number: 7, headSha: HEAD, timeoutMs: 600_000 }, { gh: fake.gh, ...time });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "merged");
  assert.equal(result.summary.mergeCommitSha, MERGE);
  assert.deepEqual(time.sleeps, [10_000]);

  // Unconfirmed at the deadline it is a timeout that still names the removal, never a guessed ejection.
  const late = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 1 },
    { gh: fakeGh([afterQueue([added(), removedEvent("checks_timed_out")])]).gh, ...clock() });
  assert.ok(late.ok);
  assert.equal(late.summary.outcome, "timeout");
  assert.deepEqual(late.summary.mergeQueueRemoval, { reason: "checks_timed_out", removedAt: REMOVED_AT });
});

test("a removal that stops applying before it is confirmed falls back to the head's checks", async () => {
  // Queued again: the timeline shows the new entry before the entry itself is readable.
  const fake = fakeGh([
    afterQueue([added(), removedEvent("checks_timed_out")]),
    afterQueue([removedEvent("checks_timed_out"), added("2026-10-12T12:30:00Z")]),
  ]);
  const result = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 600_000 }, { gh: fake.gh, ...clock() });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "checks_passed");
  assert.equal(result.summary.mergeQueueRemoval, null);
});

test("an ejection this call watched also carries GitHub's removal reason", async () => {
  const entry = { position: 1, state: "AWAITING_CHECKS", enqueuedAt: ENQUEUED_AT, headCommit: null };
  const fake = fakeGh([
    ok(pr({ mergeQueueEntry: entry, queueEvents: { nodes: [added()] } }, [run(AGGREGATOR, "SUCCESS")])),
    afterQueue([added(), removedEvent("failed_checks")]),
  ]);
  const result = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 600_000 }, { gh: fake.gh, ...clock() });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "queue_ejected");
  assert.deepEqual(result.summary.mergeQueueRemoval, { reason: "failed_checks", removedAt: REMOVED_AT });
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

test("a required check past the first page of contexts is read from the next page", async () => {
  const optional = Array.from({ length: 100 }, (_, index) => run(`optional-${index}`, "SUCCESS"));
  const first = ok(pr({ commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: {
    contexts: { pageInfo: { hasNextPage: true, endCursor: "cursor-1" }, nodes: optional },
  } } }] } }));
  const next = (conclusion: string) => ok({ data: { repository: { object: { statusCheckRollup: {
    contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [run(AGGREGATOR, conclusion)] },
  } } } } });
  const passed = fakeGh([first], { pages: [next("SUCCESS")] });
  const result = await waitForPullRequest({ repository: "o/r", number: 7 }, { gh: passed.gh, ...clock() });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "checks_passed");
  assert.equal(result.summary.checks.truncated, undefined);
  const page = passed.calls.find((args) => args.includes(`query=${PULL_REQUEST_CONTEXTS_QUERY}`))!;
  assert.ok(page.includes(`oid=${HEAD}`) && page.includes("after=cursor-1") && page.includes("number=7"));

  const failing = await waitForPullRequest({ repository: "o/r", number: 7 },
    { gh: fakeGh([first], { pages: [next("FAILURE")] }).gh, ...clock() });
  assert.ok(failing.ok);
  assert.equal(failing.summary.outcome, "checks_failed");
  assert.equal(failing.summary.checks.failedJobs[0]!.name, AGGREGATOR);

  // Pages are bounded: past the last one, a pass needs GitHub's merge state as before.
  const endless = ok({ data: { repository: { object: { statusCheckRollup: {
    contexts: { pageInfo: { hasNextPage: true, endCursor: "again" }, nodes: [run(AGGREGATOR, "SUCCESS")] },
  } } } } });
  const bounded = fakeGh([first], { pages: [endless] });
  const capped = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 1 }, { gh: bounded.gh, ...clock() });
  assert.ok(capped.ok);
  assert.equal(capped.summary.outcome, "timeout");
  assert.equal(bounded.calls.filter((args) => args.includes(`query=${PULL_REQUEST_CONTEXTS_QUERY}`)).length, 9 * capped.summary.polls,
    "at most nine further pages per poll");
});

test("every app a required check is bound to must report", () => {
  const appRun = (app: number, conclusion: string) => run("CI", conclusion, { databaseId: app, checkSuite: { app: { databaseId: app } } });
  const one = evaluateCommitChecks(HEAD, rollup([appRun(123, "SUCCESS")]), ["CI"], { CI: [123, 456] });
  assert.equal(one.requiredState, "pending");
  assert.deepEqual(one.summary.required, [{ name: "CI", state: "pending", reported: false }]);
  const both = evaluateCommitChecks(HEAD, rollup([appRun(123, "SUCCESS"), appRun(456, "SUCCESS")]), ["CI"], { CI: [123, 456] });
  assert.equal(both.requiredState, "passed");
  const status = evaluateCommitChecks(HEAD, rollup([
    appRun(123, "SUCCESS"), { __typename: "StatusContext", context: "CI", state: "FAILURE", createdAt: "x" },
  ]), ["CI"], { CI: [123, 456] });
  assert.equal(status.requiredState, "failed", "a status context stands in for an app with no run");
  const masked = evaluateCommitChecks(HEAD, rollup([
    appRun(123, "SUCCESS"), { __typename: "StatusContext", context: "CI", state: "FAILURE", createdAt: "x", isRequired: true },
  ]), ["CI"], { CI: [123] });
  assert.equal(masked.requiredState, "failed", "the required app's run never masks a failing same-name status");
  assert.deepEqual(masked.summary.failedJobs.map(({ name, required }) => ({ name, required })), [{ name: "CI", required: true }]);
});

test("check names that collide with object prototype keys evaluate normally", () => {
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const verdict = evaluateCommitChecks(HEAD, rollup([run(name, "SUCCESS", { checkSuite: { app: { databaseId: 9 } } })]), [name]);
    assert.equal(verdict.requiredState, "passed", name);
    const restricted = evaluateCommitChecks(HEAD, rollup([run(name, "SUCCESS", { checkSuite: { app: { databaseId: 9 } } })]), [name],
      Object.fromEntries([[name, [9]]]));
    assert.equal(restricted.requiredState, "passed", `${name} restricted`);
  }
});

test("slow reads cannot carry the call past the timeout plus one read's grace", async () => {
  // Every read takes 25 s and the contexts never end, so only the shared budget stops the reads.
  const time = clock();
  const started = time.now();
  const starts: number[] = [];
  const endless = ok({ data: { repository: { object: { statusCheckRollup: {
    contexts: { pageInfo: { hasNextPage: true, endCursor: "again" }, nodes: [] },
  } } } } });
  const first = ok(pr({ commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: {
    contexts: { pageInfo: { hasNextPage: true, endCursor: "c" }, nodes: [run(AGGREGATOR, null)] },
  } } }] } }));
  const fake = fakeGh([first], { pages: [endless] });
  const slow: GhRunner = async (args) => {
    starts.push(time.now() - started);
    await time.sleep(25_000);
    return fake.gh(args);
  };
  const result = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 60_000 }, { gh: slow, now: time.now, sleep: async () => {} });
  assert.equal(result.ok, false);
  assert.ok(starts.every((at) => at < 80_000), `no read starts past timeout + grace: ${starts.join(",")}`);
  assert.equal(starts.length, 4);
});

test("a read hung past the budget is killed on the real clock", async () => {
  const startedAt = Date.now();
  let killed = false;
  const hung: GhRunner = (_args, signal) => new Promise(() => {
    signal?.addEventListener("abort", () => { killed = true; }, { once: true });
  });
  const result = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 1 }, { gh: hung, readGraceMs: 50 });
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : "", /forge_unreachable/u);
  assert.ok(Date.now() - startedAt < 2_000);
  assert.equal(killed, true, "the read's process is told to stop, not merely abandoned");
});

test("aborting a context command kills its process", async () => {
  const startedAt = Date.now();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(runContextCommand({ kind: "native" }, process.execPath, ["-e", "setTimeout(() => {}, 20000)"], {
    cwd: process.cwd(), signal: controller.signal,
  }));
  assert.ok(Date.now() - startedAt < 5_000);
});

test("a read that fails once the timeout has passed reports the last observation as a timeout", async () => {
  const fake = fakeGh([ok(pr({}, [run(AGGREGATOR, null)])), failed("error connecting to api.github.com")]);
  const result = await waitForPullRequest({ repository: "o/r", number: 7, timeoutMs: 30_000 }, { gh: fake.gh, ...clock() });
  assert.ok(result.ok);
  assert.equal(result.summary.outcome, "timeout");
  assert.equal(result.summary.polls, 2);
  assert.deepEqual(result.summary.checks.required, [{ name: AGGREGATOR, state: "pending", reported: true }]);
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
  assert.match((parsePullRequestRef("https://example.com/a/b/merge_requests/1", undefined) as { error: string }).error, /must be/u);
  assert.match((parsePullRequestRef("0", "o/r") as { error: string }).error, /positive/u);
  assert.match((parsePullRequestRef("1", "../etc") as { error: string }).error, /invalid repository/u);
});
