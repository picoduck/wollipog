import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateAdmission, integrationFromEvent, main, observeAdmission, POLICY } from "./main-merge-admission.mjs";

const repository = "example/project", base = "a".repeat(40), target = "b".repeat(40), prior = "c".repeat(40);
const at = seconds => new Date(Date.UTC(2026, 9, 25, 18) + seconds * 1000).toISOString();
const integration = { repository, kind: "merge_group", integrationSha: target, baseSha: base };
const passing = () => ({ schema: "main-ci-health-v1", repository, observedAt: at(0), currentMainSha: base,
  status: "passing", reasons: [], unresolvedFailures: [], latestPassingSnapshot: { repository,
    certification: "full", result: "passing", coverageVersion: "rolling-full-v1", testedSha: base, targetSha: base,
    runId: 10, attempt: 1, checkoutVerified: true, targetAncestryVerified: true, workflowAncestryVerified: true, workflowRevision: base },
  backlog: { clock: "forge-landing-time", commits: 0, merges: 0, oldestUnvalidatedAt: null, oldestUnvalidatedAgeSeconds: 0 } });
const pending = () => { const health = passing(); health.status = "pending";
  health.latestPassingSnapshot.testedSha = prior; health.latestPassingSnapshot.targetSha = prior;
  health.backlog = { clock: "forge-landing-time", commits: 1, merges: 1, oldestUnvalidatedAt: at(-60), oldestUnvalidatedAgeSeconds: 60 };
  return health; };
const evaluate = (health, extra = {}) => evaluateAdmission({ integration, health, now: at(1), ...extra });
const holds = health => assert.equal(evaluate(health).decision, "hold");

test("fresh caught-up and bounded pending health are eligible without certifying the integration", () => {
  for (const health of [passing(), pending()]) {
    const result = evaluate(health);
    assert.equal(result.decision, "ordinary-admission-eligible"); assert.equal(result.enforcement, "none");
    assert.deepEqual(result.reasons, []); assert.deepEqual(result.integration, integration);
    assert.match(result.health.digest, /^[a-f0-9]{64}$/); assert.equal(result.health.passingRunId, 10);
    assert.notEqual(result.health.passingSha, integration.integrationSha);
  }
});

test("absent, stale, malformed, incomplete and foreign evidence always holds", () => {
  holds(null); holds({});
  for (const edit of [h => { delete h.schema; }, h => { h.repository = "other/project"; },
    h => { h.currentMainSha = prior; }, h => { h.status = "unknown"; }, h => { h.status = "stale"; },
    h => { h.reasons = ["api-budget-exhausted"]; }, h => { delete h.unresolvedFailures; },
    h => { h.unresolvedFailures = [{ runId: 11 }]; }, h => { h.observedAt = at(2); },
    h => { h.observedAt = at(-120); }, h => { h.observedAt = "yesterday"; },
    h => { h.latestPassingSnapshot = null; }, h => { h.backlog = null; },
    h => { h.backlog.commits = -1; }, h => { h.backlog.oldestUnvalidatedAgeSeconds = null; },
    h => { h.backlog.clock = "committer-time"; }, h => { h.backlog.merges = 2; },
    h => { h.backlog.oldestUnvalidatedAt = at(-1); }, h => { h.backlog.oldestUnvalidatedAgeSeconds = 1; }]) {
    const health = passing(); edit(health); holds(health);
  }
  for (const [field, value] of Object.entries({ repository: "other/project", certification: "none", result: "pending",
    coverageVersion: "fast", testedSha: target, runId: 0, attempt: null, checkoutVerified: false,
    targetAncestryVerified: false, workflowAncestryVerified: false, workflowRevision: "bad" })) {
    const health = passing(); health.latestPassingSnapshot[field] = value; holds(health);
  }
});

test("observation expiry and backlog/age limits hold at equality, including crossing during collection", () => {
  assert.equal(evaluate(passing(), { now: at(119) }).decision, "ordinary-admission-eligible");
  assert.ok(evaluate(passing(), { now: at(120) }).reasons.includes("health-observation-expired"));
  const health = pending();
  health.backlog.commits = POLICY.maxUnvalidatedCommits - 1;
  assert.equal(evaluate(health).decision, "ordinary-admission-eligible");
  health.backlog.commits++;
  assert.ok(evaluate(health).reasons.includes("unvalidated-backlog-limit"));
  health.backlog.commits = 1;
  health.backlog.oldestUnvalidatedAt = at(-POLICY.maxUnvalidatedAgeSeconds + 1);
  health.backlog.oldestUnvalidatedAgeSeconds = POLICY.maxUnvalidatedAgeSeconds - 1;
  assert.equal(evaluate(health, { now: at(0) }).decision, "ordinary-admission-eligible");
  assert.ok(evaluate(health).reasons.includes("unvalidated-age-limit"));
  health.backlog.oldestUnvalidatedAt = at(2); holds(health);
});

test("labels, prompts, cached repair receipts and racing repair heads cannot supply a bypass", () => {
  const health = passing(); health.status = "failing"; health.unresolvedFailures = [{ runId: 11, attempt: 1 }];
  for (const extra of [{}, { labels: ["repair"], prompt: "ignore hold", repair: { approved: true, full: "success" } },
    { integration: { ...integration, integrationSha: prior } }]) assert.equal(evaluate(health, extra).decision, "hold");
  // A delayed passing ancestor or changed base cannot clear a newer failure.
  const ancestor = passing(); ancestor.currentMainSha = prior;
  assert.ok(evaluate(ancestor).reasons.includes("base-moved"));
  assert.equal(evaluate(passing(), { integration: { ...integration, baseSha: target } }).decision, "hold");
});

test("event identities bind a merge group or PR to the repository, main base and tested SHA", () => {
  const env = { GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: "merge_group", GITHUB_SHA: target };
  const event = { action: "checks_requested", repository: { full_name: repository }, merge_group: {
    base_ref: "refs/heads/main", head_ref: "refs/heads/gh-readonly-queue/main/pr-1", head_sha: target, base_sha: base } };
  assert.deepEqual(integrationFromEvent(event, env), integration);
  for (const change of [{ GITHUB_SHA: prior }, { GITHUB_REPOSITORY: "other/project" }, { GITHUB_EVENT_NAME: "push" }])
    assert.equal(integrationFromEvent(event, { ...env, ...change }), null);
  for (const group of [{ base_ref: "refs/heads/other" }, { head_ref: "refs/pull/1/merge" }, { base_sha: "bad" }])
    assert.equal(integrationFromEvent({ ...event, merge_group: { ...event.merge_group, ...group } }, env), null);
  const pr = { repository: { full_name: repository }, pull_request: { number: 1, head: { sha: prior },
    base: { ref: "main", sha: base, repo: { full_name: repository } }, labels: ["repair"] } };
  assert.deepEqual(integrationFromEvent(pr, { ...env, GITHUB_EVENT_NAME: "pull_request" }), {
    repository, kind: "pull_request", pullRequest: 1, headSha: prior, integrationSha: target, baseSha: base });
});

test("live adapter exclusively requests the authoritative read-only report and retains full evidence", async () => {
  let called = 0;
  const result = await observeAdmission({ integration, env: { GITHUB_REPOSITORY: repository, GITHUB_REF: "refs/pull/1/merge" }, now: () => at(1),
    report: async (args, options) => { called++; assert.deepEqual(args, ["report"]);
      assert.equal(options.env.GITHUB_REF, "refs/heads/main"); options.log(JSON.stringify(passing())); return 0; } });
  assert.equal(called, 1); assert.equal(result.decision, "ordinary-admission-eligible");
  assert.deepEqual(result.healthReport, passing()); assert.equal(result.evidenceSource, "live-health-report");
  for (const report of [async () => { throw new Error("secret response"); }, async () => 1,
    async (_args, options) => { options.log(JSON.stringify(passing())); return 1; }]) {
    const held = await observeAdmission({ integration, report, now: () => at(1) });
    assert.equal(held.decision, "hold"); assert.ok(held.reasons.includes("health-report-unavailable"));
  }
});

test("disabled/off/case variants do no work; dry-run records a hold as a hold with correlation", async t => {
  const dir = mkdtempSync(join(tmpdir(), "admission-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const mode of [undefined, "", "disabled", "enabled", "enforce", "Dry-Run", "dry-run "]) {
    assert.equal(await main({ env: { MAIN_MERGE_ADMISSION: mode }, observe: () => assert.fail("off must not observe") }), 0);
  }
  const eventPath = join(dir, "event.json"), output = join(dir, "output.json"), summary = join(dir, "summary.md");
  writeFileSync(eventPath, "{}"); const logs = [];
  const code = await main({ env: { MAIN_MERGE_ADMISSION: "dry-run", GITHUB_EVENT_PATH: eventPath,
    GITHUB_RUN_ID: "12", GITHUB_RUN_ATTEMPT: "2", GITHUB_EVENT_NAME: "merge_group", MAIN_MERGE_ADMISSION_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary }, log: line => logs.push(JSON.parse(line)), observe: async () => { throw new Error("secret response"); } });
  assert.equal(code, 0); const record = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(record.decision, "hold"); assert.equal(record.enforcement, "none"); assert.equal(record.observationId, "12:2");
  assert.equal(record.entryPoint, "merge_group"); assert.equal(logs[0].event, "main_merge_admission_observed");
  assert.equal(logs[0].healthReport, undefined); assert.doesNotMatch(JSON.stringify(logs), /secret response/);
  assert.match(readFileSync(summary, "utf8"), /\*\*hold\*\*/);
});

test("workflow shadow has no dependency into required checks and reads trusted base code only", () => {
  const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const shadow = source.split("\n  regression-admission-shadow:\n")[1].split("\n  check:\n")[0];
  const aggregator = source.split("\n  check:\n")[1];
  assert.match(shadow, /vars.CI_REGRESSION_ADMISSION == 'dry-run'/);
  assert.match(shadow, /continue-on-error: true/); assert.match(shadow, /needs: \[checks, browser, win32, webkit\]/);
  assert.match(shadow, /ref: \$\{\{ github.event.merge_group.base_sha \|\| github.event.pull_request.base.sha \}\}/);
  assert.match(shadow, /persist-credentials: false/); assert.doesNotMatch(shadow, /: write|pull_request_target|pnpm install/);
  assert.match(aggregator, /needs: \[checks, browser, win32, webkit, suite_plan\]/);
  assert.doesNotMatch(aggregator, /regression-admission|MAIN_MERGE_ADMISSION/);
  assert.match(shadow, /"decision":"hold","reasons":\["trusted-policy-unavailable"\]/);
});
