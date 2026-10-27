import { createHash } from "node:crypto";
import { evaluateAdmission } from "./main-merge-admission.mjs";

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const positive = n => Number.isSafeInteger(n) && n > 0;
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value));
export const repairDigest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Bind an already authorized group to the actual squash merge. This function
 * does not establish authority, approve a PR, or certify the unmerged group.
 * The caller must obtain the exact operator decision through its trusted boundary.
 */
export async function mergedRepairBinding(repository, authorization, admission, { api } = {}) {
  const hold = reason => ({ decision: "hold", reason });
  const a = authorization;
  if (!REPOSITORY.test(repository ?? "") || !a || a.repository !== repository || !ID.test(a.authorizationId ?? "") || !positive(a.pullRequest) ||
      ![a.headSha, a.baseSha, a.integrationSha].every(value => SHA.test(value ?? "")) ||
      !date(a.approvedAt) || !date(a.expiresAt) || Date.parse(a.expiresAt) <= Date.parse(a.approvedAt))
    return hold("repair-authorization-unavailable");
  if (admission?.authorizationDigest !== repairDigest(a) || admission.integrationSha !== a.integrationSha ||
      !date(admission.admittedAt) || Date.parse(admission.admittedAt) < Date.parse(a.approvedAt) ||
      Date.parse(admission.admittedAt) >= Date.parse(a.expiresAt)) return hold("repair-admission-unavailable");
  // An admission receipt is not a grant. Missing trusted authority verification
  // must be rejected before this helper is reached by an enforcing controller.
  try {
    const root = `/repos/${repository}`;
    const pull = await api(`${root}/pulls/${a.pullRequest}`);
    if (pull?.number !== a.pullRequest || pull.merged !== true || pull.head?.sha !== a.headSha ||
        pull.base?.ref !== "main" || pull.base?.repo?.full_name !== repository ||
        !SHA.test(pull.merge_commit_sha ?? "") || !date(pull.merged_at) ||
        Date.parse(pull.merged_at) < Date.parse(admission.admittedAt)) return hold("repair-merge-unavailable");
    const mergeSha = pull.merge_commit_sha;
    const [merged, group, main] = await Promise.all([
      api(`${root}/git/commits/${mergeSha}`), api(`${root}/git/commits/${a.integrationSha}`),
      api(`${root}/git/ref/heads/main`),
    ]);
    if (merged?.sha !== mergeSha || group?.sha !== a.integrationSha || !SHA.test(merged.tree?.sha ?? "") ||
        merged.tree.sha !== group.tree?.sha || !Array.isArray(merged.parents) || merged.parents.length !== 1 ||
        merged.parents[0]?.sha !== a.baseSha) return hold("repair-merge-binding-changed");
    // Ordinary work is held during reconciliation. Unexpected main movement,
    // including another repair, needs a new exact reconciliation, not extrapolation.
    if (main?.object?.sha !== mergeSha) return hold("repair-main-moved");
    const fresh = await api(`${root}/pulls/${a.pullRequest}`);
    if (fresh?.merged !== true || fresh.head?.sha !== a.headSha || fresh.merge_commit_sha !== mergeSha ||
        (await api(`${root}/git/ref/heads/main`))?.object?.sha !== mergeSha) return hold("repair-merge-changed");
    return { decision: "merged-repair-bound", repository, pullRequest: a.pullRequest, headSha: a.headSha,
      baseSha: a.baseSha, integrationSha: a.integrationSha, mergeSha, treeSha: merged.tree.sha,
      authorizationId: a.authorizationId, authorizationDigest: repairDigest(a), admittedAt: admission.admittedAt,
      mergedAt: pull.merged_at };
  } catch { return hold("repair-forge-unavailable"); }
}

/** Use the one shared main-ancestry primitive. In particular, never ask whether
 * broken current main is passing before allowing its merged repair to be tested.
 * This exported function is not called by any workflow/CLI in the disabled delivery.
 */
export async function requestMergedRepairCandidate(binding, { api, now, requestCandidate } = {}) {
  if (binding?.decision !== "merged-repair-bound" || !SHA.test(binding.mergeSha ?? ""))
    return { decision: "hold", reason: "repair-merge-unavailable" };
  try {
    requestCandidate ??= (await import("./main-rolling-validation.mjs")).requestCandidate;
    const receipt = await requestCandidate(binding.repository, binding.mergeSha, { purpose: "repair", api, now });
    return { decision: "repair-validation-requested", binding, receipt };
  } catch { return { decision: "hold", reason: "repair-candidate-unavailable" }; }
}

/** A candidate receipt always certifies NONE. Release requires a fresh independent
 * main-health report with the exact merged target and exact live full run/attempt.
 * The candidate claim identifies an allocation, which may reuse an older worker.
 */
export function repairRecovery({ binding, receipt, health, now = new Date().toISOString() } = {}) {
  const reasons = new Set();
  const target = binding?.mergeSha;
  if (binding?.decision !== "merged-repair-bound" || !SHA.test(target ?? "") || !positive(binding.pullRequest))
    reasons.add("repair-merge-unavailable");
  const integration = { repository: binding?.repository, kind: "merge_group", integrationSha: target, baseSha: target };
  const ordinary = evaluateAdmission({ integration, health, now });
  if (ordinary.decision !== "ordinary-admission-eligible") ordinary.reasons.forEach(reason => reasons.add(reason));
  const certificate = health?.fullCertification;
  if (health?.currentMainSha !== target || certificate?.testedSha !== target || certificate?.targetSha !== target ||
      certificate?.repository !== binding?.repository || certificate?.certification !== "full" ||
      certificate?.coverageVersion !== "rolling-full-v1" || certificate?.result !== "passing" || certificate?.checkoutVerified !== true ||
      certificate?.targetAncestryVerified !== true || certificate?.workflowAncestryVerified !== true ||
      !positive(certificate?.runId) || !positive(certificate?.attempt) || !HASH.test(certificate?.suiteVersion ?? "") ||
      certificate?.runId !== health?.latestPassingSnapshot?.runId || certificate?.attempt !== health?.latestPassingSnapshot?.attempt)
    reasons.add("repair-full-evidence-unavailable");
  if (receipt?.schema !== "main-validation-candidate-v1" || receipt?.purpose !== "repair" ||
      !["repair", "release"].includes(receipt?.scheduledPurpose) || receipt?.targetSha !== target ||
      receipt?.suiteVersion !== certificate?.suiteVersion || receipt?.runId !== certificate?.runId ||
      receipt?.status !== "success" || receipt?.certification !== "none" || !ID.test(receipt?.claimId ?? "") ||
      !date(receipt?.observedAt) || !date(now) || Date.parse(receipt.observedAt) > Date.parse(now))
    reasons.add("repair-receipt-unavailable");
  return { schema: "main-merge-repair-recovery-v1", evaluatedAt: now, repository: binding?.repository ?? null,
    mergeSha: SHA.test(target ?? "") ? target : null, decision: reasons.size ? "hold" : "release-eligible",
    enforcement: "none", reasons: [...reasons].sort(), healthDigest: ordinary.health.digest,
    candidateClaimId: receipt?.claimId ?? null, fullRunId: certificate?.runId ?? null,
    fullAttempt: certificate?.attempt ?? null, authorizationId: binding?.authorizationId ?? null };
}
