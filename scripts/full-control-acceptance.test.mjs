import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acceptanceMatrix, inspectLivePlan, liveSteps } from "./full-control-acceptance.mjs";

const proposal = () => JSON.parse(readFileSync(new URL("./fixtures/full-control-live-plan.json", import.meta.url), "utf8"));

test("the concrete live proposal identifies missing empirical/authoritative inputs and never grants execution", () => {
  const report = inspectLivePlan(proposal());
  assert.equal(report.status, "blocked");
  assert.equal(report.liveExecutionAvailable, false);
  assert.equal(report.releaseAcceptanceProven, false);
  assert.deepEqual(report.blockers, ["integrated_main_proof", "exact_media_profile_disclosure", "accounted_native_review_profile", "blind_oracle_namespace"]);
});

test("filling JSON with fixture proof digests is still incapable of authorizing a real campaign", () => {
  const plan = proposal();
  plan.integration = { reviewedMainSha: "a".repeat(40), mergedPrerequisites:
    [2934, 2935, 2936, 2937, 2938, 2940, 1321, 1448, 1469].map((issue) => ({ issue, mergeCommitSha: "b".repeat(40) })) };
  plan.provider.media.capabilitiesSha256 = "c".repeat(64);
  Object.assign(plan.provider.codeReview, { controllerSha256: "d".repeat(64), executableSha256: "e".repeat(64), cliVersion: "fixture" });
  plan.oracle.namespaceProbeSha256 = "f".repeat(64);
  const report = inspectLivePlan(plan);
  assert.equal(report.planComplete, true);
  assert.equal(report.status, "blocked");
  assert.equal(report.liveExecutionAvailable, false);
  assert.ok(report.requiredIndependentChecks.includes("authenticated_human_envelope"));
  assert.ok(report.requiredIndependentChecks.includes("actual_media_and_cost_proof"));
});

test("finite allowance, exact private destination, normal video and fixed root are independent required inputs", () => {
  const changes = [
    [(p) => { p.repository = "PICODUCK/WOLLIPOG"; }, "isolated_repository"],
    [(p) => { p.limits.costUsd = Infinity; }, "finite_aggregate_limits"],
    [(p) => { p.limits.toolCalls = 0; }, "finite_aggregate_limits"],
    [(p) => { p.limits.faultAttempts = 7; }, "finite_aggregate_limits"],
    [(p) => { p.limits.unknownUsage = "zero"; }, "no_limit_reset"],
    [(p) => { p.provider.root.effort = "low"; }, "fixed_root_profile"],
    [(p) => { p.evidence.destinationKind = "external_url"; }, "private_destination_retention"],
    [(p) => { p.evidence.candidateOnly = true; }, "normal_video_original_gate"],
    [(p) => { p.evidence.originalGateSnapshotPreserved = false; }, "normal_video_original_gate"],
    [(p) => { p.scope.originalIssues = [1, 1]; }, "exact_original_issue_scope"],
    [(p) => { p.isolation.hostingStackChanges = true; }, "isolated_services"],
    [(p) => { p.accounting.unpricedIsZero = true; }, "usage_provenance"],
  ];
  for (const [change, code] of changes) {
    const plan = proposal(); change(plan);
    assert.ok(inspectLivePlan(plan).blockers.includes(code), code);
  }
  assert.ok(inspectLivePlan(null).blockers.length > 0);
});

test("every prepared matrix path exists and browser/provider coverage is explicitly deterministic", () => {
  const files = acceptanceMatrix.flatMap((suite) => suite.files);
  assert.equal(new Set(files).size, files.length);
  for (const file of files) assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), file);
  assert.ok(liveSteps.some((step) => step.includes("normal-video source frame")));
  assert.ok(liveSteps.some((step) => step.includes("actual MERGED")));
  assert.ok(liveSteps.some((step) => step.includes("without a required result acknowledgment")));
});

test("CLI rejects live execution and malformed plans without echoing private input", () => {
  const path = new URL("./full-control-acceptance.mjs", import.meta.url);
  const run = (args) => spawnSync(process.execPath, [path.pathname, ...args], { encoding: "utf8", timeout: 10_000 });
  assert.equal(run(["live"]).status, 2);
  assert.equal(run(["run-deterministic", "untrusted-command"]).status, 2);
  const directory = mkdtempSync(join(tmpdir(), "full-control-plan-test-"));
  try {
    const file = join(directory, "private.json");
    writeFileSync(file, "PRIVATE_INVALID_INPUT");
    const invalid = run(["check-plan", file]);
    assert.equal(invalid.status, 2);
    assert.ok(!`${invalid.stdout}${invalid.stderr}`.includes("PRIVATE_INVALID_INPUT"));
    writeFileSync(file, JSON.stringify(proposal()));
    const checked = run(["check-plan", file]);
    assert.equal(checked.status, 2);
    assert.equal(JSON.parse(checked.stdout).status, "blocked");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
