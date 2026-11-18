import assert from "node:assert/strict";
import test from "node:test";
import type { PendingApproval, SessionStatus, SessionView } from "@wollipog/protocol";
import { statusValues } from "./status-meta.js";
import {
  backgroundWorkerState,
  isCurrentWorker,
  isLiveWorker,
  stepActivity,
  subagentWorkerStatus,
  workerElapsed,
  workerRequestSentence,
  workerRoster,
  workerStatusMeta,
  type WorkerState,
} from "./worker-roster.js";
import type { SubagentDescriptor, SubagentLifecycle } from "./subagents.js";

const session = {
  id: "parent", runnerId: "runner", status: "running", backgroundWorkState: "running",
  pendingApproval: { requestId: "ask", ownerToolUseId: "child", title: "Edit: src/auth/parser.ts", options: [] },
  backgroundJobs: [{ id: "monitor", parentTurnId: "turn-1", launchType: "monitor",
    registeredAt: 1, lastObservedAt: 2, sourcePresent: true }],
} as unknown as SessionView;
const child: SubagentDescriptor = {
  id: "child", childIds: [], title: "Inspect Parser", depth: 1, sourceIndex: 0,
  lifecycle: "running", toolStatus: "in_progress", availability: "live",
  directUsage: { inputTokens: 3, outputTokens: 2 },
  inclusiveUsage: { inputTokens: 7, outputTokens: 5 },
  toolCount: 2,
  latestTool: { title: "$ npm test", active: true },
};

const WORKER_WORDS: Record<WorkerState, [label: string, tone: string]> = {
  running: ["Running", "info"],
  queued: ["Queued", "neutral"],
  awaiting_prompt: ["Awaiting Prompt", "neutral"],
  attention: ["Needs Your Input", "warning"],
  completed: ["Completed", "success"],
  failed: ["Failed", "danger"],
  stopped: ["Stopped", "neutral"],
  unverified: ["Unverified", "neutral"],
  lost: ["Lost", "danger"],
};

test("every worker state reads exactly one word and tone (#2857)", () => {
  for (const [state, [label, tone]] of Object.entries(WORKER_WORDS) as [WorkerState, [string, string]][]) {
    const meta = workerStatusMeta({ state });
    assert.deepEqual([meta.label, meta.tone], [label, tone], state);
  }
  assert.equal(workerStatusMeta({ state: "running" }).pulse, true, "only Running pulses");
  assert.equal(workerStatusMeta({ state: "unverified" }).hollow, true, "Unverified has a hollow dot");
  assert.deepEqual(workerStatusMeta({ state: "attention", attention: "approval_required" }).label, "Approval Required");
  assert.deepEqual(workerStatusMeta({ state: "attention", attention: "answer_required" }).label, "Answer Required");
  assert.deepEqual(workerStatusMeta({ state: "attention", attention: "review_requested" }).label, "Needs Your Input",
    "an attention kind with no word of its own falls back to the general one");
});

test("the job domain no longer carries Working, Waiting or Input Required", () => {
  const values: readonly string[] = statusValues("job");
  for (const retired of ["working", "waiting", "input_required"]) assert.equal(values.includes(retired), false, retired);
});

test("every subagent lifecycle maps to one worker state, the same for the roster and the transcript", () => {
  const expected: Record<SubagentLifecycle, [live: WorkerState, recorded: WorkerState]> = {
    starting: ["running", "unverified"], running: ["running", "unverified"], waiting: ["running", "unverified"],
    completed: ["completed", "completed"], failed: ["failed", "failed"], interrupted: ["stopped", "stopped"],
    unreachable: ["lost", "unverified"], unknown: ["unverified", "unverified"],
  };
  for (const [lifecycle, [live, recorded]] of Object.entries(expected) as [SubagentLifecycle, [WorkerState, WorkerState]][]) {
    assert.equal(subagentWorkerStatus({ lifecycle, availability: "live" }).state, live, `${lifecycle} live`);
    assert.equal(subagentWorkerStatus({ lifecycle, availability: "recorded" }).state, recorded, `${lifecycle} recorded`);
  }
  assert.deepEqual(subagentWorkerStatus({ lifecycle: "running", availability: "live" }, "approval_required"),
    { state: "attention", attention: "approval_required" });
  assert.equal(subagentWorkerStatus({ lifecycle: "completed", availability: "live" }, "approval_required").state, "completed",
    "terminal truth wins over a stale pending owner");
});

test("roster rows carry a group, an activity sentence and a parent, and keep the page's facts", () => {
  const parent: SubagentDescriptor = { ...child, id: "lead", title: "Lead", depth: 0, childIds: ["child"], latestTool: undefined };
  const rows = workerRoster(session, [parent, { ...child, parentId: "lead" }], true);
  assert.equal(rows.length, 3);
  const [lead, inspect, monitor] = rows as [typeof rows[0], typeof rows[0], typeof rows[0]];
  assert.deepEqual([lead.group.name, inspect.group.name, monitor.group.name],
    ["Subagents", "Subagents", "Background Jobs"]);
  assert.equal(inspect.parentId, "subagent:lead");
  assert.deepEqual([inspect.state, inspect.attention], ["attention", "approval_required"]);
  assert.equal(inspect.activity, "Waiting to edit src/auth/parser.ts");
  assert.equal(lead.activity, "Starting its first step");
  assert.equal(monitor.state, "running");
  assert.equal(monitor.activity, "A monitor the agent started in the background");
  // The row sets the job's id apart; the whole name stays for titles and sentences (§4.10).
  assert.equal(monitor.name, "Monitor Job 3e0219");
  assert.deepEqual(monitor.nameParts, { kind: "Monitor Job", id: "3e0219" });
  assert.equal(inspect.tokens, 5);
  assert.equal(inspect.inclusiveTokens, 12);
  assert.equal(rows.filter(isCurrentWorker).length, 3);
});

test("subagent roster token totals distinguish reported zero from unavailable usage", () => {
  const cases: [usage: SubagentDescriptor["directUsage"], expected: number | undefined][] = [
    [undefined, undefined],
    [{}, undefined],
    [{ inputTokens: 0, outputTokens: 0 }, 0],
    [{ inputTokens: 0 }, 0],
    [{ outputTokens: 0 }, 0],
    [{ inputTokens: 3 }, 3],
    [{ outputTokens: 2 }, 2],
    [{ inputTokens: 3, outputTokens: 2 }, 5],
  ];
  for (const [usage, expected] of cases) {
    for (const field of ["directUsage", "inclusiveUsage"] as const) {
      const row = workerRoster(session, [{ ...child, [field]: usage }], true)[0]!;
      const tokenField = field === "directUsage" ? "tokens" : "inclusiveTokens";
      assert.equal(row[tokenField], expected, `${field}: ${JSON.stringify(usage)}`);
      assert.equal(Object.hasOwn(row, tokenField), expected !== undefined,
        "unavailable usage is omitted rather than fabricated as zero");
    }
  }
});

test("a worker's tokens say whether its provider counts cached input (#3086)", () => {
  const claudeParent = { ...session, driver: "claude-code" } as SessionView;
  const rows = workerRoster(claudeParent, [child], true);
  const basis = Object.fromEntries(rows.map((row) => [row.id, row.inputBasis]));
  assert.deepEqual(basis, {
    "subagent:child": "excludesCached",
    "background:monitor": undefined,
  });
});

test("a roster row's elapsed time reads in days and hours past a day, unchanged under it (#2857)", () => {
  const minute = 60_000;
  const hour = 60 * minute;
  assert.equal(workerElapsed(3 * hour + 20 * minute), "3h 20m");
  assert.equal(workerElapsed(23 * hour + 59 * minute), "23h 59m");
  assert.equal(workerElapsed(5 * minute + 12_000), "5m 12s");
  assert.equal(workerElapsed(24 * hour), "1d");
  assert.equal(workerElapsed(2 * 24 * hour + 3 * hour + 40 * minute), "2d 3h");
  assert.equal(workerElapsed(16 * 24 * hour), "16d");
  assert.equal(workerElapsed(384 * hour + 14 * minute), "16d");
});

test("a step reads as what the worker is doing, did, or waits to do", () => {
  assert.equal(stepActivity("$ npm test", "now"), "Running npm test");
  assert.equal(stepActivity("Bash: npm test", "done"), "Ran npm test");
  assert.equal(stepActivity("Edit: /repo/src/a.ts", "wait", "/repo"), "Waiting to edit src/a.ts");
  assert.equal(stepActivity("Run Parser Tests?", "wait"), "Run Parser Tests?", "an unknown verb reads as written");
  assert.equal(stepActivity("Agent: Write Parser Tests", "now"), "Waiting on Write Parser Tests", "a worker waits on the one it spawned");
  assert.equal(stepActivity("$ npm test", "seen"), "Last seen running npm test");
  assert.equal(stepActivity("Read Schema", "seen"), "Last seen: Read Schema");
});

test("a worker page's notice says what the worker wants and what it waits for (#2860)", () => {
  const request = (title: string, extra: Partial<PendingApproval> = {}) =>
    ({ requestId: "r", title, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }], ...extra }) as PendingApproval;
  assert.equal(workerRequestSentence(request("Bash: npm test -- storage")),
    "Wants to run npm test -- storage and is waiting for your approval.");
  assert.equal(workerRequestSentence(request("Edit: /repo/src/a.ts"), "/repo"), "Wants to edit src/a.ts and is waiting for your approval.");
  assert.equal(workerRequestSentence(request("Run Parser Tests?")), "Is waiting for your approval.",
    "a title that is not a step leaves the card to say it");
  assert.equal(workerRequestSentence(request("Choose Scope", { kind: "question", options: [], questions: [] })),
    "Has a question and is waiting for your answer.");
});

test("offline workers stay current as Unverified; settled ones move to History", () => {
  const offline = workerRoster(session, [{ ...child, availability: "recorded" }], false);
  assert.deepEqual(offline.map((row) => row.state), ["unverified", "unverified"]);
  assert.equal(offline.filter(isCurrentWorker).length, 2);
  assert.equal(offline[0]!.activity, "Last seen running npm test", "an unverified step is never reported as done");
  assert.equal(offline.filter(isLiveWorker).length, 0, "the session header counts only verifiably live workers");
  assert.equal(isLiveWorker({ state: "attention" }), true, "a worker waiting on the user is still in flight");
  const completed = workerRoster(session, [{ ...child, lifecycle: "completed", latestTool: { title: "$ npm test", active: false } }], true)[0]!;
  assert.equal(completed.state, "completed");
  assert.equal(completed.activity, "Ran npm test");
  assert.equal(isCurrentWorker(completed), false);
  assert.equal(backgroundWorkerState({ ...session.backgroundJobs![0]!, terminalStatus: "completed" }, session, true), "completed");
  assert.equal(backgroundWorkerState({ ...session.backgroundJobs![0]!, terminalStatus: "killed" }, session, true), "stopped");
  assert.equal(backgroundWorkerState(session.backgroundJobs![0]!, { ...session, backgroundWorkState: "resumed" }, true), "unverified");
  assert.equal(backgroundWorkerState({ ...session.backgroundJobs![0]!, sourcePresent: false }, session, true), "unverified");
  assert.equal(workerRoster(session, [{ ...child, availability: "recorded" }], true)[0]!.latestTool?.active, false,
    "recorded history never labels an unfinished tool as current activity");
});

test("legacy empty evidence has no fabricated workers and unknown ownership is not assigned", () => {
  const legacy = { ...session, backgroundJobs: undefined, pendingApproval: { requestId: "ask", title: "Choose", options: [] } } as SessionView;
  assert.deepEqual(workerRoster(legacy, [], true), []);
  assert.equal(workerRoster(legacy, [child], true)[0]!.state, "running");
});
