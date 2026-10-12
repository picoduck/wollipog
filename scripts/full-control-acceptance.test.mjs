import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acceptanceMatrix, inspectLivePlan, liveSteps, isolateTestEnvironment } from "./full-control-acceptance.mjs";

const proposal = () => JSON.parse(readFileSync(new URL("./fixtures/full-control-live-plan.json", import.meta.url), "utf8"));

test("the concrete live proposal identifies missing empirical/authoritative inputs and never grants execution", () => {
  const report = inspectLivePlan(proposal());
  assert.equal(report.status, "blocked");
  assert.equal(report.liveExecutionAvailable, false);
  assert.equal(report.releaseAcceptanceProven, false);
  assert.deepEqual(report.blockers, ["integrated_main_proof", "exact_media_profile_disclosure", "accounted_native_review_profile", "normal_video_certification", "blind_oracle_namespace"]);
});

test("filling JSON with fixture proof digests is still incapable of authorizing a real campaign", () => {
  const plan = proposal();
  plan.integration = { reviewedMainSha: "a".repeat(40), mergedPrerequisites:
    [2934, 2935, 2936, 2937, 2938, 2940, 1321, 1448, 1469].map((issue) => ({ issue, mergeCommitSha: "b".repeat(40) })) };
  plan.provider.media.capabilitiesSha256 = "c".repeat(64);
  Object.assign(plan.provider.codeReview, { controllerSha256: "d".repeat(64), executableSha256: "e".repeat(64), cliVersion: "fixture" });
  plan.oracle.namespaceProbeSha256 = "f".repeat(64);
  plan.evidence.normalVideoCertification = { proofId: "fixture-proof", proofSha256: "a".repeat(64),
    capabilitiesSha256: plan.provider.media.capabilitiesSha256, separateOperatorReservationId: "fixture-reservation",
    completedBeforeAuthorization: true };
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
    [(p) => { p.limits.faultAttempts = 1; }, "finite_aggregate_limits"],
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
  const certification = liveSteps.findIndex((step) => step.includes("Complete normal-video"));
  const authorization = liveSteps.findIndex((step) => step.startsWith("One authenticated-human ingress"));
  assert.ok(certification >= 0 && certification < authorization);
  const recovery = acceptanceMatrix.find((suite) => suite.id === "recovery-and-mutation");
  assert.ok(!recovery.criteria.includes("ancestor-decision-access"));
  assert.ok(recovery.pending.includes("1469-ancestor-decision-enumeration"));
});

test("certification binds the proposed capability and separate reservation before measured authorization", () => {
  const plan = proposal();
  plan.provider.media.capabilitiesSha256 = "a".repeat(64);
  plan.evidence.normalVideoCertification = { proofId: "fixture", proofSha256: "b".repeat(64),
    capabilitiesSha256: "a".repeat(64), separateOperatorReservationId: "operator-fixture", completedBeforeAuthorization: true };
  assert.ok(!inspectLivePlan(plan).blockers.includes("normal_video_certification"));
  plan.evidence.normalVideoCertification.completedBeforeAuthorization = false;
  assert.ok(inspectLivePlan(plan).blockers.includes("normal_video_certification"));
  plan.evidence.normalVideoCertification.completedBeforeAuthorization = true;
  plan.provider.media.capabilitiesSha256 = "c".repeat(64);
  assert.ok(inspectLivePlan(plan).blockers.includes("normal_video_certification"));
});

test("deterministic children lose current and legacy hosting configuration", () => {
  const env = isolateTestEnvironment({ PATH: "/fixture/bin", ORDINARY: "retained",
    WOLLIPOG_SESSION_ID: "fixture", MAM_TOKEN: "fixture", MAM_SESSION_ID: "fixture",
    CONTROL_PLANE_DB: "fixture", RUNNER_STATE_DIR: "fixture" });
  assert.deepEqual(env, { PATH: "/fixture/bin", ORDINARY: "retained" });
});

test("oracle plan directories cannot be the same canonical path or nest within each other", () => {
  const plan = proposal();
  plan.oracle.namespaceProbeSha256 = "f".repeat(64);
  assert.ok(!inspectLivePlan(plan).blockers.includes("blind_oracle_namespace"));
  for (const path of [plan.oracle.operatorDirectory + "/", plan.oracle.operatorDirectory + "/reviewer",
    join(plan.oracle.operatorDirectory, "..")]) {
    plan.oracle.reviewerDirectory = path;
    assert.ok(inspectLivePlan(plan).blockers.includes("blind_oracle_namespace"));
  }
});

test("CLI rejects live execution and malformed plans without echoing private input", () => {
  const path = new URL("./full-control-acceptance.mjs", import.meta.url);
  const run = (args) => spawnSync(process.execPath, [fileURLToPath(path), ...args], { encoding: "utf8", timeout: 10_000 });
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
    writeFileSync(file, "x".repeat(256 * 1024 + 1));
    assert.equal(run(["check-plan", file]).status, 2);
    if (process.platform !== "win32" && existsSync("/dev/zero")) {
      const device = run(["check-plan", "/dev/zero"]);
      assert.equal(device.status, 2, "nonregular zero-size files must be refused without reading");
      assert.equal(device.error, undefined, "the rejection must complete rather than hit the test timeout");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
