import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { identity, parseTiming, TIMING_MARKER } from "./ci-timing.mjs";
import { combineReports } from "./merge-queue-wait-report.mjs";

const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const id = (value) => Number.isSafeInteger(value) && value > 0;
const time = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const causes = ["unresolved", "product-nondeterminism", "environment-sensitivity", "infrastructure-interruption"];
const owners = ["test-maintainer", "product-maintainer", "ci-maintainer"];
const fail = () => { throw new Error("Invalid or unsupported reliability input"); };

function rejectExclusions(input) {
  if (!Array.isArray(input?.records) || input.records.length > 10_000 ||
      input.exclusions !== undefined || input.quarantine !== undefined ||
      input.records.some((row) => !row || row.exclusions !== undefined || row.quarantine !== undefined)) fail();
}

// File-scoped candidates, never an asserted error match or a verified root cause.
export const knownIssueCandidates = [
  { suite: "browser", fileId: identity("apps/web/e2e/command-inbox-projects.spec.ts"), issue: 3517 },
  { suite: "node", fileId: identity("apps/control-plane/src/runner-channel.integration.test.ts"), issue: 2601 },
];

/** Reviewed assertions carry only public numeric evidence references and fixed role labels. */
export function triageDecisions(policy = { version: 1, decisions: [] }) {
  if (policy?.version !== 1 || !Array.isArray(policy.decisions) || policy.decisions.length > 200 ||
      Object.keys(policy).some((key) => !["version", "decisions"].includes(key))) fail();
  const decisions = new Map();
  for (const row of policy.decisions) {
    if (!row || !["node", "browser"].includes(row.suite) || !sha(row.suiteRevision) ||
        !hash(row.fileId) || !hash(row.testId) || !causes.includes(row.cause) ||
        !owners.includes(row.owner) || !id(row.issue) || !id(row.reviewPullRequest) ||
        !Array.isArray(row.evidence) || row.evidence.length < 1 || row.evidence.length > 10 ||
        !row.evidence.every((item) => id(item?.runId) && id(item.attempt) && id(item.jobId)) ||
        Object.keys(row).some((key) => !["suite", "suiteRevision", "fileId", "testId", "cause", "owner", "issue", "reviewPullRequest", "evidence"].includes(key))) fail();
    const key = JSON.stringify([row.suite, row.suiteRevision, row.fileId, row.testId]);
    if (decisions.has(key)) fail();
    decisions.set(key, { cause: row.cause, owner: row.owner, issue: row.issue, reviewPullRequest: row.reviewPullRequest,
      evidence: row.evidence.map(({ runId, attempt, jobId }) => ({ runId, attempt, jobId })) });
  }
  return decisions;
}

/** Advisory projection of existing version-2 attempts. It grants no certification or retry authority. */
export function reliabilityReport(input, policy) {
  rejectExclusions(input);
  if (input?.schemaVersion !== 2 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository ?? "") ||
      !Array.isArray(input.records) || input.records.length > 10_000 ||
      !Array.isArray(input.windows) || input.windows.length > 100 ||
      !input.windows.every((w) => time(w?.since) && time(w.until) && Date.parse(w.since) < Date.parse(w.until)) ||
      input.exclusions !== undefined || input.quarantine !== undefined) fail();
  const decisions = triageDecisions(policy), groups = new Map(), seen = new Set();
  const gaps = [], runOutcomes = [], rerunRecoveries = [];
  const records = input.records;
  for (const record of records) {
    if (!record || record.repository !== input.repository || !id(record.runId) || !id(record.attempt) ||
        !["pull_request", "push", "merge_group"].includes(record.event) || !time(record.createdAt) ||
        !["passing", "failing", "cancelled", "skipped", "unfinished", "unmeasured"].includes(record.state) ||
        (record.jobs !== undefined && (!Array.isArray(record.jobs) || record.jobs.length > 1000)) ||
        record.exclusions !== undefined || record.quarantine !== undefined) fail();
    const recordKey = `${record.runId}/${record.attempt}`;
    if (seen.has(recordKey)) fail();
    seen.add(recordKey);
    const run = { runId: record.runId, attempt: record.attempt, event: record.event,
      attemptClass: record.attempt === 1 ? "first" : "rerun", state: record.state,
      sha: sha(record.sha) ? record.sha : null };
    if (record.state !== "passing") runOutcomes.push(run);
    if (record.attempt > 1 && record.state === "passing" && sha(record.sha) && records.some((first) =>
      first.runId === record.runId && first.attempt === 1 && first.sha === record.sha && first.state === "failing"))
      rerunRecoveries.push({ ...run, classification: "retry-only", cause: "unresolved", originalAttempt: 1 });
    if (record.jobsTruncated || !record.jobs?.length) gaps.push({ ...run, reason: "missing-or-truncated-jobs" });
    for (const job of record.jobs ?? []) {
      if (!id(job?.id)) fail();
      const source = { ...run, jobId: job.id };
      // Non-test jobs also lack timing; this conservatively describes selected coverage, not a denominator.
      if (!Array.isArray(job.testTiming?.summaries) || job.testTiming.summaries.length === 0) {
        gaps.push({ ...source, reason: "no-test-projection" });
        continue;
      }
      if (job.testTiming.summaries.length > 10) fail();
      if (job.testTiming.truncated) gaps.push({ ...source, reason: "truncated-log" });
      for (const raw of job.testTiming.summaries) {
        const summary = parseTiming(TIMING_MARKER + JSON.stringify(raw));
        if (!summary || summary.context.runId !== String(record.runId) || summary.context.attempt !== record.attempt ||
            !sha(summary.context.testedSha)) {
          gaps.push({ ...source, reason: "invalid-or-unmatched-test-projection" });
          continue;
        }
        const suiteRevision = summary.context.testedSha;
        if (!summary.reliability || summary.reliability.truncated || summary.truncated)
          gaps.push({ ...source, suite: summary.suite, reason: summary.reliability ? "truncated-test-projection" : "legacy-top-20-only" });
        for (const row of summary.reliability?.tests ?? summary.slowestTests) {
          if (row.state === "passing" && row.retry === 0 || row.state === "skipped") continue;
          const key = JSON.stringify([summary.suite, suiteRevision, row.fileId, row.testId]);
          const group = groups.get(key) ?? { suite: summary.suite, suiteRevision, fileId: row.fileId, testId: row.testId,
            observations: new Map(), times: [] };
          const observationKey = `${recordKey}/${job.id}/${row.retry}/${row.state}`;
          group.observations.set(observationKey, { ...source, retry: row.retry, state: row.state,
            classification: row.state === "passing" && row.retry > 0 ? "retry-only" : row.state,
            testedSha: suiteRevision, workflowSha: summary.context.workflowSha });
          group.times.push(new Date(record.createdAt).toISOString());
          groups.set(key, group);
        }
      }
    }
  }
  const signatures = [...groups].map(([key, group]) => {
    const triage = decisions.get(key) ?? { cause: "unresolved", owner: "test-maintainer", issue: null,
      reviewPullRequest: null, evidence: [] };
    const observations = [...group.observations.values()];
    const affectedRuns = new Set(observations.map((row) => row.runId)).size;
    return { suite: group.suite, suiteRevision: group.suiteRevision, fileId: group.fileId, testId: group.testId,
      affectedRuns, recurring: affectedRuns >= 2, firstSeen: group.times.sort()[0], lastSeen: group.times.at(-1),
      triage, nextAction: triage.cause === "unresolved" ? "preserve-evidence-and-reproduce" : "repair-and-verify-original-contract",
      candidateIssues: knownIssueCandidates.filter((item) => item.suite === group.suite && item.fileId === group.fileId)
        .map(({ issue }) => ({ issue, match: "file-only-confirm-test-and-symptom" })), observations };
  });
  // Investigation leads only: matching hashed names do not prove unchanged test dependencies.
  const crossRevision = new Map();
  for (const signature of signatures) {
    const key = JSON.stringify([signature.suite, signature.fileId, signature.testId]);
    const rows = crossRevision.get(key) ?? [];
    rows.push(signature);
    crossRevision.set(key, rows);
  }
  const crossRevisionCandidates = [...crossRevision.values()].filter((rows) => rows.length > 1).map((rows) => ({
    suite: rows[0].suite, fileId: rows[0].fileId, testId: rows[0].testId,
    suiteRevisions: rows.map((row) => row.suiteRevision),
    affectedRuns: new Set(rows.flatMap((row) => row.observations.map((observation) => observation.runId))).size,
    firstSeen: rows.map((row) => row.firstSeen).sort()[0], lastSeen: rows.map((row) => row.lastSeen).sort().at(-1),
    compatibility: "unverified", nextAction: "confirm-source-compatibility-and-triage",
  })).filter((row) => row.affectedRuns >= 2);
  return { schemaVersion: 1, repository: input.repository,
    windows: input.windows.map(({ since, until }) => ({ since: new Date(since).toISOString(), until: new Date(until).toISOString() })),
    basis: "observed-identities-only-no-failure-text", certification: "advisory-never-authorizes-merge",
    exclusions: [], sourceIncomplete: Boolean(input.attemptsTruncated || input.pagination?.some((p) => p.truncated)),
    observedAttempts: { first: records.filter((row) => row.attempt === 1).length,
      rerun: records.filter((row) => row.attempt > 1).length },
    signatures, crossRevisionCandidates, runOutcomes, rerunRecoveries, coverageGaps: gaps,
    trend: "lower-bound-no-rate-or-cause-inference" };
}

async function readJson(path) {
  if ((await stat(path)).size > 32 * 1024 * 1024) fail();
  return JSON.parse(await readFile(path, "utf8"));
}

export async function main(argv, { out = console.log, err = console.error } = {}) {
  try {
    const { values } = parseArgs({ args: argv, options: {
      input: { type: "string", multiple: true }, triage: { type: "string" },
    } });
    if (!values.input?.length || values.input.length > 10) fail();
    const reports = await Promise.all(values.input.map(readJson));
    // Refuse exclusions even in older snapshots that combination would otherwise replace.
    for (const report of reports) rejectExclusions(report);
    // Reuse #3626's raw-attempt deduplication and explicit source windows.
    const input = reports.length === 1 ? reports[0] : combineReports(reports);
    out(JSON.stringify(reliabilityReport(input, values.triage ? await readJson(values.triage) : undefined), null, 2));
    return 0;
  } catch {
    err("Reliability report failed: invalid, unreadable, oversized, or unsupported input; no certification produced.");
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2));
