import assert from "node:assert/strict";
import { test } from "node:test";
import { nextWorkflowRetryAt, workflowRetryTimerDelay } from "./workflow-retry.js";

test("workflow retry clock chooses the nearest future deadline and ignores elapsed nodes", () => {
  assert.equal(nextWorkflowRetryAt([{ readyAt: 900 }, {}, { readyAt: 1_500 }, { readyAt: 1_200 }], 1_000), 1_200);
  assert.equal(nextWorkflowRetryAt([{ readyAt: 900 }, { readyAt: 1_000 }], 1_000), null);
});

test("workflow retry clock repaints each second and just after the deadline", () => {
  assert.equal(workflowRetryTimerDelay(5_000, 1_000), 1_000);
  assert.equal(workflowRetryTimerDelay(1_400, 1_000), 410);
  assert.equal(workflowRetryTimerDelay(999, 1_000), 25);
});
