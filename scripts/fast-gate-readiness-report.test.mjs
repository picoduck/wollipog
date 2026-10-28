import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ADMISSION_CONTEXT, admissionEnforcement, REQUIRED_CONTEXT } from "./ci-merge-group-gate.mjs";
import { ADMISSION_ISSUER_PLACEHOLDER, buildReadiness, holdKind, LIVE_SETTINGS, main, markdown, MEASUREMENTS, PROPOSAL,
  proposedRuleset, REPORT_PATH, RULESET_FIELDS, rulesetDrift } from "./fast-gate-readiness-report.mjs";
import { rehearseFastGateRollback } from "./fast-gate-rollback.mjs";
import { rehearseAdmissionLease } from "./rehearse-admission-lease.mjs";
import { rehearseFastGateCutover } from "./rehearse-fast-gate-cutover.mjs";

const live = JSON.parse(readFileSync(LIVE_SETTINGS, "utf8"));
let shared;
const inputs = async () => shared ??= { cutover: await rehearseFastGateCutover(), rollback: await rehearseFastGateRollback(),
  lease: await rehearseAdmissionLease() };

test("the committed dated report is exactly the generator's deterministic output, built without the network", async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("The readiness report must never reach the network"); };
  t.after(() => { globalThis.fetch = realFetch; });
  const errors = [];
  assert.equal(await main(["--check"], { error: (line) => errors.push(line) }), 0, errors.join("\n"));
  const [first, second] = [await buildReadiness(await inputs()), await buildReadiness(await inputs())];
  assert.equal(markdown(first), markdown(second));
  assert.equal(readFileSync(REPORT_PATH, "utf8"), markdown(first));
});

test("nothing passes by default: only computed evidence is met, and the verdict stays not ready", async () => {
  const report = await buildReadiness(await inputs());
  assert.equal(report.activationReady, false);
  assert.equal(report.liveMutations, 0);
  const ids = report.criteria.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const row of report.criteria) {
    const expected = { met: "met", "observation-gap": "incomplete", "approval-gap": "pending-approval", "code-gap": "open" }[row.classification];
    assert.ok(row.status === expected || row.classification === "code-gap" && row.status === "failing", `${row.id}: ${row.status}`);
  }
  const by = Object.fromEntries(report.criteria.map((row) => [row.id, row]));
  // AC3/AC4 have no post-activation sample: incomplete, never met.
  for (const id of ["rollout-window", "required-p90", "no-green-expiry", "first-real-gate-group", "prereq-3633-enforcement-bound"])
    assert.equal(by[id].classification, "observation-gap", id);
  for (const id of ["detection-backlog-recovery", "status-writing-identity", "agents-md-active", "reconcile-2674"])
    assert.equal(by[id].classification, "approval-gap", id);
  // Escalation delivery is met through the rehearsal's exactly-once step; configuring its target is an approval.
  assert.deepEqual([by["escalation-delivery"].status, by["escalation-target"].classification], ["met", "approval-gap"]);
  for (const id of ["capacity-backlog-limit", "capacity-zero-headroom", "planrollback-run-level-proof"])
    assert.equal(by[id].classification, "code-gap", id);
  // #3633 just-in-time admission closes the sticky-success code gap; its race and availability remain.
  assert.deepEqual([by["sticky-success"].classification, by["admission-landing-race"].classification,
    by["admission-outage-availability"].classification], ["met", "observation-gap", "approval-gap"]);
  for (const flow of report.rehearsals.cutover.flows) assert.equal(by[`ac2-${flow.id}`].status, "met", flow.id);
  assert.deepEqual(Object.values(report.counts).reduce((a, b) => a + b, 0), report.criteria.length);
});

test("a failing rehearsal flow or rollback scenario is reported as a failing code gap, never met", async () => {
  const { cutover, rollback, lease } = await inputs();
  const broken = structuredClone(cutover);
  broken.flows[0].pass = false; broken.flows[0].steps[0].match = false;
  broken.flows.find((flow) => flow.id === "exhausted-investigation-budget").steps
    .find((step) => step.step === "each exhaustion reaches the open incident exactly once").match = false;
  const brokenRollback = structuredClone(rollback);
  brokenRollback.summary.pass = false;
  brokenRollback.scenarios[0].steps.find((step) => step.step === "every unverified, reduced, forged or foreign proof is refused").match = false;
  const brokenLease = structuredClone(lease); brokenLease.summary.pass = false;
  const report = await buildReadiness({ cutover: broken, rollback: brokenRollback, lease: brokenLease });
  const by = Object.fromEntries(report.criteria.map((row) => [row.id, row]));
  for (const id of [`ac2-${broken.flows[0].id}`, "rollback-triggers", "restore-before-hold-removal", "sticky-success", "escalation-delivery"]) {
    assert.equal(by[id].classification, "code-gap", id); assert.equal(by[id].status, "failing", id);
  }
});

test("capacity findings are computed from the delivered rehearsals", async () => {
  const { capacity } = await buildReadiness(await inputs());
  assert.deepEqual(capacity.healthReportCallsByBacklog.map((row) => [row.backlog, row.calls]), [[1, 35], [2, 42], [3, 47], [4, 52], [5, 57]]);
  assert.deepEqual([capacity.backlogLimitWriterCallsUsed, capacity.backlogLimitWritesAvailable, capacity.fanoutTargetsFitted], [55, 41, 45]);
  assert.deepEqual([capacity.batched45Calls, capacity.callCap, capacity.batched46Writes], [96, 96, 0], "#3711: zero headroom");
  assert.ok(capacity.rehearsalHolds.baseMovedOnly > 0 && capacity.rehearsalHolds.healthOrPolicy > 0);
});

test("the proposed ruleset adds only an issuer-pinned admission context, and the unfilled template fails closed", async () => {
  const body = proposedRuleset(live);
  // The body comes from the target ruleset's own rules; the effective branch rules are only evidence.
  const liveRules = live.ruleset.rules;
  assert.deepEqual([...new Set(live.branchRules.map((rule) => rule.ruleset_id))], [live.ruleset.id], "every effective main rule is owned by the target ruleset");
  const checks = (rules) => rules.find((rule) => rule.type === "required_status_checks").parameters.required_status_checks;
  assert.deepEqual(checks(body.rules), [...checks(liveRules), { context: ADMISSION_CONTEXT, integration_id: ADMISSION_ISSUER_PLACEHOLDER }]);
  assert.deepEqual(body.rules.filter((rule) => rule.type !== "required_status_checks"), liveRules.filter((rule) => rule.type !== "required_status_checks"));
  assert.deepEqual(checks(body.rules)[0], { context: REQUIRED_CONTEXT, integration_id: 15368 });
  assert.deepEqual(body.bypass_actors, live.ruleset.bypass_actors);
  assert.deepEqual(admissionEnforcement(body.rules), { active: false, reason: "admission-issuer-unpinned" });
  assert.deepEqual(admissionEnforcement(proposedRuleset(live, 4242).rules), { active: true, reason: null });
  assert.throws(() => proposedRuleset({ ...live, ruleset: { ...live.ruleset, rules: proposedRuleset(live, 1).rules } }), /Unexpected live ruleset/);
  assert.throws(() => proposedRuleset({ ...live, ruleset: { ...live.ruleset, id: 1 } }), /Unexpected live ruleset/);
  // A rule only present in the effective branch rules (another ruleset) is never copied into this body.
  const foreign = { ...live, branchRules: [...live.branchRules, { type: "creation", ruleset_id: 1, parameters: null }] };
  assert.deepEqual(proposedRuleset(foreign), body);
  // The operator proposal embeds exactly this body.
  assert.ok(readFileSync(PROPOSAL, "utf8").includes(JSON.stringify(body, null, 2)));
  // The snapshot retains variable names only and finds every CI switch absent.
  assert.deepEqual(live.gateVariables, { CI_MERGE_GROUP_GATE: null, CI_REGRESSION_ADMISSION: null, CI_PR_SUITE_ROUTING: null });
});

test("any drift in a field the PUT replaces blocks applying the body (#3759 review)", () => {
  const fresh = { ...structuredClone(live.ruleset), id: live.ruleset.id, updated_at: "2026-11-01T00:00:00Z", _links: {}, current_user_can_bypass: "never" };
  assert.deepEqual(rulesetDrift(fresh, live), [], "read-only metadata is not drift");
  for (const field of RULESET_FIELDS) {
    const changed = structuredClone(fresh);
    changed[field] = field === "bypass_actors" ? [] : field === "rules" ? changed.rules.slice(1) : field === "conditions" ? { ref_name: { include: [], exclude: [] } } : "changed";
    assert.deepEqual(rulesetDrift(changed, live), [field], field);
  }
  // Every field the body replaces is covered by the drift check, and the proposal runs it before the PUT.
  assert.deepEqual(Object.keys(proposedRuleset(live)).sort(), [...RULESET_FIELDS].sort());
  const proposal = readFileSync(PROPOSAL, "utf8");
  assert.ok(proposal.indexOf("diff ruleset-now.json ruleset-snapshot.json") < proposal.indexOf("gh api -X PUT repos/picoduck/wollipog/rulesets/22200037"));
  assert.ok(proposal.includes("fields='{name, target, enforcement, conditions, bypass_actors, rules: [.rules[] | {type, parameters}]}'"));
});

test("every quoted measurement still appears verbatim in its committed source", () => {
  for (const row of MEASUREMENTS) assert.ok(readFileSync(row.source, "utf8").includes(row.quote), `${row.id} drifted from ${row.source}`);
});

test("holds whose only reason is a moved base are counted apart from health holds", () => {
  assert.equal(holdKind({ decision: "hold", reasons: ["base-moved"] }), "base-moved");
  assert.equal(holdKind({ decision: "hold", reasons: ["base-moved", "unvalidated-backlog-limit"] }), "health-or-policy");
  assert.equal(holdKind({ decision: "hold", reasons: [] }), "health-or-policy", "an unexplained hold is never a re-sync artifact");
  assert.equal(holdKind({ decision: "ordinary-admission-eligible", reasons: [] }), null);
});
