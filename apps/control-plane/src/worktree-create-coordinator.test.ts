import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSnapshot } from "@wollipog/protocol";
import { WorktreeCreateCoordinator } from "./worktree-create-coordinator.js";

const coordinates = {
  runnerId: "runner-1",
  sessionId: "session-1",
  branch: "fix/one",
  baseRef: "origin/main",
};
const snapshot = { id: "session-1" } as unknown as SessionSnapshot;

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("exact retries join one operation and terminal polling releases it", async () => {
  let starts = 0;
  let complete!: (value: { snapshot: SessionSnapshot }) => void;
  const completion = new Promise<{ snapshot: SessionSnapshot }>((resolve) => { complete = resolve; });
  const coordinator = new WorktreeCreateCoordinator(60_000, () => "worktree_1");
  const start = () => { starts += 1; return completion; };

  const first = coordinator.startOrJoin(coordinates, start);
  const retry = coordinator.startOrJoin(coordinates, start);
  assert.deepEqual(first, { id: "worktree_1", status: "in_progress" });
  assert.equal(retry, first);
  await flush();
  assert.equal(starts, 1);

  assert.equal(coordinator.recordProgress("wrong-runner", {
    type: "session_worktree_progress",
    requestId: "worktree_1",
    sessionId: "session-1",
    phase: "fetching_remote",
  }), false);
  assert.equal(coordinator.recordProgress("runner-1", {
    type: "session_worktree_progress",
    requestId: "worktree_1",
    sessionId: "wrong-session",
    phase: "fetching_remote",
  }), false);
  assert.equal(coordinator.recordProgress("runner-1", {
    type: "session_worktree_progress",
    requestId: "worktree_1",
    sessionId: "session-1",
    phase: "fetching_remote",
  }), true);
  assert.deepEqual(coordinator.startOrJoin(coordinates, start), {
    id: "worktree_1", status: "in_progress", phase: "fetching_remote",
  });

  complete({ snapshot });
  await flush();
  const terminal = coordinator.startOrJoin(coordinates, start);
  assert.equal(terminal.status, "completed");
  coordinator.releaseTerminal(terminal.id);
  coordinator.startOrJoin(coordinates, start);
  await flush();
  assert.equal(starts, 2, "a consumed terminal result no longer masks an idempotent retry");
});

test("a stalled or failed runner request becomes an explicit terminal failure", async () => {
  const coordinator = new WorktreeCreateCoordinator(60_000, () => "worktree_failed");
  coordinator.startOrJoin(coordinates, async () => { throw new Error("runner request timed out"); });
  await flush();
  assert.deepEqual(coordinator.startOrJoin(coordinates, async () => ({ snapshot })), {
    id: "worktree_failed",
    status: "failed",
    error: "runner request timed out",
  });
  assert.equal(coordinator.recordProgress("runner-1", {
    type: "session_worktree_progress",
    requestId: "worktree_failed",
    sessionId: "session-1",
    phase: "activating",
  }), false, "late progress cannot revive a terminal operation");
});

test("base ref is part of the in-flight identity", async () => {
  let nextId = 0;
  let starts = 0;
  const coordinator = new WorktreeCreateCoordinator(60_000, () => `worktree_${++nextId}`);
  const start = async () => {
    starts += 1;
    return new Promise<{ snapshot: SessionSnapshot }>(() => {});
  };
  const first = coordinator.startOrJoin(coordinates, start);
  const duplicate = coordinator.startOrJoin(coordinates, start);
  const otherBase = coordinator.startOrJoin({ ...coordinates, baseRef: "origin/release" }, start);
  await flush();
  assert.equal(duplicate.id, first.id);
  assert.notEqual(otherBase.id, first.id);
  assert.equal(starts, 2);
});
