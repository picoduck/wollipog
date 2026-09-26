import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import type { RunnerToControlPlane, SessionLaunchSpec, SessionQueueHoldView } from "@wollipog/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  DriverBackgroundJob,
  DriverBackgroundJobStopResult,
  DriverBackgroundTerminalJob,
  DriverCallbacks,
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
function fakeProvider(options: { canStop?: boolean; onPrompt?: (provider: ProviderProcess, text: string) => void } = {}) {
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
    manager.stop(spec.sessionId);
    await waitFor(() => store.readMeta(spec.sessionId)?.status === "stopped", "the session did not stop");
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
