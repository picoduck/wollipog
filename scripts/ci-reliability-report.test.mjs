import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import { TimingSummary, TIMING_MARKER, parseTiming, identity } from "./ci-timing.mjs";
import { reliabilityReport, triageDecisions, main } from "./ci-reliability-report.mjs";

const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/ci-reliability-outcomes.json", import.meta.url), "utf8"));
const summaryOf = (input) => input.records[0].jobs[0].testTiming.summaries[0];

test("stored outcomes retain failures, retry-only passes, exact identities and recurrence windows", () => {
  const report = reliabilityReport(fixture());
  assert.equal(report.signatures.length, 1);
  const signature = report.signatures[0];
  assert.equal(signature.affectedRuns, 2);
  assert.equal(signature.recurring, true);
  assert.equal(signature.firstSeen, "2026-10-20T01:00:00.000Z");
  assert.equal(signature.lastSeen, "2026-10-21T01:00:00.000Z");
  assert.equal(signature.triage.cause, "unresolved");
  assert.deepEqual(signature.observations.map((row) => row.classification), ["failing", "retry-only", "failing", "retry-only"]);
  assert.equal(signature.observations[0].jobId, 1011);
  assert.equal(report.runOutcomes.length, 2);
  assert.equal(report.rerunRecoveries.length, 1);
  assert.equal(report.rerunRecoveries[0].originalAttempt, 1);
  assert.equal(report.certification, "advisory-never-authorizes-merge");
  assert.deepEqual(report.exclusions, []);
});

test("repeated attempts are not recurring runs and changed suite revisions do not merge", () => {
  const input = fixture(); input.records.splice(1, 1);
  assert.equal(reliabilityReport(input).signatures[0].recurring, false);
  const changed = fixture();
  changed.records[1].jobs[0].testTiming.summaries[0].context.testedSha = "e".repeat(40);
  const report = reliabilityReport(changed);
  assert.equal(report.signatures.length, 2);
  assert.ok(report.signatures.every((row) => !row.recurring && row.triage.cause === "unresolved"));
  assert.equal(report.crossRevisionCandidates.length, 1);
  assert.equal(report.crossRevisionCandidates[0].affectedRuns, 2);
  assert.equal(report.crossRevisionCandidates[0].compatibility, "unverified");
  changed.records[2].sha = "f".repeat(40);
  assert.equal(reliabilityReport(changed).rerunRecoveries.length, 0);
});

test("CLI combines source windows and latest attempts, loads triage and refuses every supplied exclusion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ci-reliability-"));
  try {
    const older = fixture(), newer = fixture();
    for (const [index, input] of [older, newer].entries()) {
      input.collectedAt = "2026-10-22T0" + index + ":00:00Z";
      input.removals = [];
      // The real collector records metrics; keep this inert fixture compatible with its combiner.
      for (const record of input.records) record.metrics = { measuredRunnerMinutes: null };
    }
    newer.records[1].state = "passing";
    const a = join(dir, "a.json"), b = join(dir, "b.json"), triage = join(dir, "triage.json");
    const summary = summaryOf(older), row = summary.reliability.tests[0];
    await writeFile(triage, JSON.stringify({ version: 1, decisions: [{ suite: summary.suite,
      suiteRevision: summary.context.testedSha, fileId: row.fileId, testId: row.testId,
      cause: "unresolved", owner: "test-maintainer", issue: 3517, reviewPullRequest: 3639,
      evidence: [{ runId: 101, attempt: 1, jobId: 1011 }] }] }));
    const outputs = [], errors = [];
    const io = { out: (text) => outputs.push(JSON.parse(text)), err: (text) => errors.push(text) };
    const args = ["--input", b, "--input", a, "--triage", triage];
    await writeFile(a, JSON.stringify(older)); await writeFile(b, JSON.stringify(newer));
    assert.equal(await main(args, io), 0);
    assert.deepEqual(outputs[0].observedAttempts, { first: 2, rerun: 1 });
    assert.equal(outputs[0].windows.length, 2);
    assert.equal(outputs[0].runOutcomes.length, 1);
    assert.equal(outputs[0].signatures[0].triage.issue, 3517);
    for (const input of [older, newer]) for (const target of [input, input.records[0]]) {
      for (const field of ["exclusions", "quarantine"]) {
        target[field] = [{ expiresAt: "2000-01-01T00:00:00Z" }];
        await writeFile(a, JSON.stringify(older)); await writeFile(b, JSON.stringify(newer));
        assert.equal(await main(args, io), 1);
        delete target[field];
      }
    }
    assert.equal(outputs.length, 1, "invalid inputs must not print a report");
    assert.equal(errors.length, 8);
  } finally { await rm(dir, { recursive: true }); }
});

test("CLI refuses oversized files and more than ten inputs without publishing output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ci-reliability-size-"));
  try {
    const file = join(dir, "oversized.json");
    await writeFile(file, "{}");
    await truncate(file, 32 * 1024 * 1024 + 1);
    const outputs = [], io = { out: (line) => outputs.push(line), err: () => {} };
    assert.equal(await main(["--input", file], io), 1);
    assert.equal(await main(Array.from({ length: 11 }, () => ["--input", file]).flat(), io), 1);
    assert.deepEqual(outputs, []);
  } finally { await rm(dir, { recursive: true }); }
});

test("only explicit reviewed exact-scope assertions change cause and ownership", () => {
  for (const cause of ["product-nondeterminism", "environment-sensitivity", "infrastructure-interruption", "unresolved"]) {
    const input = fixture(), summary = summaryOf(input), row = summary.reliability.tests[0];
    const policy = { version: 1, decisions: [{ suite: summary.suite, suiteRevision: summary.context.testedSha,
      fileId: row.fileId, testId: row.testId, cause, owner: "ci-maintainer", issue: 2601,
      reviewPullRequest: 3639, evidence: [{ runId: 101, attempt: 1, jobId: 1011 }] }] };
    assert.equal(reliabilityReport(input, policy).signatures[0].triage.cause, cause);
    policy.decisions[0].testId = "e".repeat(64);
    assert.equal(reliabilityReport(input, policy).signatures[0].triage.cause, "unresolved");
    policy.decisions[0].quarantine = true;
    assert.throws(() => triageDecisions(policy));
  }
});

test("missing, legacy, truncated and mismatched projections are visible gaps", () => {
  for (const change of [
    (input) => { delete summaryOf(input).reliability; },
    (input) => { summaryOf(input).reliability.truncated = true; },
    (input) => { summaryOf(input).context.runId = "999"; },
    (input) => { delete input.records[0].jobs[0].testTiming; },
    (input) => { summaryOf(input).context.testedSha = null; },
    (input) => { input.records[0].jobsTruncated = true; },
  ]) {
    const input = fixture(); change(input);
    assert.ok(reliabilityReport(input).coverageGaps.length > 0);
  }
  const input = fixture(); input.attemptsTruncated = true;
  assert.equal(reliabilityReport(input).sourceIncomplete, true);
  assert.throws(() => reliabilityReport({ ...input, exclusions: [] }));
  assert.throws(() => triageDecisions({ version: 1, decisions: [], exclusions: [{ expiresAt: "2000-01-01" }] }));
});

test("file-scoped known issue matches remain candidates and interruptions do not assert infrastructure", () => {
  const input = fixture(), summary = summaryOf(input);
  summary.reliability.tests[0].fileId = identity("apps/web/e2e/command-inbox-projects.spec.ts");
  summary.reliability.tests[0].state = "cancelled";
  const signature = reliabilityReport(input).signatures.find((row) => row.candidateIssues.length);
  assert.equal(signature.candidateIssues[0].issue, 3517);
  assert.equal(signature.triage.cause, "unresolved");
  assert.equal(signature.observations[0].classification, "cancelled");
});

test("untrusted input is reprojected and failures never echo raw diagnostics", async () => {
  const input = fixture(); input.private = "PRIVATE_SENTINEL";
  input.records[0].branch = "PRIVATE_SENTINEL";
  summaryOf(input).reliability.tests[0].error = "PRIVATE_SENTINEL";
  assert.ok(!JSON.stringify(reliabilityReport(input)).includes("PRIVATE_SENTINEL"));
  const errors = [];
  assert.equal(await main(["--PRIVATE_SENTINEL"], { err: (line) => errors.push(line) }), 1);
  assert.ok(!errors.join().includes("PRIVATE_SENTINEL"));
});

test("arbitrary private strings cannot change or escape the safe report projection", () => {
  const expected = reliabilityReport(fixture());
  fc.assert(fc.property(fc.string({ maxLength: 300 }), (privateText) => {
    const input = fixture();
    input.private = privateText;
    for (const record of input.records) {
      record.branch = privateText;
      record.error = privateText;
      for (const job of record.jobs) {
        job.name = privateText;
        for (const summary of job.testTiming.summaries) {
          summary.stdout = privateText;
          for (const row of summary.reliability.tests) row.error = privateText;
        }
      }
    }
    assert.deepEqual(reliabilityReport(input), expected);
  }), { numRuns: 100 });
});

test("fast failures survive slow top-20 selection; reliability overflow is bounded and marked", () => {
  const summary = new TimingSummary("node");
  for (let i = 0; i < 25; i++) summary.add({ file: process.cwd() + "/synthetic.test.ts", name: "slow-" + i, durationMs: 100, state: "passing" });
  summary.add({ file: process.cwd() + "/synthetic.test.ts", name: "fast failure", durationMs: 1, state: "failing" });
  assert.equal(summary.result().slowestTests.some((row) => row.state === "failing"), false);
  assert.equal(summary.result().reliability.tests[0].state, "failing");
  for (let i = 0; i < 50; i++) summary.add({ file: process.cwd() + "/synthetic.test.ts", name: "fail-" + i, durationMs: 1, state: "failing" });
  const line = TIMING_MARKER + JSON.stringify(summary.result());
  assert.ok(line.length < 32_000);
  assert.equal(parseTiming(line).reliability.tests.length, 40);
  assert.equal(parseTiming(line).reliability.truncated, true);
  const malformed = summary.result(); malformed.reliability.tests[0].fileId = "PRIVATE_SENTINEL";
  assert.equal(parseTiming(TIMING_MARKER + JSON.stringify(malformed)), null);
});

test("existing fail-on-flaky and sanitized diagnostic contracts remain configured", async () => {
  const previous = process.env.CI;
  process.env.CI = "true";
  try {
    for (const path of ["playwright.config.ts", "playwright.webkit.config.ts", "playwright.production.config.ts"]) {
      const { default: config } = await import("../" + path);
      assert.equal(config.failOnFlakyTests, true);
    }
  } finally {
    if (previous === undefined) delete process.env.CI;
    else process.env.CI = previous;
  }
  assert.match(readFileSync("docs/synthetic-browser-failure-artifacts.md", "utf8"), /three days/);
});
