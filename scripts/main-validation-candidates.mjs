/** Scheduling receipts are hints, never full-regression certificates. */
export const CANDIDATE_POLICY = Object.freeze({
  maxRequests: 16,
  minimumIntervalMs: 60 * 60_000,
  release: Object.freeze({ minimumIntervalMs: 60 * 60_000, priority: 1 }),
  repair: Object.freeze({ minimumIntervalMs: 60 * 60_000, priority: 1 }),
});
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const date = (s) => typeof s === "string" && Number.isFinite(Date.parse(s));
const purpose = (p) => p === "release" || p === "repair";
const statuses = ["queued", "dispatched", "success", "failure", "reconciliation-required", "incompatible-suite"];
export const cleanCandidates = (ledger) => ({ version: 1, lastAdmissionAt: ledger.lastAdmissionAt,
  requests: ledger.requests.map((r) => Object.fromEntries(["targetSha", "suiteVersion", "purpose", "requestedAt", "claimId",
    "dispatchedAt", "runId", "status", "statusObservedAt", "waitMinutes", "executionMinutes"].filter((key) => r[key] !== undefined).map((key) => [key, r[key]]))) });

export function validCandidates(ledger) {
  return ledger?.version === 1 && (ledger.lastAdmissionAt === null || date(ledger.lastAdmissionAt)) &&
    Array.isArray(ledger.requests) && ledger.requests.length <= CANDIDATE_POLICY.maxRequests &&
    new Set(ledger.requests.map((r) => `${r.targetSha}:${r.suiteVersion}`)).size === ledger.requests.length &&
    ledger.requests.every((r) => SHA.test(r.targetSha) && HASH.test(r.suiteVersion) && purpose(r.purpose) &&
      date(r.requestedAt) && UUID.test(r.claimId) && statuses.includes(r.status) &&
      (r.dispatchedAt === null || date(r.dispatchedAt)) &&
      (r.runId === null || Number.isSafeInteger(r.runId) && r.runId > 0));
}

export function queueCandidate(ledger, request) {
  ledger ??= { version: 1, lastAdmissionAt: null, requests: [] };
  if (!validCandidates(ledger) || !purpose(request.purpose)) throw new Error("Invalid candidate scheduler request");
  // Cross-purpose requests share one exact target/suite allocation.
  if (ledger.requests.some((r) => r.targetSha === request.targetSha && r.suiteVersion === request.suiteVersion)) return ledger;
  if (ledger.requests.length >= CANDIDATE_POLICY.maxRequests) throw new Error("Candidate retention limit requires operator reconciliation");
  const next = cleanCandidates({ ...ledger, requests: [...ledger.requests, { ...request, dispatchedAt: null, runId: null, status: "queued" }] });
  if (!validCandidates(next)) throw new Error("Invalid candidate scheduler request");
  return next;
}

/** Main backlog always wins. A dispatched allocation is never automatically retried. */
export function candidatePlan(ledger, observation, suiteVersion, now, mainComplete) {
  const next = structuredClone(ledger);
  for (const request of next.requests) {
    const records = observation.records.filter((r) => r.targetSha === request.targetSha && r.verdict !== "superseded")
      .sort((a, b) => b.runId - a.runId || b.attempt - a.attempt);
    const live = observation.active.find((r) => r.display_title?.startsWith(`Rolling ${request.targetSha} `));
    const record = records[0];
    if (live) {
      request.runId = live.id; request.status = "dispatched"; request.statusObservedAt = now;
    } else if (record) {
      request.runId = record.runId;
      request.status = record.suiteVersion !== request.suiteVersion ? request.dispatchedAt ? "incompatible-suite"
        : records.some((r) => r.suiteVersion === request.suiteVersion) ? "reconciliation-required" : "queued"
        : ["success", "failure"].includes(record.verdict) ? record.verdict : "reconciliation-required";
      request.waitMinutes = record.metrics?.criticalWaitMinutes ?? null;
      request.executionMinutes = record.metrics?.criticalExecutionMinutes ?? null;
      request.statusObservedAt = now;
    } else if (request.suiteVersion !== suiteVersion) request.status = "incompatible-suite";
    else if (request.dispatchedAt && ["queued", "dispatched"].includes(request.status)) request.status = "reconciliation-required";
    if (request.status === "queued" && request.suiteVersion !== suiteVersion) request.status = "incompatible-suite";
  }
  const elapsed = (at, interval) => at === null || Date.parse(now) - Date.parse(at) >= interval;
  // Forge-derived cooldown survives a lost coordination ledger. Conservatively charge ordinary
  // main workers too: candidate work only uses otherwise idle full-validation capacity.
  const available = mainComplete && observation.active.length === 0 &&
    elapsed(observation.latestWorkerActivityAt ?? null, CANDIDATE_POLICY.minimumIntervalMs) &&
    elapsed(next.lastAdmissionAt, CANDIDATE_POLICY.minimumIntervalMs);
  const request = available ? next.requests.filter((r) => r.status === "queued" && !r.dispatchedAt &&
    elapsed(next.requests.filter((other) => other.purpose === r.purpose && other.dispatchedAt)
      .map((other) => other.dispatchedAt).sort().at(-1) ?? null, CANDIDATE_POLICY[r.purpose].minimumIntervalMs))
    .sort((a, b) => CANDIDATE_POLICY[a.purpose].priority - CANDIDATE_POLICY[b.purpose].priority ||
      Date.parse(a.requestedAt) - Date.parse(b.requestedAt))[0] : null;
  return { next, request: request ?? null };
}

export function candidateReceipt(ledger, targetSha, requestedPurpose, suiteVersion, observedAt) {
  if (!validCandidates(ledger) || !purpose(requestedPurpose)) throw new Error("Invalid candidate receipt request");
  const request = ledger.requests.find((r) => r.targetSha === targetSha && r.suiteVersion === suiteVersion);
  if (!request) throw new Error("Candidate request not retained");
  return { schema: "main-validation-candidate-v1", purpose: requestedPurpose, scheduledPurpose: request.purpose,
    targetSha, suiteVersion, claimId: request.claimId, requestedAt: request.requestedAt, observedAt,
    dispatchedAt: request.dispatchedAt, runId: request.runId, status: request.status,
    statusObservedAt: request.statusObservedAt ?? request.requestedAt,
    queueWaitMinutes: (Date.parse(request.dispatchedAt ?? observedAt) - Date.parse(request.requestedAt)) / 60_000,
    waitMinutes: request.waitMinutes ?? null, executionMinutes: request.executionMinutes ?? null,
    certification: "none" };
}
