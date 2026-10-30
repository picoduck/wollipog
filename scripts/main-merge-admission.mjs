import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { main as healthReport, HEALTH_SCHEMA, FULL_COVERAGE } from "./main-ci-health.mjs";

export const ADMISSION_SCHEMA = "main-merge-admission-v1";
// Proposed shadow thresholds, not operator-approved activation settings.
export const POLICY = Object.freeze({ version: 1, maxObservationAgeSeconds: 120,
  maxUnvalidatedAgeSeconds: 7200, maxUnvalidatedCommits: 5 });
const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const positive = n => Number.isSafeInteger(n) && n > 0;
const nonnegative = n => Number.isSafeInteger(n) && n >= 0;
const time = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
  ? Date.parse(value) : NaN;
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Trusted event metadata only. Labels, PR bodies and author-provided inputs are irrelevant. */
export function integrationFromEvent(event, env) {
  const repository = env.GITHUB_REPOSITORY;
  if (!REPOSITORY.test(repository ?? "") || event?.repository?.full_name !== repository || !SHA.test(env.GITHUB_SHA ?? "")) return null;
  if (env.GITHUB_EVENT_NAME === "merge_group") {
    const group = event.merge_group;
    if (event.action !== "checks_requested" || group?.base_ref !== "refs/heads/main" ||
        !group.head_ref?.startsWith("refs/heads/gh-readonly-queue/main/") ||
        group.head_sha !== env.GITHUB_SHA || !SHA.test(group.base_sha ?? "")) return null;
    return { repository, kind: "merge_group", integrationSha: group.head_sha, baseSha: group.base_sha };
  }
  const pr = event?.pull_request;
  if (env.GITHUB_EVENT_NAME !== "pull_request" || !positive(pr?.number) || pr.base?.ref !== "main" ||
      pr.base?.repo?.full_name !== repository || !SHA.test(pr.base?.sha ?? "") || !SHA.test(pr.head?.sha ?? "")) return null;
  return { repository, kind: "pull_request", pullRequest: pr.number, headSha: pr.head.sha,
    integrationSha: env.GITHUB_SHA, baseSha: pr.base.sha };
}

function validIntegration(value) {
  return REPOSITORY.test(value?.repository ?? "") && SHA.test(value.integrationSha ?? "") && SHA.test(value.baseSha ?? "") &&
    (value.kind === "merge_group" || value.kind === "pull_request" && positive(value.pullRequest) && SHA.test(value.headSha ?? ""));
}

/** Pure policy over a freshly collected report. A serialized record is NOT independent proof.
 * The live adapter below must rebuild evidence with the authoritative report entry point.
 * This slice has no enforcement or repair bypass, including for an apparent repair label.
 */
export function evaluateAdmission({ integration, health, now = new Date().toISOString() } = {}) {
  const reasons = new Set();
  if (!validIntegration(integration)) reasons.add("integration-unavailable");
  const observed = time(health?.observedAt), checked = time(now);
  if (!Number.isFinite(checked) || !Number.isFinite(observed) || observed > checked ||
      checked - observed >= POLICY.maxObservationAgeSeconds * 1000) reasons.add("health-observation-expired");
  if (health?.schema !== HEALTH_SCHEMA || health.repository !== integration?.repository ||
      !SHA.test(health?.currentMainSha ?? "")) reasons.add("health-identity-unavailable");
  if (health?.currentMainSha !== integration?.baseSha) reasons.add("base-moved");
  if (!Array.isArray(health?.unresolvedFailures) || health.unresolvedFailures.length) reasons.add("unresolved-full-failure");
  if (!["passing", "pending"].includes(health?.status) || !Array.isArray(health?.reasons) || health.reasons.length)
    reasons.add("health-unavailable");
  const pass = health?.latestPassingSnapshot;
  if (pass?.repository !== integration?.repository || pass?.certification !== "full" || pass?.result !== "passing" ||
      pass?.coverageVersion !== FULL_COVERAGE || !SHA.test(pass?.testedSha ?? "") || pass?.targetSha !== pass?.testedSha ||
      !positive(pass?.runId) || !positive(pass?.attempt) || pass?.checkoutVerified !== true ||
      pass?.targetAncestryVerified !== true || pass?.workflowAncestryVerified !== true || !SHA.test(pass?.workflowRevision ?? ""))
    reasons.add("full-passing-evidence-unavailable");
  const backlog = health?.backlog;
  const age = Number.isFinite(checked) && Number.isFinite(time(backlog?.oldestUnvalidatedAt))
    ? (checked - time(backlog.oldestUnvalidatedAt)) / 1000 : NaN;
  if (backlog?.clock !== "forge-landing-time" || !nonnegative(backlog?.commits) || !nonnegative(backlog?.merges) ||
      backlog.merges > backlog.commits || !Number.isFinite(backlog?.oldestUnvalidatedAgeSeconds) || backlog.oldestUnvalidatedAgeSeconds < 0 ||
      (backlog.commits === 0 ? backlog.oldestUnvalidatedAt !== null || backlog.oldestUnvalidatedAgeSeconds !== 0 ||
        pass?.testedSha !== health?.currentMainSha || health?.status !== "passing" :
        !Number.isFinite(age) || age < 0 || pass?.testedSha === health?.currentMainSha || health?.status !== "pending"))
    reasons.add("backlog-unavailable");
  if (backlog?.commits >= POLICY.maxUnvalidatedCommits) reasons.add("unvalidated-backlog-limit");
  // Recompute at decision time: a threshold can cross while the observer reads Actions.
  if (age >= POLICY.maxUnvalidatedAgeSeconds || backlog?.oldestUnvalidatedAgeSeconds >= POLICY.maxUnvalidatedAgeSeconds)
    reasons.add("unvalidated-age-limit");
  return { schema: ADMISSION_SCHEMA, policy: POLICY, evaluatedAt: now,
    integration: validIntegration(integration) ? integration : null,
    enforcement: "none", decision: reasons.size ? "hold" : "ordinary-admission-eligible", reasons: [...reasons].sort(),
    health: { digest: health ? digest(health) : null, observedAt: Number.isFinite(observed) ? health.observedAt : null,
      currentMainSha: SHA.test(health?.currentMainSha ?? "") ? health.currentMainSha : null,
      status: ["passing", "pending", "failing", "unknown", "stale"].includes(health?.status) ? health.status : "unknown",
      passingSha: SHA.test(pass?.testedSha ?? "") ? pass.testedSha : null,
      passingRunId: positive(pass?.runId) ? pass.runId : null, passingAttempt: positive(pass?.attempt) ? pass.attempt : null,
      backlogCommits: nonnegative(backlog?.commits) ? backlog.commits : null,
      oldestUnvalidatedAgeSeconds: Number.isFinite(age) && age >= 0 ? age : backlog?.commits === 0 ? 0 : null } };
}

/** Read-only report uses exactly the health observer's quota, incident and revalidation rules.
 * No cached health verdict, issue mutation, status write, candidate dispatch or retry.
 */
export async function observeAdmission({ integration, env = process.env, api, report = healthReport,
  now = () => new Date().toISOString(), error = console.error } = {}) {
  let health = null, result = 1;
  if (validIntegration(integration)) {
    try {
      result = await report(["report"], { env: { ...env, GITHUB_REF: "refs/heads/main" }, api,
        log: line => { health = JSON.parse(line); }, error, now });
    } catch { /* The decision below remains a hold; never print response bodies. */ }
  }
  const decision = evaluateAdmission({ integration, health, now: now() });
  if (result !== 0) {
    decision.decision = "hold";
    decision.reasons = [...new Set([...decision.reasons, "health-report-unavailable"])].sort();
  }
  return { ...decision, evidenceSource: "live-health-report", healthReport: health };
}

export async function main({ env = process.env, log = console.log, error = console.error, observe = observeAdmission } = {}) {
  // There is deliberately no enabled/enforce value in this first delivery.
  if (env.MAIN_MERGE_ADMISSION !== "dry-run") return 0;
  const observationId = positive(Number(env.GITHUB_RUN_ID)) && positive(Number(env.GITHUB_RUN_ATTEMPT))
    ? `${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}` : randomUUID();
  const entryPoint = env.GITHUB_EVENT_NAME ?? "cli";
  let integration = null;
  try { integration = integrationFromEvent(JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")), env); } catch { /* hold */ }
  let record;
  try { record = await observe({ integration, env, error }); }
  catch { record = { ...evaluateAdmission({ integration }), evidenceSource: "unavailable", healthReport: null }; }
  record = { ...record, observationId, entryPoint, mode: "dry-run" };
  if (env.MAIN_MERGE_ADMISSION_OUTPUT) writeFileSync(env.MAIN_MERGE_ADMISSION_OUTPUT, JSON.stringify(record, null, 2) + "\n");
  const { healthReport: _report, ...summary } = record;
  log(JSON.stringify({ event: "main_merge_admission_observed", ...summary }));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY,
    `Regression admission dry run: **${record.decision}**. Enforcement: **none**.\n\n` +
    `Reasons: ${record.reasons.length ? record.reasons.join(", ") : "within proposed shadow thresholds"}.\n`);
  // An advisory job succeeds after reporting a HOLD; its exit status is not an admission pass.
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then(code => { process.exitCode = code; });
