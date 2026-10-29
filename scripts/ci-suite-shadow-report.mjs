import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { hash, parseSelection, SELECTION_MARKER } from "./ci-suite-selection.mjs";
import { parseTiming, TIMING_MARKER } from "./ci-timing.mjs";
import { combineReports } from "./merge-queue-wait-report.mjs";
import { reliabilityReport } from "./ci-reliability-report.mjs";

const REQUIRED_WORK = ["Typecheck, Unit Tests & Bundles", ...[1, 2, 3, 4, 5].map((n) => `Browser End-to-End Tests (${n})`),
  "Settings-Rows win32 Baselines / Detect Settings-Rows Changes",
  "Settings-Rows win32 Baselines / Compare win32 Settings-Rows Baselines", "WebKit End-to-End Tests"];
const mandatorySteps = ["Typecheck", "Validate Web Production Build", "Validate Runner Bundle", "Validate Control-Plane Bundle", "Rendered Production Browser Smoke"];
const utcWorkingDate = (time) => {
  const date = new Date(time);
  return [0, 6].includes(date.getUTCDay()) ? null : date.toISOString().slice(0, 10);
};

/**
 * Documented cohort-key cutover (#3786). Samples created before it keep their original
 * `suiteId/policyId` cohorts; samples from it onward join policy-identity cohorts. The
 * time is prospective: it must follow the merge of the first commit that uses it.
 */
export const COHORT_KEY_CUTOVER = "2026-11-02T00:00:00.000Z";
const LEGACY_KEYING = "suiteId/policyId", POLICY_KEYING = "suiteVersion/policyVersion/policyId";
export function cohortKey(row) {
  return Date.parse(row.createdAt) < Date.parse(COHORT_KEY_CUTOVER)
    ? { cohortKeying: LEGACY_KEYING, cohortKey: `${row.suiteId}/${row.policyId}` }
    : { cohortKeying: POLICY_KEYING, cohortKey: `${row.suiteVersion}/${row.policyVersion}/${row.policyId}` };
}

/** Contract drift inside one policy cohort, for compatibility review; never a cohort split. */
function compatibility(rows) {
  const ordered = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || Number(a.runId) - Number(b.runId));
  const transitions = (field) => ordered.slice(1).filter((row, index) => row[field] !== ordered[index][field]).length;
  const fileIdentityChangedSamples = ordered.slice(1).flatMap((row, index) => {
    const previous = ordered[index];
    return row.fileIdentitySetId === previous.fileIdentitySetId ? [] : [{
      runId: row.runId, attempt: row.attempt, createdAt: row.createdAt, suiteId: row.suiteId, inventoryId: row.inventoryId,
      inventoryCount: row.inventoryCount, previousRunId: previous.runId, previousAttempt: previous.attempt,
      previousSuiteId: previous.suiteId, previousInventoryId: previous.inventoryId, previousInventoryCount: previous.inventoryCount }];
  });
  return { distinctSuiteIds: new Set(rows.map((row) => row.suiteId)).size, distinctInventoryIds: new Set(rows.map((row) => row.inventoryId)).size,
    suiteIdTransitions: transitions("suiteId"), inventoryIdTransitions: transitions("inventoryId"),
    fileIdentityChanges: fileIdentityChangedSamples.length, fileIdentityChangedSamples,
    review: "contract-drift-visible-requires-compatibility-review" };
}

/** Groups comparisons by cohort key; samples from either side of the cutover never share a cohort. */
export function shadowCohorts(comparisons) {
  const groups = new Map();
  for (const row of comparisons) {
    const { cohortKeying, cohortKey: key } = cohortKey(row), id = `${cohortKeying}\n${key}`;
    groups.set(id, [...(groups.get(id) ?? []), row]);
  }
  return [...groups.values()].map((rows) => {
    const { cohortKeying, cohortKey: key } = cohortKey(rows[0]), legacy = cohortKeying === LEGACY_KEYING;
    const identified = [], changes = new Set(), heads = new Set();
    for (const row of rows.filter((row) => row.eligible).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (!row.changeKey || changes.has(row.changeKey) || heads.has(row.changeHeadSha)) continue;
      identified.push(row); changes.add(row.changeKey); heads.add(row.changeHeadSha);
    }
    const days = new Set(identified.map((row) => row.workingDate).filter(Boolean));
    return { ...(legacy ? { suiteId: rows[0].suiteId, policyId: rows[0].policyId }
      : { suiteVersion: rows[0].suiteVersion, policyVersion: rows[0].policyVersion, policyId: rows[0].policyId }),
      cohortKeying, cohortKey: key, projectedSamples: rows.filter((row) => row.eligible).length,
      partialFailureObservations: rows.filter((row) => !row.eligible).length,
      distinctIdentifiedChanges: changes.size, distinctWorkingDatesUTC: days.size,
      missedFailureCandidates: rows.filter((row) => row.missedFailureCandidate).length,
      fastMissedFailureCandidates: rows.filter((row) => row.fastMissedFailureCandidate).length,
      sampleThresholdMet: changes.size >= 30 && days.size >= 5,
      readiness: "not-certified-requires-miss-investigation-and-reviewed-comparison",
      ...(legacy ? {} : { compatibility: compatibility(rows) }) };
  });
}

/** Offline inference from the existing full run. Never represents a second suite execution. */
export function shadowReport(input) {
  reliabilityReport(input); // Reuse attempt/summary validation and exclusion rejection.
  const comparisons = [], gaps = [], exclusions = [];
  for (const record of input.records) {
    const source = { runId: record.runId, attempt: record.attempt, event: record.event,
      testedSha: typeof record.testedSha === "string" && /^[a-f0-9]{40}$/.test(record.testedSha) ? record.testedSha : null,
      createdAt: new Date(record.createdAt).toISOString() };
    if (!["pull_request", "merge_group"].includes(record.event)) continue;
    const shadowJobs = (record.jobs ?? []).filter((job) => job.name === "Suite Selection Shadow (Advisory)");
    const rawPlans = shadowJobs.flatMap((job) => job.testTiming?.selections ?? []);
    const plan = rawPlans.length === 1 ? parseSelection(SELECTION_MARKER + JSON.stringify(rawPlans[0])) : null;
    if (!plan || shadowJobs.length !== 1 || shadowJobs[0].state !== "passing" || shadowJobs[0].testTiming?.truncated || shadowJobs[0].testTiming?.selectionTruncated ||
        record.jobsTruncated || plan.context.runId !== String(record.runId) || plan.context.attempt !== record.attempt ||
        plan.context.event !== record.event || plan.context.baseSha !== plan.context.trustedPolicySha ||
        (record.event === "merge_group" && (plan.context.diffKind !== "combined-merge-group" || plan.context.diffBaseSha !== plan.context.baseSha ||
          plan.context.testedSha !== record.sha || plan.context.changeHeadSha !== record.sha)) ||
        (record.event === "pull_request" && (plan.context.diffKind !== "pr-merge-base" || plan.context.changeHeadSha !== record.sha))) {
      gaps.push({ ...source, reason: "missing-incomplete-or-unmatched-trusted-selection" }); continue;
    }
    source.testedSha = plan.context.testedSha;
    if (record.attempt !== 1) { exclusions.push({ ...source, reason: "rerun-not-an-independent-change", cause: "unresolved" }); continue; }
    const jobs = REQUIRED_WORK.map((name) => record.jobs.filter((job) => job.name === name));
    if (jobs.some((matches) => matches.length !== 1)) { gaps.push({ ...source, reason: "missing-or-duplicate-full-job" }); continue; }
    const work = jobs.flat(), summaries = [];
    let incomplete = false, retryOnly = false, interruption = false, selectedFailed = false, fastFailed = false, outsideFailed = false;
    const failures = [], nonTestFailures = [], mandatoryFailures = [];
    for (const job of work) {
      const windows = job.name.startsWith("Settings-Rows win32 Baselines /");
      const intentionalWindowsSkip = job.name.endsWith("/ Compare win32 Settings-Rows Baselines") && job.state === "skipped" &&
        work.some((row) => row.name.endsWith("/ Detect Settings-Rows Changes") && row.state === "passing");
      if (!["passing", "failing"].includes(job.state) && !intentionalWindowsSkip) interruption = true;
      const projected = job.testTiming?.summaries ?? [];
      // The Node job, each Chromium shard and WebKit must have final projections. Production
      // emits a second browser summary on shard 1. Windows has a separate conditional workflow.
      const expected = job.name === "Browser End-to-End Tests (1)" ? 2 : 1;
      if ((!windows && projected.length !== expected) || job.testTiming?.truncated) incomplete = true;
      for (const [projectionIndex, raw] of projected.entries()) {
        const summary = parseTiming(TIMING_MARKER + JSON.stringify(raw));
        if (!summary || summary.context.runId !== String(record.runId) || summary.context.attempt !== record.attempt ||
            summary.context.testedSha !== plan.context.testedSha || summary.truncated || !summary.reliability || summary.reliability.truncated ||
            summary.suite !== (job.name === "Typecheck, Unit Tests & Bundles" ? "node" : "browser")) {
          incomplete = true; continue;
        }
        summaries.push(summary);
        if (summary.cancelled || summary.unmeasured || summary.count <= summary.skipped) incomplete = true;
        if (summary.retryOnly || summary.reliability.tests.some((row) => row.retry > 0)) retryOnly = true;
        const failed = summary.reliability.tests.filter((row) => row.state === "failing");
        if (failed.length !== summary.failed) incomplete = true;
        for (const test of failed) {
          const selected = plan.selectedFileIds.includes(test.fileId);
          // Production and WebKit are always selected, including inbox-lazy outside development.
          const alwaysBrowser = job.name === "WebKit End-to-End Tests" || (job.name === "Browser End-to-End Tests (1)" && projectionIndex === 1) ||
            (windows && plan.groups.includes("windows-baselines"));
          if (!alwaysBrowser && ![...plan.selectedFileIds, ...plan.deferredFileIds].includes(test.fileId)) incomplete = true;
          if (alwaysBrowser || selected) selectedFailed = true;
          else outsideFailed = true;
          const fast = (alwaysBrowser && !windows) || plan.fastFileIds.includes(test.fileId);
          if (fast) fastFailed = true;
          failures.push({ jobId: job.id, suite: summary.suite, fileId: test.fileId, testId: test.testId, selected: alwaysBrowser || selected, fast });
        }
      }
      for (const step of job.steps ?? []) if (step.state === "failing") {
        if (mandatorySteps.includes(step.name)) {
          selectedFailed = true; fastFailed = true;
          mandatoryFailures.push({ jobId: job.id, step: Number.isSafeInteger(step.number) && step.number > 0 ? step.number : null });
        }
        else if (!/^(Unit Tests|Remote-Instance Browser End-to-End Tests|WebKit Browser End-to-End Tests)$/.test(step.name))
          nonTestFailures.push({ jobId: job.id, step: Number.isSafeInteger(step.number) && step.number > 0 ? step.number : null });
      }
    }
    if (retryOnly) { exclusions.push({ ...source, reason: "retry-only-test-signal", cause: "unresolved", failures }); continue; }
    if (interruption || nonTestFailures.length) {
      exclusions.push({ ...source, reason: "interruption-or-unresolved-non-test-failure", cause: "unresolved", steps: nonTestFailures }); continue;
    }
    if (!["passing", "failing"].includes(record.state) ||
        (record.state === "passing" && (selectedFailed || outsideFailed || work.some((job) => job.state === "failing"))) ||
        (record.state === "failing" && !selectedFailed && !outsideFailed)) {
      gaps.push({ ...source, reason: "incomplete-full-outcome-or-failure-projection" }); continue;
    }
    if (incomplete) {
      gaps.push({ ...source, reason: "incomplete-full-outcome-or-failure-projection" });
      // A failure can skip mandatory downstream work. Preserve the observed failure/miss
      // candidate, without manufacturing a subset pass or counting an eligible sample.
      if (record.state !== "failing" || (!failures.length && !mandatoryFailures.length)) continue;
    }
    const identity = { suiteId: plan.suiteId, policyId: plan.policyId, suiteVersion: plan.suiteVersion, policyVersion: plan.policyVersion };
    comparisons.push({ ...source, ...identity, ...cohortKey({ ...source, ...identity }), inventoryId: plan.inventoryId,
      fileIdentitySetId: hash(JSON.stringify([...plan.selectedFileIds, ...plan.deferredFileIds].sort())), mode: plan.mode, fallbackReasons: plan.reasons,
      selectedCount: plan.selectedCount, fastCount: plan.fastCount, inventoryCount: plan.inventoryCount,
      fullOutcome: record.state, eligible: !incomplete,
      projectedFastOutcome: fastFailed ? "failing" : incomplete ? "unmeasured" : "passing",
      projectedSelectedOutcome: selectedFailed ? "failing" : incomplete ? "unmeasured" : "passing",
      fastMissedFailureCandidate: record.state === "failing" && !fastFailed && failures.length > 0,
      missedFailureCandidate: record.state === "failing" && !selectedFailed && outsideFailed,
      failures, mandatoryFailures, observedSkippedTests: summaries.reduce((sum, summary) => sum + summary.skipped, 0),
      selectedRuntimeMs: null, fullRequiredMinutes: Number.isFinite(record.metrics?.requiredMinutes) && record.metrics.requiredMinutes >= 0 ? record.metrics.requiredMinutes : null,
      comparisonKind: incomplete ? "partial-failure-projection" : "subset-projection-not-independent-execution", workingDate: utcWorkingDate(record.createdAt),
      changeHeadSha: plan.context.changeHeadSha,
      changeKey: Number.isSafeInteger(record.pullRequest) && record.pullRequest > 0 ? `pr-${record.pullRequest}` : null });
  }
  return { version: 2, repository: input.repository,
    windows: input.windows.map(({ since, until }) => ({ since: new Date(since).toISOString(), until: new Date(until).toISOString() })),
    cohortKeyCutover: { at: COHORT_KEY_CUTOVER, before: LEGACY_KEYING, from: POLICY_KEYING },
    comparisons, cohorts: shadowCohorts(comparisons), gaps, exclusions,
    naturalProjectedSamples: comparisons.filter((row) => row.eligible).length,
    partialFailureObservations: comparisons.filter((row) => !row.eligible).length, selectedRuntimeMs: null, certification: "none",
    remainingCriterion: "At least 30 eligible identified changes across five working days, individual triage of exclusions and every miss, and reviewed comparison before readiness." };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { input: { type: "string", multiple: true } } });
    if (!values.input?.length || values.input.length > 10) throw new Error("Input required");
    const inputs = [];
    for (const path of values.input) {
      if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error("Oversized input");
      inputs.push(JSON.parse(await readFile(path, "utf8")));
    }
    // Validate every raw source before deduplication, including superseded snapshots.
    inputs.forEach((input) => reliabilityReport(input));
    console.log(JSON.stringify(shadowReport(combineReports(inputs)), null, 2));
  } catch { console.error("Invalid or unsupported suite-shadow input"); process.exitCode = 1; }
}
