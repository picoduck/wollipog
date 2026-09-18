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

test("a later session mutation cannot make an unconsumed create restart and undo it", async () => {
  let starts = 0;
  const coordinator = new WorktreeCreateCoordinator(60_000, () => "worktree_superseded");
  const start = async () => { starts += 1; return { snapshot }; };
  coordinator.startOrJoin(coordinates, start);
  await flush();

  coordinator.invalidateSession("session-1");
  assert.deepEqual(coordinator.startOrJoin(coordinates, start), {
    id: "worktree_superseded",
    status: "failed",
    error: "session worktree selection changed after creation completed",
  });
  assert.equal(starts, 1, "polling a superseded terminal result must not restart creation");
});

test("runtime progress rejects phases outside the bounded protocol enum", () => {
  const coordinator = new WorktreeCreateCoordinator(60_000, () => "worktree_phase");
  coordinator.startOrJoin(coordinates, async () => new Promise(() => {}));
  assert.equal(coordinator.recordProgress("runner-1", {
    type: "session_worktree_progress",
    requestId: "worktree_phase",
    sessionId: "session-1",
    phase: "unbounded runner text" as never,
  }), false);
  assert.deepEqual(coordinator.startOrJoin(coordinates, async () => ({ snapshot })), {
    id: "worktree_phase",
    status: "in_progress",
  });
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

test("a failed create keeps the phase it stopped in", async () => {
  let fail!: (error: Error) => void;
  const coordinator = new WorktreeCreateCoordinator(60_000, () => "worktree_phase_failed");
  coordinator.startOrJoin(coordinates, () => new Promise((_resolve, reject) => { fail = reject; }));
  await flush();
  coordinator.recordProgress("runner-1", {
    type: "session_worktree_progress",
    requestId: "worktree_phase_failed",
    sessionId: "session-1",
    phase: "running_setup",
  });
  fail(new Error("runner request timed out"));
  await flush();
  assert.deepEqual(coordinator.startOrJoin(coordinates, async () => ({ snapshot })), {
    id: "worktree_phase_failed",
    status: "failed",
    error: "runner request timed out",
    phase: "running_setup",
  });
});

test("listing a session's creates is read-only and omits snapshots and superseded results", async () => {
  let nextId = 0;
  let starts = 0;
  let complete!: (value: { snapshot: SessionSnapshot }) => void;
  const coordinator = new WorktreeCreateCoordinator(60_000, () => `worktree_${++nextId}`);
  coordinator.startOrJoin(coordinates, () => {
    starts += 1;
    return new Promise((resolve) => { complete = resolve; });
  });
  coordinator.startOrJoin({ ...coordinates, sessionId: "session-2" }, () => new Promise(() => {}));
  await flush();
  coordinator.recordProgress("runner-1", {
    type: "session_worktree_progress",
    requestId: "worktree_1",
    sessionId: "session-1",
    phase: "fetching_remote",
  });
  assert.deepEqual(coordinator.listForSession("session-1"), [{
    id: "worktree_1", status: "in_progress", phase: "fetching_remote", branch: "fix/one", baseRef: "origin/main",
  }]);

  complete({ snapshot });
  await flush();
  assert.deepEqual(coordinator.listForSession("session-1"), [{
    id: "worktree_1", status: "completed", branch: "fix/one", baseRef: "origin/main",
  }], "completion is reported without its snapshot");
  coordinator.listForSession("session-1");
  assert.equal(coordinator.startOrJoin(coordinates, async () => ({ snapshot })).status, "completed",
    "reading never consumes a terminal result");
  assert.equal(starts, 1);

  coordinator.invalidateSession("session-1");
  assert.deepEqual(coordinator.listForSession("session-1"), [],
    "a superseded create is not offered to a rejoining client");
});

test("a listed create carries the recovery incident it started under", async () => {
  const coordinator = new WorktreeCreateCoordinator(60_000, () => "worktree_incident");
  coordinator.startOrJoin({ ...coordinates, recoveryId: "worktree-recovery:1" }, () => new Promise(() => {}));
  assert.deepEqual(coordinator.listForSession("session-1"), [{
    id: "worktree_incident", status: "in_progress", branch: "fix/one", baseRef: "origin/main",
    recoveryId: "worktree-recovery:1",
  }]);
  assert.equal(coordinator.startOrJoin(coordinates, async () => ({ snapshot })).id, "worktree_incident",
    "the incident is metadata, not part of the join identity");
});

test("another incident's retained result never answers a new incident's create", async () => {
  let nextId = 0;
  let starts = 0;
  let finish!: () => void;
  const coordinator = new WorktreeCreateCoordinator(60_000, () => `worktree_${++nextId}`);
  const incidentA = { ...coordinates, recoveryId: "worktree-recovery:a" };
  const incidentB = { ...coordinates, recoveryId: "worktree-recovery:b" };
  coordinator.startOrJoin(incidentA, async () => { starts += 1; throw new Error("incident A failed"); });
  await flush();
  const running = coordinator.startOrJoin(incidentB, () => {
    starts += 1;
    return new Promise((resolve) => { finish = () => resolve({ snapshot }); });
  });
  await flush();
  assert.equal(running.status, "in_progress", "incident B starts its own create");
  assert.equal(starts, 2);
  assert.equal(coordinator.startOrJoin(incidentA, async () => ({ snapshot })).id, running.id,
    "a running create is joined across incidents rather than duplicated");
  finish();
  await flush();
  assert.equal(starts, 2);
});

test("a poller collecting a create that cleared its incident joins instead of restarting", async () => {
  let starts = 0;
  const coordinator = new WorktreeCreateCoordinator(60_000, () => "worktree_cleared");
  coordinator.startOrJoin({ ...coordinates, recoveryId: "worktree-recovery:a" }, async () => {
    starts += 1;
    return { snapshot };
  });
  await flush();
  // The completed create resolved the incident, so the control plane stamps no incident on the poll.
  const collected = coordinator.startOrJoin(coordinates, async () => { starts += 1; return { snapshot }; });
  await flush();
  assert.equal(collected.status, "completed");
  assert.equal(collected.id, "worktree_cleared");
  assert.equal(starts, 1);
});
