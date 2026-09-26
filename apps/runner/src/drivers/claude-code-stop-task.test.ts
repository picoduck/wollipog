import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import {
  CLAUDE_PERSISTENT_FLAG,
  CLAUDE_STOP_TASK_CONFIRM_MS,
  CLAUDE_STOP_TASK_RESPONSE_MS,
  ClaudeCodeDriver,
} from "./claude-code.js";
import type { DriverBackgroundWorkUpdate, DriverCallbacks, DriverOptions } from "./driver.js";

// #1780: stopping one Claude background task by id, through the `stop_task` control request, keeps
// the provider process, its conversation, and every other task. The frame order below is the one
// Claude Code 2.1.283 produced in a live probe: `task_updated` (killed), then `task_notification`
// (stopped), then the control response. Claude answers `stop_task` with success even for a task
// it does not know, so only its own report proves a task ended.

const baseOpts: DriverOptions = {
  command: "claude",
  args: [],
  cwd: "/tmp/stop-task",
  env: {},
  config: { permissionMode: "acceptEdits" },
  context: { kind: "native" },
};

function recordingStdin(): { stdin: Writable; frames: any[] } {
  const frames: any[] = [];
  let buffer = "";
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      buffer += String(chunk);
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) frames.push(JSON.parse(line));
      }
      callback();
    },
  });
  return { stdin, frames };
}

function fakeProcess(stdin: Writable) {
  const child = new EventEmitter() as any;
  child.pid = 123;
  child.stdin = stdin;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const frame = (child: any, value: unknown) => child.stdout.write(JSON.stringify(value) + "\n");
const taskStarted = (child: any, taskId: string, toolUseId: string) =>
  frame(child, { type: "system", subtype: "task_started", task_id: taskId, tool_use_id: toolUseId });
const killedReport = (child: any, taskId: string, toolUseId: string) => {
  frame(child, { type: "system", subtype: "task_updated", task_id: taskId, patch: { status: "killed", end_time: 1 } });
  frame(child, { type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: toolUseId, status: "stopped" });
};
const controlResponse = (child: any, requestId: string, subtype: "success" | "error" = "success") =>
  frame(child, subtype === "success"
    ? { type: "control_response", response: { subtype, request_id: requestId, response: {} } }
    : { type: "control_response", response: { subtype, request_id: requestId, error: "no" } });

interface Harness {
  driver: ClaudeCodeDriver;
  spawned: any[];
  frames: any[];
  background: DriverBackgroundWorkUpdate[];
  events: unknown[];
  stderr: string[];
  timers: Array<{ callback: () => void; delay: number; cleared: boolean }>;
  killed: any[];
}

function harness(opts: Partial<DriverOptions> = {}): Harness {
  const spawned: any[] = [];
  const background: DriverBackgroundWorkUpdate[] = [];
  const events: unknown[] = [];
  const stderr: string[] = [];
  const timers: Harness["timers"] = [];
  const killed: any[] = [];
  const recorded = recordingStdin();
  const cb: DriverCallbacks = {
    onEvent: (event) => events.push(event),
    onStderr: (text) => stderr.push(text),
    onExit: () => {},
    onBackgroundWork: (update) => background.push(update),
  };
  const driver = new ClaudeCodeDriver({ ...baseOpts, ...opts }, cb, {
    spawn: () => {
      const child = fakeProcess(recorded.stdin);
      spawned.push(child);
      return child;
    },
    kill: (process: any) => killed.push(process),
    setTimer: (callback: () => void, delay: number) => {
      const timer = { callback, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer as any;
    },
    clearTimer: (timer: any) => { if (timer) timer.cleared = true; },
  } as any);
  return { driver, spawned, frames: recorded.frames, background, events, stderr, timers, killed };
}

/** One turn that launches a monitor and a shell task, then settles with both still running. */
async function launchTwoTasks(h: Harness): Promise<any> {
  const turn = h.driver.prompt("watch CI and run the suite");
  await nextTask();
  const child = h.spawned[0];
  taskStarted(child, "monitor-1", "toolu_monitor");
  taskStarted(child, "shell-2", "toolu_shell");
  frame(child, { type: "result", subtype: "success" });
  assert.equal(await turn, "end_turn");
  assert.deepEqual(h.background.at(-1)?.pendingTaskIds, ["monitor-1", "shell-2"]);
  return child;
}

function stopRequest(h: Harness, taskId: string): any {
  const request = h.frames.find((value) => value.type === "control_request" &&
    value.request?.subtype === "stop_task" && value.request?.task_id === taskId);
  assert.ok(request, `no stop_task control request for ${taskId}`);
  return request;
}

test("stopping one job ends only that task, keeps the process and the other job, and reports it killed by the runner (#1780)", async () => {
  const h = harness();
  const child = await launchTwoTasks(h);

  const stopping = h.driver.stopBackgroundJob("monitor-1");
  await nextTask();
  const request = stopRequest(h, "monitor-1");
  assert.match(request.request_id, /^wollipog_stop_task_/);
  killedReport(child, "monitor-1", "toolu_monitor");
  controlResponse(child, request.request_id);
  const result = await stopping;

  assert.equal(result.status, "stopped");
  const job = result.status === "stopped" ? result.job : undefined;
  assert.deepEqual(job && { id: job.id, status: job.status, continuationRequired: job.continuationRequired,
    endedByRunner: job.endedByRunner, toolUseId: job.toolUseId },
  { id: "monitor-1", status: "killed", continuationRequired: false, endedByRunner: true, toolUseId: "toolu_monitor" });
  const report = h.background.at(-1)!;
  assert.equal(report.state, "running", "the other job keeps running");
  assert.deepEqual(report.pendingTaskIds, ["shell-2"]);
  assert.deepEqual(report.terminalJobs?.map((terminal) => [terminal.id, terminal.status]), [["monitor-1", "killed"]]);
  assert.equal(h.background.filter((update) => update.terminalJobs?.length).length, 1, "the kill is reported once");
  assert.equal(h.background.some((update) => update.state === "orphaned"), false);
  assert.equal(child.stdin.writableEnded, false, "the provider process is kept");
  assert.deepEqual(h.killed, []);
  assert.equal(h.stderr.some((text) => text.includes("control_response")), false, "the answer is consumed, not ignored");

  // Claude may repeat its report of the stopped task; the ended job is not revived.
  frame(child, { type: "system", subtype: "task_notification", task_id: "monitor-1", status: "stopped" });
  await nextTask();
  assert.deepEqual(h.background.at(-1)?.pendingTaskIds, ["shell-2"]);

  // The conversation continues in the same process.
  const next = h.driver.prompt("next");
  await nextTask();
  frame(child, { type: "result", subtype: "success" });
  assert.equal(await next, "end_turn");
  assert.equal(h.spawned.length, 1);
  h.driver.dispose();
});

test("a job can be stopped while a turn is running, and the turn is unaffected (#1780)", async () => {
  const h = harness();
  const child = await launchTwoTasks(h);
  const turn = h.driver.prompt("keep working");
  await nextTask();
  const stopping = h.driver.stopBackgroundJob("shell-2");
  await nextTask();
  const request = stopRequest(h, "shell-2");
  killedReport(child, "shell-2", "toolu_shell");
  controlResponse(child, request.request_id);
  const result = await stopping;
  assert.equal(result.status, "stopped");
  assert.equal(result.status === "stopped" && result.job.continuationRequired, false);
  assert.deepEqual(h.background.at(-1)?.pendingTaskIds, ["monitor-1"]);
  frame(child, { type: "assistant", message: { content: [{ type: "text", text: "still here" }] } });
  frame(child, { type: "result", subtype: "success" });
  assert.equal(await turn, "end_turn");
  h.driver.dispose();
});

test("an answer without Claude's report leaves the job as it was (#1780)", async () => {
  const h = harness();
  const child = await launchTwoTasks(h);
  const stopping = h.driver.stopBackgroundJob("monitor-1");
  await nextTask();
  controlResponse(child, stopRequest(h, "monitor-1").request_id);
  await nextTask();
  const confirm = h.timers.find((timer) => timer.delay === CLAUDE_STOP_TASK_CONFIRM_MS && !timer.cleared);
  assert.ok(confirm, "the runner waits briefly for the report");
  confirm.callback();
  assert.deepEqual(await stopping, { status: "refused", reason: "unconfirmed" });
  assert.deepEqual(h.background.at(-1)?.pendingTaskIds, ["monitor-1", "shell-2"]);

  // A report that arrives only after the window still ends the job, on the ordinary killed path,
  // so a slow stop cannot leave it blocking a sibling or a handoff forever. Its trailing
  // notification does not revive it.
  killedReport(child, "monitor-1", "toolu_monitor");
  await nextTask();
  const late = h.background.at(-1)!;
  assert.deepEqual(late.pendingTaskIds, ["shell-2"]);
  assert.deepEqual(late.terminalJobs?.map((job) => [job.id, job.status, job.endedByRunner]), [["monitor-1", "killed", undefined]]);
  assert.equal(late.terminalJobs?.[0]?.continuationRequired, true, "outside a turn, the provider is told the job ended");
  frame(child, { type: "system", subtype: "task_notification", task_id: "monitor-1", status: "stopped" });
  await nextTask();
  assert.deepEqual(h.background.at(-1)?.pendingTaskIds, ["shell-2"]);
  h.driver.dispose();
});

test("a report that trails the answer within the confirmation window still counts (#1780)", async () => {
  const h = harness();
  const child = await launchTwoTasks(h);
  const stopping = h.driver.stopBackgroundJob("monitor-1");
  await nextTask();
  controlResponse(child, stopRequest(h, "monitor-1").request_id);
  await nextTask();
  killedReport(child, "monitor-1", "toolu_monitor");
  const result = await stopping;
  assert.equal(result.status, "stopped");
  assert.ok(h.timers.find((timer) => timer.delay === CLAUDE_STOP_TASK_CONFIRM_MS)?.cleared);
  h.driver.dispose();
});

test("a refused, unanswered, or interrupted stop leaves the job running (#1780)", async () => {
  const rejected = harness();
  const rejectedChild = await launchTwoTasks(rejected);
  const refusing = rejected.driver.stopBackgroundJob("monitor-1");
  await nextTask();
  controlResponse(rejectedChild, stopRequest(rejected, "monitor-1").request_id, "error");
  assert.deepEqual(await refusing, { status: "refused", reason: "provider_rejected" });
  assert.deepEqual(rejected.background.at(-1)?.pendingTaskIds, ["monitor-1", "shell-2"]);
  // A refused stop is not remembered: a later `stopped` report keeps its previous meaning.
  frame(rejectedChild, { type: "system", subtype: "task_notification", task_id: "monitor-1", status: "stopped" });
  await nextTask();
  assert.deepEqual(rejected.background.at(-1)?.pendingTaskIds, ["monitor-1", "shell-2"]);
  rejected.driver.dispose();

  const silent = harness();
  await launchTwoTasks(silent);
  const waiting = silent.driver.stopBackgroundJob("monitor-1");
  await nextTask();
  silent.timers.find((timer) => timer.delay === CLAUDE_STOP_TASK_RESPONSE_MS)!.callback();
  assert.deepEqual(await waiting, { status: "refused", reason: "unconfirmed" });
  // An unanswered stop that Claude carries out later still ends the job.
  frame(silent.spawned[0], { type: "system", subtype: "task_notification", task_id: "monitor-1", status: "stopped" });
  await nextTask();
  assert.deepEqual(silent.background.at(-1)?.pendingTaskIds, ["shell-2"]);
  silent.driver.dispose();

  const exiting = harness();
  const exitingChild = await launchTwoTasks(exiting);
  const interrupted = exiting.driver.stopBackgroundJob("monitor-1");
  await nextTask();
  exitingChild.emit("close", 1);
  assert.deepEqual(await interrupted, { status: "refused", reason: "no_live_process" });
  exiting.driver.dispose();
});

test("a job that finishes on its own while being stopped is reported as finished, not stopped (#1780)", async () => {
  const h = harness();
  const child = await launchTwoTasks(h);
  const stopping = h.driver.stopBackgroundJob("shell-2");
  await nextTask();
  frame(child, { type: "system", subtype: "task_notification", task_id: "shell-2", tool_use_id: "toolu_shell", status: "completed" });
  controlResponse(child, stopRequest(h, "shell-2").request_id);
  const result = await stopping;
  assert.equal(result.status, "finished");
  const job = result.status === "finished" ? result.job : undefined;
  assert.equal(job?.status, "completed");
  assert.equal(job?.endedByRunner, undefined);
  assert.equal(job?.continuationRequired, true, "its result is still delivered");
  h.driver.dispose();
});

test("a launch result that trails a stop cannot register the stopped task again (#1780)", async () => {
  const h = harness();
  const child = await launchTwoTasks(h);
  const turn = h.driver.prompt("launch a monitor");
  await nextTask();
  // Claude reports the task started; the stop lands before its async-launch tool result.
  taskStarted(child, "monitor-late", "toolu_late");
  await nextTask();
  const stopping = h.driver.stopBackgroundJob("monitor-late");
  await nextTask();
  killedReport(child, "monitor-late", "toolu_late");
  controlResponse(child, stopRequest(h, "monitor-late").request_id);
  assert.equal((await stopping).status, "stopped");
  frame(child, { type: "user", message: { content: [{
    type: "tool_result", tool_use_id: "toolu_late",
    content: JSON.stringify({ status: "async_launched", taskId: "monitor-late", outputFile: "/tmp/monitor-late.output" }),
  }] } });
  frame(child, { type: "result", subtype: "success" });
  assert.equal(await turn, "end_turn");
  assert.deepEqual(h.background.at(-1)?.pendingTaskIds, ["monitor-1", "shell-2"],
    "the stopped task is not pending again, so it cannot hold a handoff it can no longer be stopped from");
  h.driver.dispose();
});

test("only a task the live process launched can be stopped (#1780)", async () => {
  const h = harness();
  assert.deepEqual(await h.driver.stopBackgroundJob("nothing"), { status: "not_running" });
  const child = await launchTwoTasks(h);
  assert.deepEqual(await h.driver.stopBackgroundJob("unknown"), { status: "not_running" });

  // A launch Claude has not yet confirmed as a task has no task id to stop.
  const turn = h.driver.prompt("launch another");
  await nextTask();
  frame(child, { type: "assistant", message: { content: [
    { type: "tool_use", id: "toolu_pending", name: "Bash", input: { command: "sleep 9", run_in_background: true } },
  ] } });
  await nextTask();
  assert.deepEqual(await h.driver.stopBackgroundJob("tool:toolu_pending"), { status: "refused", reason: "not_owned" });
  frame(child, { type: "result", subtype: "success" });
  await turn;
  assert.equal(h.frames.some((value) => value.type === "control_request"), false, "nothing was sent to Claude");
  h.driver.dispose();

  // A task remembered from before a restart belongs to no live process until it is re-observed.
  const seeded = harness({ initialBackgroundTaskIds: ["old-monitor"] });
  assert.deepEqual(await seeded.driver.stopBackgroundJob("old-monitor"), { status: "refused", reason: "no_live_process" });
  const seededTurn = seeded.driver.prompt("resume");
  await nextTask();
  assert.deepEqual(await seeded.driver.stopBackgroundJob("old-monitor"), { status: "refused", reason: "not_owned" });
  frame(seeded.spawned[0], { type: "result", subtype: "success" });
  await seededTurn;
  seeded.driver.dispose();

  // A one-shot process has already exited; its work belongs to orphan recovery.
  const oneShot = harness({ env: { [CLAUDE_PERSISTENT_FLAG]: "0" } });
  const oneShotTurn = oneShot.driver.prompt("delegate once");
  await nextTask();
  taskStarted(oneShot.spawned[0], "one-shot-task", "toolu_one");
  frame(oneShot.spawned[0], { type: "result", subtype: "success" });
  oneShot.spawned[0].emit("close", 0);
  await oneShotTurn;
  assert.deepEqual(await oneShot.driver.stopBackgroundJob("one-shot-task"), { status: "refused", reason: "no_live_process" });
  oneShot.driver.dispose();
});
