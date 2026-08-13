import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcilePolicyHooksSafely } from "./policy-hook-maintenance.js";

test("guarded policy-hook reconciliation logs one failed tick and allows the next tick", () => {
  let calls = 0;
  const warnings: Array<{ fields: { error: string }; message: string }> = [];
  const service = {
    reconcilePolicyHookTimeouts() {
      calls++;
      if (calls === 1) throw new Error("conflicting durable row");
      return 1;
    },
  };
  const log = {
    warn(fields: { error: string }, message: string) {
      warnings.push({ fields, message });
    },
  };

  assert.equal(reconcilePolicyHooksSafely(service, log, 100), false);
  assert.equal(reconcilePolicyHooksSafely(service, log, 200), true);
  assert.equal(calls, 2);
  assert.deepEqual(warnings, [{
    fields: { error: "conflicting durable row" },
    message: "policy-hook approval reconciliation deferred",
  }]);
});
