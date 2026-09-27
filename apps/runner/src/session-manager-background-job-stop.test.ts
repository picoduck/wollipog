import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import type { RunnerToControlPlane, SessionLaunchSpec, SessionQueueHoldView } from "@wollipog/protocol";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { ClaudeCodeDriver } from "./drivers/claude-code.js";
import type {
  DriverBackgroundJob,
  DriverBackgroundJobStopResult,
  DriverBackgroundTerminalJob,
  DriverCallbacks,
  DriverOptions,
} from "./drivers/driver.js";
import { SessionManager, type DurableCommandLifecycle } from "./session-manager.js";
import { SessionStore } from "./session-store.js";

// #1780: an authorized actor stops one managed background job by id from outside the session. Only
// that job ends; what waited on it proceeds as though it had ended on its own.

const CONTINUATION_PREFIX = "Managed background jobs reached their terminal barrier.";

async function waitFor(predicate: () => boolean, message: string, attempts = 800): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function haveGit(): boolean {
  try {
    execFileSync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

function initRepo(root: string): string {
  const repo = join(root, "repo");
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
  return repo;
}

interface ProviderProcess {
  cwd: string;
  cb: DriverCallbacks;
}

/**
 * A Claude-shaped provider whose `stopBackgroundJob` behaves like the real driver's: it ends only
 * the named job, reports it killed and runner-ended with the rest still running, and keeps the
 * process. `endBackgroundWork` is present but must never be called by a stop.
 */
function fakeProvider(options: {
  canStop?: boolean;
  onPrompt?: (provider: ProviderProcess, text: string) => void;
  stopReason?: (text: string) => "end_turn" | "cancelled" | "refusal" | "throw";
} = {}) {
  const providers: ProviderProcess[] = [];
  const prompts: Array<{ cwd: string; text: string }> = [];
  const live = new Map<string, DriverBackgroundJob>();
  const stopCalls: string[] = [];
  let endCalls = 0;
  let stopResult: ((jobId: string) => DriverBackgroundJobStopResult | undefined) | undefined;
  const report = (provider: ProviderProcess, terminalJobs: DriverBackgroundTerminalJob[] = []) => {
    const jobs = [...live.values()];
    provider.cb.onBackgroundWork?.(jobs.length
      ? {
          state: "running",
          pendingTaskIds: jobs.map((job) => job.id).sort(),
          jobs,
          observedTaskIds: jobs.map((job) => job.id).sort(),
          ...(terminalJobs.length ? { terminalJobs } : {}),
        }
      : { state: null, pendingTaskIds: [], ...(terminalJobs.length ? { terminalJobs } : {}) });
  };
  const factory = (_driver: unknown, launch: { cwd: string }, cb: DriverCallbacks) => {
    const provider: ProviderProcess = { cwd: launch.cwd, cb };
    providers.push(provider);
    return {
      pid: providers.length,
      initialize: async () => {},
      newSession: async () => {},
      close: async () => {},
      handoffWaitMaxMs: 0,
      endBackgroundWork: async () => {
        endCalls += 1;
        return { status: "none" as const };
      },
      ...(options.canStop === false ? {} : {
        stopBackgroundJob: async (jobId: string): Promise<DriverBackgroundJobStopResult> => {
          stopCalls.push(jobId);
          const override = stopResult?.(jobId);
          if (override) return override;
          const job = live.get(jobId);
          if (!job) return { status: "not_running" };
          live.delete(jobId);
          const terminal: DriverBackgroundTerminalJob = {
            ...job, status: "killed", terminalAt: Date.now(), continuationRequired: false, endedByRunner: true,
          };
          report(provider, [terminal]);
          return { status: "stopped", job: terminal };
        },
      }),
      prompt: async (text: string) => {
        prompts.push({ cwd: launch.cwd, text });
        cb.onPromptAccepted?.();
        options.onPrompt?.(provider, text);
        const reason = options.stopReason?.(text) ?? "end_turn";
        if (reason === "throw") throw new Error("provider transport failed");
        if (reason !== "end_turn") return reason;
        cb.onEvent({ kind: "agent_message", text: `answer to: ${text.slice(0, 40)}`, final: true });
        return "end_turn" as const;
      },
      cancel: () => {},
      dispose: () => {},
      setConfig: () => {},
      resolvePermission: () => false,
      agentSessionId: () => "provider-session-id",
    };
  };
  return {
    factory, providers, prompts, live, stopCalls, report,
    get endCalls() { return endCalls; },
    set stopResult(value: typeof stopResult) { stopResult = value; },
  };
}

type Fake = ReturnType<typeof fakeProvider>;

/** The incident's turn: a monitor that never fires and a subagent. A later turn starts a shell job. */
function launches(fake: Fake) {
  return (provider: ProviderProcess, text: string) => {
    const startedAt = Date.now();
    if (text === "watch CI and review") {
      fake.live.set("monitor-1", { id: "monitor-1", launchType: "monitor", startedAt });
      fake.live.set("agent-1", { id: "agent-1", launchType: "agent", startedAt });
      fake.report(provider);
    } else if (text === "run the suite") {
      fake.live.set("shell-3", { id: "shell-3", launchType: "shell", startedAt });
      fake.report(provider);
    }
  };
}

/** The subagent finishes after its parent turn ended; the monitor does not. */
function finishSubagent(fake: Fake): void {
  const agent = fake.live.get("agent-1")!;
  fake.live.delete("agent-1");
  fake.report(fake.providers.at(-1)!, [{ ...agent, status: "completed", terminalAt: Date.now(), continuationRequired: true }]);
}

function recordingLifecycle(commandId: string, log: string[]): DurableCommandLifecycle {
  return {
    commandId,
    queued: () => { log.push(`${commandId}:queued`); },
    started: () => { log.push(`${commandId}:started`); },
    completed: () => { log.push(`${commandId}:completed`); },
    failed: (error) => { log.push(`${commandId}:failed:${error}`); },
    uncertain: (error) => { log.push(`${commandId}:uncertain:${error}`); },
  };
}

function publishedHolds(sent: RunnerToControlPlane[]): Array<SessionQueueHoldView | null | undefined> {
  return sent.filter((message) => message.type === "session_runtime_updated")
    .map((message) => (message as { snapshot: { queueHold?: SessionQueueHoldView | null } }).snapshot.queueHold);
}

function claudeSpec(sessionId: string, repo: string): SessionLaunchSpec {
  return {
    sessionId, workspaceId: "repo", workspacePath: repo, agentId: "claude",
    command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code",
    context: { kind: "native" },
  };
}

function stopNotices(store: SessionStore, sessionId: string): string[] {
  return store.readEvents(sessionId).flatMap((event) => event.payload.kind === "stderr" &&
    event.payload.text.startsWith("Wollipog stopped") ? [event.payload.text] : []);
}

test("stopping a never-firing monitor clears Result Blocked, delivers the sibling's result once, and leaves the other job and the process running (#1780)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-job-stop-blocked-"));
  let manager: SessionManager | undefined;
  try {
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    let onPrompt: (provider: ProviderProcess, text: string) => void = () => {};
    const fake = fakeProvider({ onPrompt: (provider, text) => onPrompt(provider, text) });
    onPrompt = launches(fake);
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, fake.factory as never, dataDir, 1);
    const spec = claudeSpec("s_job_stop_blocked", root);
    await manager.start(spec);

    manager.prompt(spec.sessionId, "watch CI and review");
    await waitFor(() => fake.prompts.length === 1 && store.readMeta(spec.sessionId)?.status === "idle",
      "the launching turn did not finish");
    manager.prompt(spec.sessionId, "run the suite");
    await waitFor(() => fake.prompts.length === 2 && store.readMeta(spec.sessionId)?.status === "idle",
      "the second turn did not finish");
    finishSubagent(fake);
    const blocked = store.readMeta(spec.sessionId)!;
    assert.equal(blocked.backgroundJobs?.find((job) => job.id === "agent-1")?.continuationQueuedAt, undefined,
      "Result Blocked: the finished sibling waits for the monitor from the same turn");

    const outcome = await manager.stopBackgroundJob(spec.sessionId, "monitor-1", { kind: "user", userId: "usr_owner" });
    assert.deepEqual(outcome, { outcome: "stopped", terminalStatus: "killed" });
    await waitFor(() => fake.prompts.length === 3, "the sibling's continuation did not run");
    await waitFor(() => store.readEvents(spec.sessionId)
      .some((event) => event.payload.kind === "background_continuation_delivered"), "the result was not delivered");

    // Exactly one continuation, naming the finished sibling and the stopped monitor.
    const continuation = fake.prompts[2]!;
    assert.ok(continuation.text.startsWith(CONTINUATION_PREFIX));
    assert.match(continuation.text, /"id":"agent-1","launchType":"agent","status":"completed"/);
    assert.match(continuation.text, /"id":"monitor-1","launchType":"monitor","status":"killed"/);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const events = store.readEvents(spec.sessionId);
    assert.equal(events.filter((event) => event.payload.kind === "background_continuation_delivered").length, 1);
    assert.equal(fake.prompts.filter((prompt) => prompt.text.startsWith(CONTINUATION_PREFIX)).length, 1);

    // Only the monitor ended, by the stop request and not by retiring the provider.
    const meta = store.readMeta(spec.sessionId)!;
    const monitor = meta.backgroundJobs?.find((job) => job.id === "monitor-1");
    assert.equal(monitor?.terminalStatus, "killed");
    assert.deepEqual(monitor?.endedBy && { actor: monitor.endedBy.actor, reason: monitor.endedBy.reason },
      { actor: { kind: "user", userId: "usr_owner" }, reason: "stop_request" });
    assert.ok(meta.backgroundJobs?.find((job) => job.id === "agent-1")?.assistantResultPersistedAt);
    assert.equal(meta.backgroundJobs?.find((job) => job.id === "shell-3")?.terminalStatus, undefined,
      "the session's other job keeps running");
    assert.equal(meta.backgroundWorkState, "running");
    assert.deepEqual(meta.pendingBackgroundTaskIds, ["shell-3"]);
    assert.deepEqual(fake.stopCalls, ["monitor-1"]);
    assert.equal(fake.endCalls, 0, "the provider process was not retired");
    assert.equal(fake.providers.length, 1, "the provider conversation keeps running in the same process");

    // The timeline records the stop and who asked, before the continuation it unblocked.
    const notices = stopNotices(store, spec.sessionId);
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /^Wollipog stopped a monitor \(job monitor-1, started \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\) at the request of the session owner\. It is recorded as killed\./);
    assert.match(notices[0]!, /the session's other background jobs keep running\.$/);
    const noticeAt = events.findIndex((event) => event.payload.kind === "stderr" && event.payload.text === notices[0]);
    const continuationAt = events.findIndex((event) => event.payload.kind === "stderr" &&
      event.payload.text === "Runner continued after managed background work completed.");
    assert.ok(noticeAt >= 0 && continuationAt > noticeAt, "the stop is recorded before the continuation");
    assert.equal(notices[0]!.includes("usr_owner"), false, "the transcript names the role, not the account");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stopping the job that holds a worktree rebind clears the queue hold, and the queued prompts run in their original order (#1780)", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-job-stop-rebind-"));
  let manager: SessionManager | undefined;
  try {
    const repo = initRepo(root);
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    const sent: RunnerToControlPlane[] = [];
    let onPrompt: (provider: ProviderProcess, text: string) => void = () => {};
    const fake = fakeProvider({ onPrompt: (provider, text) => onPrompt(provider, text) });
    onPrompt = launches(fake);
    manager = new SessionManager((message) => { sent.push(message); }, () => {}, store, "runner", undefined,
      fake.factory as never, dataDir, 1);
    const spec = claudeSpec("s_job_stop_rebind", repo);
    await manager.start(spec);

    manager.prompt(spec.sessionId, "watch CI and review");
    await waitFor(() => fake.prompts.length === 1 && store.readMeta(spec.sessionId)?.status === "idle",
      "the launching turn did not finish");
    finishSubagent(fake);
    const requested = await manager.requestWorktree(spec.sessionId, { baseRef: "HEAD", branch: "fix/job-stop" });
    const lifecycle: string[] = [];
    manager.prompt(spec.sessionId, "first queued");
    manager.prompt(spec.sessionId, "decision resume", [], undefined, undefined,
      recordingLifecycle("decision-resume", lifecycle), false, undefined, false, undefined, undefined, undefined, true);
    manager.prompt(spec.sessionId, "third queued");
    await waitFor(() => publishedHolds(sent).some((hold) => hold?.queuedPrompts === 3),
      "the queued prompts were not reported as held");
    const hold = publishedHolds(sent).find((candidate) => candidate?.queuedPrompts === 3)!;
    assert.equal(hold.kind, "worktree_rebind");
    assert.equal(hold.canStopJobs, true, "the hold says one job can be stopped");
    assert.equal(hold.endsAt, undefined, "no bound is configured here");
    assert.equal(fake.prompts.length, 1, "nothing runs while the hold lasts");

    const outcome = await manager.stopBackgroundJob(spec.sessionId, "monitor-1",
      { kind: "orchestrator", sessionId: "s_parent_orchestrator" });
    assert.deepEqual(outcome, { outcome: "stopped", terminalStatus: "killed" });
    await waitFor(() => fake.prompts.length === 5, "the handoff and the queued prompts did not proceed");

    const [, continuation, ...queued] = fake.prompts;
    assert.equal(continuation!.cwd, repo, "the sibling's result is delivered before the move");
    assert.ok(continuation!.text.startsWith(CONTINUATION_PREFIX));
    assert.deepEqual(queued, [
      { cwd: requested.worktree.path, text: "first queued" },
      { cwd: requested.worktree.path, text: "decision resume" },
      { cwd: requested.worktree.path, text: "third queued" },
    ]);
    await waitFor(() => lifecycle.includes("decision-resume:completed"), "the decision resume did not complete");
    assert.deepEqual(lifecycle, ["decision-resume:queued", "decision-resume:started", "decision-resume:completed"]);
    assert.equal(publishedHolds(sent).at(-1), null, "the hold is cleared explicitly");
    assert.equal(fake.endCalls, 0);

    const monitor = store.readMeta(spec.sessionId)?.backgroundJobs?.find((job) => job.id === "monitor-1");
    assert.deepEqual(monitor?.endedBy?.actor, { kind: "orchestrator", sessionId: "s_parent_orchestrator" });
    const [notice] = stopNotices(store, spec.sessionId);
    assert.match(notice!, /at the request of its controlling Orchestrator \(session s_parent_orchestrator\)\./);
    assert.ok(store.readMeta(spec.sessionId)?.recoveredBackgroundTaskIds?.includes("monitor-1"),
      "the stopped job is tombstoned so no later receipt read revives it");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown job fails, a finished job is reported without change, and a refusal changes nothing (#1780)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-job-stop-refusals-"));
  let manager: SessionManager | undefined;
  try {
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    let onPrompt: (provider: ProviderProcess, text: string) => void = () => {};
    const fake = fakeProvider({ onPrompt: (provider, text) => onPrompt(provider, text) });
    onPrompt = launches(fake);
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, fake.factory as never, dataDir, 1);
    const spec = claudeSpec("s_job_stop_refusals", root);
    const actor = { kind: "user" as const, userId: "usr_owner" };
    assert.deepEqual(await manager.stopBackgroundJob("s_missing", "monitor-1", actor),
      { outcome: "refused", reason: "session_not_found" });
    await manager.start(spec);
    manager.prompt(spec.sessionId, "watch CI and review");
    await waitFor(() => fake.prompts.length === 1 && store.readMeta(spec.sessionId)?.status === "idle",
      "the launching turn did not finish");
    finishSubagent(fake);

    assert.deepEqual(await manager.stopBackgroundJob(spec.sessionId, "no-such-job", actor), { outcome: "unknown_job" });
    const before = store.readEvents(spec.sessionId).length;
    assert.deepEqual(await manager.stopBackgroundJob(spec.sessionId, "agent-1", actor),
      { outcome: "already_terminal", terminalStatus: "completed" });
    assert.equal(store.readEvents(spec.sessionId).length, before, "a finished job is reported without change");

    // The provider could not confirm the stop: nothing is recorded and the job keeps running.
    fake.stopResult = () => ({ status: "refused", reason: "unconfirmed" });
    assert.deepEqual(await manager.stopBackgroundJob(spec.sessionId, "monitor-1", actor),
      { outcome: "refused", reason: "unconfirmed" });
    assert.equal(store.readMeta(spec.sessionId)?.backgroundJobs?.find((job) => job.id === "monitor-1")?.terminalStatus,
      undefined);
    assert.deepEqual(stopNotices(store, spec.sessionId), []);

    // The job ended on its own while the stop was in flight.
    fake.stopResult = (jobId) => {
      const job = fake.live.get(jobId)!;
      fake.live.delete(jobId);
      const terminal: DriverBackgroundTerminalJob = {
        ...job, status: "completed", terminalAt: Date.now(), continuationRequired: true,
      };
      fake.report(fake.providers.at(-1)!, [terminal]);
      return { status: "finished", job: terminal };
    };
    assert.deepEqual(await manager.stopBackgroundJob(spec.sessionId, "monitor-1", actor),
      { outcome: "already_terminal", terminalStatus: "completed" });
    assert.equal(store.readMeta(spec.sessionId)?.backgroundJobs?.find((job) => job.id === "monitor-1")?.endedBy,
      undefined, "a job that ended on its own records no stop");
    assert.deepEqual(stopNotices(store, spec.sessionId), []);

    // A stopped session has no live provider process to stop the job in.
    manager.prompt(spec.sessionId, "run the suite");
    await waitFor(() => store.readMeta(spec.sessionId)?.backgroundJobs?.some((job) => job.id === "shell-3") === true,
      "the shell job was not registered");
    await waitFor(() => store.readMeta(spec.sessionId)?.status === "idle", "the turn did not finish");
    const shell = store.readMeta(spec.sessionId)!.backgroundJobs!.find((job) => job.id === "shell-3")!;
    // An unconfirmed stop's requester is kept only while the process that could carry it out lives.
    fake.stopResult = () => ({ status: "refused", reason: "unconfirmed" });
    await manager.stopBackgroundJob(spec.sessionId, "shell-3", actor);
    const unconfirmed = (manager as unknown as { unconfirmedJobStops: Map<string, unknown> }).unconfirmedJobStops;
    assert.equal(unconfirmed.has(spec.sessionId), true);
    fake.stopResult = undefined;
    manager.stop(spec.sessionId);
    await waitFor(() => store.readMeta(spec.sessionId)?.status === "stopped", "the session did not stop");
    assert.equal(unconfirmed.has(spec.sessionId), false, "a stopped session keeps no requester");
    assert.deepEqual(await manager.stopBackgroundJob(spec.sessionId, "shell-3", actor), { outcome: "unknown_job" },
      "stopping the session already ended its jobs");
    // As after a runner restart: the job is on record, but no live process owns it.
    store.patchMeta(spec.sessionId, { backgroundJobs: [shell] });
    assert.deepEqual(await manager.stopBackgroundJob(spec.sessionId, "shell-3", actor),
      { outcome: "refused", reason: "no_live_process" });
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a harness that cannot stop a single job refuses instead of ending all of them (#1780)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-job-stop-unsupported-"));
  let manager: SessionManager | undefined;
  try {
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    let onPrompt: (provider: ProviderProcess, text: string) => void = () => {};
    const fake = fakeProvider({ canStop: false, onPrompt: (provider, text) => onPrompt(provider, text) });
    onPrompt = launches(fake);
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, fake.factory as never, dataDir, 1);
    const spec = claudeSpec("s_job_stop_unsupported", root);
    await manager.start(spec);
    manager.prompt(spec.sessionId, "watch CI and review");
    await waitFor(() => fake.prompts.length === 1 && store.readMeta(spec.sessionId)?.status === "idle",
      "the launching turn did not finish");
    assert.deepEqual(await manager.stopBackgroundJob(spec.sessionId, "monitor-1", { kind: "user", userId: "usr_owner" }),
      { outcome: "refused", reason: "unsupported" });
    assert.equal(fake.endCalls, 0);
    assert.equal(store.readMeta(spec.sessionId)?.backgroundJobs?.find((job) => job.id === "monitor-1")?.terminalStatus,
      undefined);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a job the model stops with its own tool frees its sibling's result and is not recovered after a restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-job-provider-stop-"));
  let manager: SessionManager | undefined;
  let restarted: SessionManager | undefined;
  try {
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    let onPrompt: (provider: ProviderProcess, text: string) => void = () => {};
    const fake = fakeProvider({ onPrompt: (provider, text) => onPrompt(provider, text) });
    const launch = launches(fake);
    onPrompt = (provider, text) => {
      launch(provider, text);
      if (text !== "stop the monitor") return;
      // What the Claude driver reports for the model's own stop inside its turn: a killed job the
      // runner did not end, which needs no continuation (#1855).
      const monitor = fake.live.get("monitor-1")!;
      fake.live.delete("monitor-1");
      fake.report(provider, [{
        ...monitor, status: "killed", terminalAt: Date.now(), continuationRequired: false, stoppedByModel: true,
      }]);
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, fake.factory as never, dataDir, 1);
    const spec = claudeSpec("s_job_provider_stop", root);
    await manager.start(spec);

    manager.prompt(spec.sessionId, "watch CI and review");
    await waitFor(() => fake.prompts.length === 1 && store.readMeta(spec.sessionId)?.status === "idle",
      "the launching turn did not finish");
    manager.prompt(spec.sessionId, "stop the monitor");
    await waitFor(() => fake.prompts.length === 2 && store.readMeta(spec.sessionId)?.status === "idle",
      "the stopping turn did not finish");
    finishSubagent(fake);
    await waitFor(() => store.readEvents(spec.sessionId)
      .some((event) => event.payload.kind === "background_continuation_delivered"), "the sibling's result was not delivered");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const continuations = fake.prompts.filter((prompt) => prompt.text.startsWith(CONTINUATION_PREFIX));
    assert.equal(continuations.length, 1);
    assert.match(continuations[0]!.text, /"agent-1"/);
    assert.doesNotMatch(continuations[0]!.text, /monitor-1/, "the model already knows it stopped the monitor");

    const meta = store.readMeta(spec.sessionId)!;
    const monitor = meta.backgroundJobs?.find((job) => job.id === "monitor-1");
    assert.equal(monitor?.terminalStatus, "killed");
    assert.equal(monitor?.continuationId, undefined);
    assert.equal(monitor?.endedBy, undefined, "Wollipog did not end it");
    assert.deepEqual(stopNotices(store, spec.sessionId), []);
    assert.deepEqual(fake.stopCalls, []);
    assert.equal(meta.backgroundWorkState, undefined);
    assert.ok(meta.recoveredBackgroundTaskIds?.includes("monitor-1"),
      "the stopped job is tombstoned so no later receipt read revives it");
    manager.shutdownAll();
    manager = undefined;

    // Claude left the stopped task's output file without a completion record, so a restart's
    // discovery still finds it. The tombstone keeps it from becoming orphaned work to recover.
    restarted = new SessionManager(() => {}, () => {}, store, "runner", undefined, fake.factory as never, dataDir, 1);
    Object.assign(restarted as object, {
      discoverClaudeTasks: () => [{ id: "monitor-1", outputFile: "monitor-1.output" }],
    });
    restarted.reconcileStore();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(store.readMeta(spec.sessionId)?.orphanedWork, undefined);
    assert.equal(fake.prompts.length, 3, "no recovery turn relaunches the stopped job");
  } finally {
    manager?.shutdownAll();
    restarted?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lone job the model stops in a later turn starts no continuation turn and is settled (#1855)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-job-model-stop-lone-"));
  let manager: SessionManager | undefined;
  try {
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    let onPrompt: (provider: ProviderProcess, text: string) => void = () => {};
    const fake = fakeProvider({ onPrompt: (provider, text) => onPrompt(provider, text) });
    onPrompt = (provider, text) => {
      if (text === "watch CI") {
        fake.live.set("monitor-1", { id: "monitor-1", launchType: "monitor", startedAt: Date.now() });
        fake.report(provider);
      } else if (text === "stop the monitor") {
        const monitor = fake.live.get("monitor-1")!;
        fake.live.delete("monitor-1");
        fake.report(provider, [{
          ...monitor, status: "killed", terminalAt: Date.now(), continuationRequired: false, stoppedByModel: true,
        }]);
      }
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, fake.factory as never, dataDir, 1);
    const spec = claudeSpec("s_job_model_stop_lone", root);
    await manager.start(spec);

    manager.prompt(spec.sessionId, "watch CI");
    await waitFor(() => fake.prompts.length === 1 && store.readMeta(spec.sessionId)?.status === "idle",
      "the launching turn did not finish");
    assert.equal(store.readMeta(spec.sessionId)?.backgroundWorkState, "running");
    manager.prompt(spec.sessionId, "stop the monitor");
    await waitFor(() => fake.prompts.length === 2 && store.readMeta(spec.sessionId)?.status === "idle",
      "the stopping turn did not finish");
    await new Promise<void>((resolve) => setTimeout(resolve, 150));

    assert.deepEqual(fake.prompts.map((prompt) => prompt.text), ["watch CI", "stop the monitor"],
      "no automatic turn tells the model what it already did");
    const meta = store.readMeta(spec.sessionId)!;
    assert.equal(meta.backgroundWorkState, undefined);
    assert.deepEqual(meta.pendingBackgroundTaskIds ?? [], []);
    const monitor = meta.backgroundJobs?.find((job) => job.id === "monitor-1");
    assert.equal(monitor?.terminalStatus, "killed");
    assert.equal(monitor?.continuationRequired, false);
    assert.equal(monitor?.continuationId, undefined);
    assert.equal(monitor?.endedBy, undefined, "Wollipog did not end it");
    assert.equal(typeof monitor?.assistantResultPersistedAt, "number",
      "the job is settled rather than left among unresolved jobs");
    assert.equal(store.readEvents(spec.sessionId)
      .some((event) => event.payload.kind === "background_continuation_delivered"), false);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a model stop whose turn is cancelled keeps the job's continuation (#1855)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-job-model-stop-cancelled-"));
  let manager: SessionManager | undefined;
  try {
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    let onPrompt: (provider: ProviderProcess, text: string) => void = () => {};
    const fake = fakeProvider({
      onPrompt: (provider, text) => onPrompt(provider, text),
      stopReason: (text) => text === "stop the monitor" ? "cancelled" : "end_turn",
    });
    onPrompt = (provider, text) => {
      if (text === "watch CI") {
        fake.live.set("monitor-1", { id: "monitor-1", launchType: "monitor", startedAt: Date.now() });
        fake.report(provider);
      } else if (text === "stop the monitor") {
        const monitor = fake.live.get("monitor-1")!;
        fake.live.delete("monitor-1");
        fake.report(provider, [{
          ...monitor, status: "killed", terminalAt: Date.now(), continuationRequired: false, stoppedByModel: true,
        }]);
      }
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, fake.factory as never, dataDir, 1);
    const spec = claudeSpec("s_job_model_stop_cancelled", root);
    await manager.start(spec);

    manager.prompt(spec.sessionId, "watch CI");
    await waitFor(() => fake.prompts.length === 1 && store.readMeta(spec.sessionId)?.status === "idle",
      "the launching turn did not finish");
    // The stopping turn ends without completing, so the model may never have seen its stop succeed.
    manager.prompt(spec.sessionId, "stop the monitor");
    const monitor = () => store.readMeta(spec.sessionId)?.backgroundJobs?.find((job) => job.id === "monitor-1");
    await waitFor(() => monitor()?.continuationQueuedAt !== undefined,
      "the stopped job's continuation was not restored");
    // It is queued with its launching turn's barrier, exactly as before #1855, and is not settled.
    assert.equal(monitor()?.terminalStatus, "killed");
    assert.equal(monitor()?.continuationRequired, true);
    assert.ok(monitor()?.continuationId);
    assert.equal(monitor()?.assistantResultPersistedAt, undefined);
    assert.equal(store.readMeta(spec.sessionId)?.backgroundWorkState, "continuation_pending");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a model stop whose turn fails outright keeps the job's continuation (#1855)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-job-model-stop-thrown-"));
  let manager: SessionManager | undefined;
  try {
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    let onPrompt: (provider: ProviderProcess, text: string) => void = () => {};
    const fake = fakeProvider({
      onPrompt: (provider, text) => onPrompt(provider, text),
      stopReason: (text) => text === "stop the monitor" ? "throw" : "end_turn",
    });
    onPrompt = (provider, text) => {
      if (text === "watch CI") {
        fake.live.set("monitor-1", { id: "monitor-1", launchType: "monitor", startedAt: Date.now() });
        fake.report(provider);
      } else if (text === "stop the monitor") {
        const monitor = fake.live.get("monitor-1")!;
        fake.live.delete("monitor-1");
        fake.report(provider, [{
          ...monitor, status: "killed", terminalAt: Date.now(), continuationRequired: false, stoppedByModel: true,
        }]);
      }
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, fake.factory as never, dataDir, 1);
    const spec = claudeSpec("s_job_model_stop_thrown", root);
    await manager.start(spec);

    manager.prompt(spec.sessionId, "watch CI");
    await waitFor(() => fake.prompts.length === 1 && store.readMeta(spec.sessionId)?.status === "idle",
      "the launching turn did not finish");
    manager.prompt(spec.sessionId, "stop the monitor");
    const monitor = () => store.readMeta(spec.sessionId)?.backgroundJobs?.find((job) => job.id === "monitor-1");
    // The restored continuation runs at once, so wait for its delivery rather than catching the job
    // between restore and delivery.
    await waitFor(() => monitor()?.assistantResultPersistedAt !== undefined,
      "the stopped job's continuation was not delivered after the prompt failed");
    assert.equal(monitor()?.continuationRequired, true);
    assert.ok(monitor()?.continuationId);
    const continuations = fake.prompts.filter((prompt) => prompt.text.startsWith(CONTINUATION_PREFIX));
    assert.equal(continuations.length, 1, "exactly one continuation turn reports the stop");
    assert.match(continuations[0]!.text, /monitor-1/);
    const delivered = store.readEvents(spec.sessionId).filter((event) =>
      event.payload.kind === "background_continuation_delivered");
    assert.deepEqual(delivered.map((event) => event.payload.kind === "background_continuation_delivered" &&
      event.payload.continuationId), [monitor()?.continuationId]);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a model stop in a provider-initiated turn is settled by that turn, not by a runner prompt waiting behind it (#1855)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-job-model-stop-provider-turn-"));
  let manager: SessionManager | undefined;
  try {
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    let onPrompt: (provider: ProviderProcess, text: string) => void = () => {};
    const fake = fakeProvider({
      onPrompt: (provider, text) => onPrompt(provider, text),
      stopReason: (text) => text === "carry on" ? "cancelled" : "end_turn",
    });
    onPrompt = (provider, text) => {
      if (text === "watch CI") {
        fake.live.set("monitor-1", { id: "monitor-1", launchType: "monitor", startedAt: Date.now() });
        fake.report(provider);
      } else if (text === "carry on") {
        // The runner prompt already holds the active turn id while Claude runs a turn of its own, in
        // which the model stops the monitor. The runner prompt is then cancelled.
        provider.cb.onProviderInitiatedTurn?.("started", "provider:1");
        const monitor = fake.live.get("monitor-1")!;
        fake.live.delete("monitor-1");
        fake.report(provider, [{
          ...monitor, status: "killed", terminalAt: Date.now(), continuationRequired: false, stoppedByModel: true,
        }]);
        provider.cb.onProviderInitiatedTurn?.("settled", "provider:1");
      }
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, fake.factory as never, dataDir, 1);
    const spec = claudeSpec("s_job_model_stop_provider_turn", root);
    await manager.start(spec);

    manager.prompt(spec.sessionId, "watch CI");
    await waitFor(() => fake.prompts.length === 1 && store.readMeta(spec.sessionId)?.status === "idle",
      "the launching turn did not finish");
    manager.prompt(spec.sessionId, "carry on");
    await waitFor(() => fake.prompts.length === 2 && store.readMeta(spec.sessionId)?.status !== "running",
      "the runner prompt did not end");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const monitor = store.readMeta(spec.sessionId)?.backgroundJobs?.find((job) => job.id === "monitor-1");
    assert.equal(monitor?.terminalStatus, "killed");
    assert.equal(monitor?.continuationRequired, false, "the cancelled runner prompt did not make the stop");
    assert.equal(monitor?.continuationQueuedAt, undefined);
    assert.equal(typeof monitor?.assistantResultPersistedAt, "number");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a restored model stop gets its own continuation, not one already queued for a sibling (#1855)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-job-model-stop-own-continuation-"));
  let manager: SessionManager | undefined;
  try {
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    let onPrompt: (provider: ProviderProcess, text: string) => void = () => {};
    const fake = fakeProvider({
      onPrompt: (provider, text) => onPrompt(provider, text),
      stopReason: (text) => text === "stop the monitor" ? "throw" : "end_turn",
    });
    onPrompt = (provider, text) => {
      if (text === "watch CI and run the suite") {
        fake.live.set("monitor-1", { id: "monitor-1", launchType: "monitor", startedAt: Date.now() });
        fake.live.set("shell-2", { id: "shell-2", launchType: "shell", startedAt: Date.now() });
        fake.report(provider);
      } else if (text === "stop the monitor") {
        // The suite finishes during the stopping turn, and the model's stop then completes the
        // barrier, so the suite's continuation is queued before the turn fails.
        const shell = fake.live.get("shell-2")!;
        fake.live.delete("shell-2");
        fake.report(provider, [{ ...shell, status: "completed", terminalAt: Date.now(), continuationRequired: true }]);
        const monitor = fake.live.get("monitor-1")!;
        fake.live.delete("monitor-1");
        fake.report(provider, [{
          ...monitor, status: "killed", terminalAt: Date.now(), continuationRequired: false, stoppedByModel: true,
        }]);
      }
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, fake.factory as never, dataDir, 1);
    const spec = claudeSpec("s_job_model_stop_own_continuation", root);
    await manager.start(spec);

    manager.prompt(spec.sessionId, "watch CI and run the suite");
    await waitFor(() => fake.prompts.length === 1 && store.readMeta(spec.sessionId)?.status === "idle",
      "the launching turn did not finish");
    manager.prompt(spec.sessionId, "stop the monitor");
    const job = (id: string) => store.readMeta(spec.sessionId)?.backgroundJobs?.find((each) => each.id === id);
    await waitFor(() => job("monitor-1")?.continuationQueuedAt !== undefined,
      "the stopped job's continuation was not restored");
    assert.ok(job("shell-2")?.continuationId);
    assert.ok(job("monitor-1")?.continuationId);
    assert.notEqual(job("monitor-1")?.continuationId, job("shell-2")?.continuationId,
      "delivery of the suite's continuation cannot count as delivery of the stop");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a restored model stop keeps its own continuation through a later background update (#1855)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-job-model-stop-own-continuation-kept-"));
  let manager: SessionManager | undefined;
  try {
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    let onPrompt: (provider: ProviderProcess, text: string) => void = () => {};
    const fake = fakeProvider({
      onPrompt: (provider, text) => onPrompt(provider, text),
      stopReason: (text) => text === "stop the monitor" ? "throw" : "end_turn",
    });
    const job = (id: string) => store.readMeta(spec.sessionId)?.backgroundJobs?.find((each) => each.id === id);
    let idsAfterUpdate: [string | undefined, string | undefined] | undefined;
    onPrompt = (provider, text) => {
      if (text === "watch CI and run the suite") {
        fake.live.set("monitor-1", { id: "monitor-1", launchType: "monitor", startedAt: Date.now() });
        fake.live.set("shell-2", { id: "shell-2", launchType: "shell", startedAt: Date.now() });
        fake.report(provider);
      } else if (text === "stop the monitor") {
        const shell = fake.live.get("shell-2")!;
        fake.live.delete("shell-2");
        fake.report(provider, [{ ...shell, status: "completed", terminalAt: Date.now(), continuationRequired: true }]);
        const monitor = fake.live.get("monitor-1")!;
        fake.live.delete("monitor-1");
        fake.report(provider, [{
          ...monitor, status: "killed", terminalAt: Date.now(), continuationRequired: false, stoppedByModel: true,
        }]);
      } else if (text === "look around") {
        // The next turn runs before either continuation and reports background work of its own, so
        // the session manager merges both queued jobs again.
        fake.report(provider);
        idsAfterUpdate = [job("monitor-1")?.continuationId, job("shell-2")?.continuationId];
      }
    };
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, fake.factory as never, dataDir, 1);
    const spec = claudeSpec("s_job_model_stop_own_continuation_kept", root);
    await manager.start(spec);

    manager.prompt(spec.sessionId, "watch CI and run the suite");
    await waitFor(() => fake.prompts.length === 1 && store.readMeta(spec.sessionId)?.status === "idle",
      "the launching turn did not finish");
    manager.prompt(spec.sessionId, "stop the monitor");
    manager.prompt(spec.sessionId, "look around");
    await waitFor(() => idsAfterUpdate !== undefined, "the next turn did not run");
    const [monitorId, shellId] = idsAfterUpdate!;
    assert.ok(monitorId);
    assert.ok(shellId);
    assert.notEqual(monitorId, shellId, "delivery of the suite's continuation cannot count as delivery of the stop");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("with the real Claude driver, a model stop in a later turn starts no continuation turn (#1855)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-job-model-stop-driver-"));
  let manager: SessionManager | undefined;
  try {
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    const child = new EventEmitter() as any;
    child.pid = 123;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    // Every turn Wollipog hands the provider arrives on its stdin as one `user` frame.
    const submitted: string[] = [];
    let buffered = "";
    child.stdin.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let index: number;
      while ((index = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        const value = line.trim() ? JSON.parse(line) : undefined;
        if (value?.type === "user") submitted.push(JSON.stringify(value.message?.content ?? ""));
      }
    });
    const frame = (value: unknown) => child.stdout.write(JSON.stringify(value) + "\n");
    const factory = (_kind: unknown, options: DriverOptions, callbacks: DriverCallbacks) =>
      new ClaudeCodeDriver(options, callbacks, { spawn: () => child, kill: () => {} } as any);
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, dataDir, 1);
    const spec = claudeSpec("s_job_model_stop_driver", root);
    await manager.start(spec);
    const idle = () => store.readMeta(spec.sessionId)?.status === "idle";

    manager.prompt(spec.sessionId, "watch CI");
    await waitFor(() => submitted.length === 1, "the launching turn was not submitted");
    frame({ type: "system", subtype: "task_started", task_id: "monitor-1", tool_use_id: "toolu_monitor" });
    frame({ type: "result", subtype: "success" });
    await waitFor(() => idle() && store.readMeta(spec.sessionId)?.backgroundWorkState === "running",
      "the launching turn did not leave its job running");

    // Claude Code 2.1.283's frames for the model's own TaskStop (#1847), in a later turn.
    manager.prompt(spec.sessionId, "stop the monitor");
    await waitFor(() => submitted.length === 2, "the stopping turn was not submitted");
    frame({ type: "assistant", message: { content: [
      { type: "tool_use", id: "toolu_stop", name: "TaskStop", input: { task_id: "monitor-1" } },
    ] } });
    frame({ type: "system", subtype: "task_updated", task_id: "monitor-1", patch: { status: "killed", end_time: 1 } });
    frame({ type: "system", subtype: "task_notification", task_id: "monitor-1", tool_use_id: "toolu_monitor", status: "stopped" });
    frame({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_stop", content: "ok" }] } });
    frame({ type: "result", subtype: "success" });
    await waitFor(() => store.readMeta(spec.sessionId)?.backgroundJobs
      ?.some((job) => job.id === "monitor-1" && job.terminalStatus === "killed") === true,
    "the stopping turn did not end the job");
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    assert.equal(submitted.some((text) => text.includes(CONTINUATION_PREFIX)), false,
      "no automatic turn tells the model what it already did");
    assert.equal(submitted.length, 2);
    assert.ok(idle());
    const meta = store.readMeta(spec.sessionId)!;
    assert.equal(meta.backgroundWorkState, undefined);
    const monitor = meta.backgroundJobs?.find((job) => job.id === "monitor-1");
    assert.equal(monitor?.terminalStatus, "killed");
    assert.equal(monitor?.continuationRequired, false);
    assert.equal(typeof monitor?.assistantResultPersistedAt, "number");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stop the provider confirms late keeps the actor who asked, and no other stop takes it over (#1849)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-job-stop-late-"));
  let manager: SessionManager | undefined;
  try {
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    let onPrompt: (provider: ProviderProcess, text: string) => void = () => {};
    const fake = fakeProvider({ onPrompt: (provider, text) => onPrompt(provider, text) });
    onPrompt = launches(fake);
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, fake.factory as never, dataDir, 1);
    const spec = claudeSpec("s_job_stop_late", root);
    await manager.start(spec);
    manager.prompt(spec.sessionId, "watch CI and review");
    await waitFor(() => fake.prompts.length === 1 && store.readMeta(spec.sessionId)?.status === "idle",
      "the launching turn did not finish");
    manager.prompt(spec.sessionId, "run the suite");
    await waitFor(() => fake.prompts.length === 2 && store.readMeta(spec.sessionId)?.status === "idle",
      "the second turn did not finish");
    const owner = { kind: "user" as const, userId: "usr_owner" };
    const orchestrator = { kind: "orchestrator" as const, sessionId: "s_parent_orchestrator" };
    const job = (id: string) => store.readMeta(spec.sessionId)?.backgroundJobs?.find((candidate) => candidate.id === id);

    // The owner's stops of the monitor and the shell are answered without proof.
    fake.stopResult = () => ({ status: "refused", reason: "unconfirmed" });
    for (const id of ["monitor-1", "shell-3"]) {
      assert.deepEqual(await manager.stopBackgroundJob(spec.sessionId, id, owner), { outcome: "refused", reason: "unconfirmed" });
    }
    assert.deepEqual(stopNotices(store, spec.sessionId), []);

    // The Orchestrator stops the subagent. While that stop is in flight, the provider carries out
    // the owner's earlier stop of the monitor, and the driver reports it as a late confirmation.
    let lateAt = 0;
    fake.stopResult = (jobId) => {
      if (jobId !== "agent-1") return undefined;
      const monitor = fake.live.get("monitor-1")!;
      fake.live.delete("monitor-1");
      lateAt = Date.now();
      fake.report(fake.providers.at(-1)!, [{
        ...monitor, status: "killed", terminalAt: lateAt, continuationRequired: true, stopConfirmedLate: true,
      }]);
      return undefined;
    };
    assert.deepEqual(await manager.stopBackgroundJob(spec.sessionId, "agent-1", orchestrator),
      { outcome: "stopped", terminalStatus: "killed" });
    assert.deepEqual(job("monitor-1")?.endedBy, { actor: owner, reason: "stop_request", endedAt: lateAt },
      "the late stop is the owner's, not the Orchestrator's in-flight one");
    const agentEnd = job("agent-1")?.endedBy;
    assert.deepEqual(agentEnd && { actor: agentEnd.actor, reason: agentEnd.reason }, { actor: orchestrator, reason: "stop_request" });
    const [late, direct, ...rest] = stopNotices(store, spec.sessionId);
    assert.match(late ?? "", /^Wollipog stopped a monitor \(job monitor-1, started [^)]+\) at the request of the session owner\. The provider confirmed the stop only after the request had been reported as unconfirmed\. It is recorded as killed\./);
    assert.match(direct ?? "", /^Wollipog stopped a subagent \(job agent-1, [^)]+\) at the request of its controlling Orchestrator \(session s_parent_orchestrator\)\. It is recorded as killed\./);
    assert.deepEqual(rest, []);

    // The shell then ends without the driver tying it to that stop, as when Claude stops it on its
    // own: an earlier unconfirmed request does not make it the owner's stop.
    const shell = fake.live.get("shell-3")!;
    fake.live.delete("shell-3");
    fake.report(fake.providers.at(-1)!, [{ ...shell, status: "killed", terminalAt: Date.now(), continuationRequired: true }]);
    assert.equal(job("shell-3")?.terminalStatus, "killed");
    assert.equal(job("shell-3")?.endedBy, undefined);
    assert.equal(stopNotices(store, spec.sessionId).length, 2);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});
