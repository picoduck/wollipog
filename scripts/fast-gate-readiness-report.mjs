import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ADMISSION_CONTEXT, admissionEnforcement, GATE_ENABLED, GATE_VARIABLE, gateDecision, REQUIRED_CONTEXT,
  ROLLBACK_VALUE } from "./ci-merge-group-gate.mjs";
import { PROPOSED_THRESHOLDS, rehearseFastGateRollback } from "./fast-gate-rollback.mjs";
import { eventSummary } from "./merge-queue-wait-report.mjs";
import { rehearseFastGateCutover } from "./rehearse-fast-gate-cutover.mjs";

/** #3637 AC1 readiness evidence. Deterministic and offline: it composes slice B's cutover rehearsal,
 * the rollback rehearsal, slice A's gate decision on the proposed configuration, #3633's fan-out
 * bounds and committed measurements. Every criterion is met only by computed or committed evidence;
 * missing live data is an observation gap, a human decision an approval gap. Nothing here passes
 * by default, reads GitHub or changes a setting.
 */
export const SCHEMA = "fast-gate-readiness-v1";
export const REPORT_DATE = "2026-10-28";
export const REPORT_PATH = `docs/fast-gate-readiness-${REPORT_DATE}.md`;
export const LIVE_SETTINGS = `scripts/fixtures/fast-gate-live-settings-${REPORT_DATE}.json`;
const BASELINE = "docs/ci-baseline-2026-10-22.json";
export const PROPOSAL = "docs/fast-gate-activation-proposal.md";
// Pre-activation guidance must point at the proposal (AC6); AGENTS.md changes only at activation.
export const GUIDANCE = Object.freeze(["docs/agent-workflow.md", "docs/ci-aggregation.md", "docs/main-ci-health.md",
  "docs/merge-queue-wait.md", "docs/RELEASING.md", ".agents/skills/codebase-maintenance/jobs/flaky-test-triage.md"]);
export const RULESET_ID = 22200037;
// Never a real issuer: a string is not a positive integer, so the unfilled template keeps the gate full.
export const ADMISSION_ISSUER_PLACEHOLDER = "<APPROVED_ADMISSION_APP_ID>";
const minutes = (ms) => Number.isFinite(ms) ? Math.round(ms / 600) / 100 : null;
const text = (path) => existsSync(new URL(`../${path}`, import.meta.url)) ? readFileSync(new URL(`../${path}`, import.meta.url), "utf8") : "";
const read = (path) => JSON.parse(text(path));

/** Committed measurements quoted verbatim from their source; the test fails if a source drifts. */
export const MEASUREMENTS = Object.freeze([
  { id: "rolling-dispatch-to-verdict", value: "33.68/34.27/46.42 min (min/median/max, 7 natural runs)", source: "docs/main-merge-admission.md", quote: "**33.68/34.27/46.42 minutes**" },
  { id: "two-suite-envelope", value: "92.84 min (two observed maxima)", source: "docs/main-merge-admission.md", quote: "two observed maxima total 92.84 minutes" },
  { id: "queue-wait-under-pressure", value: "102 min 20 s to 104 min 51 s browser-shard queue waits (one campaign group)", source: "docs/main-merge-recovery.md", quote: "**102 minutes 20 seconds**" },
  { id: "health-natural-observation-calls", value: "28–48 observation calls, cap 96, REST floor 3000", source: "docs/main-ci-health-budget-2026-10-24.md", quote: "This common lag-one observation required **48 observation calls**" },
  { id: "controller-live-census", value: "35–45 ready targets, 27–53 calls per read-only cycle", source: "docs/main-merge-recovery.md", quote: "verified two matching complete censuses of **45 targets**" },
  { id: "batched-45-target-headroom", value: "53 - 3 + 1 + 45 = 96/96 calls, zero headroom (#3711)", source: "docs/main-merge-admission.md", quote: "**53 - 3 + 1 + 45 = 96**, **zero call headroom**" },
  { id: "pr-assurance-routing", value: "Fast PR routing: net three fewer jobs; standalone fast minutes unmeasured", source: "docs/ci-pr-assurance-baseline-2026-10-24.md", quote: "net **three fewer jobs**" },
  { id: "suite-shadow-local", value: "Node fast entry point 231 tests in 36.830 s; five critical Chromium files 3.3 min (local, not CI)", source: "docs/ci-suite-evidence-2026-10-23.md", quote: "passed **231 tests in 36.830 s**" },
]);

/** The exact PUT body for the main ruleset: every live rule unchanged except one added admission context. */
export function proposedRuleset(live, issuer = ADMISSION_ISSUER_PLACEHOLDER) {
  const rules = live.branchRules.map(({ type, parameters }) => parameters === null ? { type } : { type, parameters: structuredClone(parameters) });
  const checks = rules.find((rule) => rule.type === "required_status_checks");
  if (!checks || checks.parameters.required_status_checks.some((check) => check.context === ADMISSION_CONTEXT) ||
      !checks.parameters.required_status_checks.some((check) => check.context === REQUIRED_CONTEXT)) throw new Error("Unexpected live ruleset");
  checks.parameters.required_status_checks.push({ context: ADMISSION_CONTEXT, integration_id: issuer });
  const { name, target, enforcement, conditions, bypass_actors } = live.ruleset;
  return { name, target, enforcement, conditions, bypass_actors, rules };
}

/** A hold whose only reason is a moved base is a re-sync artifact, not a health hold; measure them apart. */
export function holdKind(decision) {
  if (decision?.decision !== "hold") return null;
  const reasons = Array.isArray(decision.reasons) ? decision.reasons : [];
  return reasons.length && reasons.every((reason) => reason === "base-moved") ? "base-moved" : "health-or-policy";
}

const SHA_MAIN = "a".repeat(40), SHA_GROUP = "b".repeat(40);
const ordinary = { mode: "fast", reasons: [], risks: ["ordinary"], context: { event: "merge_group", diffKind: "combined-merge-group",
  baseSha: SHA_MAIN, diffBaseSha: SHA_MAIN, trustedPolicySha: SHA_MAIN, testedSha: SHA_GROUP, changeHeadSha: SHA_GROUP } };
/** Exactly `ci-merge-group-gate.mjs evaluate`: enforcement is always derived from the rules. */
const evaluate = (config) => ({ ...gateDecision({ ...config, enforcement: admissionEnforcement(config.rules) }), enforcement: admissionEnforcement(config.rules) });

function gateEvaluations(live) {
  const proposal = { event: "merge_group", trustedMainSha: SHA_MAIN, testedSha: SHA_GROUP, workflowMatches: true, selection: ordinary };
  const withIssuer = (issuer) => proposedRuleset(live, issuer).rules;
  return [
    ["Live settings today (variable absent)", { ...proposal, gate: live.gateVariables[GATE_VARIABLE] ?? undefined, rules: live.branchRules }],
    ["Variable set to enabled prematurely, live ruleset", { ...proposal, gate: GATE_ENABLED, rules: live.branchRules }],
    ["Proposed ruleset, issuer placeholder unfilled", { ...proposal, gate: GATE_ENABLED, rules: withIssuer(ADMISSION_ISSUER_PLACEHOLDER) }],
    ["Proposed ruleset, pinned issuer, ordinary group", { ...proposal, gate: GATE_ENABLED, rules: withIssuer(4242) }],
    ["Proposed ruleset, pinned issuer, high-risk group", { ...proposal, gate: GATE_ENABLED, rules: withIssuer(4242),
      selection: { ...ordinary, mode: "full", reasons: ["high-risk-path"], risks: ["high"] } }],
    ["Rollback value, pinned issuer", { ...proposal, gate: ROLLBACK_VALUE, rules: withIssuer(4242) }],
  ].map(([label, config]) => ({ label, gate: config.gate ?? null, ...evaluate(config) }));
}

function baselineContext() {
  const baseline = read(BASELINE);
  const group = eventSummary(baseline.records).cohorts.find((row) => row.event === "merge_group" && row.attemptClass === "first");
  const removals = Object.fromEntries([...new Set(baseline.removals.map((row) => row.reason))].sort()
    .map((reason) => [reason, baseline.removals.filter((row) => row.reason === reason).length]));
  return { source: BASELINE, windows: baseline.windows, collectedAt: baseline.collectedAt, mergeGroupFirstAttempts: group.records,
    states: group.states, passingRequiredMinutes: group.byState.passing.measures.requiredMinutes, removals,
    note: "Full-gate baseline before any fast gate. Context for AC4, not evidence of it." };
}

export async function buildReadiness({ cutover, rollback } = {}) {
  cutover ??= await rehearseFastGateCutover();
  rollback ??= await rehearseFastGateRollback();
  const live = read(LIVE_SETTINGS);
  const flows = Object.fromEntries(cutover.flows.map((flow) => [flow.id, flow]));
  const gate = gateEvaluations(live);
  const ruleset = proposedRuleset(live);
  const fanout = cutover.delivered3633Rehearsal.fanout;
  const backlog = flows["stale-backlogged-health"];
  const lagging = backlog.observations.lagging ?? [];
  const holds = lagging.flatMap((row) => row.earlierReady).map(holdKind).filter(Boolean);
  const capacity = {
    healthReportCallsByBacklog: lagging.map((row) => ({ backlog: row.backlog, calls: row.healthCalls })),
    backlogLimitWriterCallsUsed: backlog.callBudgets.backlogLimitCapacity.callsUsed,
    backlogLimitWritesAvailable: backlog.callBudgets.backlogLimitCapacity.writesAvailable,
    fanoutTargetsFitted: fanout.batchedMeasuredCost45Targets.targetCount,
    batched45Calls: fanout.batchedMeasuredCost45Targets.calls, callCap: backlog.callBudgets.healthReportLimit,
    batched46Writes: fanout.batchedMeasuredCost46Targets.writes,
    rehearsalHolds: { baseMovedOnly: holds.filter((kind) => kind === "base-moved").length, healthOrPolicy: holds.filter((kind) => kind === "health-or-policy").length },
  };
  const liveRequired = live.branchRules.find((rule) => rule.type === "required_status_checks").parameters.required_status_checks;
  const queue = live.branchRules.find((rule) => rule.type === "merge_queue").parameters;
  const workflow = text(".github/workflows/ci.yml");
  const linked = GUIDANCE.filter((path) => text(path).includes("fast-gate-activation-proposal.md"));
  const decided = (label) => gate.find((row) => row.label === label);
  const baseline = baselineContext();
  const criteria = [];
  const add = (id, acceptance, criterion, classification, evidence, ok = true) =>
    criteria.push({ id, acceptance, criterion, classification: classification === "met" && !ok ? "code-gap" : classification,
      status: classification === "met" ? ok ? "met" : "failing" : classification === "approval-gap" ? "pending-approval"
        : classification === "code-gap" ? "open" : "incomplete", evidence });

  add("readiness-report", "AC1", "Readiness evidence published before activation", "met", `${REPORT_PATH}, generated by scripts/fast-gate-readiness-report.mjs`);
  add("exact-changes", "AC1", "Exact workflow, status and ruleset changes published", "met",
    `${PROPOSAL} embeds the ruleset body computed below from the live snapshot`, text(PROPOSAL).includes(JSON.stringify(ruleset, null, 2)));
  add("protected-context-kept", "AC1", `\`${REQUIRED_CONTEXT}\` keeps its name and issuer; nothing is renamed or removed`, "met",
    `ci.yml check job name; proposed ruleset keeps ${JSON.stringify(liveRequired[0])} first`,
    workflow.includes(`    name: ${REQUIRED_CONTEXT}\n`) && JSON.stringify(ruleset.rules.find((r) => r.type === "required_status_checks")
      .parameters.required_status_checks[0]) === JSON.stringify(liveRequired[0]));
  add("unknown-checks-block", "AC1", "An unfilled, unpinned or unknown admission issuer keeps full validation", "met",
    `Gate on the unfilled template: ${decided("Proposed ruleset, issuer placeholder unfilled").mode} (${decided("Proposed ruleset, issuer placeholder unfilled").enforcement.reason})`,
    decided("Proposed ruleset, issuer placeholder unfilled").mode === "full");
  add("disabled-today", "AC1", "The gate is disabled on live settings and fails closed if enabled early", "met",
    `Live ${live.observedAt}: ${GATE_VARIABLE} ${live.gateVariables[GATE_VARIABLE] === null ? "absent" : "present"}; early enable: ${decided("Variable set to enabled prematurely, live ruleset").mode} (${decided("Variable set to enabled prematurely, live ruleset").reasons.join(", ")})`,
    live.gateVariables[GATE_VARIABLE] === null && decided("Live settings today (variable absent)").mode === "full" &&
      decided("Variable set to enabled prematurely, live ruleset").mode === "full");
  add("proposed-configuration-fast", "AC1", "Only the complete proposed configuration reduces an ordinary group", "met",
    `Pinned issuer + ordinary: ${decided("Proposed ruleset, pinned issuer, ordinary group").mode}; high risk: ${decided("Proposed ruleset, pinned issuer, high-risk group").mode}`,
    decided("Proposed ruleset, pinned issuer, ordinary group").mode === "fast" && decided("Proposed ruleset, pinned issuer, high-risk group").mode === "full");
  for (const flow of cutover.flows) add(`ac2-${flow.id}`, "AC2", flow.title, "met",
    `${flow.steps.filter((step) => step.match).length}/${flow.steps.length} steps match (scripts/rehearse-fast-gate-cutover.mjs)`, flow.pass);
  add("ac2-live-forge", "AC2", "Live forge timing, landing races, real fast-check coverage and real API cost", "observation-gap",
    "The cutover rehearsal is an inert fixture; see its disclosed limits");
  add("rollout-window", "AC3", "At least 30 eligible normal-traffic integrations over five working days in an approved scope", "observation-gap",
    "0 post-activation integrations; the gate has never been enabled");
  add("required-p90", "AC4", "Ordinary-change required-result p90 at most 15 min", "observation-gap",
    `No fast-gate sample. Full-gate passing merge-group p90 was ${baseline.passingRequiredMinutes.p90.toFixed(2)} min (context only)`);
  add("no-green-expiry", "AC4", "No passing group expires for missing required results in the window", "observation-gap",
    `No fast-gate sample. The full-gate baseline window had ${baseline.removals.checks_timed_out ?? 0} checks_timed_out removals, not reconciled to episodes`);
  add("detection-backlog-recovery", "AC4", "Detection, backlog and recovery within separately approved thresholds", "approval-gap",
    `Proposed: detection ≤ ${PROPOSED_THRESHOLDS.maxDetectionMinutes} min, backlog ≤ ${PROPOSED_THRESHOLDS.maxUnvalidatedCommits} commits / ${PROPOSED_THRESHOLDS.maxUnvalidatedAgeSeconds} s, recovery ≤ ${PROPOSED_THRESHOLDS.maxRecoveryMinutes} min; then observation`);
  add("rollback-triggers", "AC5", "Rollback triggers defined and each exercised through restoration", "met",
    `${rollback.summary.passed}/${rollback.summary.scenarios} trigger scenarios, ${rollback.summary.steps} steps (scripts/fast-gate-rollback.mjs)`, rollback.summary.pass);
  add("restore-before-hold-removal", "AC5", "Full queue validation verified before any health-policy hold is removed", "met",
    "planRollback refuses without fullQueueProof, with a reduced, unfinished or forged proof, and with an approval for another digest",
    rollback.scenarios.every((s) => s.steps.find((step) => step.step === "hold removal refused without fullQueueProof")?.match));
  add("no-auto-expansion", "AC5", "No budget, timeout, paid capacity or bypass right is expanded", "met",
    `Rehearsals made ${cutover.liveMutations + rollback.liveMutations} live mutations; proposal keeps check_response_timeout_minutes ${queue.check_response_timeout_minutes}, max_entries_to_build ${queue.max_entries_to_build} and bypass actors unchanged`,
    JSON.stringify(ruleset.bypass_actors) === JSON.stringify(live.ruleset.bypass_actors) &&
      JSON.stringify(ruleset.rules.find((r) => r.type === "merge_queue").parameters) === JSON.stringify(queue));
  add("live-rollback", "AC5", "A real switch-back read-back and restoration proof on live merge groups", "observation-gap",
    "Only possible after activation; the verifier and commands are ready");
  add("docs-disabled-machinery", "AC6", "CI docs and contributor skills describe the disabled machinery", "met",
    `${linked.length}/${GUIDANCE.length} guidance files link the proposal`, linked.length === GUIDANCE.length);
  add("agents-md-active", "AC6", "AGENTS.md and workflow guidance for active fast-gate semantics", "approval-gap",
    "Exact text is in the proposal, to be applied with activation; current semantics are unchanged");
  add("reconcile-2674", "AC7", "#2674 scope and trial outcome reconciled explicitly", "approval-gap",
    "Proposed path in the proposal; the fast gate is not evidence for #2674's full-gate criterion");
  add("prereq-3628-3629-window", "Prerequisite", "#3628/#3629 sustained critical-path and long-window suite comparison", "observation-gap", "Interim observations only");
  add("prereq-3630-post-activation", "Prerequisite", "#3630 PR routing post-activation measurement", "approval-gap",
    `CI_PR_SUITE_ROUTING ${live.gateVariables.CI_PR_SUITE_ROUTING === null ? "absent" : "present"}; enabling needs approval, then a natural window`);
  add("prereq-3633-enforcement-bound", "Prerequisite", "#3633 AC1 live enforcement bound", "observation-gap", "Shipped enforcement bound: none (disabled)");
  add("prereq-2674-trial", "Prerequisite", "#2674 five-working-day full-gate trial", "observation-gap", "Separate trial; not satisfied by this policy");
  add("first-real-gate-group", "Prerequisite", "The gate's first real merge group decision and job-level evidence", "observation-gap", "Never enabled");
  add("base-moved-separation", "Measurement", "base-moved holds measured apart from health holds", "observation-gap",
    `Rehearsal: ${capacity.rehearsalHolds.baseMovedOnly} base-moved-only and ${capacity.rehearsalHolds.healthOrPolicy} health/policy ready-PR holds; no live sample`);
  add("capacity-backlog-limit", "Capacity", "A full ready set can still be held at the backlog limit", "code-gap",
    `Health report ${capacity.healthReportCallsByBacklog[0]?.calls}→${capacity.healthReportCallsByBacklog.at(-1)?.calls} calls at backlog ${capacity.healthReportCallsByBacklog[0]?.backlog}→${capacity.healthReportCallsByBacklog.at(-1)?.backlog}; writer used ${capacity.backlogLimitWriterCallsUsed} leaving ${capacity.backlogLimitWritesAvailable} writes, under the ${capacity.fanoutTargetsFitted}-target fan-out: refuses with zero writes`,
    capacity.backlogLimitWritesAvailable >= capacity.fanoutTargetsFitted);
  add("capacity-zero-headroom", "Capacity", "Call headroom for the 45-target hold set", "code-gap",
    `${capacity.batched45Calls}/${capacity.callCap} calls (#3711), zero headroom; 46 targets write ${capacity.batched46Writes}`);
  add("sticky-success", "Enforcement", "A controller or forge outage cannot leave an earlier success sticky", "code-gap",
    "Writer refuses with zero writes and cannot withdraw; needs a fail-closed lease or retained full validation");
  add("escalation-delivery", "Operations", "Exhausted investigation escalation reaches a human", "code-gap", "Outside the delivered modules; not rehearsed");
  add("exposure-window", "Operations", "Accepted exposure between fast landing and the full verdict", "approval-gap",
    `Rehearsal: ${minutes(flows["missed-failure"].times.landingToFailedVerdictMs)} min, ${flows["missed-failure"].times.exposureAdmissionsBeforeHold} admissions withdrawn (virtual)`);
  add("status-writing-identity", "Approval", "Status-writing app, operator host and pinned integration_id for Regression Admission", "approval-gap", "Not provisioned; no workflow grants statuses: write");
  add("admission-and-investigation-activation", "Approval", "CI_REGRESSION_ADMISSION dry-run window, enforcement and #3634 investigation activation", "approval-gap",
    `CI_REGRESSION_ADMISSION ${live.gateVariables.CI_REGRESSION_ADMISSION === null ? "absent" : "present"}`);

  const counts = Object.fromEntries(["met", "observation-gap", "approval-gap", "code-gap"]
    .map((kind) => [kind, criteria.filter((row) => row.classification === kind).length]));
  return { schema: SCHEMA, issue: "#3637 AC1", date: REPORT_DATE, activationReady: false, liveMutations: 0,
    verdict: "Not ready to activate: observation, approval and code gaps remain. Insufficient data is reported as incomplete, never as passing.",
    counts, criteria, gate, ruleset: { id: RULESET_ID, put: ruleset }, capacity, baseline,
    live: { observedAt: live.observedAt, method: live.method, repositoryVariableNames: live.repositoryVariableNames, gateVariables: live.gateVariables,
      requiredStatusChecks: liveRequired, mergeQueue: queue, bypassActors: live.ruleset.bypass_actors },
    rehearsals: {
      cutover: { schema: cutover.schema, summary: cutover.summary, timing: cutover.timing,
        flows: cutover.flows.map((flow) => ({ id: flow.id, pass: flow.pass, steps: flow.steps.length, times: flow.times, gaps: flow.gaps })) },
      rollback: { schema: rollback.schema, summary: rollback.summary, checks: rollback.checks,
        scenarios: rollback.scenarios.map((s) => ({ trigger: s.trigger, pass: s.pass, steps: s.steps.length })) },
    },
    measurements: MEASUREMENTS.map(({ quote, ...row }) => row), thresholds: PROPOSED_THRESHOLDS };
}

const LABEL = { "met": "Met (code/fixture)", "observation-gap": "Observation gap", "approval-gap": "Approval gap", "code-gap": "Code gap" };
const STATUS = { met: "Met", failing: "Failing", incomplete: "Incomplete", "pending-approval": "Pending approval", open: "Open" };
const cell = (text) => String(text).replaceAll("|", "\\|");

export function markdown(report) {
  const timesFor = (flow) => Object.entries(flow.times).map(([key, value]) => /Ms$/.test(key) ? `${key.replace(/Ms$/, "")} ${minutes(value)} min`
    : `${key} ${value}`).join("; ") || "—";
  return [
    `# Fast-Gate Readiness Evidence: ${report.date}`, "",
    "Refs #3637 under #3625 (acceptance criterion 1). Generated by `scripts/fast-gate-readiness-report.mjs`; do not edit by hand.",
    "**Nothing is activated.** No variable, ruleset, required context, permission, status grant or budget changed.", "",
    `**Verdict:** ${report.verdict}`, "",
    `| Classification | Criteria |`, "| --- | ---: |",
    ...Object.entries(report.counts).map(([kind, count]) => `| ${LABEL[kind]} | ${count} |`), "",
    "Met means computed here from delivered code, inert fixtures or committed documents. It never means live",
    "readiness. Observation gaps need normal traffic after a separately approved activation; approval gaps need",
    "a human decision; code gaps need further code or design before cutover.", "",
    "```sh", `node scripts/fast-gate-readiness-report.mjs --check   # fails if this file differs from the generator`,
    `node scripts/fast-gate-readiness-report.mjs --write ${REPORT_PATH}`, `node scripts/fast-gate-readiness-report.mjs --json`, "```", "",
    "## Criteria", "",
    "| Criterion | Acceptance | Classification | Status | Evidence |", "| --- | --- | --- | --- | --- |",
    ...report.criteria.map((row) => `| ${cell(row.criterion)} | ${row.acceptance} | ${LABEL[row.classification]} | ${STATUS[row.status]} | ${cell(row.evidence)} |`), "",
    "## Live Settings Snapshot", "",
    `Observed **${report.live.observedAt}**. ${report.live.method}`, "",
    `- Repository variables present: ${report.live.repositoryVariableNames.map((name) => `\`${name}\``).join(", ") || "none"}.`,
    `- ${Object.entries(report.live.gateVariables).map(([name, value]) => `\`${name}\` ${value === null ? "absent" : `\`${value}\``}`).join("; ")}.`,
    `- Required status checks: \`${JSON.stringify(report.live.requiredStatusChecks)}\`.`,
    `- Merge queue: \`${JSON.stringify(report.live.mergeQueue)}\`.`,
    `- Bypass actors: \`${JSON.stringify(report.live.bypassActors)}\`.`, "",
    "## Gate Decisions on Proposed Configurations", "",
    "Each row is exactly `node scripts/ci-merge-group-gate.mjs evaluate` over the named configuration.", "",
    "| Configuration | Gate Value | Mode | Reasons | Enforcement |", "| --- | --- | --- | --- | --- |",
    ...report.gate.map((row) => `| ${row.label} | ${row.gate === null ? "absent" : `\`${row.gate}\``} | ${row.mode} | ${row.reasons.join(", ") || "—"} | ${row.enforcement.active ? "active" : row.enforcement.reason} |`), "",
    "## Cutover Rehearsal (AC2)", "",
    `Slice B's inert rehearsal: ${report.rehearsals.cutover.summary.passed}/${report.rehearsals.cutover.summary.flows} flows, ${report.rehearsals.cutover.summary.steps} steps. Virtual times are`,
    "consequences of fixture assumptions, not measurements.", "",
    "| Flow | Pass | Steps | Virtual Times |", "| --- | --- | ---: | --- |",
    ...report.rehearsals.cutover.flows.map((flow) => `| ${flow.id} | ${flow.pass ? "Yes" : "No"} | ${flow.steps} | ${cell(timesFor(flow))} |`), "",
    "## Rollback Rehearsal (AC5)", "",
    `${report.rehearsals.rollback.summary.passed}/${report.rehearsals.rollback.summary.scenarios} trigger scenarios, ${report.rehearsals.rollback.summary.steps} steps. Each runs: fast gate active → trigger →`,
    `\`${GATE_VARIABLE}=${ROLLBACK_VALUE}\` → hold removal refused without proof → restoration verified → planRollback.`, "",
    "| Trigger | Pass | Steps |", "| --- | --- | ---: |",
    ...report.rehearsals.rollback.scenarios.map((row) => `| ${row.trigger} | ${row.pass ? "Yes" : "No"} | ${row.steps} |`), "",
    `Live adapter at the rollback value: \`${JSON.stringify(report.rehearsals.rollback.checks.liveAdapterAtRollbackValue)}\`.`,
    `Unapproved thresholds: \`${report.rehearsals.rollback.checks.unapprovedThresholdsRollBack.join(", ")}\`.`,
    `A sparse sample stays incomplete: \`${report.rehearsals.rollback.checks.sparseSampleIsIncomplete.incomplete.join(", ")}\`.`, "",
    "## Capacity Findings", "",
    `- Health report calls by unvalidated backlog: ${report.capacity.healthReportCallsByBacklog.map((row) => `${row.backlog}→${row.calls}`).join(", ")} (fixture cost).`,
    `- At the five-commit limit the writer's shared budget used **${report.capacity.backlogLimitWriterCallsUsed}** calls, leaving **${report.capacity.backlogLimitWritesAvailable}** status writes,`,
    `  fewer than the **${report.capacity.fanoutTargetsFitted}**-target fan-out. A full queue at the backlog limit would refuse with zero writes.`,
    `- #3711's batched measured cost fits 45 holds in **${report.capacity.batched45Calls}/${report.capacity.callCap}** calls: zero headroom; 46 targets write ${report.capacity.batched46Writes}.`,
    `- Rehearsal ready-PR holds: ${report.capacity.rehearsalHolds.baseMovedOnly} \`base-moved\` only, ${report.capacity.rehearsalHolds.healthOrPolicy} with a health or policy reason.`,
    "  Live measurement must count these classes separately (`holdKind` in the generator).", "",
    "## Full-Gate Baseline Context", "",
    `From \`${report.baseline.source}\`, windows ${report.baseline.windows.map((w) => `[${w.since}, ${w.until})`).join(", ")}, collected ${report.baseline.collectedAt}.`,
    `${report.baseline.note}`, "",
    `- Merge-group first attempts: ${report.baseline.mergeGroupFirstAttempts} (${Object.entries(report.baseline.states).filter(([, n]) => n).map(([state, n]) => `${state} ${n}`).join(", ")}).`,
    `- Passing required result p50/p90/max: ${report.baseline.passingRequiredMinutes.median.toFixed(2)}/${report.baseline.passingRequiredMinutes.p90.toFixed(2)}/${report.baseline.passingRequiredMinutes.max.toFixed(2)} min.`,
    `- Queue removals: ${Object.entries(report.baseline.removals).map(([reason, n]) => `${reason} ${n}`).join(", ")}.`, "",
    "## Committed Measurements", "",
    "| Measurement | Value | Source |", "| --- | --- | --- |",
    ...report.measurements.map((row) => `| ${row.id} | ${cell(row.value)} | [${row.source.replace("docs/", "")}](${row.source.replace("docs/", "")}) |`), "",
    "## Proposed Ruleset Body", "",
    `\`PUT /repos/picoduck/wollipog/rulesets/${report.ruleset.id}\`, every live rule unchanged except one added context. The`,
    `placeholder is not an integer, so applying it unfilled keeps the gate full. See the [activation proposal](fast-gate-activation-proposal.md).`, "",
    "```json", JSON.stringify(report.ruleset.put, null, 2), "```", "",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  let values;
  try { ({ values } = parseArgs({ args: argv, options: { json: { type: "boolean" }, write: { type: "string" }, check: { type: "boolean" } } })); }
  catch { error("Usage: fast-gate-readiness-report.mjs [--json] [--write FILE] [--check]"); return 2; }
  const report = await buildReadiness();
  const output = markdown(report);
  if (values.check) {
    if (text(REPORT_PATH) !== output) { error(`${REPORT_PATH} differs from the generator; run --write ${REPORT_PATH}`); return 1; }
    return 0;
  }
  if (values.write) writeFileSync(values.write, output);
  else log(values.json ? JSON.stringify(report, null, 2) : output);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
