import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluateAdmission } from "./main-merge-admission.mjs";
import { authorizedRepair, CONTROLLER, failureFingerprint, planAdmissionCycle, planRollback, rebuildAdmissionCycle,
  writeAdmissionPlan } from "./main-merge-admission-controller.mjs";
import { mergedRepairBinding, repairDigest, repairRecovery, requestMergedRepairCandidate } from "./main-merge-repair.mjs";

/** Entire target set, inert transport, explicit virtual API latency. The 36
 * report reads + one census conservatively replay the prior 37-read rebuild.
 * Delivery is bounded per cycle (the writer's reserve) and continues on the next
 * 60-second cycle with the writer's own durable progress, up to `maxCycles`.
 * These endpoints cannot reach GitHub; the enabled flag applies only to fixtures.
 */
export async function rehearseHoldFanout(health, { expired = false, restLimit = 5000, targetCount = 45, healthReadCount = 36,
  workflowBatches = 0, maxCycles = 12, heldGroups = 0 } = {}) {
  const repository = health.repository, origin = Date.parse(health.observedAt);
  const trigger = expired ? origin + 120_000 : Date.parse(health.unresolvedFailures[0].completedAt);
  const start = expired ? trigger : trigger + 1000;
  const virtualRequestMs = 100;
  let clock = start, reports = 0, censuses = 0, writes = 0, workflowQueries = 0;
  const written = [];
  const workflowFiles = ["main-rolling-validation.yml", "ci.yml", "settings-rows-win32.yml"];
  const workflowText = "# Inert complete workflow blob; not live health evidence\n";
  const byteSize = Buffer.byteLength(workflowText);
  const workflowBlob = { __typename: "Blob", text: workflowText, byteSize, isBinary: false,
    oid: createHash("sha1").update(`blob ${byteSize}\0${workflowText}`).digest("hex") };
  // `heldGroups` of the pull requests sit in queue groups on main that already hold a just-in-time
  // success: the only landing-critical targets. Each adds a group target beside its PR head.
  const groupSha = i => (i + 900).toString(16).padStart(40, "0");
  const nodes = Array.from({ length: targetCount - heldGroups }, (_, i) => ({ number: i + 1, isDraft: false,
    headRefOid: (i + 100).toString(16).padStart(40, "0"), baseRefOid: health.currentMainSha,
    mergeQueueEntry: i < heldGroups ? { state: "MERGEABLE", position: i + 1, baseCommit: { oid: health.currentMainSha },
      headCommit: { oid: groupSha(i), statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [
        { __typename: "CheckRun", name: "Typecheck, Test & Sidecar Bundle", status: "COMPLETED", conclusion: "SUCCESS", checkSuite: { app: { databaseId: 15368 } } },
        { __typename: "StatusContext", context: "Regression Admission", state: "SUCCESS" }] } } } } : null }));
  const api = async (path, { body } = {}) => {
    clock += virtualRequestMs;
    api.rateLimit.remaining--;
    if (path === "/rate_limit" || path.startsWith("/inert-health/")) return {};
    if (path === "/graphql") {
      if (body.query.includes("AdmissionWorkflowEvidence")) {
        workflowQueries++;
        return { data: { repository: { nameWithOwner: repository, revision: { __typename: "Commit", oid: body.variables.revision },
          file0: workflowBlob, file1: workflowBlob, file2: workflowBlob } } };
      }
      censuses++;
      return { data: { repository: { defaultBranchRef: { name: "main", target: { oid: health.currentMainSha } },
        pullRequests: { pageInfo: { hasNextPage: false }, nodes } } } };
    }
    if (path.startsWith(`/repos/${repository}/statuses/`)) {
      if (body.state !== "failure") throw new Error("Fanout fixture must hold every target");
      const target = path.slice(`/repos/${repository}/statuses/`.length);
      written.push(target);
      // The forge now shows the hold: later censuses observe the group's admission as failure.
      for (const p of nodes) if (p.mergeQueueEntry?.headCommit.oid === target)
        for (const c of p.mergeQueueEntry.headCommit.statusCheckRollup.contexts.nodes) if (c.context === body.context) c.state = "FAILURE";
      if (target in census.admissionStates) census.admissionStates[target] = "failure";
      return { id: ++writes, state: body.state, context: body.context };
    }
    throw new Error("Unexpected inert fanout request");
  };
  api.rateLimit = { limit: restLimit, remaining: restLimit };
  const now = () => new Date(clock).toISOString();
  const report = async (_args, { api: bounded, log }) => {
    reports++;
    for (let i = 0; i < workflowBatches; i++) for (const file of workflowFiles)
      await bounded(`/repos/${repository}/contents/.github/workflows/${file}?ref=${(i + 1).toString(16).padStart(40, "0")}`);
    for (let i = workflowBatches * 3; i < healthReadCount; i++) await bounded(`/inert-health/${i}`);
    log(JSON.stringify(health)); return 0;
  };
  const census = { repository, mainSha: health.currentMainSha, complete: true,
    entries: [...nodes.map(p => ({ repository, kind: "pull_request", pullRequest: p.number,
      headSha: p.headRefOid, baseSha: p.baseRefOid, integrationSha: p.headRefOid })),
    ...nodes.filter(p => p.mergeQueueEntry).map(p => ({ repository, kind: "merge_group", pullRequest: p.number, headSha: p.headRefOid,
      baseSha: health.currentMainSha, integrationSha: p.mergeQueueEntry.headCommit.oid, members: [{ pullRequest: p.number, headSha: p.headRefOid }] }))]
      .sort((a, b) => `${a.kind}:${a.kind === "pull_request" ? a.headSha : a.integrationSha}`.localeCompare(`${b.kind}:${b.kind === "pull_request" ? b.headSha : b.integrationSha}`, "en")),
    requiredResults: Object.fromEntries(nodes.filter(p => p.mergeQueueEntry).map(p => [p.mergeQueueEntry.headCommit.oid, "success"])),
    admissionStates: Object.fromEntries(nodes.filter(p => p.mergeQueueEntry).map(p => [p.mergeQueueEntry.headCommit.oid, "success"])) };
  const control = { available: true, repair: null };
  // Holds are planned against the health being replayed; a cycle's clock never moves past its lease.
  const cpuStart = performance.now();
  const cycles = [];
  let progress = null, lastReceiptAt = null, lastPlannedBlockLatencyMs = null, firstCapacity = null;
  for (let cycle = 0; cycle < maxCycles; cycle++) {
    if (cycle) clock = start + cycle * CONTROLLER.reevaluateMs;
    const cycleStart = clock;
    api.rateLimit.remaining = restLimit; // An inert per-cycle quota snapshot; live quota is shared and observed.
    const initial = await planAdmissionCycle({ repository, census, health: { ...health, observedAt: new Date(clock).toISOString() },
      control, now: now() });
    const delivery = await writeAdmissionPlan(initial, { configuration: { enabled: true, repository, context: "Regression Admission" },
      api, now, progress, revalidate: ({ repository }, { api }) => rebuildAdmissionCycle({ repository, api,
        report: (args, options) => report(args, options), now, control, observationId: "inert-full-fanout", entryPoint: "rehearsal" }) });
    progress = delivery.progress;
    firstCapacity ??= delivery.capacity;
    if (delivery.lastReceiptAt) lastReceiptAt = delivery.lastReceiptAt;
    if (delivery.lastPlannedBlockLatencyMs !== null) lastPlannedBlockLatencyMs = delivery.lastPlannedBlockLatencyMs;
    const before = written.length;
    cycles.push({ cycle: cycle + 1, startedAtMs: cycleStart - trigger, writes: delivery.writes, alreadyHeld: delivery.capacity.alreadyHeld,
      groupHoldsWritten: written.slice(before - delivery.writes).filter(target => target >= groupSha(0)).length,
      deferred: delivery.deferred, calls: delivery.apiBudget.calls, limit: delivery.apiBudget.limit,
      headroomCalls: delivery.apiBudget.limit - delivery.apiBudget.calls, reserveCalls: delivery.capacity.reserveCalls,
      complete: delivery.complete, coverage: delivery.coverage });
    if (delivery.complete) break;
  }
  const last = cycles.at(-1), first = cycles[0];
  return { evidenceClass: "inert-api-and-virtual-clock; no live delivery or authority", targetCount,
    reports, censuses, healthReadCount, workflowQueries, unbatchedReadCalls: healthReadCount + 2,
    savedCalls: workflowBatches * 2, virtualRequestMs, virtualStartAt: new Date(start).toISOString(),
    // First-cycle delivery, as the earlier single-batch fixtures reported it.
    writes: first.writes, calls: first.calls, callLimit: first.limit, firstCycleHeadroomCalls: first.headroomCalls, heldGroups,
    groupHoldsInFirstCycle: first.groupHoldsWritten, capacity: firstCapacity, lastPlannedBlockLatencyMs,
    complete: last.complete, cyclesToComplete: last.complete ? cycles.length : null, totalWrites: cycles.reduce((n, c) => n + c.writes, 0),
    minHeadroomCalls: Math.min(...cycles.map(c => c.headroomCalls)),
    minHeadroomFraction: Math.min(...cycles.map(c => c.headroomCalls / c.limit)), cycles,
    failureOrExpiryToLastPlannedHoldMs: last.complete && lastReceiptAt ? Date.parse(lastReceiptAt) - trigger : null,
    computeMs: performance.now() - cpuStart, liveMutations: 0 };
}

/** Inert rehearsal. Historical live health is replayed at its original observation
 * time; every failure, authorization, CI proof, merge, request and recovery is a
 * labelled fixture. This module cannot dispatch a workflow or write forge state.
 */
export async function rehearseAdmission(projection, { candidateInterfaces } = {}) {
  const historical = projection?.health;
  if (historical?.schema !== "main-ci-health-v1" || historical.status !== "passing" ||
      !Number.isFinite(Date.parse(historical.observedAt))) throw new Error("Passing historical health projection required");
  candidateInterfaces ??= await import("./main-validation-candidates.mjs");
  const { queueCandidate, candidateReceipt } = candidateInterfaces;
  const source = { repository: historical.repository, mainSha: historical.currentMainSha, observedAt: historical.observedAt,
    originalReportDigest: projection.source?.originalReportDigest ?? null,
    evidenceClass: "historical-live-projection; replay is not current authority" };
  const repository = historical.repository, origin = Date.parse(historical.observedAt);
  const at = seconds => new Date(origin + seconds * 1000).toISOString();
  const failed = "1".repeat(40), head = "2".repeat(40), group = "3".repeat(40), merged = "4".repeat(40), tree = "5".repeat(40);
  const claim = "12345678-1234-1234-1234-123456789012", suite = historical.latestPassingSnapshot.suiteVersion;
  const entry = { repository, kind: "merge_group", pullRequest: 42, headSha: head, baseSha: failed, integrationSha: group,
    members: [{ pullRequest: 42, headSha: head }] };
  const red = { ...structuredClone(historical), currentMainSha: failed, status: "failing", observedAt: at(10), fullCertification: null,
    unresolvedFailures: [{ repository, runId: 9001, attempt: 1, testedSha: failed, targetSha: failed,
      result: "failing", targetAncestryVerified: true, workflowAncestryVerified: true, completedAt: at(10) }],
    backlog: { commits: 1, merges: 1, clock: "forge-landing-time", oldestUnvalidatedAt: at(1), oldestUnvalidatedAgeSeconds: 9 } };
  const census = { repository, mainSha: failed, complete: true, entries: [entry], fingerprint: "inert-rehearsal" };
  const control = { available: true, repair: null }, phases = [], latency = {};
  const measured = async (key, work) => { const start = performance.now(); const result = await work();
    latency[`${key}ComputeMs`] = performance.now() - start; return result; };
  const baseline = evaluateAdmission({ integration: { repository, kind: "merge_group", baseSha: source.mainSha,
    integrationSha: source.mainSha }, health: historical, now: at(0.1) });
  phases.push({ phase: "historical-baseline-replay", evidenceClass: "historical-live-projection", decision: baseline.decision });
  const hold = await measured("failure", () => planAdmissionCycle({ repository, census, health: red, control, now: at(11), entryPoint: "rehearsal" }));
  latency.failureToPlannedBlockMs = hold.decisions[0].plannedBlockLatencyMs;
  phases.push({ phase: "hold", evidenceClass: "inert-fixture", decision: hold.decisions[0].decision });
  const expired = await measured("expiry", () => planAdmissionCycle({ repository,
    census: { ...census, mainSha: source.mainSha, entries: [{ ...entry, baseSha: source.mainSha }] },
    health: historical, control, now: at(120), entryPoint: "rehearsal" }));
  latency.expiryToPlannedBlockMs = expired.decisions[0].plannedBlockLatencyMs;
  phases.push({ phase: "expiry", evidenceClass: "inert-fixture", decision: expired.decisions[0].decision });
  const grant = { repository, authorizationId: "inert-repair-42", pullRequest: 42, kind: "merge_group", headSha: head,
    baseSha: failed, integrationSha: group, failureFingerprint: failureFingerprint(red), approvedAt: at(10), expiresAt: at(70) };
  const verifyAuthority = async ({ grant: current }) => ({ approved: true, authorizationDigest: repairDigest(current) });
  const verifyChecks = async ({ entry: current }) => ({ repository, headSha: current.headSha, baseSha: current.baseSha,
    integrationSha: current.integrationSha, status: "passed", fast: true, failingScenarios: true, normalReviewAndMergeRequired: true });
  const permission = await authorizedRepair(entry, red, grant, { now: at(12), verifyAuthority, verifyChecks });
  const repairPlan = await planAdmissionCycle({ repository, census, health: red, control, grant, verifyAuthority, verifyChecks, now: at(12), entryPoint: "rehearsal" });
  phases.push({ phase: "authorized-exact-head-repair", evidenceClass: "inert-authority-and-ci-fixture",
    decision: repairPlan.decisions[0].decision, normalReviewAndMergeRequired: permission?.normalReviewAndMergeRequired === true });
  const pull = { number: 42, merged: true, head: { sha: head }, base: { ref: "main", repo: { full_name: repository } }, merge_commit_sha: merged, merged_at: at(30) };
  let fixtureReads = 0;
  const api = async (path, options = {}) => {
    if ((options.method ?? "GET") !== "GET") throw new Error("Rehearsal cannot mutate forge state");
    fixtureReads++;
    if (path.endsWith("/pulls/42")) return pull;
    if (path.endsWith(`/git/commits/${merged}`)) return { sha: merged, parents: [{ sha: failed }], tree: { sha: tree } };
    if (path.endsWith(`/git/commits/${group}`)) return { sha: group, tree: { sha: tree } };
    if (path.endsWith("/git/ref/heads/main")) return { object: { sha: merged } };
    throw new Error("Unexpected fixture request");
  };
  const binding = await mergedRepairBinding(repository, grant, { authorizationDigest: repairDigest(grant), integrationSha: group, admittedAt: at(12) }, { api });
  phases.push({ phase: "merged-identity-reconciliation", evidenceClass: "inert-forge-fixture", decision: binding.decision, mergeSha: binding.mergeSha });
  let ledger, requestedPurpose;
  const request = await requestMergedRepairCandidate(binding, { api, now: () => at(31),
    requestCandidate: async (repo, targetSha, { purpose }) => {
      if (repo !== repository || targetSha !== merged || purpose !== "repair") throw new Error("Wrong candidate request");
      requestedPurpose = purpose;
      ledger = queueCandidate(undefined, { targetSha, suiteVersion: suite, purpose, requestedAt: at(31), claimId: claim });
      return candidateReceipt(ledger, targetSha, purpose, suite, at(31));
    } });
  phases.push({ phase: "purpose-repair-validation-request", evidenceClass: "shared-primitive-with-inert-ledger",
    decision: request.decision, purpose: requestedPurpose, targetSha: request.receipt.targetSha, certification: request.receipt.certification });
  phases.push({ phase: "pending-validation-holds", evidenceClass: "inert-fixture",
    decision: repairRecovery({ binding, receipt: request.receipt, health: red, now: at(32) }).decision });
  ledger.requests[0] = { ...ledger.requests[0], status: "success", runId: 9002, dispatchedAt: at(35), statusObservedAt: at(90) };
  const receipt = candidateReceipt(ledger, merged, "repair", suite, at(90));
  phases.push({ phase: "receipt-alone-holds", evidenceClass: "inert-fixture", decision: repairRecovery({ binding, receipt, now: at(91) }).decision });
  const pass = { ...structuredClone(historical.latestPassingSnapshot), repository, testedSha: merged, targetSha: merged,
    runId: 9002, attempt: 1, workflowRevision: merged, suiteVersion: suite };
  const recovered = { ...structuredClone(historical), currentMainSha: merged, observedAt: at(90), status: "passing", reasons: [],
    unresolvedFailures: [], latestPassingSnapshot: pass, fullCertification: pass,
    backlog: { commits: 0, merges: 0, clock: "forge-landing-time", oldestUnvalidatedAt: null, oldestUnvalidatedAgeSeconds: 0 } };
  const reconciliation = repairRecovery({ binding, receipt, health: recovered, now: at(91) });
  phases.push({ phase: "independent-health-reconciliation", evidenceClass: "inert-full-health-fixture", decision: reconciliation.decision });
  const released = await planAdmissionCycle({ repository, census: { ...census, mainSha: merged, entries: [{ ...entry, baseSha: merged }] },
    health: recovered, control: { available: true, repair: { binding, receipt } }, now: at(92), entryPoint: "rehearsal" });
  phases.push({ phase: "release", evidenceClass: "inert-fixture", decision: released.decisions[0].decision });
  const beforeRestore = planRollback({ repository });
  phases.push({ phase: "rollback-before-full-restoration", evidenceClass: "inert-fixture", decision: beforeRestore.decision, holdRetained: beforeRestore.holdRetained });
  // Shaped exactly like ci-merge-group-restoration.mjs output; planRollback checks every run (#3633).
  const proof = { schema: "merge-group-restoration-v1", repository, since: at(80), verified: true, coverage: "full-merge-group-v1",
    requiredContext: "Typecheck, Test & Sidecar Bundle", workflowSha: merged,
    workflowBlobs: { ".github/workflows/ci.yml": "1".repeat(40), ".github/workflows/settings-rows-win32.yml": "2".repeat(40) },
    runs: [{ runId: 9003, attempt: 1, headSha: "3".repeat(40), createdAt: at(85), certification: "full", reasons: [] }], reasons: [] };
  const restored = planRollback({ repository, fullQueueProof: proof });
  const rollback = planRollback({ repository, fullQueueProof: proof, operatorApproval: { repository, approved: true,
    action: "remove-admission-hold", fullQueueProofDigest: restored.fullQueueProofDigest } });
  phases.push({ phase: "rollback-after-full-restoration-and-exact-operator-approval", evidenceClass: "inert-fixture",
    decision: rollback.decision, holdRetained: rollback.holdRetained, fullRequiredContextRetained: true });
  const disabledWriter = await writeAdmissionPlan(released, { api: () => { throw new Error("No live writer permitted"); } });
  return { schema: "main-merge-admission-rehearsal-v1", mode: "dry-run", enforcement: "none", source,
    phases, latency, fixtureReads, liveMutations: 0, disabledWriter,
    fanout: { failure: await rehearseHoldFanout(red), expiry: await rehearseHoldFanout(historical, { expired: true }),
      insufficientBudget: await rehearseHoldFanout(red, { restLimit: 1000 }),
      currentReadCost35Targets: await rehearseHoldFanout(red, { targetCount: 35, healthReadCount: 51 }),
      currentReadCost45Targets: await rehearseHoldFanout(red, { healthReadCount: 51 }),
      batchedMeasuredCost45Targets: await rehearseHoldFanout(red, { healthReadCount: 51, workflowBatches: 1 }),
      batchedMeasuredCostExpiry45Targets: await rehearseHoldFanout(historical, { expired: true, healthReadCount: 51, workflowBatches: 1 }),
      batchedMeasuredCost46Targets: await rehearseHoldFanout(red, { targetCount: 46, healthReadCount: 51, workflowBatches: 1 }),
      latestObservedCost45Targets: await rehearseHoldFanout(red, { healthReadCount: 36, workflowBatches: 2 }),
      // The #3637 backlog-limit cost (55 calls before writes) with two queue groups holding a success.
      backlogLimitCost45TargetsTwoHeldGroups: await rehearseHoldFanout(red, { healthReadCount: 53, heldGroups: 2 }) },
    forgeRace: "A success is sticky after the controller stops; fixture lease expiry does not expire a GitHub status. No finite unconditional block bound or atomic enforcement is established." };
}

export async function main(argv = process.argv.slice(2)) {
  const path = argv[0] ?? fileURLToPath(new URL("./fixtures/main-merge-health-projection.json", import.meta.url));
  const report = await rehearseAdmission(JSON.parse(readFileSync(path, "utf8")));
  if (argv[1]) writeFileSync(argv[1], JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report)); return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then(code => { process.exitCode = code; });
