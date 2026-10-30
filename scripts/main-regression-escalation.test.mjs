import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inertForge, REPOSITORY } from "./fast-gate-rehearsal-forge.mjs";
import { emptyState, readState, writeState } from "./main-regression-automation.mjs";
import { API_LIMIT, deliverEscalation, escalationBody, escalationMarker, main, MAX_COMMENT_PAGES, parseMentions,
  pendingEscalation } from "./main-regression-escalation.mjs";

const candidate = (attempt = 1) => ({ runId: 7101, attempt, testedSha: "a".repeat(40), suiteVersion: "b".repeat(64),
  passingSha: "c".repeat(40), observedAt: 1_793_000_000_000 });
const exhausted = (blocked, attempt = 1) => ({ ...emptyState(REPOSITORY), seen: [`${"a".repeat(40)}:${"b".repeat(64)}`], blocked,
  active: { ...candidate(attempt), createdAt: 1_793_000_000_000, tries: 3, lastSentAt: 1_793_000_000_000, stopTries: 0,
    invocationId: null, executionId: null } });
async function world(state) {
  const w = inertForge();
  if (state) await writeState(w.api, REPOSITORY, await readState(w.api, REPOSITORY), state);
  return w;
}
const mentions = ["@fixture/maintainers"];

test("the target is disabled unless explicitly configured, and only users or teams are accepted", () => {
  for (const value of [undefined, null, "", "  "]) assert.deepEqual(parseMentions(value), { enabled: false, mentions: [] });
  assert.deepEqual(parseMentions("@alice"), { enabled: true, mentions: ["@alice"] });
  assert.deepEqual(parseMentions("@picoduck/maintainers, @alice @alice"), { enabled: true, mentions: ["@picoduck/maintainers", "@alice"] });
  for (const value of ["alice", "@", "@-x", "@a/b/c", "@alice <!-- x -->", "@everyone!", "@a @b @c @d @e @f", "@x](https://evil)"])
    assert.deepEqual(parseMentions(value), { enabled: false, mentions: [], invalid: true }, value);
});

test("only an exhausted investigation with its exact run and attempt is an escalation", () => {
  for (const reason of ["delivery-exhausted", "elapsed-exhausted"])
    assert.deepEqual(pendingEscalation(exhausted(reason)), { reason, runId: 7101, attempt: 1, eventId: "main-regression:7101:1" });
  for (const state of [emptyState(REPOSITORY), exhausted("delivery-rejected"), exhausted("ledger-exhausted"), { ...exhausted("elapsed-exhausted"), active: null }, null])
    assert.equal(pendingEscalation(state), null);
  const body = escalationBody(REPOSITORY, pendingEscalation(exhausted("elapsed-exhausted")), mentions);
  assert.ok(body.startsWith(escalationMarker({ runId: 7101, attempt: 1, reason: "elapsed-exhausted" })));
  assert.match(body, /@fixture\/maintainers/); assert.match(body, /elapsed-exhausted-operator-required/);
  assert.match(body, /actions\/runs\/7101\/attempts\/1/);
});

test("exactly one notification per incident, run, attempt and reason; repeats and reruns never re-notify", async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Escalation tests must never reach the network"); };
  t.after(() => { globalThis.fetch = realFetch; });
  const w = await world(exhausted("delivery-exhausted"));
  assert.deepEqual(await deliverEscalation(REPOSITORY, { api: w.api, mentions }), { status: "no-open-incident",
    escalation: pendingEscalation(exhausted("delivery-exhausted")), writes: 0 });
  const incident = w.openIncident(4001);
  const first = await deliverEscalation(REPOSITORY, { api: w.api, mentions });
  assert.deepEqual([first.status, first.issue, first.writes], ["notified", 4001, 1]);
  for (let i = 0; i < 3; i++) assert.equal((await deliverEscalation(REPOSITORY, { api: w.api, mentions })).status, "already-notified");
  assert.equal(incident.comments.length, 1);
  // A new attempt that exhausts again is a new escalation; so is the other exhaustion reason.
  await writeState(w.api, REPOSITORY, await readState(w.api, REPOSITORY), exhausted("delivery-exhausted", 2));
  assert.equal((await deliverEscalation(REPOSITORY, { api: w.api, mentions })).status, "notified");
  await writeState(w.api, REPOSITORY, await readState(w.api, REPOSITORY), exhausted("elapsed-exhausted", 2));
  assert.equal((await deliverEscalation(REPOSITORY, { api: w.api, mentions })).status, "notified");
  assert.equal((await deliverEscalation(REPOSITORY, { api: w.api, mentions })).status, "already-notified");
  assert.equal(incident.comments.length, 3);
  // A cleared block (the investigation settled) delivers nothing.
  await writeState(w.api, REPOSITORY, await readState(w.api, REPOSITORY), { ...exhausted("elapsed-exhausted", 2), blocked: null });
  assert.deepEqual(await deliverEscalation(REPOSITORY, { api: w.api, mentions }), { status: "no-escalation", writes: 0 });
});

test("a pasted marker cannot suppress delivery, and an incomplete comment listing never posts", async () => {
  const w = await world(exhausted("elapsed-exhausted"));
  const incident = w.openIncident(4001);
  const marker = escalationMarker(pendingEscalation(exhausted("elapsed-exhausted")));
  w.commentAs(4001, "someone-else", `quoting ${marker}`);
  assert.equal((await deliverEscalation(REPOSITORY, { api: w.api, mentions })).status, "notified");
  const crowded = await world(exhausted("elapsed-exhausted"));
  crowded.openIncident(4002);
  for (let i = 0; i < MAX_COMMENT_PAGES * 100; i++) crowded.commentAs(4002, "github-actions[bot]", `unrelated ${i}`);
  const refused = await deliverEscalation(REPOSITORY, { api: crowded.api, mentions });
  assert.deepEqual([refused.status, refused.writes], ["dedup-unavailable", 0]);
  assert.equal(incident.comments.length, 2);
});

test("the CLI does no API work when disabled or misconfigured, stays inside its budget, and never fails the health job", async () => {
  const lines = [];
  const refuse = () => { throw new Error("must not call the API"); };
  for (const value of [undefined, "", "not-a-mention"]) {
    lines.length = 0;
    assert.equal(await main({ env: { MAIN_REGRESSION_ESCALATION_MENTION: value }, api: refuse, log: (line) => lines.push(line) }), 0);
    assert.equal(JSON.parse(lines.at(-1)).status, value === "not-a-mention" ? "invalid-configuration" : "disabled");
  }
  const w = await world(exhausted("delivery-exhausted"));
  w.openIncident(4001);
  const env = { MAIN_REGRESSION_ESCALATION_MENTION: "@fixture/maintainers", GITHUB_REPOSITORY: REPOSITORY, GITHUB_REF: "refs/heads/main" };
  lines.length = 0;
  assert.equal(await main({ env, api: w.api, log: (line) => lines.push(line) }), 0);
  const result = JSON.parse(lines.at(-1));
  assert.deepEqual([result.status, result.writes], ["notified", 1]); assert.ok(result.apiCalls <= API_LIMIT);
  lines.length = 0;
  assert.equal(await main({ env: { ...env, GITHUB_REF: "refs/heads/feature" }, api: w.api, log: (line) => lines.push(line) }), 0);
  assert.deepEqual(JSON.parse(lines.at(-1)), { event: "main_regression_escalation", status: "unavailable", reason: "untrusted-entry-point", writes: 0 });
  // An API failure is a warning with a fixed reason; no response body is echoed.
  lines.length = 0;
  const broken = async () => { throw Object.assign(new Error("secret body text"), { status: 500 }); };
  assert.equal(await main({ env, api: broken, log: (line) => lines.push(line) }), 0);
  assert.ok(lines.every((line) => !line.includes("secret body text")));
  assert.equal(JSON.parse(lines.at(-1)).status, "unavailable");
});

test("the trusted health job runs delivery with its existing token and permissions; nothing else changes", () => {
  const workflow = readFileSync(".github/workflows/main-ci-health.yml", "utf8");
  assert.match(workflow, /\n      - name: Deliver Exhausted Investigation Escalation\n        if: \$\{\{ !cancelled\(\) \}\}\n        env:\n          GITHUB_TOKEN: \$\{\{ github\.token \}\}\n          MAIN_REGRESSION_ESCALATION_MENTION: \$\{\{ vars\.MAIN_REGRESSION_ESCALATION_MENTION \}\}\n        run: node scripts\/main-regression-escalation\.mjs\n/);
  assert.match(workflow, /    permissions:\n      contents: write\n      actions: read\n      issues: write\n/, "the job's permissions are unchanged");
  assert.equal(workflow.match(/vars\.MAIN_REGRESSION_ESCALATION_MENTION/g).length, 1, "only the step reads the target");
  // The automation itself still cannot write issues.
  assert.doesNotMatch(readFileSync(".github/workflows/main-regression-automation.yml", "utf8"), /issues:/);
});
