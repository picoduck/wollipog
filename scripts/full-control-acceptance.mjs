#!/usr/bin/env node
/** Offline #2939 preparation runner. Never creates a live grant or invokes a real provider/forge. */
import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, isAbsolute, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";

export const acceptanceMatrix = Object.freeze([
  { id: "joined-authority", criteria: ["root-planning", "generic-child-permission", "image-feedback-repair", "concurrent-consume", "restart-stale-grant", "exception-continuation"],
    files: ["apps/control-plane/src/full-control-acceptance.integration.test.ts", "apps/control-plane/src/campaign-authority.test.ts", "packages/protocol/src/campaign-authority.test.ts"] },
  { id: "recovery-and-mutation", criteria: ["uncertain-mutation-reconciliation", "runner-steering-dedup", "own-child-decision-access", "audience-refusal"],
    pending: ["1448-agent-steering-recovery", "1469-ancestor-decision-enumeration"],
    files: ["apps/control-plane/src/workflow-action-reconciliation-route.integration.test.ts", "apps/control-plane/src/session-descendants-route.integration.test.ts", "apps/runner/src/session-manager-steering.test.ts"] },
  { id: "media-integrity", criteria: ["all-candidate-frames", "transient-integrity", "unsupported-video-fallback"],
    files: ["apps/control-plane/src/video-frame-decode.test.ts", "apps/control-plane/src/video-frame-validation.test.ts", "apps/control-plane/src/ui-evidence-review.test.ts"] },
  { id: "delivery-and-cleanup", criteria: ["simulated-forge-not-delivery", "ledger-follow-up-dedup", "cleanup-refusal", "durable-report", "attention-semantics"],
    files: ["apps/control-plane/src/campaign-status-acceptance.integration.test.ts", "apps/control-plane/src/campaign-work-state.test.ts", "apps/control-plane/src/campaign-report-recovery.test.ts", "apps/control-plane/src/session-attention.db.test.ts"] },
  { id: "provider-boundary", criteria: ["managed-provider-restrictions", "unknown-effects", "out-of-bound-repository"],
    files: ["apps/runner/src/orchestrator-provider-permissions.test.ts", "apps/runner/src/orchestrator-additive-campaign.integration.test.ts"] },
]);

export const liveSteps = Object.freeze([
  "Freeze reviewed integrated main and prerequisite merge commits; verify actual current runtime capabilities.",
  "Operator establishes disposable services/state and the exact private test repository; never reuse hosting ports or databases.",
  "Operator verifies existing account/profile, official prices and stricter limits; authenticate outside the campaign if needed.",
  "Probe the actual media-only reviewer namespace and tools; generate fresh private oracle afterward, outside that namespace.",
  "Complete normal-video candidate/paced/maximum certification under a separately human-authorized metered operator reservation; finish required human inspection/registration before the measured campaign authorization.",
  "One authenticated-human ingress composes exact repository/objective/scope/effects, finite aggregate allowance and private evidence disclosure.",
  "Capture authoritative server authorization and admission digests; record all later human requests, acknowledgments and policy edits as failures of the positive run.",
  "Resolve epic membership; implement the sanitized test UI interaction; capture screenshot and normal paced video through approved private Session storage.",
  "Deliver exact screenshot plus every normal-video source frame to the admitted reviewer; retain original UI-gate artifact snapshot and separate actual reviewer provenance.",
  "Require criteria-bound defect/verdict and complete ordered delivery proof; compare blind answers against the committed private oracle after the reviewer finishes.",
  "Repair verified feedback, recapture/re-review changed bytes and current head; run accounted Opus 5.5 high native code review separately from managed media review.",
  "Check required branch CI on the reviewed pushed SHA; consume exact merge admission; observe successful merge-group CI and actual MERGED with commit on default branch.",
  "Record/adjudicate one justified related follow-up, inspect duplicates, sanitize/review exact title/body/labels, publish once and read back exact payload.",
  "Complete that follow-up through review, exact-head and merge-group CI and actual merge; close delivered test issues through enforced authority and read them back.",
  "Verify direct stacked dependents; delete only safe merged branches; verify child reports, retired clean worktrees and stopped/archived sessions.",
  "Confirm informational completion without a required result acknowledgment; reconcile model-priced usage separately from billed invoice evidence.",
  "Repeat adversarial fault cases in fresh bounded attempts; never reset allowance, review epoch, grants, mutation identity or oracle boundary.",
]);

const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
const text = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 2048;
const positive = (value) => Number.isFinite(value) && value > 0;
const integer = (value) => Number.isSafeInteger(value) && value > 0;

function disjointDirectories(left, right) {
  if (!text(left) || !text(right) || !isAbsolute(left) || !isAbsolute(right)) return false;
  const below = (parent, child) => {
    const part = relative(resolve(parent), resolve(child));
    return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
  };
  return !below(left, right) && !below(right, left);
}

/** Checks completeness only. Agent-authored JSON is never evidence of human authority/readiness. */
export function inspectLivePlan(plan) {
  const blockers = [];
  const need = (condition, code) => { if (!condition) blockers.push(code); };
  need(plan?.version === 1 && plan?.status === "proposed", "plan_format");
  need(text(plan?.repository) && /^[\w.-]+\/[\w.-]+$/u.test(plan.repository) &&
    plan.repository.toLowerCase() !== "picoduck/wollipog", "isolated_repository");
  need(text(plan?.objective), "objective");
  need(Array.isArray(plan?.scope?.originalIssues) && plan.scope.originalIssues.length > 0 &&
    plan.scope.originalIssues.every(integer) && new Set(plan.scope.originalIssues).size === plan.scope.originalIssues.length,
  "exact_original_issue_scope");
  need(Array.isArray(plan?.scope?.effects) && ["issue_create", "issue_close", "branch_push", "pull_request_create", "pull_request_merge", "merged_branch_delete", "session_archive", "worktree_retire"].every((effect) => plan.scope.effects.includes(effect)), "effects");
  need(plan?.scope?.relatedFollowUps === 1, "bounded_related_follow_up");
  need(sha(plan?.integration?.reviewedMainSha) && Array.isArray(plan?.integration?.mergedPrerequisites) &&
    [2934, 2935, 2936, 2937, 2938, 2940, 1321, 1448, 1469].every((issue) =>
      plan.integration.mergedPrerequisites.some((p) => p?.issue === issue && sha(p?.mergeCommitSha))), "integrated_main_proof");
  need(positive(plan?.limits?.costUsd) && integer(plan?.limits?.toolCalls) && integer(plan?.limits?.concurrency) &&
    integer(plan?.limits?.wallTimeMinutes) && plan?.limits?.followUps === 1 &&
    plan?.limits?.faultAttempts === 6, "finite_aggregate_limits");
  need(plan?.limits?.onExhaustion === "stop_without_override" && plan?.limits?.unknownUsage === "retain_reservation", "no_limit_reset");
  need(plan?.provider?.root?.driver === "codex-app-server" && plan?.provider?.root?.model === "gpt-6.1-sol" &&
    plan?.provider?.root?.effort === "high" && text(plan?.provider?.root?.accountProfile), "fixed_root_profile");
  need(["codex-app-server", "claude-code"].includes(plan?.provider?.media?.driver) && text(plan?.provider?.media?.model) &&
    text(plan?.provider?.media?.provider) && text(plan?.provider?.media?.accountProfile) &&
    digest(plan?.provider?.media?.capabilitiesSha256) && text(plan?.provider?.media?.retentionDisclosure), "exact_media_profile_disclosure");
  need(plan?.provider?.codeReview?.profile === "native_opus_5_5_high_read_only" &&
    text(plan?.provider?.codeReview?.accountProfile) && text(plan?.provider?.codeReview?.cliVersion) &&
    digest(plan?.provider?.codeReview?.controllerSha256) && digest(plan?.provider?.codeReview?.executableSha256), "accounted_native_review_profile");
  need(plan?.evidence?.destinationKind === "private_session_artifacts" && text(plan?.evidence?.destination) &&
    text(plan?.evidence?.retention) && plan?.evidence?.sanitizedGeneratedMediaOnly === true, "private_destination_retention");
  need(plan?.evidence?.videoProfile === "paced-silent-complete-frames-v1" && plan?.evidence?.allSourceFrames === true &&
    plan?.evidence?.candidateOnly === false && plan?.evidence?.originalGateSnapshotPreserved === true, "normal_video_original_gate");
  const certification = plan?.evidence?.normalVideoCertification;
  need(text(certification?.proofId) && digest(certification?.proofSha256) &&
    digest(certification?.capabilitiesSha256) && certification.capabilitiesSha256 === plan?.provider?.media?.capabilitiesSha256 &&
    text(certification?.separateOperatorReservationId) && certification?.completedBeforeAuthorization === true,
  "normal_video_certification");
  need(disjointDirectories(plan?.oracle?.operatorDirectory, plan?.oracle?.reviewerDirectory) && digest(plan?.oracle?.namespaceProbeSha256) &&
    plan?.oracle?.generateAfterNamespaceProbe === true && plan?.oracle?.mediaOnlyTools === true, "blind_oracle_namespace");
  need(text(plan?.isolation?.controlPlaneData) && text(plan?.isolation?.runnerState) &&
    plan?.isolation?.hostingStackChanges === false && plan?.isolation?.newPersistentGrants === false, "isolated_services");
  need(text(plan?.cleanup?.failurePolicy) && plan?.cleanup?.preserveUncertainEffects === true &&
    plan?.cleanup?.verifyForgeAndRetirement === true, "recovery_cleanup");
  need(plan?.accounting?.modelPricedSeparateFromBilled === true && plan?.accounting?.unpricedIsZero === false &&
    plan?.accounting?.meterInvalidAttempts === true, "usage_provenance");
  // A prepared plan cannot activate missing runtime adapters or certify its own approval.
  return { status: "blocked", planComplete: blockers.length === 0, blockers,
    requiredIndependentChecks: ["authenticated_human_envelope", "registered_integrated_adapters", "actual_namespace_enforcement",
      "actual_media_and_cost_proof", "current_server_capabilities", "isolated_repository_operator_authorization"],
    liveExecutionAvailable: false, releaseAcceptanceProven: false };
}

export function isolateTestEnvironment(source) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !/^(WOLLIPOG_|MAM_|RUNNER_|CONTROL_PLANE_)/u.test(key)));
}

/** Open without blocking on a FIFO, reject devices, and bound reads even if the file grows. */
function readPlan(path) {
  const limit = 256 * 1024;
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > limit) throw new Error("not a bounded regular file");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > limit) throw new Error("oversize");
    return JSON.parse(bytes.subarray(0, length).toString("utf8"));
  } finally { closeSync(descriptor); }
}

export function main(args) {
  if (args[0] === "matrix" && args.length === 1) {
    console.log(JSON.stringify({ mode: "deterministic_only", suites: acceptanceMatrix,
      browser: ["delegated-ui-evidence-live.spec.ts", "campaign-status-live.spec.ts"], liveSteps }, null, 2));
    return 0;
  }
  if (args[0] === "check-plan" && args.length === 2) {
    try {
      const path = resolve(args[1]);
      const result = inspectLivePlan(readPlan(path));
      console.log(JSON.stringify(result, null, 2));
      return 2; // Even a structurally complete file grants no execution authority.
    } catch { console.error("Plan unreadable or invalid; no plan contents were logged."); return 2; }
  }
  if (args[0] === "run-deterministic" && args.length <= 2) {
    const suites = args[1] ? acceptanceMatrix.filter((suite) => suite.id === args[1]) : acceptanceMatrix;
    if (!suites.length) { console.error("Unknown deterministic suite."); return 2; }
    const root = fileURLToPath(new URL("..", import.meta.url));
    const env = isolateTestEnvironment(process.env);
    // Never forward the hosting Session credential/config to isolated synthetic test processes.
    for (const suite of suites) {
      console.log(`Deterministic Contract Suite: ${suite.id}`);
      const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-timeout=300000", ...suite.files],
        { cwd: root, env, stdio: "inherit", timeout: 600_000, killSignal: "SIGKILL" });
      if (result.error || result.status !== 0) return 1;
    }
    console.log("Listed deterministic contracts passed. Pending integrated/live coverage remains unproven.");
    return 0;
  }
  console.error("Usage: node scripts/full-control-acceptance.mjs matrix | run-deterministic [suite] | check-plan <json>");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
