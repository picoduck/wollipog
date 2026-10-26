import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { evaluateAdmission, POLICY } from "./main-merge-admission.mjs";
import { repairRecovery, repairDigest } from "./main-merge-repair.mjs";
import { budgetApi, githubApi, main as healthReport } from "./main-ci-health.mjs";

export const ADMISSION_CONTEXT = "Regression Admission";
export const CONTROLLER = Object.freeze({ maxEntries: 100, maxCycleAgeMs: 60_000, reevaluateMs: 60_000 });
const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const positive = n => Number.isSafeInteger(n) && n > 0;
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validEntry = e => REPOSITORY.test(e?.repository ?? "") && positive(e.pullRequest) &&
  [e.headSha, e.baseSha, e.integrationSha].every(value => SHA.test(value ?? "")) && ["pull_request", "merge_group"].includes(e.kind);
const target = e => e.kind === "pull_request" ? e.headSha : e.integrationSha;

/** Only authoritative failure identities, never labels, issue prose or wall-clock arrival order. */
export function failureFingerprint(health) {
  return hash({ main: health?.currentMainSha ?? null, status: health?.status ?? "unknown",
    reasons: Array.isArray(health?.reasons) ? [...health.reasons].sort() : ["unavailable"],
    failures: (Array.isArray(health?.unresolvedFailures) ? health.unresolvedFailures : []).map(f =>
      [f?.runId, f?.attempt, f?.testedSha]).sort((a, b) => a[0] - b[0] || a[1] - b[1]) });
}

/** `verifyAuthority` is a future operator-owned trust boundary, never a PR field.
 * Missing authority, proof or an exact group binding cannot create an exception.
 */
export async function authorizedRepair(entry, health, grant, { now, verifyAuthority, verifyChecks } = {}) {
  if (!validEntry(entry) || !grant || !date(now) || typeof verifyAuthority !== "function" ||
      typeof verifyChecks !== "function") return null;
  // Authority can permit a repair of a known failure or budget overrun; it
  // cannot replace unavailable health. Recheck the ordinary evidence contract
  // after removing only its known-failure veto, retaining baseline/backlog proof.
  const failures = health?.unresolvedFailures;
  // A fresh observer's "stale" verdict can identify a verified landing-age
  // overrun. It does not make an expired observation or stalled evidence usable.
  const ageOverrun = health?.status === "stale" && health?.reasons?.length === 1 &&
    health.reasons[0] === "oldest-unvalidated-change-exceeds-budget";
  if ((!ageOverrun && !["failing", "pending"].includes(health?.status)) || !Array.isArray(health?.reasons) ||
      (!ageOverrun && health.reasons.length) ||
      !Array.isArray(failures) || (health.status === "failing" ? !failures.length : failures.length) ||
      !failures.every(f => f?.repository === entry.repository && positive(f.runId) && positive(f.attempt) &&
        SHA.test(f.testedSha ?? "") && f.targetSha === f.testedSha && f.result === "failing" &&
        f.targetAncestryVerified === true && f.workflowAncestryVerified === true)) return null;
  const baseline = evaluateAdmission({ integration: entry, now, health: { ...health,
    status: health.backlog?.commits === 0 ? "passing" : "pending", reasons: [], unresolvedFailures: [] } });
  if (ageOverrun && !baseline.reasons.includes("unvalidated-age-limit")) return null;
  if (baseline.reasons.some(reason => !["unvalidated-age-limit", "unvalidated-backlog-limit"].includes(reason))) return null;
  const snapshot = structuredClone({ entry, grant, fingerprint: failureFingerprint(health) });
  const { grant: g } = snapshot;
  if (g.repository !== entry.repository || g.pullRequest !== entry.pullRequest || g.headSha !== entry.headSha ||
      g.baseSha !== entry.baseSha || g.integrationSha !== entry.integrationSha || g.kind !== entry.kind ||
      g.failureFingerprint !== snapshot.fingerprint || typeof g.authorizationId !== "string" ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(g.authorizationId) || !date(g.approvedAt) || !date(g.expiresAt) ||
      Date.parse(g.approvedAt) > Date.parse(now) || Date.parse(g.expiresAt) <= Date.parse(now) ||
      !date(health?.observedAt) || Date.parse(health.observedAt) > Date.parse(now) ||
      Date.parse(now) - Date.parse(health.observedAt) >= POLICY.maxObservationAgeSeconds * 1000 ||
      health.currentMainSha !== entry.baseSha ||
      entry.kind === "merge_group" && (entry.members?.length !== 1 || entry.members[0]?.pullRequest !== g.pullRequest || entry.members[0]?.headSha !== g.headSha))
    return null;
  try {
    const digest = repairDigest(g);
    const authority = await verifyAuthority(structuredClone(snapshot));
    if (authority?.approved !== true || authority.authorizationDigest !== digest) return null;
    const checks = await verifyChecks(structuredClone(snapshot));
    if (checks?.repository !== entry.repository || checks?.headSha !== entry.headSha ||
        checks?.integrationSha !== entry.integrationSha || checks?.baseSha !== entry.baseSha || checks?.status !== "passed" ||
        checks?.fast !== true || checks?.failingScenarios !== true || checks?.normalReviewAndMergeRequired !== true)
      return null;
    return { authorizationId: g.authorizationId, authorizationDigest: digest, expiresAt: g.expiresAt,
      normalReviewAndMergeRequired: true };
  } catch { return null; }
}

/** One bounded, complete live census includes ready PRs and all current queue heads.
 * A group containing multiple PRs is explicit; a one-PR repair grant cannot admit it.
 */
export async function readAdmissionEntries(api, repository) {
  if (!REPOSITORY.test(repository ?? "")) throw new Error("Invalid admission repository");
  const [owner, name] = repository.split("/");
  const body = await api("/graphql", { method: "POST", body: { query:
    "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){defaultBranchRef{name target{oid}} pullRequests(first:100,states:OPEN,baseRefName:\"main\"){pageInfo{hasNextPage} nodes{number isDraft headRefOid baseRefOid mergeQueueEntry{state position headCommit{oid} baseCommit{oid}}}}}}",
    variables: { owner, name } } });
  const repo = body?.data?.repository, list = repo?.pullRequests;
  if (body?.errors?.length || repo?.defaultBranchRef?.name !== "main" || !SHA.test(repo.defaultBranchRef.target?.oid ?? "") ||
      !Array.isArray(list?.nodes) || list.nodes.length > CONTROLLER.maxEntries || list.pageInfo?.hasNextPage !== false)
    throw new Error("Admission census unavailable");
  const entries = [], groups = new Map(), numbers = new Set();
  for (const p of list.nodes) {
    if (!positive(p?.number) || numbers.has(p.number) || typeof p.isDraft !== "boolean" ||
        !SHA.test(p.headRefOid ?? "") || !SHA.test(p.baseRefOid ?? "")) throw new Error("Invalid admission entry");
    numbers.add(p.number);
    if (p.isDraft) continue;
    entries.push({ repository, kind: "pull_request", pullRequest: p.number, headSha: p.headRefOid,
      baseSha: p.baseRefOid, integrationSha: p.headRefOid });
    const q = p.mergeQueueEntry;
    if (!q?.headCommit) continue;
    if (!SHA.test(q.headCommit.oid ?? "") || !SHA.test(q.baseCommit?.oid ?? "")) throw new Error("Queue head unavailable");
    const group = groups.get(q.headCommit.oid) ?? { repository, kind: "merge_group", pullRequest: p.number,
      headSha: p.headRefOid, baseSha: q.baseCommit.oid, integrationSha: q.headCommit.oid, members: [] };
    if (group.baseSha !== q.baseCommit.oid) throw new Error("Queue group changed");
    group.members.push({ pullRequest: p.number, headSha: p.headRefOid }); groups.set(group.integrationSha, group);
  }
  entries.push(...groups.values());
  if (entries.length > CONTROLLER.maxEntries) throw new Error("Admission census capacity");
  entries.sort((a, b) => `${a.kind}:${target(a)}`.localeCompare(`${b.kind}:${target(b)}`, "en"));
  return { repository, mainSha: repo.defaultBranchRef.target.oid, entries, complete: true, fingerprint: hash(entries) };
}

/** Complete plan before any optional writer is considered. Previous successes
 * supply no authority and a repaired baseline stays held through reconciliation.
 */
export async function planAdmissionCycle({ repository, census, health, control, grant, verifyAuthority, verifyChecks,
  now = new Date().toISOString(), observationId = randomUUID(), entryPoint = "cli" } = {}) {
  if (!date(now)) return { schema: "main-merge-admission-cycle-v1", mode: "dry-run", enforcement: "none", repository,
    observationId, entryPoint, evaluatedAt: null, censusComplete: false, reasons: ["controller-clock-unavailable"], decisions: [], nextEvaluationAt: null };
  const global = [];
  if (!REPOSITORY.test(repository ?? "") || census?.repository !== repository || census?.complete !== true ||
      !SHA.test(census?.mainSha ?? "") || !Array.isArray(census?.entries) || census.entries.length > CONTROLLER.maxEntries ||
      !census.entries.every(e => validEntry(e) && e.repository === repository)) global.push("queue-census-unavailable");
  if (control?.available !== true) global.push("control-state-unavailable");
  if (census?.mainSha !== health?.currentMainSha) global.push("main-observation-changed");
  const recovery = control?.repair ? repairRecovery({ ...control.repair, health, now }) : null;
  if (recovery && recovery.decision !== "release-eligible") global.push("repair-reconciliation-pending");
  const decisions = [];
  for (const entry of global.includes("queue-census-unavailable") ? [] : structuredClone(census.entries)) {
    const ordinary = evaluateAdmission({ integration: entry, health, now });
    const reasons = [...new Set([...global, ...ordinary.reasons])];
    // A second repair cannot inherit the first repair's authorization or overlap its recovery.
    const repair = reasons.length && !global.length ? await authorizedRepair(entry, health, grant,
      { now, verifyAuthority, verifyChecks }) : null;
    const eligible = !reasons.length || Boolean(repair);
    const expiresAt = new Date(Math.min(Date.parse(now) + CONTROLLER.maxCycleAgeMs,
      date(health?.observedAt) ? Date.parse(health.observedAt) + POLICY.maxObservationAgeSeconds * 1000 : Date.parse(now),
      repair ? Date.parse(repair.expiresAt) : Infinity,
      !repair && date(health?.backlog?.oldestUnvalidatedAt)
        ? Date.parse(health.backlog.oldestUnvalidatedAt) + POLICY.maxUnvalidatedAgeSeconds * 1000 : Infinity)).toISOString();
    const failureTimes = (Array.isArray(health?.unresolvedFailures) ? health.unresolvedFailures : [])
      .map(f => f?.completedAt).filter(date).map(Date.parse);
    const trigger = failureTimes.length ? Math.min(...failureTimes) :
      ordinary.reasons.includes("health-observation-expired") && date(health?.observedAt)
        ? Date.parse(health.observedAt) + POLICY.maxObservationAgeSeconds * 1000 :
      ordinary.reasons.includes("unvalidated-age-limit") && date(health?.backlog?.oldestUnvalidatedAt)
        ? Date.parse(health.backlog.oldestUnvalidatedAt) + POLICY.maxUnvalidatedAgeSeconds * 1000 : null;
    decisions.push({ entry, targetSha: target(entry), context: ADMISSION_CONTEXT, state: eligible ? "success" : "failure",
      decision: repair ? "authorized-repair-eligible" : eligible ? "ordinary-admission-eligible" : "hold",
      reasons: repair ? ["operator-authorized-exact-repair"] : reasons, repair, expiresAt,
      plannedBlockLatencyMs: !eligible && trigger !== null && trigger <= Date.parse(now) ? Date.parse(now) - trigger : null });
  }
  return { schema: "main-merge-admission-cycle-v1", mode: "dry-run", enforcement: "none", repository,
    observationId, entryPoint, evaluatedAt: now, healthDigest: health ? hash(health) : null,
    healthSummary: { status: health?.status ?? "unknown", mainSha: health?.currentMainSha ?? null,
      observedAt: health?.observedAt ?? null, passingRunId: health?.latestPassingSnapshot?.runId ?? null,
      backlogCommits: health?.backlog?.commits ?? null },
    censusFingerprint: census?.fingerprint ?? null, censusComplete: !global.includes("queue-census-unavailable"),
    reasons: global, recovery, decisions, nextEvaluationAt: new Date(Date.parse(now) + CONTROLLER.reevaluateMs).toISOString() };
}

/** Required-context/ruleset operations remain manual. Even an approved rollback
 * cannot plan hold removal until complete full queue validation is independently
 * verified. A false/unknown proof always preserves the hold.
 */
export function planRollback({ repository, fullQueueProof, operatorApproval } = {}) {
  const full = fullQueueProof?.repository === repository && REPOSITORY.test(repository ?? "") &&
    fullQueueProof?.verified === true && fullQueueProof?.coverage === "full-merge-group-v1" &&
    fullQueueProof?.requiredContext === "Typecheck, Test & Sidecar Bundle" && SHA.test(fullQueueProof?.workflowSha ?? "");
  if (!full) return { decision: "restore-full-queue-validation-first", holdRetained: true, enforcement: "none",
    steps: ["Restore full merge-group validation", "Independently verify the required full context", "Obtain separate operator hold-removal approval"] };
  const approved = operatorApproval?.repository === repository && operatorApproval?.fullQueueProofDigest === hash(fullQueueProof) &&
    operatorApproval?.action === "remove-admission-hold" && operatorApproval?.approved === true;
  return { decision: approved ? "operator-hold-removal-planned" : "operator-hold-removal-approval-required",
    holdRetained: true, enforcement: "none", fullQueueProofDigest: hash(fullQueueProof),
    steps: approved ? ["Full queue validation restored and verified", "Operator may remove the admission hold; full required CI stays enforced"] :
      ["Keep the hold", "Obtain separate operator hold-removal approval"] };
}

/** One independent health rebuild followed by one complete exact census. The
 * health observer re-pins main itself; any main/census mismatch plans holds.
 * The caller owns the single outer budget, including report and census reads.
 */
export async function rebuildAdmissionCycle({ repository, api, env = process.env, report = healthReport,
  error = console.error, now = () => new Date().toISOString(), ...options } = {}) {
  let health = null, census;
  try {
    const result = await report(["report"], { env: { ...env, GITHUB_REPOSITORY: repository, GITHUB_REF: "refs/heads/main" },
      api, log: line => { health = JSON.parse(line); }, error });
    if (result !== 0) health = { ...health, status: "unknown", reasons: ["health-report-unavailable"] };
    census = await readAdmissionEntries(api, repository);
  } catch { census = { repository, complete: false, entries: [] }; }
  return planAdmissionCycle({ ...options, repository, census, health, now: now() });
}

/** Code-only adapter: default DENY. No workflow grants status-writing scope.
 * A trusted operator callback rebuilds the WHOLE cycle once using this budget.
 * Serialized input supplies target identities only, never success authority.
 */
export async function writeAdmissionPlan(plan, { configuration, api, revalidate, now = () => new Date().toISOString(), log = () => {} } = {}) {
  if (configuration?.enabled !== true) return { mode: "disabled", writes: 0 };
  if (!REPOSITORY.test(configuration.repository ?? "") || configuration.repository !== plan?.repository ||
      configuration.context !== ADMISSION_CONTEXT || typeof revalidate !== "function" || typeof api !== "function" ||
      !Array.isArray(plan?.decisions) || plan.decisions.length > CONTROLLER.maxEntries) throw new Error("Writer configuration unavailable");
  const requested = structuredClone(plan.decisions);
  // One quota-sized budget covers the independent rebuild, census and ALL writes.
  const writerApi = budgetApi(api, { reserve: 0, requireHeaders: true });
  let writes = 0, attemptedWrites = 0, capacity, fresh, lastReceiptAt = null, lastPlannedBlockLatencyMs = null;
  try {
    await writerApi("/rate_limit");
    fresh = structuredClone(await revalidate({ repository: configuration.repository }, { api: writerApi }));
    const checkTime = () => {
      const checked = Date.parse(now());
      if (!Number.isFinite(checked) || fresh?.repository !== configuration.repository || fresh?.censusComplete !== true ||
          !date(fresh.evaluatedAt) || Date.parse(fresh.evaluatedAt) > checked ||
          checked - Date.parse(fresh.evaluatedAt) >= CONTROLLER.maxCycleAgeMs) throw new Error("Writer revalidation unavailable");
      return checked;
    };
    const checked = checkTime();
    if (!Array.isArray(fresh.decisions) || fresh.decisions.length !== requested.length)
      throw new Error("Writer target census changed");
    // Validate the ENTIRE batch before the first write; no changed head, newly
    // discovered target or late malformed decision may leave a partial pass.
    const identities = new Map();
    for (const d of requested) {
      if (!validEntry(d.entry) || d.entry.repository !== configuration.repository || d.targetSha !== target(d.entry) ||
          identities.has(d.targetSha)) throw new Error("Writer target unavailable or duplicated");
      identities.set(d.targetSha, hash(d.entry));
    }
    const seen = new Set();
    for (const d of fresh.decisions) {
      if (!validEntry(d.entry) || d.entry.repository !== configuration.repository || d.targetSha !== target(d.entry) ||
          !identities.has(d.targetSha) || identities.get(d.targetSha) !== hash(d.entry) || seen.has(d.targetSha) ||
          !["success", "failure"].includes(d.state) || d.context !== ADMISSION_CONTEXT ||
          d.state === "success" && (!date(d.expiresAt) || Date.parse(d.expiresAt) <= checked))
        throw new Error("Writer evidence expired or changed");
      seen.add(d.targetSha);
    }
    const usage = writerApi.budget;
    capacity = { plannedWrites: fresh.decisions.length, callsUsed: usage.calls, callLimit: usage.limit,
      callsAvailable: usage.limit - usage.calls, restRemaining: usage.rateRemaining, remainingFloor: usage.remainingFloor,
      quotaAvailable: usage.rateRemaining - usage.remainingFloor };
    capacity.writesAvailable = Math.max(0, Math.min(capacity.callsAvailable, capacity.quotaAvailable));
    capacity.shortfall = Math.max(0, capacity.plannedWrites - capacity.writesAvailable);
    if (capacity.shortfall) throw new Error("Writer complete batch exceeds remaining budget");
    for (const current of fresh.decisions) {
      const checked = checkTime();
      if (current.state === "success" && Date.parse(current.expiresAt) <= checked)
        throw new Error("Writer evidence expired or changed");
      attemptedWrites++;
      const result = await writerApi(`/repos/${configuration.repository}/statuses/${current.targetSha}`, { method: "POST", body: {
        state: current.state, context: ADMISSION_CONTEXT,
        description: current.state === "failure" ? "Regression health hold; inspect the admission audit" :
          current.repair ? "Exact repair exception; normal merge authority still required" : "Fresh regression admission decision",
      } });
      if (!positive(result?.id) || result.context !== ADMISSION_CONTEXT || result.state !== current.state)
        throw new Error("Writer receipt unavailable");
      writes++;
      const received = Date.parse(now());
      if (!Number.isFinite(received) || received < checked) throw new Error("Writer receipt clock unavailable");
      lastReceiptAt = new Date(received).toISOString();
      const plannedBlockLatencyMs = current.state === "failure" && Number.isFinite(current.plannedBlockLatencyMs)
        ? current.plannedBlockLatencyMs + received - Date.parse(fresh.evaluatedAt) : null;
      if (plannedBlockLatencyMs !== null) lastPlannedBlockLatencyMs = Math.max(lastPlannedBlockLatencyMs ?? 0, plannedBlockLatencyMs);
      log(JSON.stringify({ event: "main_merge_admission_status_written", entryPoint: fresh.entryPoint,
        observationId: fresh.observationId, repository: configuration.repository, targetSha: current.targetSha,
        state: current.state, decision: current.decision, expiresAt: current.expiresAt, statusId: result.id,
        receivedAt: lastReceiptAt, plannedBlockLatencyMs, apiCalls: writerApi.budget.calls }));
    }
    return { mode: "operator-enabled", writes, attemptedWrites, complete: true, capacity, apiBudget: { ...writerApi.budget },
      lastReceiptAt, lastPlannedBlockLatencyMs };
  } catch (cause) {
    const failure = { event: "main_merge_admission_batch_incomplete", repository: configuration.repository,
      writes, attemptedWrites, plannedWrites: requested.length, complete: false,
      reason: writerApi.budget.reason ?? (capacity?.shortfall ? "complete-batch-capacity-shortfall" : "revalidation-or-delivery-unavailable"), capacity: capacity ?? null, apiBudget: { ...writerApi.budget } };
    log(JSON.stringify(failure));
    // A prior success is sticky even on a zero-write budget refusal. Never call
    // this enforcement success or retry with another token; reconcile explicitly.
    throw Object.assign(new Error("Admission batch incomplete", { cause }), failure);
  }
}

export async function main({ env = process.env, api, log = console.log, error = console.error } = {}) {
  if (env.MAIN_MERGE_ADMISSION_CONTROLLER !== "dry-run") return 0;
  const repository = env.GITHUB_REPOSITORY, observationId = randomUUID(), entryPoint = env.GITHUB_EVENT_NAME ?? "cli";
  let bounded, plan;
  try {
    if (!REPOSITORY.test(repository ?? "") || !env.GITHUB_TOKEN) throw new Error("Environment unavailable");
    bounded = budgetApi(api ?? githubApi(env.GITHUB_TOKEN), { reserve: 0, requireHeaders: !api });
    await bounded("/rate_limit");
    // No authority or writer is configured. Missing control state always holds.
    plan = await rebuildAdmissionCycle({ repository, api: bounded, env, error,
      control: { available: false }, observationId, entryPoint });
  } catch {
    plan = await planAdmissionCycle({ repository, census: { repository, complete: false, entries: [] },
      control: { available: false }, observationId, entryPoint });
  }
  if (bounded) plan.apiBudget = { ...bounded.budget };
  if (env.MAIN_MERGE_ADMISSION_OUTPUT) writeFileSync(env.MAIN_MERGE_ADMISSION_OUTPUT, JSON.stringify(plan, null, 2) + "\n");
  log(JSON.stringify({ event: "main_merge_admission_cycle_planned", ...plan }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then(code => { process.exitCode = code; });
