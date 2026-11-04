import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { ADMISSION_CONTEXT, GATE_ENABLED, GATE_VARIABLE, REQUIRED_CONTEXT, ROLLBACK_VALUE, admissionEnforcement,
  computeMergeGroupGate, gateDecision, main } from "./ci-merge-group-gate.mjs";
import { ADMISSION_CONTEXT as CONTROLLER_CONTEXT } from "./main-merge-admission-controller.mjs";

const main_ = "a".repeat(40), tested = "b".repeat(40);
const activeRules = [
  { type: "merge_queue", parameters: {} },
  { type: "required_status_checks", parameters: { required_status_checks: [{ context: REQUIRED_CONTEXT, integration_id: 15368 }] } },
  { type: "required_status_checks", parameters: { required_status_checks: [{ context: ADMISSION_CONTEXT, integration_id: 4242 }] } },
];
const selection = { mode: "fast", reasons: [], risks: [], context: { event: "merge_group", diffKind: "combined-merge-group",
  baseSha: main_, diffBaseSha: main_, trustedPolicySha: main_, testedSha: tested, changeHeadSha: tested } };
const proposal = { gate: "enabled", event: "merge_group", trustedMainSha: main_, testedSha: tested, workflowMatches: true,
  selection, enforcement: admissionEnforcement(activeRules) };

test("the gate names the documented variable, rollback value and #3633's enforced admission context", () => {
  assert.equal(GATE_VARIABLE, "CI_MERGE_GROUP_GATE");
  assert.equal(GATE_ENABLED, "enabled");
  assert.equal(ROLLBACK_VALUE, "disabled");
  assert.equal(ADMISSION_CONTEXT, CONTROLLER_CONTEXT);
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.ok(workflow.includes(`vars.${GATE_VARIABLE} == '${GATE_ENABLED}'`));
});

test("only an active ruleset requiring the merge queue, the full context and a pinned admission issuer is enforcement", () => {
  assert.deepEqual(admissionEnforcement(activeRules), { active: true, reason: null });
  const without = (predicate) => activeRules.map((rule) => ({ ...rule, parameters: { ...rule.parameters,
    required_status_checks: rule.parameters.required_status_checks?.filter((check) => !predicate(check)) } }));
  for (const [rules, reason] of [
    [null, "admission-rules-unavailable"], [{}, "admission-rules-unavailable"], [Array(101).fill(activeRules[0]), "admission-rules-unavailable"],
    [[], "merge-queue-not-required"], [activeRules.slice(1), "merge-queue-not-required"],
    [without((check) => check.context === REQUIRED_CONTEXT), "full-context-not-required"],
    [without((check) => check.context === ADMISSION_CONTEXT), "admission-context-not-required"],
    // Dry run alone (the advisory shadow) changes no ruleset and is therefore never enforcement.
    [activeRules.slice(0, 2), "admission-context-not-required"],
  ]) assert.deepEqual(admissionEnforcement(rules), { active: false, reason }, reason);
  for (const integration_id of [null, undefined, 0, -1, "4242", 1.5]) {
    const rules = [...activeRules.slice(0, 2), { type: "required_status_checks", parameters: { required_status_checks: [{ context: ADMISSION_CONTEXT, integration_id }] } }];
    assert.deepEqual(admissionEnforcement(rules), { active: false, reason: "admission-issuer-unpinned" }, String(integration_id));
    // Any unpinned duplicate entry also refuses: another app could satisfy that requirement.
    assert.equal(admissionEnforcement([...activeRules, rules[2]]).active, false);
  }
});

test("only the exact enabled gate with every precondition reduces a merge group; everything else is full", () => {
  assert.deepEqual(gateDecision(proposal), { mode: "fast", reasons: [] });
  assert.deepEqual(gateDecision(), { mode: "full", reasons: ["gate-disabled", "non-merge-group-full", "admission-rules-unavailable",
    "workflow-changed-or-unavailable", "selection-context-unavailable"] });
  for (const gate of [undefined, "", "disabled", "Enabled", "ENABLED", "enabled ", "true", "fast"]) {
    assert.deepEqual(gateDecision({ ...proposal, gate }), { mode: "full", reasons: ["gate-disabled"] }, String(gate));
  }
  for (const event of ["pull_request", "push", "workflow_dispatch", "workflow_call"]) {
    assert.equal(gateDecision({ ...proposal, event }).mode, "full", event);
  }
  for (const enforcement of [undefined, null, { active: "true" }, admissionEnforcement(activeRules.slice(0, 2))]) {
    assert.equal(gateDecision({ ...proposal, enforcement }).mode, "full");
  }
  assert.deepEqual(gateDecision({ ...proposal, workflowMatches: undefined }).reasons, ["workflow-changed-or-unavailable"]);
  assert.deepEqual(gateDecision({ ...proposal, workflowMatches: false }).reasons, ["workflow-changed-or-unavailable"]);
  for (const mode of ["affected", "full", "unknown", undefined]) {
    assert.deepEqual(gateDecision({ ...proposal, selection: { ...selection, mode } }).reasons, ["full-or-affected-closure"]);
  }
  for (const change of [{ reasons: ["incomplete-diff"] }, { reasons: undefined }, { risks: ["runner-execution"] },
    { risks: ["ordinary", "security-and-approval"] }, { risks: undefined }]) {
    assert.deepEqual(gateDecision({ ...proposal, selection: { ...selection, ...change } }).reasons, ["uncertain-risk"]);
  }
  for (const field of ["event", "diffKind", "baseSha", "diffBaseSha", "trustedPolicySha", "testedSha", "changeHeadSha"]) {
    const changed = { ...proposal, selection: { ...selection, context: { ...selection.context, [field]: "c".repeat(40) } } };
    assert.deepEqual(gateDecision(changed).reasons, ["selection-context-unavailable"], field);
  }
  for (const value of [{ selection: null }, { trustedMainSha: "short" }, { testedSha: undefined }]) {
    assert.deepEqual(gateDecision({ ...proposal, ...value }).reasons, ["selection-context-unavailable"]);
  }
});

test("the live gate does no work unless exactly enabled on a merge group and fails closed to full", async () => {
  const refuse = () => { throw new Error("must not read"); };
  for (const GATE_SWITCH of [undefined, "", "Enabled", "ENABLED", "disabled", "enabled "]) {
    assert.deepEqual(await computeMergeGroupGate({ env: { GATE_SWITCH, GITHUB_EVENT_NAME: "merge_group" }, cwd: "/unavailable", api: refuse }),
      { mode: "full", reasons: ["gate-disabled"] });
  }
  for (const event of ["pull_request", "push", "workflow_dispatch"]) {
    assert.deepEqual(await computeMergeGroupGate({ env: { GATE_SWITCH: "enabled", GITHUB_EVENT_NAME: event }, api: refuse }),
      { mode: "full", reasons: ["non-merge-group-full"] });
  }
  assert.deepEqual(await computeMergeGroupGate({ env: { GATE_SWITCH: "enabled", GITHUB_EVENT_NAME: "merge_group" }, cwd: "/unavailable", api: refuse }),
    { mode: "full", reasons: ["gate-unavailable"] });
});

test("Git-object gate evaluation uses trusted main and the combined group diff", async (t) => {
  const { FAST_API_FILES, CRITICAL_BROWSER_FILES, FAST_PROSE_FILES } = await import("./ci-suite-policy.mjs");
  const { fastFiles } = JSON.parse(readFileSync("docs/ci-node-profile-2026-10-23.json", "utf8"));
  const cwd = mkdtempSync(join(tmpdir(), "ci-merge-group-gate-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const put = (path, text) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), text); };
  git("init", "-q"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  for (const file of [...fastFiles, ...FAST_API_FILES, ...CRITICAL_BROWSER_FILES.map((file) => `apps/web/e2e/${file}`),
    FAST_PROSE_FILES[0], ".github/workflows/ci.yml", "apps/web/src/ordinary.ts"]) put(file, "fixture\n");
  git("add", "."); git("commit", "-qm", "main");
  const trusted = git("rev-parse", "HEAD");
  const reads = [];
  const gate = async (edits, { rules = activeRules, env = {}, prior = [] } = {}) => {
    git("checkout", "-q", "--detach", trusted);
    // Earlier queued PRs in the same group are part of the combined diff from trusted main.
    for (const edit of [...prior, edits]) { edit(); git("add", "-A"); git("commit", "-qm", "queued"); }
    const head = git("rev-parse", "HEAD");
    git("checkout", "-q", "--detach", trusted);
    return computeMergeGroupGate({ cwd, api: async (path) => { reads.push(path); if (rules instanceof Error) throw rules; return rules; },
      env: { GATE_SWITCH: "enabled", GITHUB_EVENT_NAME: "merge_group", GITHUB_REPOSITORY: "owner/repo",
        TESTED_SHA: head, GITHUB_SHA: head, ...env } });
  };
  const prose = () => put(FAST_PROSE_FILES[0], `reviewed prose ${Math.random()}\n`);
  const fast = await gate(prose);
  assert.equal(fast.mode, "fast");
  assert.equal(fast.selection.context.trustedPolicySha, trusted);
  assert.deepEqual(reads, ["/repos/owner/repo/rules/branches/main?per_page=100"]);
  assert.deepEqual((await gate(prose, { rules: activeRules.slice(0, 2) })).reasons, ["admission-context-not-required"]);
  assert.deepEqual((await gate(prose, { rules: new Error("403") })).reasons, ["gate-unavailable"]);
  assert.deepEqual((await gate(() => put("apps/web/src/ordinary.ts", "source\n"))).reasons, ["full-or-affected-closure"]);
  assert.deepEqual((await gate(prose, { prior: [() => put("apps/web/src/ordinary.ts", "earlier queued source\n")] })).reasons,
    ["full-or-affected-closure"], "an earlier queued source change keeps the whole group full");
  assert.deepEqual((await gate(() => { prose(); put(".github/workflows/ci.yml", "hostile workflow\n"); })).reasons,
    ["workflow-changed-or-unavailable", "full-or-affected-closure"]);
  assert.deepEqual((await gate(prose, { env: { GITHUB_SHA: "f".repeat(40) } })).reasons, ["integration-unavailable"]);
  assert.deepEqual((await gate(prose, { env: { GITHUB_REPOSITORY: "not a repository" } })).reasons, ["integration-unavailable"]);
  // A group that does not descend from trusted main (main moved outside the queue) stays full.
  git("checkout", "-q", "--detach", trusted); put("unrelated.md", "x\n"); git("add", "-A"); git("commit", "-qm", "outside");
  const outside = git("rev-parse", "HEAD");
  git("checkout", "-q", "--detach", trusted); prose(); git("add", "-A"); git("commit", "-qm", "group");
  const group = git("rev-parse", "HEAD");
  git("checkout", "-q", "--detach", outside);
  const moved = await computeMergeGroupGate({ cwd, api: async () => activeRules, env: { GATE_SWITCH: "enabled",
    GITHUB_EVENT_NAME: "merge_group", GITHUB_REPOSITORY: "owner/repo", TESTED_SHA: group, GITHUB_SHA: group } });
  assert.equal(moved.mode, "full");
});

test("the CLI evaluates a proposed configuration offline and always derives enforcement from its rules", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ci-merge-group-gate-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "proposal.json");
  const run = async (value) => {
    writeFileSync(config, JSON.stringify(value));
    const lines = [];
    assert.equal(await main(["evaluate", "--config", config], { log: (line) => lines.push(line) }), 0);
    return JSON.parse(lines.at(-1));
  };
  const { enforcement: _, ...rest } = proposal;
  assert.equal((await run({ ...rest, rules: activeRules })).mode, "fast");
  const asserted = await run({ ...rest, rules: [], enforcement: { active: true } });
  assert.equal(asserted.mode, "full");
  assert.deepEqual(asserted.reasons, ["merge-queue-not-required"]);
  assert.deepEqual((await run({ ...rest, gate: ROLLBACK_VALUE, rules: activeRules })).reasons, ["gate-disabled"]);
  const output = join(dir, "output");
  writeFileSync(output, "");
  const lines = [];
  assert.equal(await main([], { env: { GATE_SWITCH: "Enabled", GITHUB_OUTPUT: output }, log: (line) => lines.push(line) }), 0);
  assert.equal(readFileSync(output, "utf8"), "mode=full\n");
  assert.deepEqual(JSON.parse(lines.at(-1)), { mode: "full", reasons: ["gate-disabled"] });
});
