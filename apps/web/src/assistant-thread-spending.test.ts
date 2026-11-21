import assert from "node:assert/strict";
import { test } from "node:test";
import { threadSpendingCopy, threadSpendingStates } from "./assistant-thread-spending.js";

test("the spending threshold includes 80%, separates equality from overflow and honors unlimited budgets", () => {
  const states = (used: number, limit: number | null = 25) => threadSpendingStates({
    status: "done",
    usage: { costUsd: { used, limit }, launchedSessions: { used: 0, limit: null } },
  }).map(({ kind }) => kind);
  assert.deepEqual(states(19.9999), []);
  assert.deepEqual(states(20), ["near_budget"]);
  assert.deepEqual(states(24.9999), ["near_budget"]);
  assert.deepEqual(states(25), ["budget_used_up"]);
  assert.deepEqual(states(25.0001), ["over_budget"]);
  assert.deepEqual(states(100, null), []);
});

test("a blocked launch outranks a budget advisory and an exhausted budget outranks the launch limit", () => {
  const states = (used: number) => threadSpendingStates({
    status: "working",
    usage: { costUsd: { used, limit: 25 }, launchedSessions: { used: 0, limit: 0 } },
  }).map(({ kind }) => kind);
  assert.deepEqual(states(19), ["launch_limit"]);
  assert.deepEqual(states(20), ["launch_limit", "near_budget"]);
  assert.deepEqual(states(25), ["budget_used_up", "launch_limit"]);
  assert.deepEqual(states(80), ["over_budget", "launch_limit"]);
});

test("archived threads and peers without usage do not acquire spending state", () => {
  assert.deepEqual(threadSpendingStates({ status: "done", launchLimitRefusal: "Budget unavailable." }), []);
  assert.deepEqual(threadSpendingStates({ status: "archived", usage: {
    costUsd: { used: 79.93, limit: 25 }, launchedSessions: { used: 10, limit: 10 },
  } }), []);
});

test("a launch refusal below the budget shows the server's explanation without inflating actual spend", () => {
  const refusal = "This Wollipog Assistant thread has spent or committed its whole $25 budget, so it cannot launch another session.";
  for (const used of [8.13, 21.40]) {
    const states = threadSpendingStates({
      status: "done", launchLimitRefusal: refusal,
      usage: { costUsd: { used, limit: 25 }, launchedSessions: { used: 2, limit: 10 } },
    });
    assert.deepEqual(states, [{ kind: "budget_committed", used, limit: 25, refusal }]);
    assert.deepEqual(threadSpendingCopy(states[0]!), { title: "Budget Committed", message: refusal });
  }
});

test("the over-budget title shows the difference and budget copy uses the configured amount", () => {
  assert.deepEqual(threadSpendingCopy({ kind: "over_budget", used: 79.93, limit: 25 }), {
    title: "Over Budget by $54.93",
    message: "Sessions this thread launched kept running after its $25.00 budget ran out, and their cost counts toward it. The assistant can't launch more until you raise the budget.",
  });
});
