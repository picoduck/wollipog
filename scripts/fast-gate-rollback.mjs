import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ADMISSION_CONTEXT, admissionEnforcement, computeMergeGroupGate, GATE_ENABLED, GATE_VARIABLE, gateDecision,
  REQUIRED_CONTEXT, ROLLBACK_VALUE } from "./ci-merge-group-gate.mjs";
import { CHECK_STEPS, COVERAGE, FULL_JOBS, verifyRestoration } from "./ci-merge-group-restoration.mjs";
import { planRollback } from "./main-merge-admission-controller.mjs";
import { POLICY } from "./main-merge-admission.mjs";

/** #3637 AC5: rollback triggers for a future fast merge-group gate and the ordered return to full
 * queue validation. Inert: nothing here reads GitHub, sets a variable, writes a status or removes a
 * hold. Every decision after the trigger comes from delivered modules: the gate (#3637 slice A),
 * its restoration verifier and #3633's planRollback(). Thresholds are proposals until a human
 * approves them; unapproved thresholds can never keep a fast gate active.
 */
export const OBSERVATION_SCHEMA = "fast-gate-operating-observation-v1";
export const REHEARSAL_SCHEMA = "fast-gate-rollback-rehearsal-v1";
const MINUTE = 60_000;
const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const time = (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
  ? Date.parse(value) : NaN;
const nearestRank = (values, q) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] : null;
};

/** Proposed values with their measurement basis (docs/fast-gate-activation-proposal.md). Backlog and
 * age reuse #3633's policy so the hold point and its rollback point can never diverge. */
export const PROPOSED_THRESHOLDS = Object.freeze({
  version: 1, approved: false,
  requiredLatencyP90Minutes: 15, latencyWindowIntegrations: 20, fastExecutionTargetMinutes: Object.freeze([5, 10]),
  maxRegressionEscapes: 1, maxDetectionMinutes: POLICY.maxUnvalidatedAgeSeconds / 60, maxRecoveryMinutes: 240,
  maxValidatorOutageMinutes: 30, maxUnvalidatedCommits: POLICY.maxUnvalidatedCommits,
  maxUnvalidatedAgeSeconds: POLICY.maxUnvalidatedAgeSeconds,
});

export const ROLLBACK_TRIGGERS = Object.freeze([
  { id: "required-latency-breach", condition: "p90 required result of the latest latencyWindowIntegrations eligible integrations above requiredLatencyP90Minutes, or any passing group removed for missing required results" },
  { id: "missed-regression-or-escape", condition: "a regression found outside rolling full validation, or more than maxRegressionEscapes rolling-detected escapes in the rollout window" },
  { id: "detection-beyond-bound", condition: "an escape's landing to failed full verdict above maxDetectionMinutes, or still undetected beyond it" },
  { id: "recovery-beyond-bound", condition: "an escape's failed verdict to verified healthy main above maxRecoveryMinutes, or still unrecovered beyond it" },
  { id: "validator-outage", condition: "health unknown/stale or the controller unavailable for maxValidatorOutageMinutes or longer, or with an unknown start" },
  { id: "backlog-beyond-limit", condition: "unvalidated commits above maxUnvalidatedCommits or oldest unvalidated age above maxUnvalidatedAgeSeconds: holds failed to bound the backlog" },
]);

const THRESHOLD_KEYS = ["requiredLatencyP90Minutes", "latencyWindowIntegrations", "maxRegressionEscapes", "maxDetectionMinutes",
  "maxRecoveryMinutes", "maxValidatorOutageMinutes", "maxUnvalidatedCommits", "maxUnvalidatedAgeSeconds"];

/**
 * Pure. `integrations` are in landing order; the latency window is the newest eligible ones.
 * Returns `rollback: true` when any trigger fires, when thresholds are unapproved, or when the
 * observation cannot be read. Too few integrations leaves latency `incomplete`, never passing.
 */
export function evaluateRollbackTriggers(observation, thresholds) {
  const fired = [], incomplete = [];
  const fire = (id, reason) => fired.push({ id, reason });
  if (thresholds?.approved !== true || thresholds.version !== 1 ||
      THRESHOLD_KEYS.some((key) => !Number.isFinite(thresholds[key]) || thresholds[key] < 0))
    return { rollback: true, triggers: [{ id: "thresholds-unapproved", reason: "Unapproved or malformed thresholds cannot keep a fast gate active" }], incomplete };
  const observedAt = time(observation?.observedAt);
  if (observation?.schema !== OBSERVATION_SCHEMA || !REPOSITORY.test(observation.repository ?? "") || !Number.isFinite(observedAt) ||
      !Array.isArray(observation.integrations) || !Array.isArray(observation.escapes) || !observation.health || typeof observation.health !== "object")
    return { rollback: true, triggers: [{ id: "observation-unavailable", reason: "An unreadable operating observation is a validator outage" }], incomplete };
  const elapsed = (from, to = observedAt) => Number.isFinite(time(from)) ? (to - time(from)) / MINUTE : null;

  const eligible = observation.integrations.filter((row) => row?.eligible === true);
  if (eligible.some((row) => row.passing === true && row.expiredMissingRequired === true))
    fire("required-latency-breach", "A passing group expired for missing required results");
  const window = eligible.slice(-thresholds.latencyWindowIntegrations).map((row) => row.requiredMinutes);
  const p90 = window.length >= thresholds.latencyWindowIntegrations && window.every(Number.isFinite) ? nearestRank(window, 0.9) : null;
  if (p90 === null) incomplete.push({ id: "required-latency-breach", reason: `Fewer than ${thresholds.latencyWindowIntegrations} measured eligible integrations` });
  else if (p90 > thresholds.requiredLatencyP90Minutes) fire("required-latency-breach", `Required-result p90 ${p90} min above ${thresholds.requiredLatencyP90Minutes}`);

  const escapes = observation.escapes;
  if (escapes.some((row) => row?.detectedBy !== "rolling")) fire("missed-regression-or-escape", "A regression was found outside rolling full validation");
  if (escapes.length > thresholds.maxRegressionEscapes)
    fire("missed-regression-or-escape", `${escapes.length} escapes above ${thresholds.maxRegressionEscapes}`);
  for (const row of escapes) {
    const detection = elapsed(row?.landedAt, Number.isFinite(time(row?.detectedAt)) ? time(row.detectedAt) : observedAt);
    if (detection === null || detection > thresholds.maxDetectionMinutes)
      fire("detection-beyond-bound", `Detection ${detection ?? "unknown"} min above ${thresholds.maxDetectionMinutes}`);
    if (!Number.isFinite(time(row?.detectedAt))) continue;
    const recovery = elapsed(row.detectedAt, Number.isFinite(time(row.recoveredAt)) ? time(row.recoveredAt) : observedAt);
    if (recovery === null || recovery > thresholds.maxRecoveryMinutes)
      fire("recovery-beyond-bound", `Recovery ${recovery ?? "unknown"} min above ${thresholds.maxRecoveryMinutes}`);
  }

  const health = observation.health;
  const unavailable = !["passing", "pending", "failing"].includes(health.status) || observation.controllerAvailable !== true;
  if (unavailable) {
    const outage = elapsed(observation.validatorUnavailableSince);
    if (outage === null || outage >= thresholds.maxValidatorOutageMinutes)
      fire("validator-outage", `Validator or controller unavailable for ${outage ?? "an unknown time"} min`);
  }
  const commits = health.backlog?.commits, age = health.backlog?.oldestUnvalidatedAgeSeconds;
  if (!unavailable && (!Number.isSafeInteger(commits) || !Number.isFinite(age)))
    fire("validator-outage", "Health reported no measurable backlog");
  if (commits > thresholds.maxUnvalidatedCommits) fire("backlog-beyond-limit", `${commits} unvalidated commits above ${thresholds.maxUnvalidatedCommits}`);
  if (age > thresholds.maxUnvalidatedAgeSeconds) fire("backlog-beyond-limit", `Oldest unvalidated age ${age} s above ${thresholds.maxUnvalidatedAgeSeconds}`);
  const ids = [...new Set(fired.map((row) => row.id))];
  return { rollback: ids.length > 0, triggers: ids.map((id) => ({ id, reasons: fired.filter((row) => row.id === id).map((row) => row.reason) })),
    incomplete, requiredLatencyP90Minutes: p90 };
}

/** The exact operator commands. They are printed for a human; this module never runs them. */
export function rollbackCommands(repository) {
  return {
    set: `gh variable set ${GATE_VARIABLE} --repo ${repository} --body ${ROLLBACK_VALUE}`,
    // Must print the rollback value; its updated_at is the switch-back time the verifier starts from.
    readBack: `gh api repos/${repository}/actions/variables/${GATE_VARIABLE} --jq '[.value, .updated_at] | @tsv'`,
    verify: `GITHUB_TOKEN=<read token> node scripts/ci-merge-group-restoration.mjs --repository ${repository} --since <read-back updated_at> --trusted-ref <reviewed full-coverage commit SHA> --runs 1 > restoration.json`,
    plan: `node scripts/fast-gate-rollback.mjs plan --repository ${repository} --proof restoration.json [--approval approval.json]`,
  };
}

// ---- Inert rehearsal fixtures -------------------------------------------------------------------
export const REPOSITORY_FIXTURE = "fixture/fast-gate-rollback";
const fixtureSha = (n) => n.toString(16).padStart(40, "0");
const MAIN = fixtureSha(0xa1), GROUP = fixtureSha(0xb2), TRUSTED = fixtureSha(0xc3);
const START = Date.parse("2026-11-02T15:00:00Z");
const iso = (minutes) => new Date(START + minutes * MINUTE).toISOString().replace(".000Z", "Z");
const WORKFLOWS = [{ path: ".github/workflows/ci.yml", type: "file", sha: fixtureSha(0x1) },
  { path: ".github/workflows/settings-rows-win32.yml", type: "file", sha: fixtureSha(0x2) }];
// The proposed ruleset after activation: the full context unchanged, plus an issuer-pinned admission context.
const ACTIVE_RULES = [{ type: "merge_queue", parameters: {} }, { type: "required_status_checks", parameters: { required_status_checks: [
  { context: REQUIRED_CONTEXT, integration_id: 15368 }, { context: ADMISSION_CONTEXT, integration_id: 4242 }] } }];
const ACTIVE = { gate: GATE_ENABLED, event: "merge_group", trustedMainSha: MAIN, testedSha: GROUP, workflowMatches: true,
  selection: { mode: "fast", reasons: [], risks: ["ordinary"], context: { event: "merge_group", diffKind: "combined-merge-group",
    baseSha: MAIN, diffBaseSha: MAIN, trustedPolicySha: MAIN, testedSha: GROUP, changeHeadSha: GROUP } } };
export const REHEARSAL_THRESHOLDS = Object.freeze({ ...PROPOSED_THRESHOLDS, approved: true,
  approval: "Inert rehearsal fixture; not a human approval of these values" });

const STEP_NAMES = (name) => name === "Typecheck, Unit Tests & Bundles" ? CHECK_STEPS
  : /^Browser End-to-End Tests \(1\)$/.test(name) ? ["Remote-Instance Browser End-to-End Tests", "Rendered Production Browser Smoke"]
    : /^Browser End-to-End Tests/.test(name) ? ["Remote-Instance Browser End-to-End Tests"]
      : name === "WebKit End-to-End Tests" ? ["WebKit Browser End-to-End Tests"]
        : name.endsWith("Detect Settings-Rows Changes") ? ["Compare the Diff Against the Settings-Rows Paths"]
          : name === REQUIRED_CONTEXT ? ["Require Every Job to Have Succeeded"] : [];
/** A merge-group attempt shaped like the restoration verifier's input. `reduced` is a fast-gate group. */
function groupRun(id, createdMinutes, { reduced = false, status = "completed" } = {}) {
  const run = { id, run_attempt: 1, event: "merge_group", path: ".github/workflows/ci.yml", status, conclusion: status === "completed" ? "success" : null,
    repository: { full_name: REPOSITORY_FIXTURE }, head_branch: `gh-readonly-queue/main/pr-${id}-${MAIN}`, head_sha: fixtureSha(0x1000 + id),
    created_at: iso(createdMinutes) };
  const job = (name, steps, conclusion = "success") => ({ name, run_id: id, run_attempt: 1, status: "completed", conclusion,
    steps: steps.map((step) => ({ name: step, status: "completed", conclusion: "success" })) });
  const jobs = [job("PR Suite Routing", [], "skipped"),
    reduced ? job("Merge Group Gate", ["Compute Trusted Merge Group Gate", "Record Reduced Merge Group Coverage"])
      : job("Merge Group Gate", [], "skipped"),
    ...FULL_JOBS.filter((name) => !reduced || !/^Browser End-to-End Tests \([2-5]\)$/.test(name))
      .map((name) => name.endsWith("Compare win32 Settings-Rows Baselines") ? job(name, [], "skipped") : job(name, STEP_NAMES(name)))];
  return { run, jobs: { total_count: jobs.length, jobs } };
}
function restoration(since, runs) {
  return verifyRestoration({ repository: REPOSITORY_FIXTURE, since, count: 1, trustedRef: TRUSTED, trustedWorkflows: WORKFLOWS,
    listing: { workflow_runs: runs.map((r) => r.run) }, jobsByRun: Object.fromEntries(runs.map((r) => [r.run.id, r.jobs])),
    workflowsByRun: Object.fromEntries(runs.map((r) => [r.run.id, WORKFLOWS])) });
}

/** A healthy fast-gate operating observation, then exactly one trigger per scenario. */
function observation(overrides = {}) {
  return { schema: OBSERVATION_SCHEMA, repository: REPOSITORY_FIXTURE, observedAt: iso(0), controllerAvailable: true,
    validatorUnavailableSince: null, integrations: Array.from({ length: 20 }, (_, i) => ({ eligible: true, passing: true,
      expiredMissingRequired: false, requiredMinutes: 8 + (i % 5) })), escapes: [],
    health: { status: "passing", reasons: [], backlog: { commits: 1, oldestUnvalidatedAgeSeconds: 900 } }, ...overrides };
}
const SCENARIOS = [
  ["required-latency-breach", () => observation({ integrations: observation().integrations.map((row, i) => i < 3 ? { ...row, requiredMinutes: 22 } : row) })],
  ["missed-regression-or-escape", () => observation({ escapes: [{ detectedBy: "release-certification", landedAt: iso(-50), detectedAt: iso(-5), recoveredAt: null }] })],
  ["detection-beyond-bound", () => observation({ escapes: [{ detectedBy: "rolling", landedAt: iso(-125), detectedAt: null, recoveredAt: null }] })],
  ["recovery-beyond-bound", () => observation({ escapes: [{ detectedBy: "rolling", landedAt: iso(-300), detectedAt: iso(-260), recoveredAt: null }] })],
  ["validator-outage", () => observation({ validatorUnavailableSince: iso(-30), health: { status: "unknown", reasons: ["validation-stalled"], backlog: null } })],
  ["backlog-beyond-limit", () => observation({ health: { status: "pending", reasons: [], backlog: { commits: 6, oldestUnvalidatedAgeSeconds: 3000 } } })],
];

function scenario(trigger, observed) {
  const steps = [];
  const check = (step, decidedBy, expected, actual) => {
    steps.push({ step, decidedBy, expected, actual, match: JSON.stringify(expected) === JSON.stringify(actual) });
    return actual;
  };
  const enforcement = admissionEnforcement(ACTIVE_RULES);
  check("fast gate active under the proposed ruleset", "ci-merge-group-gate", { mode: "fast", reasons: [] }, gateDecision({ ...ACTIVE, enforcement }));
  const evaluation = evaluateRollbackTriggers(observed, REHEARSAL_THRESHOLDS);
  check("exactly this rollback trigger fires", "fast-gate-rollback", { rollback: true, triggers: [trigger] },
    { rollback: evaluation.rollback, triggers: evaluation.triggers.map((row) => row.id) });
  check("gate set to the rollback value selects full", "ci-merge-group-gate", { mode: "full", reasons: ["gate-disabled"] },
    gateDecision({ ...ACTIVE, gate: ROLLBACK_VALUE, enforcement }));
  // Switched back at minute 5; a group built from the stale value before propagation is not evidence.
  const since = iso(5);
  const noProof = planRollback({ repository: REPOSITORY_FIXTURE });
  check("hold removal refused without fullQueueProof", "main-merge-admission-controller",
    { decision: "restore-full-queue-validation-first", holdRetained: true }, { decision: noProof.decision, holdRetained: noProof.holdRetained });
  const reduced = restoration(since, [groupRun(301, 6, { reduced: true })]);
  check("a reduced group after the switch-back is not restoration", "ci-merge-group-restoration",
    { verified: false, reasons: ["merge-group-gate-active", "reduced-coverage-recorded"] },
    { verified: reduced.verified, reasons: reduced.runs[0].reasons.filter((r) => /gate-active|reduced/.test(r)) });
  const inProgress = restoration(since, [groupRun(302, 7, { status: "in_progress" })]);
  check("an unfinished full group is not restoration", "ci-merge-group-restoration",
    { verified: false, reasons: ["insufficient-completed-merge-group-runs"] }, { verified: inProgress.verified, reasons: inProgress.reasons });
  const refusedProofs = [reduced, inProgress, { ...reduced, verified: true }, { ...restoration(since, [groupRun(303, 8)]), coverage: "rolling-full-v1" }];
  check("planRollback refuses every unverified, forged or foreign proof", "main-merge-admission-controller", refusedProofs.map(() => "restore-full-queue-validation-first"),
    refusedProofs.map((fullQueueProof) => planRollback({ repository: REPOSITORY_FIXTURE, fullQueueProof }).decision));
  const proof = restoration(since, [groupRun(301, 6, { reduced: true }), groupRun(304, 9)]);
  check("the newest completed group after the switch-back certifies full queue validation", "ci-merge-group-restoration",
    { verified: true, coverage: COVERAGE, requiredContext: REQUIRED_CONTEXT, workflowSha: TRUSTED, runs: [304] },
    { verified: proof.verified, coverage: proof.coverage, requiredContext: proof.requiredContext, workflowSha: proof.workflowSha, runs: proof.runs.map((r) => r.runId) });
  const pending = planRollback({ repository: REPOSITORY_FIXTURE, fullQueueProof: proof });
  check("a verified proof still needs separate operator approval", "main-merge-admission-controller",
    { decision: "operator-hold-removal-approval-required", holdRetained: true, enforcement: "none" },
    { decision: pending.decision, holdRetained: pending.holdRetained, enforcement: pending.enforcement });
  const approval = (digest) => ({ repository: REPOSITORY_FIXTURE, fullQueueProofDigest: digest, action: "remove-admission-hold", approved: true });
  const stale = planRollback({ repository: REPOSITORY_FIXTURE, fullQueueProof: proof, operatorApproval: approval("0".repeat(64)) });
  check("an approval bound to another proof grants nothing", "main-merge-admission-controller", "operator-hold-removal-approval-required", stale.decision);
  const planned = planRollback({ repository: REPOSITORY_FIXTURE, fullQueueProof: proof, operatorApproval: approval(pending.fullQueueProofDigest) });
  check("only then may the operator remove the health-policy hold; full CI stays required", "main-merge-admission-controller",
    { decision: "operator-hold-removal-planned", holdRetained: true, enforcement: "none" },
    { decision: planned.decision, holdRetained: planned.holdRetained, enforcement: planned.enforcement });
  return { trigger, pass: steps.every((s) => s.match), steps, fullQueueProofDigest: pending.fullQueueProofDigest };
}

export async function rehearseFastGateRollback() {
  // The live gate adapter's first check is the raw switch, so the rollback value does no Git or API work.
  const live = await computeMergeGroupGate({ env: { GATE_SWITCH: ROLLBACK_VALUE, GITHUB_EVENT_NAME: "merge_group" },
    api: () => { throw new Error("The rollback value must not read the forge"); } });
  const control = evaluateRollbackTriggers(observation(), REHEARSAL_THRESHOLDS);
  const sparse = evaluateRollbackTriggers(observation({ integrations: observation().integrations.slice(0, 5) }), REHEARSAL_THRESHOLDS);
  const unapproved = evaluateRollbackTriggers(observation(), PROPOSED_THRESHOLDS);
  const scenarios = SCENARIOS.map(([trigger, make]) => scenario(trigger, make()));
  const checks = {
    liveAdapterAtRollbackValue: live,
    healthyObservationKeepsGate: { rollback: control.rollback, requiredLatencyP90Minutes: control.requiredLatencyP90Minutes },
    sparseSampleIsIncomplete: { rollback: sparse.rollback, incomplete: sparse.incomplete.map((row) => row.id) },
    unapprovedThresholdsRollBack: unapproved.triggers.map((row) => row.id),
  };
  const pass = scenarios.every((s) => s.pass) && live.mode === "full" && !control.rollback && !sparse.rollback &&
    sparse.incomplete.length === 1 && unapproved.rollback;
  return { schema: REHEARSAL_SCHEMA, issue: "#3637 AC5", mode: "inert-offline-fixture", enforcement: "none", repository: REPOSITORY_FIXTURE,
    evidenceClass: "Delivered gate, restoration verifier and planRollback over fixture runs and observations. Not a live rollback, not measured timing, not threshold approval.",
    thresholds: REHEARSAL_THRESHOLDS, triggers: ROLLBACK_TRIGGERS, commands: rollbackCommands("OWNER/REPO"),
    summary: { scenarios: scenarios.length, passed: scenarios.filter((s) => s.pass).length, steps: scenarios.reduce((n, s) => n + s.steps.length, 0), pass },
    checks, scenarios, liveMutations: 0 };
}

const usage = "Usage: fast-gate-rollback.mjs triggers --observation FILE --thresholds FILE | plan --repository OWNER/REPO --proof FILE [--approval FILE] | rehearse [OUT.json]";
export async function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  const [command, ...rest] = argv;
  const read = (path) => JSON.parse(readFileSync(path, "utf8"));
  let values;
  try {
    ({ values } = parseArgs({ args: rest, allowPositionals: command === "rehearse", options: { observation: { type: "string" },
      thresholds: { type: "string" }, repository: { type: "string" }, proof: { type: "string" }, approval: { type: "string" } } }));
  } catch { error(usage); return 2; }
  if (command === "triggers" && values.observation && values.thresholds) {
    const result = evaluateRollbackTriggers(read(values.observation), read(values.thresholds));
    log(JSON.stringify(result, null, 2));
    return result.rollback ? 1 : 0;
  }
  if (command === "plan" && REPOSITORY.test(values.repository ?? "") && values.proof) {
    // Offline only: #3633's planRollback over a saved restoration proof. It plans; it never removes a hold.
    const plan = planRollback({ repository: values.repository, fullQueueProof: read(values.proof),
      operatorApproval: values.approval ? read(values.approval) : undefined });
    log(JSON.stringify(plan, null, 2));
    return 0;
  }
  if (command === "rehearse") {
    const report = await rehearseFastGateRollback();
    if (rest[0]) writeFileSync(rest[0], JSON.stringify(report, null, 2) + "\n");
    log(JSON.stringify(report.summary));
    return report.summary.pass ? 0 : 1;
  }
  error(usage);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
