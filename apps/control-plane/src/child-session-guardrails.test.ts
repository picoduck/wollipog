import assert from "node:assert/strict";
import { test } from "node:test";
import { childSessionDefaultsError, childSessionGuardrails } from "./child-session-guardrails.js";

const unlimited = { costBudgetUsd: null, costUsd: 0, maxToolCalls: null, toolCallCount: 0 };

test("project defaults apply independently only to unbounded parent dimensions", () => {
  const defaults = { costBudgetUsd: 3, maxToolCalls: 60 };
  assert.deepEqual(childSessionGuardrails(unlimited, {}, 4, defaults), { config: defaults });
  assert.deepEqual(childSessionGuardrails({ ...unlimited, costBudgetUsd: 8 }, {}, 4, defaults),
    { config: { costBudgetUsd: 2, maxToolCalls: 60 } });
  assert.deepEqual(childSessionGuardrails({ ...unlimited, maxToolCalls: 40 }, {}, 4, defaults),
    { config: { costBudgetUsd: 3, maxToolCalls: 10 } });
  assert.deepEqual(childSessionGuardrails(unlimited, { costBudgetUsd: 1, maxToolCalls: 2 }, 4, defaults),
    { config: { costBudgetUsd: 1, maxToolCalls: 2 } });
});

test("project defaults require finite positive allowances and reject unknown fields", () => {
  assert.equal(childSessionDefaultsError(null), null);
  assert.equal(childSessionDefaultsError({ costBudgetUsd: 3, maxToolCalls: 60 }), null);
  for (const value of [undefined, {}, [], { costBudgetUsd: Infinity, maxToolCalls: 2 },
    { costBudgetUsd: 0, maxToolCalls: 2 }, { costBudgetUsd: 1, maxToolCalls: 0.5 },
    { costBudgetUsd: 1, maxToolCalls: 2, extra: true }]) assert.ok(childSessionDefaultsError(value));
});

test("unlimited parents give children finite defaults and retain model choices", () => {
  assert.deepEqual(childSessionGuardrails(unlimited, { model: "chosen" }, 4), {
    config: { model: "chosen", costBudgetUsd: 5, maxToolCalls: 100 },
  });
});

test("child limits divide remaining capacity and cannot exceed the parent's allowance", () => {
  const parent = { costBudgetUsd: 20, costUsd: 8, maxToolCalls: 200, toolCallCount: 80 };
  assert.deepEqual(childSessionGuardrails(parent, { costBudgetUsd: 100, maxToolCalls: 1000 }, 3), {
    config: { costBudgetUsd: 4, maxToolCalls: 40 },
  });
  assert.deepEqual(childSessionGuardrails(parent, { costBudgetUsd: 1, maxToolCalls: 2 }, 3), {
    config: { costBudgetUsd: 1, maxToolCalls: 2 },
  });
});

test("exhausted capacity and explicit unlimited or malformed limits fail closed", () => {
  for (const remaining of [0, -1, NaN, Infinity, 1.5]) {
    assert.ok("error" in childSessionGuardrails(unlimited, {}, remaining));
  }
  for (const value of [0, -1, NaN, Infinity]) {
    assert.ok("error" in childSessionGuardrails(unlimited, { costBudgetUsd: value }, 1));
    assert.ok("error" in childSessionGuardrails(unlimited, { maxToolCalls: value }, 1));
  }
  assert.ok("error" in childSessionGuardrails(unlimited, { maxToolCalls: 0.5 }, 1));
  assert.ok("error" in childSessionGuardrails({ ...unlimited, costBudgetUsd: 1, costUsd: 1 }, {}, 1));
  assert.ok("error" in childSessionGuardrails({ ...unlimited, maxToolCalls: 3 }, {}, 4));
});
