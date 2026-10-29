import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FAST_API_FILES, FAST_PROSE_FILES, CRITICAL_BROWSER_FILES } from "./ci-suite-policy.mjs";
import { makeSelection, hash, SELECTION_MARKER } from "./ci-suite-selection.mjs";
import { shadowReport } from "./ci-suite-shadow-report.mjs";
import { readTimingLog } from "./merge-queue-wait-report.mjs";

const testedSha = "b".repeat(40), baseSha = "a".repeat(40);
const tree = [...FAST_API_FILES, ...CRITICAL_BROWSER_FILES.map((file) => `apps/web/e2e/${file}`), "apps/web/e2e/deferred.spec.ts"]
  .map((path) => ({ path, oid: baseSha }));
const plan = () => makeSelection({ tree, fastFiles: [], diff: { entries: [{ path: FAST_PROSE_FILES[0], status: "M" }] }, policyId: hash("policy-fixture"),
  context: { baseSha, diffBaseSha: baseSha, testedSha, changeHeadSha: testedSha, trustedPolicySha: baseSha,
    runId: "101", attempt: 1, event: "merge_group", diffKind: "combined-merge-group" } });
const summary = (suite) => ({ version: 1, suite, count: 3, failed: 0, skipped: 0, cancelled: 0, unmeasured: 0, retryOnly: 0, truncated: false,
  context: { runId: "101", attempt: 1, testedSha, workflowSha: testedSha }, slowestFiles: [], slowestTests: [], reliability: { tests: [], truncated: false } });
function input() {
  const names = ["Typecheck, Unit Tests & Bundles", ...[1, 2, 3, 4, 5].map((n) => `Browser End-to-End Tests (${n})`), "WebKit End-to-End Tests"];
  const jobs = names.map((name, index) => ({ id: 1010 + index, name, state: "passing", steps: [],
    testTiming: { state: "measured", summaries: name.endsWith("(1)") ? [summary("browser"), summary("browser")]
      : [summary(index === 0 ? "node" : "browser")] } }));
  jobs.push({ id: 1020, name: "Settings-Rows win32 Baselines / Detect Settings-Rows Changes", state: "passing", steps: [] },
    { id: 1021, name: "Settings-Rows win32 Baselines / Compare win32 Settings-Rows Baselines", state: "skipped", steps: [] },
    { id: 1022, name: "Suite Selection Shadow (Advisory)", state: "passing", testTiming: { summaries: [], selections: [plan()] } });
  return { schemaVersion: 2, repository: "picoduck/wollipog", windows: [{ since: "2026-10-20T00:00:00Z", until: "2026-10-22T00:00:00Z" }],
    records: [{ repository: "picoduck/wollipog", runId: 101, attempt: 1, event: "merge_group", sha: testedSha, testedSha,
      state: "passing", createdAt: "2026-10-20T01:00:00Z", pullRequest: 123, jobs, metrics: { requiredMinutes: 30 } }] };
}
function failTest(data, file, { retryOnly = false } = {}) {
  const record = data.records[0], job = record.jobs[1], result = job.testTiming.summaries[0];
  record.state = "failing"; job.state = "failing";
  result.failed = 1;
  result.reliability.tests = [{ fileId: hash(file), testId: hash("inert-failure"), durationMs: 10, state: "failing", retry: 0 }];
  if (retryOnly) { result.retryOnly = 1; result.reliability.tests.push({ ...result.reliability.tests[0], state: "passing", retry: 1 }); }
}

test("full passing results yield explicitly inferred samples with actual full runtime and no selected runtime", () => {
  const report = shadowReport(input());
  assert.equal(report.comparisons.length, 1);
  assert.equal(report.comparisons[0].projectedSelectedOutcome, "passing");
  assert.equal(report.comparisons[0].fullRequiredMinutes, 30);
  assert.equal(report.comparisons[0].selectedRuntimeMs, null);
  assert.equal(report.cohorts[0].sampleThresholdMet, false);
  assert.equal(report.certification, "none");
});

test("known selected failures and missed-failure candidates remain individual exact identities", () => {
  const selected = input(); failTest(selected, "apps/web/e2e/request-surfaces.spec.ts");
  const covered = shadowReport(selected).comparisons[0];
  assert.equal(covered.projectedSelectedOutcome, "failing");
  assert.equal(covered.missedFailureCandidate, false);
  const deferred = input(); failTest(deferred, "apps/web/e2e/deferred.spec.ts");
  const missed = shadowReport(deferred).comparisons[0];
  assert.equal(missed.missedFailureCandidate, true);
  assert.equal(missed.failures[0].fileId, hash("apps/web/e2e/deferred.spec.ts"));
});

test("an affected journey can detect a failure that the fixed fast set would miss", () => {
  const data = input(), previous = data.records[0].jobs.at(-1).testTiming.selections[0];
  data.records[0].jobs.at(-1).testTiming.selections[0] = makeSelection({ tree, fastFiles: [], policyId: previous.policyId,
    context: previous.context, diff: { entries: [{ path: "apps/web/src/components/Timeline.tsx", status: "M" }] } });
  failTest(data, "apps/web/e2e/deferred.spec.ts");
  const compared = shadowReport(data).comparisons[0];
  assert.equal(compared.projectedFastOutcome, "passing");
  assert.equal(compared.projectedSelectedOutcome, "failing");
  assert.equal(compared.fastMissedFailureCandidate, true);
  assert.equal(compared.missedFailureCandidate, false);
});

test("production failures are always selected even when that file's development group is deferred", () => {
  const data = input();
  const record = data.records[0], job = record.jobs.find((row) => row.name === "Browser End-to-End Tests (1)");
  record.state = "failing"; job.state = "failing";
  const production = job.testTiming.summaries[1];
  production.failed = 1;
  production.reliability.tests = [{ fileId: hash("apps/web/e2e/deferred.spec.ts"), testId: hash("production-failure"),
    state: "failing", retry: 0, durationMs: 10 }];
  const compared = shadowReport(data).comparisons[0];
  assert.equal(compared.projectedSelectedOutcome, "failing");
  assert.equal(compared.missedFailureCandidate, false);
});

test("shard-1 failures preserve miss candidates when production was skipped", () => {
  const data = input(); failTest(data, "apps/web/e2e/deferred.spec.ts");
  data.records[0].jobs[1].testTiming.summaries.pop();
  data.records[0].jobs[1].steps = [{ number: 20, name: "Rendered Production Browser Smoke", state: "skipped" }];
  const report = shadowReport(data), compared = report.comparisons[0];
  assert.equal(compared.missedFailureCandidate, true);
  assert.equal(compared.projectedSelectedOutcome, "unmeasured");
  assert.equal(compared.eligible, false);
  assert.equal(report.partialFailureObservations, 1);
  assert.equal(report.naturalProjectedSamples, 0);
  assert.equal(report.cohorts[0].missedFailureCandidates, 1);
  assert.equal(report.cohorts[0].distinctIdentifiedChanges, 0);
});

test("mandatory typecheck failure is visible even when Node tests never ran", () => {
  const data = input(), record = data.records[0], node = record.jobs[0];
  record.state = "failing"; node.state = "failing"; node.testTiming.summaries = [];
  node.steps = [{ number: 10, name: "Typecheck", state: "failing" }];
  const compared = shadowReport(data).comparisons[0];
  assert.equal(compared.projectedFastOutcome, "failing");
  assert.equal(compared.projectedSelectedOutcome, "failing");
  assert.equal(compared.eligible, false);
  assert.deepEqual(compared.mandatoryFailures, [{ jobId: node.id, step: 10 }]);
});

test("retry-only, infrastructure candidates, truncation and missing coverage cannot count as eligible passes", () => {
  const retry = input(); failTest(retry, "apps/web/e2e/deferred.spec.ts", { retryOnly: true });
  const retried = shadowReport(retry);
  assert.equal(retried.exclusions[0].reason, "retry-only-test-signal");
  assert.equal(retried.exclusions[0].cause, "unresolved");
  assert.equal(retried.comparisons.length, 0);
  const infra = input(); infra.records[0].jobs[0].steps.push({ number: 1, name: "Install Dependencies", state: "failing" });
  assert.equal(shadowReport(infra).exclusions[0].cause, "unresolved");
  const truncated = input(); truncated.records[0].jobs[0].testTiming.summaries[0].reliability.truncated = true;
  assert.equal(shadowReport(truncated).gaps.length, 1);
  const absent = input(); absent.records[0].jobs.pop();
  assert.equal(shadowReport(absent).gaps.length, 1);
  const mismatch = input(); mismatch.records[0].jobs[0].testTiming.summaries[0].context.testedSha = baseSha;
  assert.equal(shadowReport(mismatch).gaps.length, 1);
  const stale = input(); stale.records[0].jobs.at(-1).testTiming.selections[0].context.trustedPolicySha = testedSha;
  assert.equal(shadowReport(stale).gaps.length, 1);
  const lastPR = input(); lastPR.records[0].jobs.at(-1).testTiming.selections[0].context.diffKind = "pr-merge-base";
  assert.equal(shadowReport(lastPR).gaps.length, 1);
});

test("reruns cannot inflate changes and suite/policy identities never share a cohort", () => {
  const data = input(), duplicate = structuredClone(data.records[0]);
  duplicate.runId = 102;
  for (const job of duplicate.jobs) {
    for (const s of job.testTiming?.summaries ?? []) s.context.runId = "102";
    for (const p of job.testTiming?.selections ?? []) { p.context.runId = "102"; p.policyId = hash("other-policy"); }
  }
  data.records.push(duplicate);
  assert.equal(shadowReport(data).cohorts.length, 2);
  const rerun = input(); rerun.records[0].attempt = 2;
  rerun.records[0].jobs.at(-1).testTiming.selections[0].context.attempt = 2;
  assert.equal(shadowReport(rerun).exclusions[0].reason, "rerun-not-an-independent-change");
});

test("the long-window threshold requires 30 independent identified changes across five working dates", () => {
  const data = input(), original = data.records[0];
  data.windows = [{ since: "2026-10-19T00:00:00Z", until: "2026-10-24T00:00:00Z" }];
  data.records = Array.from({ length: 30 }, (_, index) => {
    const record = structuredClone(original), sha = (index + 1000).toString(16).padStart(40, "0");
    record.runId = 101 + index; record.pullRequest = 200 + index; record.sha = sha; record.testedSha = sha;
    record.createdAt = `2026-10-${19 + index % 5}T01:00:00Z`;
    for (const job of record.jobs) {
      job.id += index * 100;
      for (const summary of job.testTiming?.summaries ?? []) { summary.context.runId = String(record.runId); summary.context.testedSha = sha; }
      for (const selection of job.testTiming?.selections ?? []) {
        selection.context.runId = String(record.runId); selection.context.testedSha = sha; selection.context.changeHeadSha = sha;
      }
    }
    return record;
  });
  assert.equal(shadowReport(data).cohorts[0].sampleThresholdMet, true);
  assert.equal(shadowReport(data).certification, "none");
  for (const record of data.records) record.pullRequest = 123;
  const repeated = shadowReport(data).cohorts[0];
  assert.equal(repeated.distinctIdentifiedChanges, 1);
  assert.equal(repeated.distinctWorkingDatesUTC, 1);
  assert.equal(repeated.sampleThresholdMet, false);
});

test("baseline absence is unmeasured and unsupported exclusions are rejected before evaluation", () => {
  const baseline = JSON.parse(readFileSync(new URL("../docs/ci-baseline-2026-10-22.json", import.meta.url)));
  assert.equal(shadowReport(baseline).naturalProjectedSamples, 0);
  assert.ok(shadowReport(baseline).gaps.length);
  const data = input(); data.exclusions = [];
  assert.throws(() => shadowReport(data));
});

test("unknown runtime, window, revision and step metadata cannot leak arbitrary input", () => {
  const data = input();
  data.windows[0].privateInput = "PRIVATE_SENTINEL";
  data.records[0].metrics.requiredMinutes = { privateInput: "PRIVATE_SENTINEL" };
  assert.equal(shadowReport(data).comparisons[0].fullRequiredMinutes, null);
  assert.ok(!JSON.stringify(shadowReport(data)).includes("PRIVATE_SENTINEL"));
  data.records[0].jobs[0].steps.push({ name: "Install Dependencies", number: { privateInput: "PRIVATE_SENTINEL" }, state: "failing" });
  assert.ok(!JSON.stringify(shadowReport(data)).includes("PRIVATE_SENTINEL"));
  data.records[0].jobs.pop(); data.records[0].testedSha = { privateInput: "PRIVATE_SENTINEL" };
  assert.ok(!JSON.stringify(shadowReport(data)).includes("PRIVATE_SENTINEL"));
});

test("the existing bounded log collector projects safe selection metadata with the same redirect boundary", async () => {
  const row = plan();
  const log = `2026-10-20T01:00:00Z ${SELECTION_MARKER}${JSON.stringify({ ...row, privateInput: "PRIVATE_SENTINEL" })}\n`;
  const result = await readTimingLog("private-token", "picoduck/wollipog", "101", async (url, options) => {
    if (String(url).startsWith("https://api.github.com")) return new Response(null, { status: 302, headers: { location: "https://safe.blob.core.windows.net/job" } });
    assert.equal(options.headers, undefined);
    return new Response(log);
  });
  assert.deepEqual(result.selections, [row]);
  assert.equal(result.state, "measured");
  assert.ok(!JSON.stringify(result).includes("PRIVATE_SENTINEL"));
});

test("invalid selection echoes and oversized unrelated lines do not truncate legacy timing", async () => {
  const marker = "ci-timing-v1 " + JSON.stringify(summary("node"));
  const chunks = ["ci-selection-v1 {bad json\n", "x".repeat(40_000), "x".repeat(800_000), `\n${marker}\n`];
  const result = await readTimingLog("private-token", "picoduck/wollipog", "101", async (url) => {
    if (String(url).startsWith("https://api.github.com")) return new Response(null, { status: 302, headers: { location: "https://safe.blob.core.windows.net/job" } });
    return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }));
  });
  assert.equal(result.truncated, false);
  assert.equal(result.summaries.length, 1);
  assert.equal(result.selectionTruncated, undefined);
});

test("oversized selection output has its own truncation flag and cannot yield a sample", async () => {
  const log = `${SELECTION_MARKER}${"x".repeat(800_000)}\n${SELECTION_MARKER}${JSON.stringify(plan())}\n`;
  const result = await readTimingLog("private-token", "picoduck/wollipog", "101", async (url) =>
    String(url).startsWith("https://api.github.com")
      ? new Response(null, { status: 302, headers: { location: "https://safe.blob.core.windows.net/job" } }) : new Response(log));
  assert.equal(result.truncated, false);
  assert.equal(result.selectionTruncated, true);
  const data = input(); data.records[0].jobs.at(-1).testTiming = result;
  assert.equal(shadowReport(data).naturalProjectedSamples, 0);
  assert.equal(shadowReport(data).gaps.length, 1);
});

test("shadow workflow is advisory, draft guarded and runs base-revision code without dependency installation", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const shadow = workflow.split("\n  suite-shadow:\n")[1].split("\n  check:\n")[0];
  assert.match(shadow, /continue-on-error: true/);
  assert.match(shadow, /github\.event\.pull_request\.draft == false/);
  assert.match(shadow, /ref: \$\{\{ github\.event\.merge_group\.base_sha \|\| github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(shadow, /--change-head "\$CHANGE_HEAD_SHA"/);
  assert.doesNotMatch(shadow, /pnpm install|pnpm test|pull_request_target/);
  assert.match(workflow, /needs: \[checks, browser, win32, webkit, delegated_pipeline, suite_plan, merge_group_gate\]/);
});
