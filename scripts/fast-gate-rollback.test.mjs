import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GATE_VARIABLE, ROLLBACK_VALUE } from "./ci-merge-group-gate.mjs";
import { evaluateRollbackTriggers, main, OBSERVATION_SCHEMA, PROPOSED_THRESHOLDS, REHEARSAL_THRESHOLDS, rehearseFastGateRollback,
  rollbackCommands, ROLLBACK_TRIGGERS } from "./fast-gate-rollback.mjs";
import { POLICY } from "./main-merge-admission.mjs";

const at = (minutes) => new Date(Date.UTC(2026, 10, 2, 15) + minutes * 60_000).toISOString();
const healthy = (overrides = {}) => ({ schema: OBSERVATION_SCHEMA, repository: "owner/repo", observedAt: at(0), controllerAvailable: true,
  validatorUnavailableSince: null, escapes: [], health: { status: "passing", reasons: [], backlog: { commits: 0, oldestUnvalidatedAgeSeconds: 0 } },
  integrations: Array.from({ length: 20 }, () => ({ eligible: true, passing: true, expiredMissingRequired: false, requiredMinutes: 9 })), ...overrides });
const ids = (result) => result.triggers.map((row) => row.id);

test("the rehearsal drives every trigger through rollback, restoration proof and planRollback without the network", async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("The rollback rehearsal must never reach the network"); };
  t.after(() => { globalThis.fetch = realFetch; });
  const report = await rehearseFastGateRollback();
  assert.equal(report.enforcement, "none"); assert.equal(report.liveMutations, 0);
  assert.deepEqual(report.scenarios.map((s) => s.trigger), ROLLBACK_TRIGGERS.map((row) => row.id));
  for (const scenario of report.scenarios) for (const step of scenario.steps)
    assert.ok(step.match, `${scenario.trigger}: ${step.step} expected ${JSON.stringify(step.expected)}, got ${JSON.stringify(step.actual)}`);
  assert.deepEqual(report.summary, { scenarios: 6, passed: 6, steps: 66, pass: true });
  assert.deepEqual(report.checks.liveAdapterAtRollbackValue, { mode: "full", reasons: ["gate-disabled"] });
  assert.deepEqual(report.checks.unapprovedThresholdsRollBack, ["thresholds-unapproved"]);
  assert.equal(JSON.stringify(report), JSON.stringify(await rehearseFastGateRollback()), "deterministic");
  // Order is the contract: no hold-removal plan precedes a verified full proof.
  for (const scenario of report.scenarios) {
    const order = scenario.steps.map((s) => s.step);
    assert.ok(order.indexOf("hold removal refused without fullQueueProof") < order.indexOf("the newest completed group after the switch-back certifies full queue validation"));
    assert.equal(order.at(-1), "only then may the operator remove the health-policy hold; full CI stays required");
  }
});

test("unapproved, malformed or unreadable inputs always roll back", () => {
  assert.equal(PROPOSED_THRESHOLDS.approved, false);
  assert.deepEqual(ids(evaluateRollbackTriggers(healthy(), PROPOSED_THRESHOLDS)), ["thresholds-unapproved"]);
  for (const broken of [undefined, {}, { ...REHEARSAL_THRESHOLDS, version: 2 }, { ...REHEARSAL_THRESHOLDS, maxRecoveryMinutes: "240" },
    { ...REHEARSAL_THRESHOLDS, maxDetectionMinutes: -1 }]) assert.deepEqual(ids(evaluateRollbackTriggers(healthy(), broken)), ["thresholds-unapproved"]);
  for (const observation of [undefined, {}, healthy({ schema: "other" }), healthy({ observedAt: "yesterday" }), healthy({ integrations: null }),
    healthy({ repository: "not-a-repository" }), healthy({ health: null })]) assert.deepEqual(ids(evaluateRollbackTriggers(observation, REHEARSAL_THRESHOLDS)), ["observation-unavailable"]);
});

test("thresholds are boundaries: equality keeps the gate, the next step beyond it rolls back", () => {
  const evaluate = (overrides) => evaluateRollbackTriggers(healthy(overrides), REHEARSAL_THRESHOLDS);
  assert.equal(evaluate({}).rollback, false);
  const latency = (minutes) => healthy().integrations.map((row, i) => i < 2 ? { ...row, requiredMinutes: minutes } : row);
  assert.equal(evaluate({ integrations: latency(15) }).requiredLatencyP90Minutes, 9, "two slow of twenty is the p90 boundary");
  assert.equal(evaluate({ integrations: healthy().integrations.map((row, i) => i < 3 ? { ...row, requiredMinutes: 15 } : row) }).rollback, false);
  assert.deepEqual(ids(evaluate({ integrations: healthy().integrations.map((row, i) => i < 3 ? { ...row, requiredMinutes: 15.1 } : row) })), ["required-latency-breach"]);
  // Ineligible (high-risk full-fallback) integrations are outside the ordinary-change target.
  assert.equal(evaluate({ integrations: [...healthy().integrations, ...Array(10).fill({ eligible: false, passing: true, requiredMinutes: 60 })] }).rollback, false);
  assert.deepEqual(ids(evaluate({ integrations: [...healthy().integrations, { eligible: true, passing: true, expiredMissingRequired: true, requiredMinutes: null }] })),
    ["required-latency-breach"], "one all-green expiry is a breach regardless of sample size");
  const sparse = evaluate({ integrations: healthy().integrations.slice(0, 19) });
  assert.equal(sparse.rollback, false); assert.equal(sparse.requiredLatencyP90Minutes, null);
  assert.deepEqual(sparse.incomplete.map((row) => row.id), ["required-latency-breach"], "insufficient traffic is incomplete, never passing");
  const escape = (landed, detected, recovered = null, detectedBy = "rolling") => ({ detectedBy, landedAt: at(landed), detectedAt: detected === null ? null : at(detected),
    recoveredAt: recovered === null ? null : at(recovered) });
  assert.equal(evaluate({ escapes: [escape(-120, null)] }).rollback, false, "exactly 120 minutes undetected is within the bound");
  assert.deepEqual(ids(evaluate({ escapes: [escape(-121, null)] })), ["detection-beyond-bound"]);
  assert.equal(evaluate({ escapes: [escape(-300, -240)] }).rollback, false, "exactly 240 minutes unrecovered is within the bound");
  assert.deepEqual(ids(evaluate({ escapes: [escape(-300, -241)] })), ["recovery-beyond-bound"]);
  assert.equal(evaluate({ escapes: [escape(-60, -20, -5)] }).rollback, false, "one rolling-detected, recovered escape is within the proposal");
  assert.deepEqual(ids(evaluate({ escapes: [escape(-60, -20, -5), escape(-30, -2)] })), ["missed-regression-or-escape"]);
  assert.deepEqual(ids(evaluate({ escapes: [escape(-60, -20, -5, "human")] })), ["missed-regression-or-escape"]);
  const unknown = (since) => ({ validatorUnavailableSince: since, health: { status: "unknown", reasons: ["api-budget-exhausted"], backlog: null } });
  assert.equal(evaluate(unknown(at(-29))).rollback, false);
  assert.deepEqual(ids(evaluate(unknown(at(-30)))), ["validator-outage"]);
  assert.deepEqual(ids(evaluate(unknown(null))), ["validator-outage"], "an outage of unknown length is not bounded");
  assert.deepEqual(ids(evaluate({ controllerAvailable: false, validatorUnavailableSince: at(-45) })), ["validator-outage"]);
  assert.deepEqual(ids(evaluate({ health: { status: "passing", reasons: [], backlog: null } })), ["validator-outage"]);
  // The hold point is #3633's threshold; only beyond it did holds fail to bound the backlog.
  const backlog = (commits, age) => ({ health: { status: "pending", reasons: [], backlog: { commits, oldestUnvalidatedAgeSeconds: age } } });
  assert.equal(evaluate(backlog(POLICY.maxUnvalidatedCommits, POLICY.maxUnvalidatedAgeSeconds)).rollback, false);
  assert.deepEqual(ids(evaluate(backlog(POLICY.maxUnvalidatedCommits + 1, 0))), ["backlog-beyond-limit"]);
  assert.deepEqual(ids(evaluate(backlog(1, POLICY.maxUnvalidatedAgeSeconds + 1))), ["backlog-beyond-limit"]);
  assert.equal(PROPOSED_THRESHOLDS.maxDetectionMinutes, POLICY.maxUnvalidatedAgeSeconds / 60);
});

test("rollback commands name the gate variable and value, and the workflow admits the gate only for the exact enabled value", () => {
  const commands = rollbackCommands("picoduck/wollipog");
  assert.equal(commands.set, `gh variable set ${GATE_VARIABLE} --repo picoduck/wollipog --body ${ROLLBACK_VALUE}`);
  assert.equal(commands.readBack, `gh api repos/picoduck/wollipog/actions/variables/${GATE_VARIABLE} --jq '[.value, .updated_at] | @tsv'`);
  assert.match(commands.verify, /ci-merge-group-restoration\.mjs --repository picoduck\/wollipog --since .* --trusted-ref /);
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.match(workflow, /\n  merge_group_gate:\n    if: github\.event_name == 'merge_group' && vars\.CI_MERGE_GROUP_GATE == 'enabled'\n/);
});

test("the CLI evaluates triggers, plans only from a saved proof and refuses unknown commands", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fast-gate-rollback-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name, value) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(value)); return path; };
  const out = [];
  const run = (argv) => main(argv, { log: (line) => out.push(line), error: (line) => out.push(line) });
  assert.equal(await run(["triggers", "--observation", write("ok.json", healthy()), "--thresholds", write("t.json", REHEARSAL_THRESHOLDS)]), 0);
  assert.equal(await run(["triggers", "--observation", write("ok.json", healthy()), "--thresholds", write("p.json", PROPOSED_THRESHOLDS)]), 1);
  assert.equal(await run(["plan", "--repository", "owner/repo", "--proof", write("proof.json", { verified: false })]), 0);
  assert.equal(JSON.parse(out.at(-1)).decision, "restore-full-queue-validation-first");
  assert.equal(await run(["plan", "--repository", "owner/repo"]), 2);
  assert.equal(await run(["remove-hold", "--repository", "owner/repo"]), 2);
  assert.equal(await run(["plan", "--unknown"]), 2);
  assert.equal(await run(["rehearse", join(dir, "out.json")]), 0);
  assert.equal(JSON.parse(readFileSync(join(dir, "out.json"), "utf8")).summary.pass, true);
});
