import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { codexCliAdmission, codexCliAdmissionScript } from "./codex-cli-admission.js";

const command = "gh pr merge https://github.com/team/repo/pull/1 --squash --match-head-commit " + "a".repeat(40);
const action = { kind: "pr_merge_enqueue", command };
const script = `"$WOLLIPOG_CLI" decision consume workflow-test --snapshot '{"category":"pr_merge"}' --action '${JSON.stringify(action)}' --json`;
const response = { decision: { occurrenceId: "workflow-test", status: "approved", actionAdmission: {
  ...action, providerThreadId: "thread-test", providerTurnId: "turn-test",
} } };
const parse = (input: string, output = JSON.stringify(response)) => codexCliAdmission(input, output, "thread-test", "turn-test");

test("CLI proof refuses shell composition and mismatched causal identities", () => {
  assert.equal(parse(script)?.approved, true);
  fc.assert(fc.property(fc.string(), (suffix) => {
    assert.equal(parse(`${script};${suffix}`), null);
    assert.equal(parse(`echo ${script}${suffix}`), null);
    assert.equal(parse(script, JSON.stringify({ decision: { ...response.decision, occurrenceId: `other-${suffix}` } }))?.approved, false);
    assert.equal(codexCliAdmission(script, JSON.stringify(response), `other-${suffix}`, "turn-test")?.approved, false);
    assert.equal(codexCliAdmission(script, JSON.stringify(response), "thread-test", `other-${suffix}`)?.approved, false);
  }), { numRuns: 200 });
});

test("CLI admission argv decoding preserves quoted JSON and rejects outer shell operations", () => {
  const wrapped = `/usr/bin/zsh -lc '${script.replaceAll("'", "'\\''")}'`;
  assert.equal(codexCliAdmissionScript(wrapped), script);
  assert.equal(parse(codexCliAdmissionScript(wrapped))?.approved, true);
  for (const input of [wrapped + "; echo fake", "/usr/bin/zsh -lc $UNTRUSTED", wrapped + " extra"]) {
    assert.equal(parse(codexCliAdmissionScript(input)), null);
  }
});

test("CLI proof refuses failed, duplicate, and oversized responses", () => {
  assert.equal(parse(script, JSON.stringify({ decision: { ...response.decision, status: "consumed" } }))?.approved, false);
  assert.equal(parse(script, `${JSON.stringify(response)}\n${JSON.stringify(response)}`)?.approved, false);
  assert.equal(parse(script, "x".repeat(100_001))?.approved, false);
});
