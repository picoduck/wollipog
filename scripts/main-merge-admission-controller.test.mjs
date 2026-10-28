import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { ADMISSION_CONTEXT, authorizedRepair, failureFingerprint, main, planAdmissionCycle, planRollback,
  readAdmissionEntries, rebuildAdmissionCycle, REQUIRED_RESULT, requiredResult, writeAdmissionPlan } from "./main-merge-admission-controller.mjs";
import { repairDigest } from "./main-merge-repair.mjs";

const repository = "example/project", base = "a".repeat(40), head = "b".repeat(40), group = "c".repeat(40);
const at = seconds => new Date(Date.UTC(2026, 9, 26, 1) + seconds * 1000).toISOString();
const entry = () => ({ repository, kind: "merge_group", pullRequest: 42, headSha: head, baseSha: base,
  integrationSha: group, members: [{ pullRequest: 42, headSha: head }] });
// The group's own aggregator already succeeded: just-in-time admission may write its success.
const census = () => ({ repository, complete: true, mainSha: base, entries: [entry()], requiredResults: { [group]: "success" }, fingerprint: "fixture" });
const control = () => ({ available: true, repair: null });
function health() {
  return { schema: "main-ci-health-v1", repository, currentMainSha: base, observedAt: at(0), status: "passing", reasons: [],
    unresolvedFailures: [], latestPassingSnapshot: { repository, testedSha: base, targetSha: base, certification: "full", result: "passing",
      coverageVersion: "rolling-full-v1", runId: 20, attempt: 1, checkoutVerified: true, targetAncestryVerified: true,
      workflowAncestryVerified: true, workflowRevision: base }, backlog: { clock: "forge-landing-time", commits: 0, merges: 0,
      oldestUnvalidatedAt: null, oldestUnvalidatedAgeSeconds: 0 } };
}
const red = () => ({ ...health(), status: "failing", unresolvedFailures: [{ repository, runId: 21, attempt: 1,
  testedSha: base, targetSha: base, result: "failing", targetAncestryVerified: true,
  workflowAncestryVerified: true, completedAt: at(10) }] });
const cycle = extra => planAdmissionCycle({ repository, census: census(), health: health(), control: control(), now: at(11), ...extra });
const grant = () => ({ ...entry(), authorizationId: "repair-1", failureFingerprint: failureFingerprint(red()), approvedAt: at(10), expiresAt: at(100) });
const verifyAuthority = async ({ grant: g }) => ({ approved: true, authorizationDigest: repairDigest(g) });
const verifyChecks = async ({ entry: e }) => ({ repository, headSha: e.headSha, baseSha: e.baseSha, integrationSha: e.integrationSha,
  status: "passed", fast: true, failingScenarios: true, normalReviewAndMergeRequired: true });

test("ready, queued and building targets are reevaluated; a complete cycle never inherits a prior success", async () => {
  const current = census(); current.entries.push({ repository, kind: "pull_request", pullRequest: 42,
    headSha: head, baseSha: base, integrationSha: head });
  const green = await cycle({ census: current });
  assert.ok(green.decisions.every(d => d.state === "success"));
  const failed = await cycle({ census: current, health: red(), previous: green });
  assert.ok(failed.decisions.every(d => d.state === "failure"));
  assert.ok(failed.decisions.every(d => d.plannedBlockLatencyMs === 1000));
  const expired = await cycle({ census: current, now: at(120), previous: green });
  assert.ok(expired.decisions.every(d => d.state === "failure" && d.plannedBlockLatencyMs === 0));
});

test("incomplete census, unavailable control state, moved main and unknown health cannot pass", async () => {
  for (const extra of [{ census: { ...census(), complete: false } }, { control: undefined },
    { health: null }, { census: { ...census(), mainSha: head } }, { health: { ...health(), status: "unknown" } }]) {
    const plan = await cycle(extra);
    assert.ok(plan.reasons.length || plan.decisions.every(d => d.state === "failure"));
    assert.ok(plan.decisions.every(d => d.state !== "success"));
  }
});

test("malformed failure collections still produce auditable holds instead of aborting the cycle", async () => {
  for (const failures of [{}, "unavailable", [null]]) {
    const plan = await cycle({ health: { ...health(), status: "unknown", unresolvedFailures: failures } });
    assert.equal(plan.decisions.length, 1);
    assert.equal(plan.decisions[0].decision, "hold");
    assert.equal(plan.decisions[0].plannedBlockLatencyMs, null);
    assert.doesNotThrow(() => failureFingerprint({ unresolvedFailures: failures }));
  }
});

test("fresh authoritative age-budget overruns permit only an exact repair; stale observations never do", async () => {
  const h = health();
  h.status = "stale";
  h.reasons = ["oldest-unvalidated-change-exceeds-budget"];
  h.latestPassingSnapshot.testedSha = head; h.latestPassingSnapshot.targetSha = head;
  h.backlog = { clock: "forge-landing-time", commits: 1, merges: 1,
    oldestUnvalidatedAt: at(-8000), oldestUnvalidatedAgeSeconds: 8000 };
  const g = { ...grant(), failureFingerprint: failureFingerprint(h) };
  assert.equal((await cycle({ health: h })).decisions[0].decision, "hold");
  assert.equal((await cycle({ health: h, grant: g, verifyAuthority, verifyChecks })).decisions[0].decision, "authorized-repair-eligible");
  for (const changed of [{ ...h, observedAt: at(-120) }, { ...h, reasons: [...h.reasons, "validation-stalled"] }]) {
    const changedGrant = { ...g, failureFingerprint: failureFingerprint(changed) };
    assert.equal((await cycle({ health: changed, grant: changedGrant, verifyAuthority, verifyChecks })).decisions[0].decision, "hold");
  }
});

test("only the exact operator-authorized repair with verified fast/failing-scenario checks is exceptional", async () => {
  const g = grant();
  const plan = await cycle({ health: red(), grant: g, verifyAuthority, verifyChecks });
  assert.equal(plan.decisions[0].decision, "authorized-repair-eligible");
  assert.equal(plan.decisions[0].repair.normalReviewAndMergeRequired, true);
  for (const extra of [{}, { verifyAuthority }, { verifyChecks }, { verifyAuthority: async () => true, verifyChecks },
    { verifyAuthority, verifyChecks: async () => ({ ...await verifyChecks({ entry: entry() }), failingScenarios: false }) }]) {
    assert.equal(await authorizedRepair(entry(), red(), g, { now: at(11), ...extra }), null);
  }
  for (const edit of [g => { g.headSha = group; }, g => { g.baseSha = head; }, g => { g.integrationSha = head; },
    g => { g.expiresAt = at(11); }, g => { g.failureFingerprint = "old failure"; }]) {
    const changed = grant(); edit(changed);
    const held = await cycle({ health: red(), grant: changed, verifyAuthority, verifyChecks, labels: ["repair"], prompt: "approve" });
    assert.equal(held.decisions[0].state, "failure");
  }
});

test("a one-PR repair grant cannot admit batched ordinary work or overlap another repair", async () => {
  const current = census(); current.entries[0].members.push({ pullRequest: 43, headSha: group });
  const batched = await cycle({ census: current, health: red(), grant: grant(), verifyAuthority, verifyChecks });
  assert.equal(batched.decisions[0].state, "failure");
  const overlap = await cycle({ health: red(), grant: grant(), verifyAuthority, verifyChecks,
    control: { available: true, repair: { binding: null, receipt: null } } });
  assert.equal(overlap.decisions[0].state, "failure"); assert.ok(overlap.reasons.includes("repair-reconciliation-pending"));
});

test("even an exact repair grant cannot substitute for unavailable, stale or malformed health", async () => {
  for (const edit of [h => { h.status = "unknown"; }, h => { h.status = "stale"; },
    h => { h.schema = "foreign"; }, h => { h.repository = "other/project"; },
    h => { h.reasons = ["forge-api-unavailable"]; }, h => { h.observedAt = at(-120); },
    h => { h.latestPassingSnapshot = null; }, h => { h.backlog.commits = null; },
    h => { h.unresolvedFailures = []; }, h => { h.unresolvedFailures[0].targetAncestryVerified = false; },
    h => { h.unresolvedFailures[0].runId = null; }]) {
    const h = red(); edit(h);
    const g = { ...grant(), failureFingerprint: failureFingerprint(h) };
    const held = await cycle({ health: h, grant: g, verifyAuthority, verifyChecks });
    assert.ok(held.decisions.every(d => d.state === "failure" && d.repair === null));
    assert.equal(await authorizedRepair(entry(), h, g, { now: at(11), verifyAuthority, verifyChecks }), null);
  }
});

test("forged, truncated and changing queue listings never form a complete census", async () => {
  const body = { data: { repository: { defaultBranchRef: { name: "main", target: { oid: base } }, pullRequests: {
    pageInfo: { hasNextPage: false }, nodes: [{ number: 42, isDraft: false, headRefOid: head, baseRefOid: base,
      mergeQueueEntry: { headCommit: { oid: group }, baseCommit: { oid: base } } }] } } } };
  const result = await readAdmissionEntries(async () => body, repository);
  assert.equal(result.entries.length, 2); assert.equal(result.complete, true);
  for (const edit of [b => { b.errors = [{}]; }, b => { b.data.repository.pullRequests.pageInfo.hasNextPage = true; },
    b => { b.data.repository.pullRequests.nodes[0].headRefOid = "bad"; },
    b => { b.data.repository.pullRequests.nodes.push(b.data.repository.pullRequests.nodes[0]); }]) {
    const b = structuredClone(body); edit(b);
    await assert.rejects(readAdmissionEntries(async () => b, repository));
  }
});

const aggregator = (status, conclusion, appId = REQUIRED_RESULT.appId, name = REQUIRED_RESULT.context) =>
  ({ __typename: "CheckRun", name, status, conclusion, checkSuite: { app: { databaseId: appId } } });
const rollup = (nodes, hasNextPage = false) => ({ contexts: { pageInfo: { hasNextPage }, nodes } });

test("a group's required result is success only from the pinned aggregator, completed and unanimous", () => {
  assert.equal(requiredResult(rollup([aggregator("COMPLETED", "SUCCESS")])), "success");
  assert.equal(requiredResult(rollup([aggregator("COMPLETED", "SUCCESS"), { __typename: "StatusContext", context: "Other", state: "SUCCESS" }])), "success");
  assert.equal(requiredResult(rollup([])), "pending", "no aggregator yet");
  assert.equal(requiredResult(rollup([aggregator("IN_PROGRESS", null)])), "pending");
  assert.equal(requiredResult(rollup([aggregator("COMPLETED", "SUCCESS"), aggregator("QUEUED", null)])), "pending", "a rerun in flight");
  for (const conclusion of ["FAILURE", "CANCELLED", "TIMED_OUT", "SKIPPED", "NEUTRAL"])
    assert.equal(requiredResult(rollup([aggregator("COMPLETED", conclusion)])), "failure", conclusion);
  // Another app could write a check with the same name; only GitHub Actions' pinned issuer counts.
  assert.equal(requiredResult(rollup([aggregator("COMPLETED", "SUCCESS", 4242)])), "unavailable");
  assert.equal(requiredResult(rollup([aggregator("COMPLETED", "SUCCESS"), aggregator("COMPLETED", "SUCCESS", 4242)])), "unavailable");
  for (const broken of [undefined, null, {}, { contexts: {} }, rollup([aggregator("COMPLETED", "SUCCESS")], true),
    rollup(Array(101).fill(aggregator("COMPLETED", "SUCCESS")))]) assert.equal(requiredResult(broken), "unavailable");
});

test("the census reads each group's aggregator on its exact SHA outside entry identity", async () => {
  const body = (nodes) => ({ data: { repository: { defaultBranchRef: { name: "main", target: { oid: base } }, pullRequests: {
    pageInfo: { hasNextPage: false }, nodes: [{ number: 42, isDraft: false, headRefOid: head, baseRefOid: base,
      mergeQueueEntry: { headCommit: { oid: group, statusCheckRollup: rollup(nodes) }, baseCommit: { oid: base } } }] } } } });
  let query = null;
  const pending = await readAdmissionEntries(async (path, { body: request }) => { query = request.query; return body([]); }, repository);
  assert.match(query, /statusCheckRollup\{contexts\(first:100\)\{pageInfo\{hasNextPage\}/);
  assert.match(query, /checkSuite\{app\{databaseId\}\}/);
  const done = await readAdmissionEntries(async () => body([aggregator("COMPLETED", "SUCCESS")]), repository);
  assert.deepEqual([pending.requiredResults, done.requiredResults], [{ [group]: "pending" }, { [group]: "success" }]);
  // A finishing aggregator changes what may be written, never which integration is targeted.
  assert.deepEqual(done.entries, pending.entries); assert.equal(done.fingerprint, pending.fingerprint);
});

test("merge groups get a success only just in time; waiting groups get no write and health holds still fail", async () => {
  const groupDecision = (plan) => plan.decisions.find(d => d.entry.kind === "merge_group");
  const ready = groupDecision(await cycle());
  assert.deepEqual([ready.state, ready.decision, ready.requiredResult, ready.awaiting], ["success", "ordinary-admission-eligible", "success", null]);
  for (const result of ["pending", "failure", "unavailable", undefined]) {
    const waiting = groupDecision(await cycle({ census: { ...census(), requiredResults: result === undefined ? undefined : { [group]: result } } }));
    assert.deepEqual([waiting.state, waiting.decision, waiting.awaiting], ["none", "ordinary-admission-eligible", "required-result"], String(result));
  }
  // Stacked behind another group (its base is not main yet): waiting, not failed, so it is not ejected.
  const stacked = groupDecision(await cycle({ census: { ...census(), entries: [{ ...entry(), baseSha: head }] } }));
  assert.deepEqual([stacked.state, stacked.decision, stacked.reasons, stacked.awaiting], ["none", "hold", ["base-moved"], "queue-head"]);
  // Any health reason still writes failure, with or without its aggregator, stacked or not.
  for (const extra of [{ health: red() }, { health: red(), census: { ...census(), requiredResults: {} } },
    { health: red(), census: { ...census(), entries: [{ ...entry(), baseSha: head }] } }])
    assert.equal(groupDecision(await cycle(extra)).state, "failure");
  // Pull-request heads only gate enqueueing; their states are unchanged.
  const pr = { repository, kind: "pull_request", pullRequest: 7, headSha: head, baseSha: base, integrationSha: head };
  const prPlan = await cycle({ census: { ...census(), entries: [pr] } });
  assert.deepEqual([prPlan.decisions[0].state, "requiredResult" in prPlan.decisions[0]], ["success", false]);
  // An exact repair is also admitted only after its own aggregator succeeded.
  const repairing = { health: red(), grant: grant(), verifyAuthority, verifyChecks };
  assert.equal(groupDecision(await cycle(repairing)).state, "success");
  const early = groupDecision(await cycle({ ...repairing, census: { ...census(), requiredResults: { [group]: "pending" } } }));
  assert.deepEqual([early.state, early.decision], ["none", "authorized-repair-eligible"]);
});

test("the writer skips waiting groups and refuses any group success without its aggregator", async () => {
  const configuration = { enabled: true, repository, context: ADMISSION_CONTEXT };
  const waiting = await cycle({ census: { ...census(), requiredResults: { [group]: "pending" } } });
  let posts = 0;
  const api = async (path, { body } = {}) => { if (path === "/rate_limit") return {}; posts++; return { id: posts, context: body.context, state: body.state }; };
  api.rateLimit = { limit: 5000, remaining: 4900 };
  const skipped = await writeAdmissionPlan(waiting, { configuration, api, now: () => at(12), revalidate: async () => waiting });
  assert.deepEqual([skipped.writes, skipped.attemptedWrites, skipped.capacity.plannedWrites, posts], [0, 0, 0, 0]);
  // A forged or stale decision claiming success for a group whose aggregator has not succeeded.
  for (const forged of [{ requiredResult: "pending" }, { requiredResult: undefined }, { requiredResult: "failure" }]) {
    const plan = structuredClone(waiting); Object.assign(plan.decisions[0], { state: "success", ...forged });
    posts = 0;
    await assert.rejects(writeAdmissionPlan(plan, { configuration, api, now: () => at(12), revalidate: async () => plan }));
    assert.equal(posts, 0, "rejected before any status request");
  }
});

test("writer refuses by default and rebuilt evidence is mandatory for the complete exact target set", async () => {
  const plan = await cycle();
  assert.deepEqual(await writeAdmissionPlan(plan, { api: () => assert.fail("default denies writes") }), { mode: "disabled", writes: 0 });
  const configuration = { enabled: true, repository, context: ADMISSION_CONTEXT };
  await assert.rejects(writeAdmissionPlan(plan, { configuration, api: () => assert.fail("no revalidation") }));
  let writes = 0, rebuilds = 0;
  const api = async (path, { body } = {}) => { if (path === "/rate_limit") return {};
    writes++; assert.equal(path, `/repos/${repository}/statuses/${group}`);
    return { id: writes, context: body.context, state: body.state }; };
  api.rateLimit = { limit: 5000, remaining: 4900 };
  const result = await writeAdmissionPlan(plan, { configuration, api, now: () => at(12),
    revalidate: async e => { rebuilds++; assert.deepEqual(e, { repository }); return cycle({ health: red(), now: at(12) }); } });
  assert.equal(result.mode, "operator-enabled"); assert.equal(result.writes, 1); assert.equal(rebuilds, 1);
  for (const fresh of [await cycle({ now: at(0) }), { ...plan, censusComplete: false },
    { ...plan, decisions: [{ ...plan.decisions[0], entry: { ...entry(), headSha: group } }] },
    { ...plan, decisions: [{ ...plan.decisions[0], expiresAt: at(12) }] }]) {
    let attemptedWrites = 0;
    const noWrite = async path => { if (path !== "/rate_limit") attemptedWrites++; return {}; };
    noWrite.rateLimit = { limit: 5000, remaining: 4900 };
    await assert.rejects(writeAdmissionPlan(plan, { configuration, api: noWrite,
      now: () => at(fresh.evaluatedAt === at(0) ? 60 : 12), revalidate: async () => fresh }));
    assert.equal(attemptedWrites, 0, "invalid evidence must be rejected before a status request");
  }
  let invalidClockWrites = 0;
  const noWrite = async path => { if (path !== "/rate_limit") invalidClockWrites++; return {}; };
  noWrite.rateLimit = { limit: 5000, remaining: 4900 };
  await assert.rejects(writeAdmissionPlan(plan, { configuration, api: noWrite,
    now: () => "invalid-clock", revalidate: async () => plan }));
  assert.equal(invalidClockWrites, 0, "invalid clock must be rejected before a status request");
});

test("rollback cannot propose hold removal before full queue validation and separate exact approval", () => {
  const first = planRollback({ repository, operatorApproval: { approved: true } });
  assert.equal(first.decision, "restore-full-queue-validation-first"); assert.equal(first.holdRetained, true);
  const proof = { repository, verified: true, coverage: "full-merge-group-v1", requiredContext: "Typecheck, Test & Sidecar Bundle", workflowSha: base };
  const restored = planRollback({ repository, fullQueueProof: proof });
  assert.equal(restored.decision, "operator-hold-removal-approval-required");
  const approved = planRollback({ repository, fullQueueProof: proof, operatorApproval: { repository, approved: true,
    action: "remove-admission-hold", fullQueueProofDigest: restored.fullQueueProofDigest } });
  assert.equal(approved.decision, "operator-hold-removal-planned"); assert.equal(approved.holdRetained, true);
  assert.equal(approved.enforcement, "none");
});

test("the CLI has no enabled mode and cannot construct a status-writing capability", async () => {
  for (const value of [undefined, "", "disabled", "enabled", "enforce", "Dry-Run"]) {
    assert.equal(await main({ env: { MAIN_MERGE_ADMISSION_CONTROLLER: value }, api: () => assert.fail("off must do no work") }), 0);
  }
});

// The old per-target rebuild spends 37 reads repeatedly and fails after two
// writes. This exercises the actual adapter with the same expensive callback.
function batch(count) {
  const c = census();
  c.entries = Array.from({ length: count }, (_, i) => ({ ...entry(), pullRequest: i + 1,
    integrationSha: (i + 1).toString(16).padStart(40, "0"),
    members: [{ pullRequest: i + 1, headSha: head }] }));
  c.requiredResults = Object.fromEntries(c.entries.map(e => [e.integrationSha, "success"]));
  return c;
}
function inertApi(limit = 5000, remaining = limit) {
  const statuses = [];
  const api = async (path, { body } = {}) => {
    api.rateLimit.remaining--;
    if (path.includes("/statuses/")) {
      statuses.push({ path, body });
      return { id: statuses.length, context: body.context, state: body.state };
    }
    return {};
  };
  api.rateLimit = { limit, remaining };
  return { api, statuses };
}
const enabled = { enabled: true, repository, context: ADMISSION_CONTEXT };

test("one independent rebuild covers all 45 holds inside the unchanged 96-call budget", async () => {
  const plan = await cycle({ census: batch(45), health: red() });
  const { api, statuses } = inertApi();
  let rebuilds = 0;
  const result = await writeAdmissionPlan(plan, { configuration: enabled, api, now: () => at(12),
    revalidate: async (_request, { api: bounded }) => {
      rebuilds++;
      for (let i = 0; i < 37; i++) await bounded(`/inert-health-read/${i}`);
      return plan;
    } });
  assert.equal(rebuilds, 1);
  assert.equal(statuses.length, 45);
  assert.ok(statuses.every(s => s.body.state === "failure"));
  assert.equal(result.writes, 45);
  assert.equal(result.apiBudget.calls, 83); // 1 quota + 37 rebuild + 45 status
  assert.equal(result.apiBudget.limit, 96);
});

test("budget/quota arithmetic admits the entire batch or refuses before every status write", async () => {
  await fc.assert(fc.asyncProperty(fc.record({ count: fc.integer({ min: 0, max: 100 }),
    reads: fc.integer({ min: 0, max: 40 }), large: fc.boolean(), headroom: fc.integer({ min: 0, max: 110 }) }),
  async ({ count, reads, large, headroom }) => {
    const limit = large ? 5000 : 1000, floor = Math.ceil(limit * 0.6), callLimit = large ? 96 : 48;
    const plan = await cycle({ census: batch(count), health: red() });
    const { api, statuses } = inertApi(limit, floor + reads + 1 + headroom);
    const available = Math.min(callLimit - reads - 1, headroom);
    let rebuilds = 0;
    const operation = writeAdmissionPlan(plan, { configuration: enabled, api, now: () => at(12),
      revalidate: async (_request, { api: bounded }) => {
        rebuilds++;
        for (let i = 0; i < reads; i++) await bounded(`/inert-read/${i}`);
        return plan;
      } });
    if (count <= available) {
      const result = await operation;
      assert.equal(result.writes, count);
      assert.equal(result.apiBudget.calls, reads + 1 + count);
      assert.equal(result.capacity.writesAvailable, available);
    } else {
      await assert.rejects(operation, e => {
        assert.equal(e.writes, 0);
        assert.equal(e.capacity.shortfall, count - available);
        assert.equal(e.capacity.callsUsed, reads + 1);
        assert.equal(e.capacity.callLimit, callLimit);
        assert.equal(e.apiBudget.calls, reads + 1);
        return true;
      });
    }
    assert.equal(rebuilds, 1);
    assert.equal(statuses.length, count <= available ? count : 0);
  }), { numRuns: 100, examples: [[{ count: 45, reads: 37, large: true, headroom: 100 }],
    [{ count: 45, reads: 37, large: false, headroom: 100 }]] });
});

test("late target changes, missing/additional targets and duplicates reject the entire batch", async () => {
  const plan = await cycle({ census: batch(3) });
  for (const edit of [p => { p.decisions[2].entry.headSha = group; }, p => { p.decisions.pop(); },
    p => { p.decisions.push(p.decisions[0]); }, p => { p.decisions[2] = p.decisions[0]; },
    p => { p.decisions[2].context = "other"; }, p => { p.decisions[2].expiresAt = at(12); }]) {
    const fresh = structuredClone(plan); edit(fresh);
    const { api, statuses } = inertApi();
    await assert.rejects(writeAdmissionPlan(plan, { configuration: enabled, api, now: () => at(12), revalidate: async () => fresh }));
    assert.equal(statuses.length, 0);
  }
});

test("a shared rebuild cannot lend an expired grant or observation to later writes", async () => {
  for (const boundary of ["grant", "cycle"]) {
    const plan = await cycle({ census: batch(3) });
    if (boundary === "grant") plan.decisions[1].expiresAt = at(13);
    const { api: transport, statuses } = inertApi();
    let clock = at(12);
    const api = async (...args) => {
      const result = await transport(...args);
      if (statuses.length === 1) clock = boundary === "grant" ? at(13) : at(71);
      return result;
    };
    Object.defineProperty(api, "rateLimit", { get: () => transport.rateLimit });
    const audit = [];
    await assert.rejects(writeAdmissionPlan(plan, { configuration: enabled, api, now: () => clock,
      revalidate: async () => plan, log: line => audit.push(JSON.parse(line)) }), e => e.writes === 1);
    assert.equal(statuses.length, 1);
    assert.equal(audit.at(-1).complete, false);
    assert.equal(audit.at(-1).writes, 1);
  }
});

test("shared live rebuild performs one health report then one complete census, retaining failure evidence", async () => {
  let reports = 0, queries = 0;
  const report = async (argv, options) => {
    reports++;
    assert.deepEqual(argv, ["report"]);
    assert.equal(options.env.GITHUB_REF, "refs/heads/main");
    assert.equal(options.now(), at(11), "the rebuild's clock reaches the health observer");
    await options.api("/inert-health");
    options.log(JSON.stringify(red())); return 0;
  };
  let mainSha = base;
  const api = async path => {
    if (path === "/inert-health") return {};
    assert.equal(path, "/graphql"); queries++;
    assert.equal(reports, queries, "one independent health rebuild precedes each census");
    return { data: { repository: { defaultBranchRef: { name: "main", target: { oid: mainSha } },
      pullRequests: { pageInfo: { hasNextPage: false }, nodes: [{ number: 42, isDraft: false,
        headRefOid: head, baseRefOid: mainSha, mergeQueueEntry: null }] } } } };
  };
  const options = { repository, api, report, control: control(), now: () => at(11) };
  const failed = await rebuildAdmissionCycle(options);
  assert.equal(failed.decisions[0].state, "failure"); assert.equal(failed.decisions[0].plannedBlockLatencyMs, 1000);
  assert.equal(reports, 1); assert.equal(queries, 1);
  mainSha = group;
  const moved = await rebuildAdmissionCycle(options);
  assert.ok(moved.reasons.includes("main-observation-changed"));
  assert.equal(moved.decisions[0].state, "failure");
  assert.equal(reports, 2); assert.equal(queries, 2);
  const unavailable = await rebuildAdmissionCycle({ ...options, report: async (_args, { log }) => {
    log(JSON.stringify(health())); return 1;
  }, api: async () => ({ data: { repository: { defaultBranchRef: { name: "main", target: { oid: base } },
    pullRequests: { pageInfo: { hasNextPage: false }, nodes: [{ number: 42, isDraft: false,
      headRefOid: head, baseRefOid: base, mergeQueueEntry: null }] } } } }) });
  assert.equal(unavailable.healthSummary.status, "unknown");
  assert.equal(unavailable.decisions[0].state, "failure", "nonzero report cannot lend a passing projection");
});
