import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acceptanceMatrix, inspectLivePlan, liveSteps, isolateTestEnvironment, readPlan } from "./full-control-acceptance.mjs";

const enforcedBoundary = (attestationSha256) => ({ executableSha256: "d".repeat(64), namespacePolicySha256: "e".repeat(64),
  supported: true, attestationSha256, deniedRoutesProofSha256: "f".repeat(64), completeToolAllowlist: true, isolatedContext: true,
  immutableResumePolicy: true });
const proposal = () => JSON.parse(readFileSync(new URL("./fixtures/full-control-live-plan.json", import.meta.url), "utf8"));

test("the concrete live proposal identifies missing empirical/authoritative inputs and never grants execution", () => {
  const report = inspectLivePlan(proposal());
  assert.equal(report.status, "blocked");
  assert.equal(report.liveExecutionAvailable, false);
  assert.equal(report.releaseAcceptanceProven, false);
  assert.deepEqual(report.blockers, ["integrated_main_proof", "exact_media_profile_disclosure", "native_media_boundary", "accounted_native_review_profile", "normal_video_certification", "blind_oracle_namespace"]);
});

test("filling JSON with fixture proof digests is still incapable of authorizing a real campaign", () => {
  const plan = proposal();
  plan.integration = { reviewedMainSha: "a".repeat(40), mergedPrerequisites:
    [2934, 2935, 2936, 2937, 2938, 2940, 1321, 1448, 1469].map((issue) => ({ issue, mergeCommitSha: "b".repeat(40) })) };
  plan.provider.media.capabilitiesSha256 = "c".repeat(64);
  Object.assign(plan.provider.media.nativeBoundary, enforcedBoundary(plan.provider.media.capabilitiesSha256));
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

test("native schema, image modality and added dynamic tools cannot replace an enforced media boundary", () => {
  const plan = proposal();
  plan.provider.media.capabilitiesSha256 = "a".repeat(64);
  Object.assign(plan.provider.media, { supportsImages: true, dynamicTools: ["review_video_evidence_frame", "submit_video_evidence_verdict"] });
  assert.ok(inspectLivePlan(plan).blockers.includes("native_media_boundary"));
  plan.provider.media.nativeBoundary.supported = true;
  assert.ok(inspectLivePlan(plan).blockers.includes("native_media_boundary"), "a claimed flag cannot fill absent enforcement metadata");
});

test("the media boundary accepts only the attested Claude Code media-only reviewer", () => {
  const complete = () => {
    const plan = proposal();
    plan.provider.media.capabilitiesSha256 = "a".repeat(64);
    Object.assign(plan.provider.media.nativeBoundary, enforcedBoundary("a".repeat(64)));
    return plan;
  };
  assert.ok(!inspectLivePlan(complete()).blockers.includes("native_media_boundary"));
  const changes = [
    (p) => { p.provider.media.driver = "codex-app-server"; p.provider.media.nativeBoundary.driver = "codex-app-server"; },
    (p) => { p.provider.media.model = "claude-sonnet-5-5"; },
    (p) => { p.provider.media.nativeBoundary.effort = "low"; },
    (p) => { p.provider.media.nativeBoundary.cliVersion = "2.1.297"; },
    (p) => { p.provider.media.nativeBoundary.profile = "claude-code-default"; },
    (p) => { p.provider.media.nativeBoundary.tools.push("Read"); },
    (p) => { p.provider.media.nativeBoundary.tools.reverse(); },
    (p) => { p.provider.media.nativeBoundary.credential = "operator_login"; },
    (p) => { p.provider.media.nativeBoundary.executableSha256 = null; },
    (p) => { p.provider.media.nativeBoundary.namespacePolicySha256 = "short"; },
    (p) => { p.provider.media.nativeBoundary.attestationSha256 = "b".repeat(64); },
    (p) => { p.provider.media.nativeBoundary.deniedRoutesProofSha256 = null; },
    (p) => { p.provider.media.nativeBoundary.isolatedContext = false; },
  ];
  for (const [index, change] of changes.entries()) {
    const plan = complete(); change(plan);
    assert.ok(inspectLivePlan(plan).blockers.includes("native_media_boundary"), String(index));
  }
});

test("picoduck/wollipog is admissible only as the explicit Human-authorized target under its ceiling", () => {
  const report = inspectLivePlan(proposal());
  assert.ok(!report.blockers.includes("isolated_repository"));
  assert.ok(report.requiredIndependentChecks.includes("human_repository_target_authorization"));
  assert.ok(!report.requiredIndependentChecks.includes("isolated_repository_operator_authorization"));
  const changes = [
    (p) => { delete p.repositoryTarget; },
    (p) => { p.repositoryTarget.authorizedBy = "orchestrator"; },
    (p) => { p.repositoryTarget.kind = "isolated"; },
    (p) => { p.repositoryTarget.repository = "picoduck/other"; },
    (p) => { p.repositoryTarget.costCeilingUsd = 199; },
    (p) => { p.repositoryTarget.costCeilingUsd = 0; },
    (p) => { p.repositoryTarget.reason = " "; },
    (p) => { p.repository = "picoduck/other"; },
  ];
  for (const [index, change] of changes.entries()) {
    const plan = proposal(); change(plan);
    assert.ok(inspectLivePlan(plan).blockers.includes("isolated_repository"), String(index));
  }
  const isolated = proposal();
  isolated.repository = "picoduck/wollipog-full-control-2939-validation";
  delete isolated.repositoryTarget;
  const isolatedReport = inspectLivePlan(isolated);
  assert.ok(!isolatedReport.blockers.includes("isolated_repository"));
  assert.ok(isolatedReport.requiredIndependentChecks.includes("isolated_repository_operator_authorization"));
  const mixedCase = proposal();
  mixedCase.repository = "PICODUCK/WOLLIPOG";
  assert.ok(!inspectLivePlan(mixedCase).blockers.includes("isolated_repository"), "the target names the same repository");
  delete mixedCase.repositoryTarget;
  assert.ok(inspectLivePlan(mixedCase).blockers.includes("isolated_repository"));
});

test("finite allowance, exact private destination, normal video and fixed root are independent required inputs", () => {
  const changes = [
    [(p) => { delete p.repositoryTarget; }, "isolated_repository"],
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
  for (const criterion of ["agent-uncertain-steering-resolution", "ancestor-decision-access",
    "ancestor-decision-list", "descendant-decision-mutation-refusal"]) {
    assert.ok(recovery.criteria.includes(criterion), criterion);
  }
  assert.deepEqual(recovery.pending, ["actual-integrated-steering-recovery",
    "actual-integrated-descendant-decision-inspection"]);
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

test("mixed-case hosting credentials and provider authority are not inherited by deterministic subprocesses", () => {
  const env = isolateTestEnvironment({ PATH: "/fixture/bin", ORDINARY: "retained", Wollipog_AGENT_CONTROL_RELAY_KEY: "synthetic",
    Mam_TOKEN: "synthetic", CODEX_HOME: "/fixture/provider", OPENAI_API_KEY: "synthetic", ANTHROPIC_AUTH_TOKEN: "synthetic",
    AWS_ACCESS_KEY_ID: "synthetic", GH_TOKEN: "synthetic", CUSTOM_PRIVATE_KEY: "synthetic", CLAUDECODE: "synthetic" });
  assert.deepEqual(env, { PATH: "/fixture/bin", ORDINARY: "retained" });
});

test("a plan that grows after descriptor stat is read within the fixed bound and its descriptor closes", () => {
  let closed = false, readBytes = 0;
  const io = { openSync: () => 42, fstatSync: () => ({ isFile: () => true, size: 0 }),
    readSync: (_fd, bytes, offset, count) => { bytes.fill(120, offset, offset + count); readBytes += count; return count; },
    closeSync: (fd) => { assert.equal(fd, 42); closed = true; } };
  assert.throws(() => readPlan("synthetic-growing-file", io), /oversize/u);
  assert.equal(readBytes, 256 * 1024 + 1);
  assert.equal(closed, true);
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
      const fifo = join(directory, "plan.fifo");
      const made = spawnSync("mkfifo", [fifo], { encoding: "utf8", timeout: 10_000 });
      assert.equal(made.status, 0);
      const pipe = run(["check-plan", fifo]);
      assert.equal(pipe.status, 2, "an unopened FIFO writer must not block the plan reader");
      assert.equal(pipe.error, undefined);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
