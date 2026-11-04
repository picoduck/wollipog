import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeCodeDriver } from "./claude-code.js";
import type { DriverBackgroundWorkUpdate, DriverOptions } from "./driver.js";

// #3752: Wollipog ended a background job at a handoff deadline and recorded it as killed. The move
// relaunched Claude Code, which then delivered the dead task's queued `stopped` notification to
// the new process. That driver had never ended the task, so it recorded it as pending again, and
// the next worktree handoff waited an hour on a job the session listed as killed.

function harness(options: Pick<DriverOptions, "initialBackgroundTaskIds" | "endedBackgroundTaskIds"> = {}) {
  const updates: DriverBackgroundWorkUpdate[] = [];
  const driver = new ClaudeCodeDriver({
    command: "claude", args: [], cwd: "/tmp/ended-task-test", env: {},
    config: {}, context: {} as DriverOptions["context"], ...options,
  }, { onEvent() {}, onStderr() {}, onExit() {}, onBackgroundWork: (update) => updates.push(update) });
  const feed = (frame: unknown) => (driver as any).handleEvent(frame);
  return { driver, updates, feed };
}

const stoppedWatcher = { type: "system", subtype: "task_notification", task_id: "killed-watcher",
  status: "stopped", output_file: "/tmp/tasks/killed-watcher.output" };
const freshTask = { type: "system", subtype: "task_started", task_id: "fresh", is_backgrounded: true };

test("without the ended ids, a relaunched driver revives a dead task from its stopped notification (#3752)", () => {
  const h = harness();
  try {
    h.feed(stoppedWatcher);
    assert.deepEqual(h.updates.at(-1)?.pendingTaskIds, ["killed-watcher"]);
    assert.deepEqual(h.updates.at(-1)?.observedTaskIds, ["killed-watcher"]);
  } finally { h.driver.dispose(); }
});

test("a task the session already recorded as ended stays ended in a relaunched driver (#3752)", () => {
  const h = harness({ endedBackgroundTaskIds: ["killed-watcher"] });
  try {
    h.feed(stoppedWatcher);
    assert.equal(h.updates.length, 0, "the dead task's notification records nothing");
    h.feed(freshTask);
    assert.deepEqual(h.updates.at(-1)?.pendingTaskIds, ["fresh"], "new work is still tracked");
    h.feed(stoppedWatcher);
    assert.deepEqual(h.updates.at(-1)?.pendingTaskIds, ["fresh"]);
    assert.deepEqual(h.updates.flatMap((update) => update.jobs ?? []).map((job) => job.id).filter((id) => id !== "fresh"), []);
  } finally { h.driver.dispose(); }
});

test("an ended id is not seeded as pending, while other seeds still are (#3752)", () => {
  const h = harness({
    initialBackgroundTaskIds: ["killed-watcher", "live-seed"],
    endedBackgroundTaskIds: ["killed-watcher"],
  });
  try {
    h.feed(freshTask);
    assert.deepEqual(h.updates.at(-1)?.pendingTaskIds, ["fresh", "live-seed"]);
  } finally { h.driver.dispose(); }
});

test("an ended provisional tool identity stays ended in a relaunched driver (#3752)", () => {
  const h = harness({ endedBackgroundTaskIds: ["watch-task", "tool:watch-tool"] });
  try {
    h.feed({ type: "assistant", message: { content: [{
      type: "tool_use", id: "watch-tool", name: "Bash", input: { command: "sleep 600", run_in_background: true },
    }] } });
    h.feed({ type: "system", subtype: "task_notification", task_id: "watch-task", tool_use_id: "watch-tool", status: "stopped" });
    assert.deepEqual(h.updates.flatMap((update) => update.pendingTaskIds), []);
  } finally { h.driver.dispose(); }
});
