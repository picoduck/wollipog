import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { collectHealth, main as healthReport } from "./main-ci-health.mjs";
import { observeAdmission, POLICY } from "./main-merge-admission.mjs";
import { failureFingerprint, planAdmissionCycle, readAdmissionEntries, rebuildAdmissionCycle,
  writeAdmissionPlan } from "./main-merge-admission-controller.mjs";
import { mergedRepairBinding, repairDigest, repairRecovery, requestMergedRepairCandidate } from "./main-merge-repair.mjs";
import { readState as readRollingState, reconcile as reconcileRolling, requestCandidate } from "./main-rolling-validation.mjs";
import { candidateReceipt } from "./main-validation-candidates.mjs";
import { plan as planInvestigation, readState as readInvestigationState, reconcile as reconcileInvestigation,
  selectCandidate, writeState as writeInvestigationState } from "./main-regression-automation.mjs";
import { classify, InvestigationBudget } from "./main-regression-investigation.mjs";
import { deliverEscalation, escalationMarker } from "./main-regression-escalation.mjs";
import { INVESTIGATION_PROMPT, LIMITS, PARAMETERS } from "./main-regression-policy.mjs";
import { collectCertification } from "./release-certification.mjs";
import { rehearseAdmission } from "./rehearse-main-merge-admission.mjs";
import { CALL_MS, inertForge, REPOSITORY, sha, START } from "./fast-gate-rehearsal-forge.mjs";

/** Offline #3637 AC2 cutover rehearsal. Fast-gate passes and rolling lag are
 * fixtures; every decision below is made by the delivered #3631-#3635 modules
 * over an inert in-process forge on a virtual clock. Nothing here can reach
 * GitHub, write a status, dispatch a workflow or activate a gate.
 */
export const SCHEMA = "fast-gate-cutover-rehearsal-v1";
const MINUTE = 60_000;
// Fixture timing assumptions, not measurements of a fast-gate deployment.
export const TIMING = Object.freeze({
  fastGateMs: 10 * MINUTE, // #3637's ordinary-change fast execution target upper bound.
  workerStartMs: MINUTE, workerDispatchToVerdictMs: 34.27 * MINUTE, // 2026-10-23 rolling census median.
  observerWakeMs: MINUTE, controllerWakeMs: MINUTE, repairProposalMs: 20 * MINUTE, virtualRequestMs: CALL_MS,
  source: "Fixture assumptions: fast-gate target bound, docs/main-rolling-shadow-2026-10-23.md median, one-minute wakes and a 20-minute repair proposal; human and runner latency are not measured here.",
});
const ENV = Object.freeze({ GITHUB_REPOSITORY: REPOSITORY, GITHUB_TOKEN: "inert-fixture-not-a-credential", GITHUB_REF: "refs/heads/main" });
const CONTEXT = "Regression Admission";
const MODULES = { health: "main-ci-health", admission: "main-merge-admission", controller: "main-merge-admission-controller",
  repair: "main-merge-repair", rolling: "main-rolling-validation", candidates: "main-validation-candidates",
  automation: "main-regression-automation", investigation: "main-regression-investigation", certification: "release-certification",
  escalation: "main-regression-escalation" };
const control = Object.freeze({ available: true, repair: null });
// The operator trust boundary is a fixture: it only echoes an exact grant digest.
const verifyAuthority = async ({ grant }) => ({ approved: true, authorizationDigest: repairDigest(grant) });
const fastChecks = (overrides = {}) => async ({ entry }) => ({ repository: entry.repository, headSha: entry.headSha,
  baseSha: entry.baseSha, integrationSha: entry.integrationSha, status: "passed", fast: true, failingScenarios: true,
  normalReviewAndMergeRequired: true, ...overrides });

function flow(id, title) {
  const steps = [];
  return { id, title, acceptance: "#3637 AC2", steps, times: {}, callBudgets: {}, observations: {}, gaps: [],
    check(step, decidedBy, expected, actual) {
      steps.push({ step, decidedBy, expected, actual, match: JSON.stringify(expected) === JSON.stringify(actual) });
      return actual;
    },
    done() { return { id, title, acceptance: this.acceptance, pass: steps.every(s => s.match), steps, times: this.times,
      callBudgets: this.callBudgets, observations: this.observations, gaps: this.gaps }; } };
}

/** The production read-only report entry point, with its own 48/96-call budget. */
async function observeHealth(w) {
  let health = null;
  const code = await healthReport(["report"], { env: ENV, api: w.api, now: () => w.iso(),
    log: line => { health = JSON.parse(line); }, error: () => {} });
  return { ...health, exitCode: code };
}
const virtualCollect = w => (repository, options) => collectHealth(repository, { ...options, now: () => w.iso() });
const rolling = w => reconcileRolling(REPOSITORY, { api: w.api, now: () => w.iso(), log: () => {} });
const census = w => readAdmissionEntries(w.api, REPOSITORY);
async function cycle(w, options = {}) {
  const health = await observeHealth(w), entries = await census(w);
  const plan = await planAdmissionCycle({ repository: REPOSITORY, census: entries, health, control, now: w.iso(),
    observationId: "inert-rehearsal", entryPoint: "rehearsal", ...options });
  return { health, plan };
}
/** Default-deny writer, explicitly enabled only against the inert forge. */
async function deliver(w, plan, options = {}) {
  const started = w.state.calls;
  let fresh = null;
  try {
    const result = await writeAdmissionPlan(plan, { configuration: { enabled: true, repository: REPOSITORY, context: CONTEXT },
      api: w.api, now: () => w.iso(), revalidate: async ({ repository }, { api }) => (fresh = await rebuildAdmissionCycle({ repository, api,
        env: ENV, now: () => w.iso(), error: () => {}, control, observationId: "inert-rehearsal", entryPoint: "rehearsal", ...options })) });
    // The writer authorizes from its own fresh rebuild, not the caller's plan.
    return { ...result, forgeCalls: w.state.calls - started, revalidatedObservedAt: fresh?.healthSummary?.observedAt ?? null };
  } catch (failure) {
    if (failure.writes === undefined) throw failure;
    return { writes: failure.writes, complete: false, reason: failure.reason, capacity: failure.capacity,
      apiBudget: failure.apiBudget, forgeCalls: w.state.calls - started };
  }
}
const byEntry = (plan, field) => Object.fromEntries(plan.decisions.map(d =>
  [`${d.entry.kind === "merge_group" ? "group" : "pr"}:${d.entry.pullRequest}`, d[field]]).sort(([a], [b]) => a.localeCompare(b, "en")));
const decisionsBy = plan => byEntry(plan, "decision");
const reasonsBy = plan => byEntry(plan, "reasons");
const budget = b => b && { calls: b.calls, limit: b.limit, readCalls: b.readCalls, mutationCalls: b.mutationCalls,
  graphqlCalls: b.graphqlCalls, reason: b.reason };

/** Baseline: main at a fully validated commit, rolling state current. */
async function baselineWorld() {
  const w = inertForge();
  w.at(START - 60 * MINUTE);
  const base = w.land("baseline", { pull: 100 });
  w.seedRun(base, { createdAt: START - 55 * MINUTE, startedAt: START - 54 * MINUTE, finishedAt: START - 20 * MINUTE, conclusion: "success" });
  w.at(START - 19 * MINUTE);
  await rolling(w);
  w.at(START);
  return { w, base };
}
/** Dispatch through the actual rolling scheduler, then run its worker to a verdict. */
async function validateLatest(w, conclusion, { finish = true } = {}) {
  const dispatchedBefore = w.state.dispatches.length;
  const scheduled = await rolling(w);
  const run = w.state.dispatches.length > dispatchedBefore ? w.latestRun() : null;
  if (!run) return { scheduled, run };
  const dispatchedAt = Date.parse(run.created_at);
  w.at(dispatchedAt + TIMING.workerStartMs); w.startRun(run, w.now);
  if (finish) { w.at(dispatchedAt + TIMING.workerDispatchToVerdictMs); w.finishRun(run, conclusion, w.now); }
  return { scheduled, run, dispatchedAt };
}

/** A fast-passing regression lands and full validation catches it later. */
async function regressionWorld() {
  const { w, base } = await baselineWorld();
  w.open(101, { head: sha("head:101") });
  const group = w.enqueue("regression", [101], { base, tree: sha("tree:regression") });
  // Just-in-time admission: only after the group's own fast checks pass may its success be written.
  w.at(START + TIMING.fastGateMs);
  w.reportRequired("regression", "success");
  const admitted = await cycle(w);
  const fastPass = await deliver(w, admitted.plan);
  const landing = w.now;
  const regression = w.land("regression", { pull: 101, tree: group.tree });
  w.at(landing + TIMING.controllerWakeMs);
  const worker = await validateLatest(w, "failure", { finish: false });
  // Exposure window: ordinary work admitted onto main while rolling validation lags.
  w.open(103, { head: sha("head:103") }); w.enqueue("innocent", [103], { base: regression });
  w.open(104, { head: sha("head:104") });
  w.at(landing + 5 * MINUTE);
  const exposure = await cycle(w);
  const exposed = await deliver(w, exposure.plan);
  w.at(worker.dispatchedAt + TIMING.workerDispatchToVerdictMs); w.finishRun(worker.run, "failure", w.now);
  const failedAt = w.now;
  w.at(failedAt + TIMING.observerWakeMs);
  return { w, base, regression, landing, failedAt, worker, admitted, fastPass, exposure, exposed };
}

async function missedFailure() {
  const f = flow("missed-failure", "Fast-passing regression caught by rolling validation, held, investigated, repaired and released");
  const r = await regressionWorld(), { w } = r;
  f.check("fast gate admits the regression group on a healthy main", MODULES.controller,
    { decisions: { "group:101": "ordinary-admission-eligible", "pr:101": "ordinary-admission-eligible" }, writes: 2 },
    { decisions: decisionsBy(r.admitted.plan), writes: r.fastPass.writes });
  f.check("rolling scheduler dispatches the landed regression SHA", MODULES.rolling,
    { dispatched: true, targetSha: r.regression }, { dispatched: Boolean(r.worker.run), targetSha: w.state.dispatches.at(-1)?.targetSha });
  f.check("exposure window: health pending, ordinary work still admitted", `${MODULES.health}+${MODULES.controller}`,
    { health: "pending", decisions: { "group:103": "ordinary-admission-eligible", "pr:103": "ordinary-admission-eligible", "pr:104": "ordinary-admission-eligible" } },
    { health: r.exposure.health.status, decisions: decisionsBy(r.exposure.plan) });
  const failing = await observeHealth(w);
  f.check("health observer records the rolling failure", MODULES.health,
    { status: "failing", failedSha: r.regression }, { status: failing.status, failedSha: failing.unresolvedFailures[0]?.testedSha });
  const hold = await cycle(w);
  const held = await deliver(w, hold.plan);
  f.check("every ready and queued entry is held", MODULES.controller,
    { "group:103": "hold", "pr:103": "hold", "pr:104": "hold" }, decisionsBy(hold.plan));
  f.check("holds delivered and earlier exposure successes withdrawn", MODULES.controller,
    { complete: true, writes: 3, withdrawn: 3 }, { complete: held.complete, writes: held.writes,
      withdrawn: r.exposure.plan.decisions.filter(d => w.latestStatus(d.targetSha)?.state === "failure").length });
  const investigation = await reconcileInvestigation(REPOSITORY, { api: w.api, now: () => w.now, dryRun: true, collect: virtualCollect(w) });
  f.check("bounded investigation is claimed for the exact failing run (dry run, no delivery)", MODULES.automation,
    { planned: "claimed", runId: r.worker.run.id }, { planned: investigation.planned, runId: investigation.active?.runId });
  // Synthetic reproduction evidence: the classifier is real; no command ran.
  const evidence = { testedSha: r.regression, passingSha: r.base, comparisonAncestryVerified: true, compatibleSuite: true,
    failing: [1, 2].map(() => ({ sha: r.regression, outcome: "product-failure", signature: "a".repeat(64) })),
    comparison: [1, 2].map(() => ({ sha: r.base, outcome: "pass" })) };
  f.check("classifier requires repeated reproduction plus passing comparison", MODULES.investigation,
    { classification: "reproducible-product-failure", incidentResolved: false }, (({ classification, incidentResolved }) =>
      ({ classification, incidentResolved }))(classify(evidence)));
  // Repair: an exact revert restoring the baseline tree, queued on the broken main.
  w.at(r.failedAt + TIMING.repairProposalMs);
  w.open(105, { head: sha("head:105") });
  const repairGroup = w.enqueue("repair", [105], { base: r.regression, tree: sha("tree:baseline") });
  w.at(w.now + TIMING.fastGateMs);
  w.reportRequired("repair", "success");
  const before = await observeHealth(w);
  const entry = { repository: REPOSITORY, kind: "merge_group", pullRequest: 105, headSha: sha("head:105"), baseSha: r.regression,
    integrationSha: repairGroup.sha, members: [{ pullRequest: 105, headSha: sha("head:105") }] };
  const grant = { repository: REPOSITORY, authorizationId: "inert-repair-105", pullRequest: 105, kind: "merge_group",
    headSha: entry.headSha, baseSha: entry.baseSha, integrationSha: entry.integrationSha, failureFingerprint: failureFingerprint(before),
    approvedAt: w.iso(), expiresAt: new Date(w.now + 30 * MINUTE).toISOString() };
  const repairPlan = await planAdmissionCycle({ repository: REPOSITORY, census: await census(w), health: before, control, grant,
    verifyAuthority, verifyChecks: fastChecks(), now: w.iso(), observationId: "inert-rehearsal", entryPoint: "rehearsal" });
  f.check("only the exact authorized repair group is eligible", MODULES.controller,
    { "group:103": "hold", "group:105": "authorized-repair-eligible", "pr:103": "hold", "pr:104": "hold", "pr:105": "hold" }, decisionsBy(repairPlan));
  const exception = await deliver(w, repairPlan, { grant, verifyAuthority, verifyChecks: fastChecks() });
  f.check("writer revalidates and delivers one repair exception beside the holds", MODULES.controller,
    { complete: true, writes: 5, repairSuccess: "success" }, { complete: exception.complete, writes: exception.writes,
      repairSuccess: w.latestStatus(repairGroup.sha)?.state });
  const admittedAt = w.iso();
  w.at(w.now + MINUTE);
  const merged = w.land("repair", { pull: 105, tree: repairGroup.tree });
  const binding = await mergedRepairBinding(REPOSITORY, grant, { authorizationDigest: repairDigest(grant),
    integrationSha: repairGroup.sha, admittedAt }, { api: w.api });
  f.check("squash merge bound to the authorized group tree and base", MODULES.repair,
    { decision: "merged-repair-bound", mergeSha: merged }, { decision: binding.decision, mergeSha: binding.mergeSha });
  const request = await requestMergedRepairCandidate(binding, { api: w.api, now: () => w.iso(), requestCandidate });
  f.check("purpose=repair validation requested through the shared candidate primitive", `${MODULES.repair}+${MODULES.candidates}`,
    { decision: "repair-validation-requested", purpose: "repair", certification: "none" },
    { decision: request.decision, purpose: request.receipt?.purpose, certification: request.receipt?.certification });
  w.at(w.now + TIMING.controllerWakeMs);
  const repairRun = await validateLatest(w, "success", { finish: false });
  const pendingHealth = await observeHealth(w);
  f.check("validation in progress keeps ordinary work held", MODULES.repair, "hold",
    repairRecovery({ binding, receipt: request.receipt, health: pendingHealth, now: w.iso() }).decision);
  w.at(repairRun.dispatchedAt + TIMING.workerDispatchToVerdictMs); w.finishRun(repairRun.run, "success", w.now);
  w.at(w.now + TIMING.observerWakeMs);
  await rolling(w);
  const { value } = await readRollingState(w.api, REPOSITORY);
  const repaired = await observeHealth(w);
  const receipt = candidateReceipt(value.candidates, merged, "repair", repaired.fullCertification?.suiteVersion, w.iso());
  const recovery = repairRecovery({ binding, receipt, health: repaired, now: w.iso() });
  f.check("independent health certifies the exact merged repair", `${MODULES.health}+${MODULES.repair}`,
    { health: "passing", certifiedSha: merged, receipt: "success", recovery: "release-eligible" },
    { health: repaired.status, certifiedSha: repaired.fullCertification?.testedSha, receipt: receipt.status, recovery: recovery.decision });
  // Rebuild the held entries on repaired main, as the queue would.
  w.state.groups.delete("innocent"); w.enqueue("innocent-rebuilt", [103], { base: merged }); w.rebase(103); w.rebase(104);
  const release = await cycle(w, { control: { available: true, repair: { binding, receipt } } });
  const released = await deliver(w, release.plan, { control: { available: true, repair: { binding, receipt } } });
  // Ordinary eligibility returns at once; the rebuilt group's own success waits for its checks (just in time).
  f.check("rebuilt entries regain ordinary admission after reconciliation", MODULES.controller,
    { decisions: { "group:103": "ordinary-admission-eligible", "pr:103": "ordinary-admission-eligible", "pr:104": "ordinary-admission-eligible" },
      writes: 2, rebuiltGroup: "none" },
    { decisions: decisionsBy(release.plan), writes: released.writes,
      rebuiltGroup: release.plan.decisions.find(d => d.entry.kind === "merge_group")?.state });
  f.times = { landingToFailedVerdictMs: r.failedAt - r.landing, landingToHealthFailingObservedMs: Date.parse(failing.observedAt) - r.landing,
    failureToLastHoldReceiptMs: Date.parse(held.lastReceiptAt) - r.failedAt,
    exposureAdmissionsBeforeHold: r.exposed.writes, failureToReleaseReceiptMs: Date.parse(released.lastReceiptAt) - r.failedAt,
    landingToReleaseReceiptMs: Date.parse(released.lastReceiptAt) - r.landing };
  f.callBudgets = { failingHealthReport: budget(failing.apiBudget), holdWriter: budget(held.apiBudget),
    releaseWriter: budget(released.apiBudget), totalInertForgeCalls: w.state.calls,
    inertStatusWrites: w.state.statuses.length, inertDispatches: w.state.dispatches.length, inertStateRefWrites: w.state.stateWrites };
  f.gaps.push("Fast-gate checks themselves are fixtures here (slice A owns the ci.yml mode); only admission, health, rolling, repair and candidate decisions are real.",
    "Repair proposal latency (20 min) and operator authority are fixtures; no human or agent latency is measured.");
  return f.done();
}

async function validatorOutage() {
  const f = flow("validator-outage", "Rolling validator stall and health-observer outage fail safe to hold, never green");
  const { w } = await baselineWorld();
  const landing = w.now, landed = w.land("unvalidated", { pull: 110 });
  w.at(landing + TIMING.controllerWakeMs);
  const stuck = await validateLatest(w, null, { finish: false });
  const probes = [];
  for (const minutes of [60, 119, 120, 121]) {
    w.at(landing + minutes * MINUTE); w.open(111 + probes.length, { head: sha(`head:outage-${minutes}`) });
    const { health, plan } = await cycle(w);
    const latest = plan.decisions.find(d => d.entry.pullRequest === 111 + probes.length);
    // The controller delivers its last healthy cycle; later probes only observe.
    if (minutes === 119) await deliver(w, plan);
    probes.push({ minutesAfterLanding: minutes, health: health.status, healthReasons: health.reasons, decision: latest.decision, reasons: latest.reasons });
  }
  f.check("ordinary admission continues while lag is within the proposed age threshold", MODULES.admission,
    ["ordinary-admission-eligible", "ordinary-admission-eligible"], probes.slice(0, 2).map(p => p.decision));
  f.check("two hours of validator lag holds; the observer reports stale", `${MODULES.admission}+${MODULES.health}`,
    { decision: "hold", health: "stale", ageLimit: true }, { decision: probes[2].decision, health: probes[2].health,
      ageLimit: probes[2].reasons.includes("unvalidated-age-limit") });
  w.at(Date.parse(stuck.run.run_started_at) + 2 * 60 * MINUTE + MINUTE);
  const scheduler = await rolling(w);
  const stalled = await observeHealth(w);
  f.check("stalled worker becomes unknown health and the scheduler reports it", `${MODULES.health}+${MODULES.rolling}`,
    { health: "unknown", reasons: ["validation-stalled"], scheduler: "stalled-active-run" },
    { health: stalled.status, reasons: stalled.reasons, scheduler: scheduler.state.status });
  w.open(130, { head: sha("head:130") });
  const unknown = await cycle(w);
  f.check("unknown health holds every entry", MODULES.controller, true, unknown.plan.decisions.every(d => d.decision === "hold"));
  // Health observer/forge outage: the observer must not hand back a green.
  const integration = { repository: REPOSITORY, kind: "pull_request", pullRequest: 130, headSha: sha("head:130"),
    integrationSha: sha("head:130"), baseSha: landed };
  w.state.outage = true;
  const observed = await observeAdmission({ integration, env: ENV, api: w.api, report: healthReport, now: () => w.iso(), error: () => {} });
  f.check("observer outage is an explicit hold", MODULES.admission, { decision: "hold", unavailable: true, health: "unknown" },
    { decision: observed.decision, unavailable: observed.reasons.includes("health-report-unavailable"), health: observed.healthReport?.status });
  const crashed = await observeAdmission({ integration, env: ENV, api: w.api, now: () => w.iso(), error: () => {},
    report: async () => { throw new Error("inert crash"); } });
  f.check("observer crash is an explicit hold", MODULES.admission, "hold", crashed.decision);
  const writer = await deliver(w, unknown.plan);
  f.check("writer refuses during forge outage with zero writes", MODULES.controller,
    { complete: false, writes: 0 }, { complete: writer.complete, writes: writer.writes });
  const sticky = unknown.plan.decisions.filter(d => w.latestStatus(d.targetSha)?.state === "success").map(d => d.entry.pullRequest).sort((a, b) => a - b);
  f.check("earlier successes stay sticky while holds cannot be delivered (documented forge race)", MODULES.controller, [111, 112], sticky);
  w.state.outage = false;
  f.times = { firstHoldProbeAfterLandingMs: probes.find(p => p.decision === "hold").minutesAfterLanding * MINUTE,
    workerStartToUnknownMs: Date.parse(stalled.observedAt) - Date.parse(stuck.run.run_started_at) };
  f.callBudgets = { stalledHealthReport: budget(stalled.apiBudget), outageWriter: budget(writer.apiBudget), totalInertForgeCalls: w.state.calls };
  f.observations = { probes };
  f.gaps.push("A forge/controller outage leaves earlier PR-head successes in place (the writer refuses with zero writes); they only gate enqueueing. Merge groups receive a success just in time, so none exists to go stale (docs/main-merge-admission.md#fail-closed-group-admission, scripts/rehearse-admission-lease.mjs).");
  return f.done();
}

async function exhaustedInvestigation() {
  const f = flow("exhausted-investigation-budget", "Exhausted investigation budget escalates to an operator without releasing holds");
  const action = { kind: "create_session", request: { prompt: INVESTIGATION_PROMPT, runnerId: "inert", workspaceId: "inert", agentId: "inert", useWorktree: true } };
  const config = { origin: "https://inert.invalid", secret: "inert-fixture-not-a-secret", automationId: "auto_inert", triggerId: "atr_inert",
    revision: 1, generation: 1, actionDigest: createHash("sha256").update(JSON.stringify(action)).digest("hex") };
  const payload = executions => ({ automation: { automationId: config.automationId, revision: 1, enabled: true, concurrencyPolicy: "wait",
    runnerPolicy: { kind: "expire", afterMinutes: 15 }, limits: { maxCostUsd: LIMITS.maxCostUsd, maxToolCalls: LIMITS.maxToolCalls },
    cron: "0 0 1 1 *", timezone: "UTC", action }, executions });
  const triggers = { triggers: [{ triggerId: config.triggerId, automationId: config.automationId, kind: "webhook", generation: 1,
    deliveryPolicy: { allowPrompt: false, parameterNames: PARAMETERS, missingReferences: "reject" } }] };
  const outcomes = {}, escalations = {};
  for (const variant of ["delivery", "elapsed"]) {
    const r = await regressionWorld(), { w } = r, controls = [];
    const collect = virtualCollect(w);
    const health = await collect(REPOSITORY, { api: w.api });
    const candidate = await selectCandidate(REPOSITORY, health, w.api, w.now);
    const key = `${candidate.testedSha}:${candidate.suiteVersion}`;
    const active = variant === "delivery"
      ? { ...candidate, createdAt: w.now - 30 * MINUTE, tries: LIMITS.deliveryAttempts, lastSentAt: w.now - 11 * MINUTE, stopTries: 0, invocationId: null, executionId: null }
      : { ...candidate, createdAt: w.now - LIMITS.elapsedMs - MINUTE, tries: 1, lastSentAt: w.now - LIMITS.elapsedMs, stopTries: 3, invocationId: "ati_inert", executionId: "axe_inert" };
    const previous = await readInvestigationState(w.api, REPOSITORY);
    await writeInvestigationState(w.api, REPOSITORY, previous, { ...previous.value, seen: [key], active });
    const executions = variant === "delivery" ? [] : [{ executionId: "axe_inert", automationId: config.automationId, automationRevision: 1,
      actionKind: "create_session", idempotencyKey: `trigger:${config.triggerId}:main-regression:${candidate.runId}:${candidate.attempt}`,
      status: "running", sessionId: "s_inert" }];
    const inertControl = async path => {
      controls.push(path);
      if (path === `/api/automations/${config.automationId}`) return payload(executions);
      if (path.endsWith("/triggers")) return triggers;
      throw new Error("Inert control plane refuses deliveries and stops");
    };
    const run = () => reconcileInvestigation(REPOSITORY, { api: w.api, control: inertControl, config, now: () => w.now, collect, dryRun: false });
    const first = await run(), second = await run();
    const state = (await readInvestigationState(w.api, REPOSITORY)).value;
    const replan = planInvestigation(state, candidate, w.now);
    const { plan } = await cycle(w);
    // Main CI Health's job delivers the escalation to its open incident; a repeat finds the marker.
    const incident = w.openIncident(4001, { runId: candidate.runId });
    const mentions = ["@fixture/maintainers"];
    const notified = await deliverEscalation(REPOSITORY, { api: w.api, mentions });
    const repeated = await deliverEscalation(REPOSITORY, { api: w.api, mentions });
    escalations[variant] = { first: notified.status, repeat: repeated.status, comments: incident.comments.length,
      marked: incident.comments.filter(c => c.body.includes(escalationMarker(notified.escalation))).length };
    outcomes[variant] = { first: first.status, second: second.status, blocked: state.blocked, replan: replan.reason,
      deliveries: controls.filter(p => p.startsWith("/hooks/")).length, admission: [...new Set(plan.decisions.map(d => d.decision))] };
  }
  f.check("exhausted delivery attempts escalate and stay blocked", MODULES.automation,
    { first: "delivery-exhausted-operator-required", second: "delivery-exhausted", blocked: "delivery-exhausted", replan: "delivery-exhausted", deliveries: 0 },
    (({ admission: _a, ...o }) => o)(outcomes.delivery));
  f.check("elapsed investigation escalates after bounded stop attempts", MODULES.automation,
    { first: "elapsed-exhausted-operator-required", second: "elapsed-exhausted-operator-required", blocked: "elapsed-exhausted",
      replan: "elapsed-exhausted", deliveries: 0 },
    (({ admission: _a, ...o }) => o)(outcomes.elapsed));
  f.check("exhaustion never releases holds while health still fails", MODULES.controller,
    { delivery: ["hold"], elapsed: ["hold"] }, { delivery: outcomes.delivery.admission, elapsed: outcomes.elapsed.admission });
  f.check("each exhaustion reaches the open incident exactly once", MODULES.escalation,
    { delivery: { first: "notified", repeat: "already-notified", comments: 1, marked: 1 },
      elapsed: { first: "notified", repeat: "already-notified", comments: 1, marked: 1 } }, escalations);
  let clock = 0;
  const investigation = new InvestigationBudget({ clock: () => clock, startedAt: 0 }), refusals = {};
  const attempt = (label, kind, options) => { try { investigation.charge(kind, options); return "charged"; }
    catch (error) { refusals[label] = error.message; return error.message; } };
  attempt("reproduction-1", "reproduction"); attempt("reproduction-2", "reproduction");
  attempt("reproduction-3", "reproduction"); attempt("unproven-bisection", "bisection"); attempt("ci-dispatch", "ciDispatch");
  clock = LIMITS.elapsedMs; attempt("after-45-minutes", "comparison");
  f.check("helper budget refuses extra work before running it", MODULES.investigation,
    { "reproduction-3": "attempt-budget-exhausted", "unproven-bisection": "reproduction-required", "ci-dispatch": "attempt-budget-exhausted",
      "after-45-minutes": "elapsed-budget-exhausted" }, refusals);
  f.callBudgets = { investigationCounts: investigation.counts, limits: { deliveryAttempts: LIMITS.deliveryAttempts, elapsedMs: LIMITS.elapsedMs,
    reproductions: LIMITS.reproductionAttempts, ciDispatches: LIMITS.ciDispatches } };
  f.gaps.push("Escalation is delivered as one marked comment on the open Main CI Health incident, mentioning the configured target; it is disabled until MAIN_REGRESSION_ESCALATION_MENTION is set, runs on Main CI Health's next invocation, and cannot prove a human read it.");
  return f.done();
}

async function staleBacklog() {
  const f = flow("stale-backlogged-health", "Backlog and unvalidated-age thresholds hold ordinary admission");
  const { w } = await baselineWorld();
  const first = w.now;
  const lagging = [];
  let backlogPlan;
  for (let i = 1; i <= 5; i++) {
    w.at(first + (i - 1) * 5 * MINUTE);
    w.land(`backlog-${i}`, { pull: 140 + i });
    if (i === 1) { w.at(w.now + TIMING.controllerWakeMs); await validateLatest(w, null, { finish: false }); }
    w.at(first + (i - 1) * 5 * MINUTE + 3 * MINUTE); w.open(150 + i, { head: sha(`head:backlog-${i}`) });
    const { health, plan } = await cycle(w);
    const d = plan.decisions.find(x => x.entry.pullRequest === 150 + i);
    backlogPlan = plan;
    lagging.push({ landed: i, backlog: health.backlog.commits, health: health.status, decision: d.decision, reasons: d.reasons,
      healthCalls: health.apiBudget.calls, earlierReady: plan.decisions.filter(x => x.entry.pullRequest < 150 + i)
        .map(x => ({ pullRequest: x.entry.pullRequest, decision: x.decision, reasons: x.reasons })) });
  }
  // GitHub's baseRefOid stays at an open PR's last sync (read-only check of 8 live PRs on 2026-10-27),
  // so every ready PR opened before a landing holds as base-moved until rebuilt.
  f.check("earlier ready PRs hold only as base-moved until rebuilt on current main", MODULES.admission, true,
    lagging.slice(1).every(l => l.earlierReady.length === l.landed - 1 &&
      l.earlierReady.every(x => x.decision === "hold" && (l.landed < 5 ? x.reasons.join() === "base-moved" : x.reasons.includes("base-moved")))));
  f.check("backlog below five admits; the fifth unvalidated commit holds", MODULES.admission,
    ["ordinary-admission-eligible", "ordinary-admission-eligible", "ordinary-admission-eligible", "ordinary-admission-eligible", "hold"],
    lagging.map(l => l.decision));
  f.check("backlog hold reason and health still pending", `${MODULES.admission}+${MODULES.health}`,
    { reasons: ["unvalidated-backlog-limit"], health: "pending", backlog: 5 }, { reasons: lagging[4].reasons, health: lagging[4].health, backlog: lagging[4].backlog });
  // Every unvalidated commit adds landing-evidence reads to each rebuild, shrinking hold fan-out capacity.
  const backlogDelivery = await deliver(w, backlogPlan);
  f.check("holds at the backlog limit are still delivered in one complete batch", MODULES.controller,
    { complete: true, writes: 5 }, { complete: backlogDelivery.complete, writes: backlogDelivery.writes });
  const aged = await baselineWorld(), a = aged.w, landing = a.now;
  a.land("aged", { pull: 160 });
  a.at(landing + TIMING.controllerWakeMs);
  const queued = await rolling(a); // Runner saturation: the dispatched worker never starts.
  const ages = [];
  for (const seconds of [7_100, 7_195, 7_200, 7_260]) {
    a.at(landing + seconds * 1000); a.open(170 + ages.length, { head: sha(`head:aged-${seconds}`) });
    const { health, plan } = await cycle(a);
    const d = plan.decisions.find(x => x.entry.pullRequest === 170 + ages.length);
    ages.push({ secondsAfterLanding: seconds, health: health.status, decision: d.decision, reasons: d.reasons,
      plannedBlockLatencyMs: d.plannedBlockLatencyMs, healthCalls: health.apiBudget.calls });
  }
  f.check("worker dispatched but never started (queue saturation)", MODULES.rolling, "dispatch-outcome-unknown", queued.state.status);
  f.check("age threshold holds at 7,200 s, recomputed at decision time", MODULES.admission,
    ["ordinary-admission-eligible", "ordinary-admission-eligible", "hold", "hold"], ages.map(x => x.decision));
  f.check("health observer reports stale only after strictly two hours", MODULES.health,
    ["pending", "pending", "stale", "stale"], ages.map(x => x.health));
  f.times = { backlogHoldAfterFirstLandingMs: 20 * MINUTE + 3 * MINUTE, ageThresholdMs: POLICY.maxUnvalidatedAgeSeconds * 1000,
    firstAgeHoldProbeSeconds: ages.find(x => x.decision === "hold").secondsAfterLanding,
    ageHoldPlannedBlockLatencyMs: ages.find(x => x.decision === "hold").plannedBlockLatencyMs };
  f.callBudgets = { maxHealthReportCalls: Math.max(...[...lagging, ...ages].map(x => x.healthCalls)), healthReportLimit: 96,
    backlogLimitCapacity: backlogDelivery.capacity, totalInertForgeCalls: w.state.calls + a.state.calls };
  f.observations = { lagging, ages, thresholds: { maxUnvalidatedCommits: POLICY.maxUnvalidatedCommits,
    maxUnvalidatedAgeSeconds: POLICY.maxUnvalidatedAgeSeconds, maxObservationAgeSeconds: POLICY.maxObservationAgeSeconds } };
  f.gaps.push("Thresholds are the code-reviewed shadow proposals (5 commits, 7,200 s), not approved activation values. At 7,200 s the observer's own collection time already pushes health past its strict two-hour stale bound.");
  return f.done();
}

async function queuedEntryHold() {
  const f = flow("queued-entry-hold", "Ready, queued and stacked entries are held and earlier successes withdrawn");
  const { w } = await baselineWorld();
  w.open(200, { head: sha("head:200") }); w.enqueue("regression", [200]);
  w.at(START + TIMING.fastGateMs);
  w.reportRequired("regression", "success");
  await deliver(w, (await cycle(w)).plan);
  const landing = w.now, regression = w.land("regression", { pull: 200 });
  w.at(landing + TIMING.controllerWakeMs);
  const worker = await validateLatest(w, "failure", { finish: false });
  w.open(201, { head: sha("head:201") });
  w.open(202, { head: sha("head:202") }); const first = w.enqueue("queued", [202], { base: regression });
  w.open(203, { head: sha("head:203") }); w.open(204, { head: sha("head:204") });
  w.enqueue("stacked", [203, 204], { base: first.sha, position: 2 });
  // The queue-head group's own checks have passed: it holds a just-in-time success that a later
  // failure must withdraw (the forge race). The stacked group gets nothing until it is next.
  w.reportRequired("queued", "success");
  w.at(landing + 5 * MINUTE);
  const before = await cycle(w);
  const green = await deliver(w, before.plan);
  f.check("pending health admits ready and queued entries; a stacked group waits on its base", MODULES.controller,
    { "group:202": "ordinary-admission-eligible", "group:203": "hold", "pr:201": "ordinary-admission-eligible",
      "pr:202": "ordinary-admission-eligible", "pr:203": "ordinary-admission-eligible", "pr:204": "ordinary-admission-eligible" }, decisionsBy(before.plan));
  f.check("stacked group reason is base-moved, not a health failure", MODULES.admission, ["base-moved"], reasonsBy(before.plan)["group:203"]);
  w.at(worker.dispatchedAt + TIMING.workerDispatchToVerdictMs); w.finishRun(worker.run, "failure", w.now);
  const failedAt = w.now;
  w.at(failedAt + TIMING.observerWakeMs);
  const after = await cycle(w);
  const held = await deliver(w, after.plan);
  f.check("failure holds every ready, queued, building and stacked target", MODULES.controller, true,
    after.plan.decisions.every(d => d.decision === "hold" && d.reasons.includes("unresolved-full-failure")));
  const previouslyGreen = before.plan.decisions.filter(d => d.state === "success").map(d => d.targetSha);
  f.check("every earlier success is withdrawn by an exact-SHA failure status", MODULES.controller,
    { previouslyGreen: 5, withdrawn: 5, writes: 6, complete: true },
    { previouslyGreen: previouslyGreen.length, withdrawn: previouslyGreen.filter(s => w.latestStatus(s)?.state === "failure").length,
      writes: held.writes, complete: held.complete });
  f.times = { failureToLastHoldReceiptMs: Date.parse(held.lastReceiptAt) - failedAt, lastPlannedBlockLatencyMs: held.lastPlannedBlockLatencyMs,
    landingToFailedVerdictMs: failedAt - landing };
  f.callBudgets = { greenWriter: budget(green.apiBudget), holdWriter: budget(held.apiBudget), holdCapacity: held.capacity,
    targets: after.plan.decisions.length, totalInertForgeCalls: w.state.calls };
  f.gaps.push("Six targets only; the #3633 fan-out rehearsal (delivered3633Rehearsal.fanout) carries the 45/46-target call-cap boundary.",
    "A status write withdraws admission only for future evaluation; GitHub's own landing of an already-green group remains the documented forge race.");
  return f.done();
}

async function exactHeadRepair() {
  const f = flow("exact-head-repair", "Repair admission binds to exact head, base, group tree and failure set");
  const r = await regressionWorld(), { w } = r;
  w.at(r.failedAt + TIMING.repairProposalMs);
  w.open(105, { head: sha("head:105") });
  const group = w.enqueue("repair", [105], { base: r.regression, tree: sha("tree:baseline") });
  w.open(106, { head: sha("head:106") }); w.open(107, { head: sha("head:107") });
  const batch = w.enqueue("batched-repair", [106, 107], { base: r.regression, position: 2 });
  const health = await observeHealth(w);
  const entry = { repository: REPOSITORY, kind: "merge_group", pullRequest: 105, headSha: sha("head:105"), baseSha: r.regression,
    integrationSha: group.sha, members: [{ pullRequest: 105, headSha: sha("head:105") }] };
  const exact = { repository: REPOSITORY, authorizationId: "inert-repair-105", pullRequest: 105, kind: "merge_group", headSha: entry.headSha,
    baseSha: entry.baseSha, integrationSha: entry.integrationSha, failureFingerprint: failureFingerprint(health),
    approvedAt: w.iso(), expiresAt: new Date(w.now + 30 * MINUTE).toISOString() };
  const decide = async (grant, { at = w.iso(), checks = fastChecks(), repair = null, observed = health } = {}) => {
    const plan = await planAdmissionCycle({ repository: REPOSITORY, census: { repository: REPOSITORY, mainSha: observed.currentMainSha,
      complete: true, entries: [entry, { repository: REPOSITORY, kind: "merge_group", pullRequest: 106, headSha: sha("head:106"),
        baseSha: r.regression, integrationSha: batch.sha, members: [106, 107].map(n => ({ pullRequest: n, headSha: sha(`head:${n}`) })) }] },
      health: observed, control: { available: true, repair }, grant, verifyAuthority, verifyChecks: checks, now: at,
      observationId: "inert-rehearsal", entryPoint: "rehearsal" });
    return decisionsBy(plan);
  };
  f.check("exact grant admits only that single-PR group", MODULES.controller,
    { "group:105": "authorized-repair-eligible", "group:106": "hold" }, await decide(exact));
  const variants = {
    "changed-head": { ...exact, headSha: sha("head:105-force-push") },
    "changed-base": { ...exact, baseSha: r.base },
    "changed-group": { ...exact, integrationSha: sha("group:other") },
    "batched-group": { ...exact, pullRequest: 106, headSha: sha("head:106"), integrationSha: batch.sha },
    "stale-failure-set": { ...exact, failureFingerprint: "0".repeat(64) },
    "expired-grant": { ...exact, expiresAt: w.iso() },
  };
  const refused = {};
  for (const [name, grant] of Object.entries(variants)) refused[name] = (await decide(grant))["group:105"] === "hold" && (await decide(grant))["group:106"] === "hold";
  refused["fast-checks-unverified"] = (await decide(exact, { checks: fastChecks({ fast: false }) }))["group:105"] === "hold";
  refused["expired-health-observation"] = (await decide(exact, { at: new Date(Date.parse(health.observedAt) + POLICY.maxObservationAgeSeconds * 1000).toISOString() }))["group:105"] === "hold";
  f.check("every non-exact grant or proof is refused", MODULES.controller,
    Object.fromEntries(Object.keys(refused).map(k => [k, true])), refused);
  const admittedAt = w.iso();
  w.at(w.now + MINUTE);
  const mismatched = w.land("repair-wrong-tree", { pull: 105, tree: sha("tree:unexpected") });
  const wrongTree = await mergedRepairBinding(REPOSITORY, exact, { authorizationDigest: repairDigest(exact), integrationSha: group.sha, admittedAt }, { api: w.api });
  f.check("squash tree differing from the authorized group is refused", MODULES.repair,
    { reason: "repair-merge-binding-changed", mainSha: mismatched }, { reason: wrongTree.reason, mainSha: w.tip() });
  const competing = await decide({ ...exact }, { repair: { binding: { decision: "merged-repair-bound", repository: REPOSITORY,
    pullRequest: 99, mergeSha: r.regression }, receipt: null } });
  f.check("a competing repair cannot be admitted during another repair's reconciliation", MODULES.controller,
    { "group:105": "hold", "group:106": "hold" }, competing);
  f.callBudgets = { health: budget(health.apiBudget), totalInertForgeCalls: w.state.calls };
  f.gaps.push("Authority and fast-check verifiers are operator-owned fixtures; no live verifier exists by design (#3633).");
  return f.done();
}

async function exactCandidateRelease() {
  const f = flow("exact-candidate-release", "Release requires exact full certification; uncertified or stale candidates are refused");
  const { w } = await baselineWorld();
  const first = w.land("release-candidate", { pull: 180 });
  w.at(w.now + 30_000);
  w.land("after-candidate", { pull: 181 });
  w.at(w.now + TIMING.controllerWakeMs);
  const latest = await validateLatest(w, "success");
  f.check("rolling validation skips the intermediate SHA under fast landings", MODULES.rolling,
    { dispatched: 1, skippedTarget: first }, { dispatched: w.state.dispatches.length, skippedTarget: w.state.dispatches.some(d => d.targetSha === first) ? null : first });
  const certify = () => collectCertification(REPOSITORY, first, { api: w.api, now: () => w.iso() });
  const missing = await certify();
  f.check("uncertified candidate is refused and asks for exact validation", MODULES.certification,
    { status: "missing", reason: "request-exact-candidate-validation" }, { status: missing.status, reason: missing.reason });
  const requestedAt = w.now;
  const receipt = await requestCandidate(REPOSITORY, first, { purpose: "release", api: w.api, now: () => w.iso() });
  f.check("scheduling receipt certifies nothing", MODULES.candidates, { purpose: "release", certification: "none", status: "queued" },
    { purpose: receipt.purpose, certification: receipt.certification, status: receipt.status });
  w.at(Date.parse(latest.run.updated_at) + TIMING.observerWakeMs);
  await rolling(w);
  const cooling = w.state.dispatches.length;
  w.at(Date.parse(latest.run.updated_at) + 60 * MINUTE);
  const candidate = await validateLatest(w, "success", { finish: false });
  f.check("candidate dispatched only after main is validated and the shared cooldown elapses", `${MODULES.rolling}+${MODULES.candidates}`,
    { beforeCooldown: 1, afterCooldown: 2, targetSha: first }, { beforeCooldown: cooling, afterCooldown: w.state.dispatches.length,
      targetSha: w.state.dispatches.at(-1)?.targetSha });
  const active = await certify();
  f.check("active candidate validation is pending, not certified", MODULES.certification, "pending", active.status);
  w.at(candidate.dispatchedAt + TIMING.workerDispatchToVerdictMs); w.finishRun(candidate.run, "success", w.now);
  w.at(w.now + TIMING.observerWakeMs);
  const certified = await certify();
  f.check("exact full verdict certifies the candidate", MODULES.certification, { status: "certified", runId: candidate.run.id },
    { status: certified.status, runId: certified.runId });
  const outside = await collectCertification(REPOSITORY, sha("head:unmerged"), { api: w.api, now: () => w.iso() });
  let outsideRequest;
  try { await requestCandidate(REPOSITORY, sha("head:unmerged"), { purpose: "release", api: w.api, now: () => w.iso() }); outsideRequest = "queued"; }
  catch (error) { outsideRequest = error.message; }
  f.check("a candidate outside main ancestry is refused", `${MODULES.certification}+${MODULES.rolling}`,
    { certification: "candidate-outside-main", request: "Candidate is outside main ancestry" }, { certification: outside.reason, request: outsideRequest });
  const red = w.land("red-candidate", { pull: 182 });
  w.at(w.now + TIMING.controllerWakeMs);
  await validateLatest(w, "failure");
  w.at(w.now + TIMING.observerWakeMs);
  const failed = await collectCertification(REPOSITORY, red, { api: w.api, now: () => w.iso() });
  f.check("a candidate whose exact full run failed is refused", MODULES.certification, "failed", failed.status);
  w.land("suite-change", { pull: 183, edition: 2 });
  w.at(w.now + MINUTE);
  const stale = await certify();
  f.check("a certificate from a superseded suite is refused as stale", MODULES.certification,
    { status: "incompatible", reason: "candidate-suite-version-mismatch" }, { status: stale.status, reason: stale.reason });
  f.times = { requestToCertifiedMs: Date.parse(certified.observedAt) - requestedAt, candidateDispatchDelayMs: candidate.dispatchedAt - requestedAt };
  f.callBudgets = { certificationLimit: 48, totalInertForgeCalls: w.state.calls, inertDispatches: w.state.dispatches.length };
  f.gaps.push("The one-hour shared cooldown and idle-main precondition dominate request-to-certification time; this is the delivered #3635 policy, not a measured live latency.");
  return f.done();
}

/** Delivered #3633 rehearsal, reused unchanged for its historical replay, hold
 * fan-out capacity boundaries and ordered rollback (slice C owns end-to-end rollback). */
async function delivered3633(projection) {
  const report = await rehearseAdmission(projection);
  return { schema: report.schema, source: report.source, phases: report.phases.map(({ phase, decision }) => ({ phase, decision })),
    fanout: Object.fromEntries(Object.entries(report.fanout).map(([k, v]) => [k, { targetCount: v.targetCount, writes: v.writes,
      complete: v.complete, calls: v.apiBudget?.calls ?? v.capacity?.callsUsed, failureOrExpiryToLastPlannedHoldMs: v.failureOrExpiryToLastPlannedHoldMs }])),
    liveMutations: report.liveMutations };
}

/** Shared inert harness: the same worlds, real health report, census and default-deny writer
 * (scripts/rehearse-admission-lease.mjs reuses them rather than building a second policy). */
export const harness = Object.freeze({ baselineWorld, validateLatest, cycle, deliver, observeHealth });

export async function rehearseFastGateCutover({ projection } = {}) {
  projection ??= JSON.parse(readFileSync(new URL("./fixtures/main-merge-health-projection.json", import.meta.url), "utf8"));
  const flows = [];
  for (const run of [missedFailure, validatorOutage, exhaustedInvestigation, staleBacklog, queuedEntryHold, exactHeadRepair, exactCandidateRelease])
    flows.push(await run());
  return { schema: SCHEMA, issue: "#3637 AC2", mode: "inert-offline-fixture", enforcement: "none", repository: REPOSITORY,
    evidenceClass: "Real delivered decision modules over an inert in-process forge and virtual clock; fixture fast checks, timings, authority and evidence. Not live enforcement, not traffic measurement, not activation readiness.",
    timing: TIMING, policy: POLICY, summary: { flows: flows.length, passed: flows.filter(f => f.pass).length,
      steps: flows.reduce((n, f) => n + f.steps.length, 0) }, flows, delivered3633Rehearsal: await delivered3633(projection),
    composition: ["Fixed here: the main-ci-health report entry point, observeAdmission and rebuildAdmissionCycle ignored the caller's clock, so virtual-time callers saw wall-clock observations. They now pass it through; production behavior is unchanged."],
    liveMutations: 0 };
}

export async function main(argv = process.argv.slice(2)) {
  const report = await rehearseFastGateCutover();
  if (argv[0]) writeFileSync(argv[0], JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ schema: report.schema, summary: report.summary, flows: report.flows.map(f => ({ id: f.id, pass: f.pass })) }));
  return report.summary.passed === report.summary.flows ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then(code => { process.exitCode = code; });
