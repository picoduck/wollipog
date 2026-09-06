import assert from "node:assert/strict";
import test from "node:test";
import type { SessionView } from "@wollipog/protocol";
import { backgroundWorkerState, isCurrentWorker, workerRoster } from "./worker-roster.js";
import type { SubagentDescriptor } from "./subagents.js";

const session = {
  id: "parent", runnerId: "runner", status: "running", backgroundWorkState: "running",
  pendingApproval: { requestId: "ask", ownerToolUseId: "child", title: "Choose", options: [] },
  backgroundJobs: [{ id: "monitor", parentTurnId: "turn-1", launchType: "monitor",
    registeredAt: 1, lastObservedAt: 2, sourcePresent: true }],
} as SessionView;
const child: SubagentDescriptor = {
  id: "child", childIds: [], title: "Inspect Parser", depth: 1, sourceIndex: 0,
  lifecycle: "running", toolStatus: "in_progress", availability: "live",
  directUsage: { inputTokens: 3, outputTokens: 2 },
  inclusiveUsage: { inputTokens: 7, outputTokens: 5 },
};

test("roster retains distinct job targets, nesting, usage, and deduplicated authorized members", () => {
  const reviewer = { ...session, id: "reviewer", title: "Review", createdAt: 1, updatedAt: 2,
    pendingApproval: null, model: "review-model", effort: "high", tokensIn: 5, tokensOut: 7 } as SessionView;
  const rows = workerRoster(session, [child], [session, reviewer, reviewer], () => true,
    new Map([["reviewer", { role: "reviewer", phase: "independent-review", activations: 2 }]]));
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.state, "input_required");
  assert.equal(rows[0]!.depth, 1);
  assert.equal(rows[0]!.tokens, 5);
  assert.equal(rows[0]!.inclusiveTokens, 12);
  assert.deepEqual(rows[1]!.target, { kind: "background", id: "monitor" });
  assert.deepEqual(rows[2]!.target, { kind: "session", id: "reviewer" });
  assert.equal(rows[2]!.role, "reviewer");
  assert.equal(rows[2]!.activations, 2);
  assert.equal(rows.filter(isCurrentWorker).length, 3);
});

test("offline, recorded, and completed evidence cannot be advertised as active child work", () => {
  assert.equal(workerRoster(session, [{ ...child, availability: "recorded" }], [], () => false)
    .filter(isCurrentWorker).length, 0);
  const completed = workerRoster(session, [{ ...child, lifecycle: "completed" }], [], () => true)[0]!;
  assert.equal(completed.state, "completed", "terminal truth wins over a stale pending owner");
  assert.equal(isCurrentWorker(completed), false);
  assert.equal(backgroundWorkerState({ ...session.backgroundJobs![0]!, terminalStatus: "completed" }, session, true), "completed");
  assert.equal(backgroundWorkerState(session.backgroundJobs![0]!, { ...session, backgroundWorkState: "resumed" }, true), "unverified");
  assert.equal(backgroundWorkerState({ ...session.backgroundJobs![0]!, sourcePresent: false }, session, true), "unverified");
});

test("legacy empty evidence has no fabricated workers and unknown ownership is not assigned", () => {
  const legacy = { ...session, backgroundJobs: undefined, pendingApproval: { requestId: "ask", title: "Choose", options: [] } };
  assert.deepEqual(workerRoster(legacy, [], [], () => true), []);
  assert.equal(workerRoster(legacy, [child], [], () => true)[0]!.state, "working");
});
