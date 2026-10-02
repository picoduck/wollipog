import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { ClaudeCodeDriver } from "./claude-code.js";
import type { DriverBackgroundWorkUpdate, DriverOptions } from "./driver.js";

function harness() {
  const updates: DriverBackgroundWorkUpdate[] = [];
  const driver = new ClaudeCodeDriver({
    command: "claude", args: [], cwd: "/tmp/monitor-test", env: {},
    config: {}, context: {} as DriverOptions["context"],
  }, { onEvent() {}, onStderr() {}, onExit() {}, onBackgroundWork: update => updates.push(update) });
  const feed = (frame: unknown) => (driver as any).handleEvent(frame);
  return { driver, updates, feed };
}

const launch = {
  type: "assistant", message: { content: [{
    type: "tool_use", id: "monitor-tool", name: "Monitor",
    input: { command: "sleep 30", timeout_ms: 5000 },
  }] },
};
const started = { type: "system", subtype: "task_started", task_id: "monitor-task",
  tool_use_id: "monitor-tool", is_backgrounded: true, task_type: "local_bash" };
const launchResult = { type: "user", message: { content: [{
  type: "tool_result", tool_use_id: "monitor-tool",
  content: "Monitor started (task monitor-task, expires in 5s unless the source ends first; you get one notice at expiry — re-arm if you still need the watch). You will be notified on each event. Keep working — do not poll or sleep. Events may arrive while you are waiting for the user — an event is not their reply.",
}] }, tool_use_result: { taskId: "monitor-task", timeoutMs: 5000, persistent: false } };
// Sanitized lifecycle fields captured from isolated Claude Code 2.1.284 and 2.1.287 probes.
// Expiry is a killed patch followed by stopped, rather than an inferred "expired" status.
const expired = { type: "system", subtype: "task_updated", task_id: "monitor-task",
  patch: { status: "killed", end_time: 6000 } };
const stopped = { type: "system", subtype: "task_notification", task_id: "monitor-task",
  tool_use_id: "monitor-tool", status: "stopped", summary: "silent monitor", output_file: "/tmp/tasks/monitor-task.output" };

test("observed monitor expiry becomes terminal once and never resurrects", () => {
  const h = harness();
  try {
    [launch, started, launchResult].forEach(h.feed);
    assert.deepEqual(h.updates.at(-1)?.pendingTaskIds, ["monitor-task"]);
    h.feed(expired);
    assert.deepEqual(h.updates.at(-1)?.pendingTaskIds, [], "expiry releases the handoff hold immediately");
    [stopped, expired, started, launch, launchResult, stopped].forEach(h.feed);
    assert.equal(h.updates.at(-1)?.state, null);
    const terminal = h.updates.flatMap(update => update.terminalJobs ?? []);
    assert.deepEqual(terminal.map(job => [job.id, job.launchType, job.status]), [["monitor-task", "monitor", "killed"]]);
    assert.deepEqual(h.updates.flatMap(update => update.jobs ?? []).map(job => job.id).filter(id => id.startsWith("tool:")), [],
      "provisional monitor identity must never become a second durable job");
  } finally { h.driver.dispose(); }
});

test("monitor launch result supplies provider identity without task_started", () => {
  const h = harness();
  try {
    [launch, launchResult].forEach(h.feed);
    assert.deepEqual(h.updates.at(-1)?.pendingTaskIds, ["monitor-task"]);
    h.feed(stopped);
    assert.deepEqual(h.updates.at(-1)?.pendingTaskIds, []);
    assert.equal(h.updates.flatMap(update => update.terminalJobs ?? []).length, 1);
  } finally { h.driver.dispose(); }
});

test("a provisional monitor holds handoffs without a durable duplicate and replay keeps its provider id", () => {
  const h = harness();
  try {
    h.feed(launch);
    assert.equal(h.updates.at(-1)?.state, "running");
    assert.deepEqual(h.updates.at(-1)?.pendingTaskIds, ["tool:monitor-tool"]);
    assert.deepEqual(h.updates.at(-1)?.jobs, []);
    [started, launch, launchResult, launch].forEach(h.feed);
    assert.deepEqual(h.updates.at(-1)?.pendingTaskIds, ["monitor-task"]);
    assert.deepEqual(h.updates.at(-1)?.jobs?.map(job => job.id), ["monitor-task"]);
    h.feed(expired);
    assert.equal(h.updates.at(-1)?.state, null);
  } finally { h.driver.dispose(); }
});

test("Monitor metadata arriving after task_started still identifies expiry", () => {
  const h = harness();
  try {
    [started, launch, launchResult, expired, stopped].forEach(h.feed);
    assert.equal(h.updates.at(-1)?.state, null);
    assert.deepEqual(h.updates.flatMap(update => update.terminalJobs ?? []).map(job => job.id), ["monitor-task"]);
  } finally { h.driver.dispose(); }
});

test("monitor launch failure ends its provisional hold and stays ended on replay", () => {
  const h = harness();
  try {
    h.feed(launch);
    h.feed({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "monitor-tool", is_error: true, content: "Launch failed" }] } });
    h.feed(launch);
    assert.equal(h.updates.at(-1)?.state, null);
    assert.equal(h.updates.flatMap(update => update.terminalJobs ?? []).length, 1);
    assert.equal(h.updates.at(-1)?.terminalJobs?.[0]?.status, "failed");
  } finally { h.driver.dispose(); }
});

test("expired monitor releases a persistent configuration handoff before the one-hour bound", async () => {
  const updates: DriverBackgroundWorkUpdate[] = [];
  const children: any[] = [];
  const driver = new ClaudeCodeDriver({ command: "claude", args: [], cwd: "/tmp/monitor-test", env: {},
    config: { permissionMode: "acceptEdits" }, context: {} as DriverOptions["context"] },
  { onEvent() {}, onStderr() {}, onExit() {}, onBackgroundWork: update => updates.push(update) }, {
    spawn: () => {
      const child = new EventEmitter() as any;
      Object.assign(child, { pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
      children.push(child);
      return child;
    }, kill() {},
  } as any);
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  const send = (frame: unknown) => children[0].stdout.write(JSON.stringify(frame) + "\n");
  try {
    const first = driver.prompt("start monitor");
    await tick();
    [launch, started, launchResult, { type: "result", subtype: "success" }].forEach(send);
    assert.equal(await first, "end_turn");
    assert.equal(updates.at(-1)?.state, "running");
    [expired, stopped].forEach(send);
    assert.equal(updates.at(-1)?.state, null);
    driver.setConfig({ permissionMode: "plan" });
    const second = driver.prompt("queued handoff prompt");
    await tick();
    assert.equal(children[0].stdin.writableEnded, true, "quiescence allows old provider retirement immediately");
    children[0].emit("close", 0);
    await tick();
    assert.equal(children.length, 2, "handoff does not wait for handoff_wait_bound");
    children[1].stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
    assert.equal(await second, "end_turn");
    assert.deepEqual(updates.flatMap(update => update.terminalJobs ?? []).map(job => job.id), ["monitor-task"]);
  } finally {
    driver.dispose({ forceImmediate: true });
    for (const child of children) child.emit("close", 0);
  }
});

test("exact missing-task TaskStop error ends only its tracked monitor", () => {
  const h = harness();
  try {
    [launch, started, launchResult].forEach(h.feed);
    h.feed({ type: "system", subtype: "task_started", task_id: "sibling" });
    h.feed({ type: "assistant", message: { content: [{ type: "tool_use", id: "stop-tool", name: "TaskStop", input: { task_id: "monitor-task" } }] } });
    h.feed({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "stop-tool", is_error: true,
      content: "<tool_use_error>No task found with ID: monitor-task</tool_use_error>" }] },
      tool_use_result: "Error: No task found with ID: monitor-task" });
    assert.deepEqual(h.updates.at(-1)?.pendingTaskIds, ["sibling"]);
    assert.equal(h.updates.at(-1)?.terminalJobs?.[0]?.status, "killed");
  } finally { h.driver.dispose(); }
});

test("unrelated errors and non-monitor stopped notifications retain pending work", () => {
  const h = harness();
  try {
    [launch, started, launchResult].forEach(h.feed);
    h.feed({ type: "assistant", message: { content: [{ type: "tool_use", id: "stop-tool", name: "TaskStop", input: { task_id: "monitor-task" } }] } });
    h.feed({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "stop-tool", is_error: true,
      content: "<tool_use_error>Permission denied</tool_use_error>" }] } });
    assert.deepEqual(h.updates.at(-1)?.pendingTaskIds, ["monitor-task"]);
    h.feed({ type: "system", subtype: "task_started", task_id: "shell" });
    h.feed({ type: "system", subtype: "task_updated", task_id: "shell", patch: { status: "killed" } });
    h.feed({ type: "system", subtype: "task_notification", task_id: "shell", status: "stopped" });
    assert.deepEqual(h.updates.at(-1)?.pendingTaskIds, ["monitor-task", "shell"]);
  } finally { h.driver.dispose(); }
});
