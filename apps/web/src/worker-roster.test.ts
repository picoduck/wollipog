import assert from "node:assert/strict";
import test from "node:test";
import type { SessionStatus, SessionView } from "@wollipog/protocol";
import { statusValues } from "./status-meta.js";
import {
  backgroundWorkerState,
  isCurrentWorker,
  isLiveWorker,
  memberName,
  memberWorkerStatus,
  stepActivity,
  subagentWorkerStatus,
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

test("every member status maps to exactly one word, on the session vocabulary", () => {
  const expected: Record<SessionStatus, string> = {
    queued: "Queued", starting: "Running", running: "Running", input_required: "Needs Your Input",
    idle: "Awaiting Prompt", completed: "Completed", failed: "Failed", stopped: "Stopped",
  };
  for (const [status, label] of Object.entries(expected) as [SessionStatus, string][]) {
    assert.equal(workerStatusMeta(memberWorkerStatus({ status, pendingApproval: null }, true)).label, label, status);
  }
  const asking = memberWorkerStatus({ status: "input_required",
    pendingApproval: { requestId: "q", title: "Pick", kind: "question", options: [], questions: [] } }, true);
  assert.equal(workerStatusMeta(asking).label, "Answer Required");
  assert.equal(memberWorkerStatus({ status: "running", pendingApproval: null }, false).state, "unverified");
  assert.equal(memberWorkerStatus({ status: "idle", pendingApproval: null }, true, "completed").state, "completed",
    "a workflow node that finished retires its idle member");
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
  const reviewer = { ...session, id: "reviewer", title: "Review", createdAt: 1, updatedAt: 2, preview: "Reading the **diff**.",
    pendingApproval: null, model: "review-model", effort: "high", tokensIn: 5, tokensOut: 7, status: "running" } as unknown as SessionView;
  const pod = { id: "pod:p", name: "Parser Pod" };
  const rows = workerRoster(session, [parent, { ...child, parentId: "lead" }], [session, reviewer, reviewer], () => true,
    new Map([["reviewer", { group: pod, role: "reviewer", phase: "independent-review", activations: 2 }]]));
  assert.equal(rows.length, 4);
  const [lead, inspect, monitor, review] = rows as [typeof rows[0], typeof rows[0], typeof rows[0], typeof rows[0]];
  assert.deepEqual([lead.group.name, inspect.group.name, monitor.group.name, review.group.name],
    ["Subagents", "Subagents", "Background Jobs", "Parser Pod"]);
  assert.equal(inspect.parentId, "subagent:lead");
  assert.deepEqual([inspect.state, inspect.attention], ["attention", "approval_required"]);
  assert.equal(inspect.activity, "Waiting to edit src/auth/parser.ts");
  assert.equal(lead.activity, "Starting its first step");
  assert.equal(monitor.state, "running");
  assert.equal(monitor.activity, "A monitor the agent started in the background");
  assert.equal(review.activity, "Reading the diff.");
  assert.equal(inspect.tokens, 5);
  assert.equal(inspect.inclusiveTokens, 12);
  assert.equal(review.activations, 2);
  assert.equal(rows.filter(isCurrentWorker).length, 4);
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

test("offline workers stay current as Unverified; settled ones move to History", () => {
  const offline = workerRoster(session, [{ ...child, availability: "recorded" }], [], () => false);
  assert.deepEqual(offline.map((row) => row.state), ["unverified", "unverified"]);
  assert.equal(offline.filter(isCurrentWorker).length, 2);
  assert.equal(offline[0]!.activity, "Last seen running npm test", "an unverified step is never reported as done");
  assert.equal(offline.filter(isLiveWorker).length, 0, "the session header counts only verifiably live workers");
  assert.equal(isLiveWorker({ state: "attention" }), true, "a worker waiting on the user is still in flight");
  const completed = workerRoster(session, [{ ...child, lifecycle: "completed", latestTool: { title: "$ npm test", active: false } }], [], () => true)[0]!;
  assert.equal(completed.state, "completed");
  assert.equal(completed.activity, "Ran npm test");
  assert.equal(isCurrentWorker(completed), false);
  assert.equal(backgroundWorkerState({ ...session.backgroundJobs![0]!, terminalStatus: "completed" }, session, true), "completed");
  assert.equal(backgroundWorkerState({ ...session.backgroundJobs![0]!, terminalStatus: "killed" }, session, true), "stopped");
  assert.equal(backgroundWorkerState(session.backgroundJobs![0]!, { ...session, backgroundWorkState: "resumed" }, true), "unverified");
  assert.equal(backgroundWorkerState({ ...session.backgroundJobs![0]!, sourcePresent: false }, session, true), "unverified");
  assert.equal(workerRoster(session, [{ ...child, availability: "recorded" }], [], () => true)[0]!.latestTool?.active, false,
    "recorded history never labels an unfinished tool as current activity");
});

test("legacy empty evidence has no fabricated workers and unknown ownership is not assigned", () => {
  const legacy = { ...session, backgroundJobs: undefined, pendingApproval: { requestId: "ask", title: "Choose", options: [] } } as SessionView;
  assert.deepEqual(workerRoster(legacy, [], [], () => true), []);
  assert.equal(workerRoster(legacy, [child], [], () => true)[0]!.state, "running");
});

test("terminal workflow evidence retires idle members without hiding new running work", () => {
  const member = { ...session, id: "member", status: "idle", pendingApproval: null } as SessionView;
  const metadata = new Map([["member", { terminalState: "completed" as const, completedAt: 50 }]]);
  const completed = workerRoster(session, [], [member], () => true, metadata).at(-1)!;
  assert.equal(completed.state, "completed");
  assert.equal(completed.completedAt, 50);
  assert.equal(isCurrentWorker(completed), false);
  const restarted = workerRoster(session, [], [{ ...member, status: "running" }], () => true, metadata).at(-1)!;
  assert.equal(restarted.state, "running");
  assert.equal(restarted.completedAt, undefined, "stale workflow completion must not freeze a new activation's duration");
});

test("a run member leads with its agent under the run's heading", () => {
  assert.equal(memberName({ title: "Release Audit · Claude Code", agentName: "Claude Code" }, "Release Audit"), "Claude Code");
  assert.equal(memberName({ title: "Fix Parser", agentName: "Codex" }, "Release Audit"), "Codex · Fix Parser");
  assert.equal(memberName({ title: "Release Audit", agentName: "Codex" }, "Release Audit"), "Codex");
  assert.equal(memberName({ title: "Pod Member", agentName: "Codex" }), "Pod Member", "a pod member keeps its title");
});
