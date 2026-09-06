import assert from "node:assert/strict";
import { test } from "node:test";
import { childSessionGuardrails } from "./child-session-guardrails.js";

const unlimited = { costBudgetUsd: null, costUsd: 0, maxToolCalls: null, toolCallCount: 0 };

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
