import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COUNT_ZERO_ERROR,
  USD_ERROR,
  USD_LIST_ERROR,
  USD_ZERO_ERROR,
  checkpointAboveThreshold,
  guardrailDraft,
  guardrailFieldError,
  guardrailPatch,
  guardrailSummary,
  parseCount,
  parseUsd,
  parseUsdList,
  type GuardrailSession,
} from "./guardrail-values.js";

const none: GuardrailSession = { costBudgetUsd: null, costCheckpointsUsd: null, maxToolCalls: null, maxChildSessions: undefined };

test("parseUsd accepts plain amounts and reads empty as no limit", () => {
  assert.deepEqual(parseUsd(""), { ok: true, value: null });
  assert.deepEqual(parseUsd("  "), { ok: true, value: null });
  assert.deepEqual(parseUsd("5"), { ok: true, value: 5 });
  assert.deepEqual(parseUsd("2.50"), { ok: true, value: 2.5 });
  assert.deepEqual(parseUsd(".5"), { ok: true, value: 0.5 });
  assert.deepEqual(parseUsd(" $3 "), { ok: true, value: 3 });
});

test("parseUsd refuses typos and zero with a sentence that says how to fix them", () => {
  for (const typo of ["1e", "-3", "abc", "1e3", "Infinity", "1,5", "$", "5$", "0x10"]) {
    assert.deepEqual(parseUsd(typo), { ok: false, error: USD_ERROR }, typo);
  }
  assert.deepEqual(parseUsd("0"), { ok: false, error: USD_ZERO_ERROR });
  assert.deepEqual(parseUsd("0.00"), { ok: false, error: USD_ZERO_ERROR });
});

test("parseUsdList sorts and de-duplicates, and one bad amount refuses the list", () => {
  assert.deepEqual(parseUsdList(""), { ok: true, value: [] });
  assert.deepEqual(parseUsdList("2.5, 1,1 4"), { ok: true, value: [1, 2.5, 4] });
  assert.deepEqual(parseUsdList("1, 1e"), { ok: false, error: USD_LIST_ERROR });
  assert.deepEqual(parseUsdList("1, 0"), { ok: false, error: USD_LIST_ERROR });
  assert.deepEqual(parseUsdList("-3"), { ok: false, error: USD_LIST_ERROR });
});

test("parseCount accepts whole numbers within its bounds", () => {
  assert.deepEqual(parseCount("", 64), { ok: true, value: null });
  assert.deepEqual(parseCount("0", 64), { ok: true, value: 0 });
  assert.deepEqual(parseCount("64", 64), { ok: true, value: 64 });
  assert.deepEqual(parseCount("65", 64), { ok: false, error: "Enter a whole number from 0 to 64." });
  for (const typo of ["1e", "-3", "abc", "2.5", "1e1"]) {
    assert.deepEqual(parseCount(typo, 64), { ok: false, error: "Enter a whole number from 0 to 64." }, typo);
  }
  assert.deepEqual(parseCount("200", Number.POSITIVE_INFINITY, 1), { ok: true, value: 200 });
  assert.deepEqual(parseCount("abc", Number.POSITIVE_INFINITY, 1), { ok: false, error: "Enter a whole number like 200." });
  assert.deepEqual(parseCount("0", Number.POSITIVE_INFINITY, 1), { ok: false, error: COUNT_ZERO_ERROR });
});

test("guardrailFieldError routes each field to its own validator", () => {
  assert.equal(guardrailFieldError("costBudgetUsd", "1e"), USD_ERROR);
  assert.equal(guardrailFieldError("costCheckpointsUsd", "abc"), USD_LIST_ERROR);
  assert.equal(guardrailFieldError("maxToolCalls", "-3"), "Enter a whole number like 200.");
  assert.equal(guardrailFieldError("maxChildSessions", "65"), "Enter a whole number from 0 to 64.");
  assert.equal(guardrailFieldError("maxChildSessions", ""), null);
});

test("a checkpoint at or above the recurring threshold is flagged", () => {
  assert.equal(checkpointAboveThreshold({ costBudgetUsd: "5", costCheckpointsUsd: "1, 2" }), false);
  assert.equal(checkpointAboveThreshold({ costBudgetUsd: "5", costCheckpointsUsd: "1, 5" }), true);
  assert.equal(checkpointAboveThreshold({ costBudgetUsd: "5", costCheckpointsUsd: "7" }), true);
  assert.equal(checkpointAboveThreshold({ costBudgetUsd: "", costCheckpointsUsd: "7" }), false);
  assert.equal(checkpointAboveThreshold({ costBudgetUsd: "abc", costCheckpointsUsd: "7" }), false);
});

test("the draft starts from the session's limits", () => {
  assert.deepEqual(guardrailDraft(none), { costBudgetUsd: "", costCheckpointsUsd: "", maxToolCalls: "", maxChildSessions: "" });
  assert.deepEqual(
    guardrailDraft({ costBudgetUsd: 2.5, costCheckpointsUsd: [1, 2], maxToolCalls: 200, maxChildSessions: 0 }),
    { costBudgetUsd: "2.5", costCheckpointsUsd: "1, 2", maxToolCalls: "200", maxChildSessions: "0" },
  );
});

test("a save sends every changed field together and nothing unchanged", () => {
  const session: GuardrailSession = { costBudgetUsd: 10, costCheckpointsUsd: [2], maxToolCalls: 200, maxChildSessions: 6 };
  assert.deepEqual(guardrailPatch(session, guardrailDraft(session)), { ok: true, patch: {} },
    "re-sending an advanced threshold would reset its recurring allowance");
  assert.deepEqual(guardrailPatch(none, { costBudgetUsd: "5", costCheckpointsUsd: "2, 1", maxToolCalls: "300", maxChildSessions: "9" }), {
    ok: true,
    patch: { costBudgetUsd: 5, costCheckpointsUsd: [1, 2], maxToolCalls: 300, maxChildSessions: 9 },
  });
});

test("every limit the server accepted reopens as plain digits and saves unchanged", () => {
  for (const session of [
    { costBudgetUsd: 0.0000001, costCheckpointsUsd: [1e-7, 2], maxToolCalls: 1e21, maxChildSessions: 6 },
    { costBudgetUsd: 1e21, costCheckpointsUsd: [1e22], maxToolCalls: 200, maxChildSessions: 6 },
  ] satisfies GuardrailSession[]) {
    const draft = guardrailDraft(session);
    for (const text of Object.values(draft)) assert.doesNotMatch(text, /e/i, `${text} reads as an amount`);
    assert.deepEqual(guardrailPatch(session, draft), { ok: true, patch: {} });
    // An unchanged limit never blocks saving another field.
    assert.deepEqual(guardrailPatch(session, { ...draft, maxChildSessions: "9" }), { ok: true, patch: { maxChildSessions: 9 } });
  }
  assert.equal(guardrailDraft({ ...none, costBudgetUsd: 0.0000001 }).costBudgetUsd, "0.0000001");
  assert.equal(guardrailDraft({ ...none, costBudgetUsd: 1e21 }).costBudgetUsd, "1000000000000000000000");
});

test("a stored limit at or below 0 reads as none, as the server means it", () => {
  const session: GuardrailSession = { costBudgetUsd: 0, costCheckpointsUsd: null, maxToolCalls: -1, maxChildSessions: undefined };
  assert.deepEqual(guardrailDraft(session), { costBudgetUsd: "", costCheckpointsUsd: "", maxToolCalls: "", maxChildSessions: "" });
  assert.deepEqual(guardrailPatch(session, guardrailDraft(session)), { ok: true, patch: {} });
  assert.equal(guardrailSummary(session), "No limits set.");
});

test("emptying clears cost and tool-call limits but keeps Live Child Limit; 0 pauses children", () => {
  const session: GuardrailSession = { costBudgetUsd: 10, costCheckpointsUsd: [2], maxToolCalls: 200, maxChildSessions: 6 };
  assert.deepEqual(guardrailPatch(session, { costBudgetUsd: "", costCheckpointsUsd: "", maxToolCalls: "", maxChildSessions: "" }), {
    ok: true,
    patch: { costBudgetUsd: 0, costCheckpointsUsd: [], maxToolCalls: 0 },
  });
  assert.deepEqual(guardrailPatch(session, { ...guardrailDraft(session), maxChildSessions: "0" }), {
    ok: true,
    patch: { maxChildSessions: 0 },
  });
});

test("any invalid field blocks the save and reports every error", () => {
  assert.deepEqual(guardrailPatch(none, { costBudgetUsd: "1e", costCheckpointsUsd: "", maxToolCalls: "abc", maxChildSessions: "4" }), {
    ok: false,
    errors: { costBudgetUsd: USD_ERROR, maxToolCalls: "Enter a whole number like 200." },
  });
});

test("the + menu summary names what pauses the session and the child limit", () => {
  assert.equal(guardrailSummary(none), "No limits set.");
  assert.equal(guardrailSummary({ ...none, costBudgetUsd: 5, maxToolCalls: 200, maxChildSessions: 4 }),
    "Pauses at $5.00 spent or 200 tool calls. Up to 4 live children.");
  assert.equal(guardrailSummary({ ...none, costBudgetUsd: 5, costCheckpointsUsd: [1, 2.5] }),
    "Pauses at $1.00, $2.50 and $5.00 spent.");
  assert.equal(guardrailSummary({ ...none, maxToolCalls: 1 }), "Pauses at 1 tool call.");
  assert.equal(guardrailSummary({ ...none, maxChildSessions: 1 }), "Up to 1 live child.");
  assert.equal(guardrailSummary({ ...none, maxChildSessions: 0 }), "New children paused.");
});
