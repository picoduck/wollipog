import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import type { RunnerToControlPlane, SessionLaunchSpec, SessionQueueMessage } from "@wollipog/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DriverBackgroundJob, DriverCallbacks } from "./drivers/driver.js";
import { SessionManager, type DurableCommandLifecycle } from "./session-manager.js";
import { SessionStore, type DurableBackgroundJob, type SessionMeta } from "./session-store.js";

// #1779: an explicit Restart keeps the work queued for the session, and accounts for the replaced
// Claude conversation's background work instead of dropping its records.

const RESTART_CONTINUATION_PREFIX = "This session was restarted.";
const HELD_TURN = "long running turn";

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

interface ProviderProcess {
  index: number;
  cb: DriverCallbacks;
  /** Task ids the runner seeded into this provider as still pending. */
  seeded: string[];
}

/**
 * A Claude-shaped provider. The first process's `HELD_TURN` stays in flight until the process is
 * disposed, as a real turn does until Restart ends its process, so later prompts queue behind it.
 * A provider initialization can be gated to keep a restart's carried prompts before admission.
 */
function fakeProvider(options: {
  onPrompt?: (provider: ProviderProcess, text: string) => void;
  initializeGate?: (index: number) => Promise<void> | undefined;
} = {}) {
  const providers: ProviderProcess[] = [];
  const prompts: Array<{ provider: number; cwd: string; text: string }> = [];
  const factory = (
    _driver: unknown,
    launch: { cwd: string; initialBackgroundTaskIds?: string[] },
    cb: DriverCallbacks,
  ) => {
    const provider: ProviderProcess = {
      index: providers.length, cb, seeded: [...(launch.initialBackgroundTaskIds ?? [])],
    };
    providers.push(provider);
    let endHeldTurn: (() => void) | undefined;
    return {
      pid: provider.index + 1,
      initialize: async () => { await options.initializeGate?.(provider.index); },
      newSession: async () => {},
      close: async () => {},
      prompt: async (text: string) => {
        prompts.push({ provider: provider.index, cwd: launch.cwd, text });
        cb.onPromptAccepted?.();
        options.onPrompt?.(provider, text);
        if (provider.index === 0 && text === HELD_TURN) {
          await new Promise<void>((resolve) => { endHeldTurn = resolve; });
          return "cancelled" as const;
        }
        cb.onEvent({ kind: "agent_message", text: `answer to: ${text.slice(0, 40)}`, final: true });
        return "end_turn" as const;
      },
      cancel: () => {},
      dispose: () => { endHeldTurn?.(); },
      setConfig: () => {},
      resolvePermission: () => false,
      agentSessionId: () => `provider-session-${provider.index}`,
    };
  };
  return { factory, providers, prompts };
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

function claudeSpec(sessionId: string, repo: string): SessionLaunchSpec {
  return {
    sessionId, workspaceId: "repo", workspacePath: repo, agentId: "claude",
    command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code",
    context: { kind: "native" },
  };
}

function fixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), `wollipog-restart-${name}-`));
  const repo = join(root, "repo");
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
  const dataDir = join(root, "data");
  const store = new SessionStore(join(dataDir, "sessions"));
  const sent: RunnerToControlPlane[] = [];
  return { root, repo, dataDir, store, sent };
}

function timelineText(store: SessionStore, sessionId: string): string[] {
  return store.readEvents(sessionId).flatMap((event) => {
    const payload = event.payload;
    if (payload.kind === "stderr") return [payload.text];
    if (payload.kind === "error") return [payload.message];
    return [];
  });
}

function latestQueue(sent: RunnerToControlPlane[], sessionId: string): SessionQueueMessage["queue"] {
  return sent.filter((message): message is SessionQueueMessage =>
    message.type === "session_queue" && message.sessionId === sessionId).at(-1)?.queue ?? [];
}

test("a restart runs the prompts queued before it afterwards, in their original order, and none is discarded (#1779)", { skip: !haveGit() }, async () => {
  const f = fixture("queue");
  let manager: SessionManager | undefined;
  try {
    let releaseInitialize = () => {};
    const initializeGate = new Promise<void>((resolve) => { releaseInitialize = resolve; });
    const fake = fakeProvider({ initializeGate: (index) => index === 1 ? initializeGate : undefined });
    manager = new SessionManager((message) => { f.sent.push(message); }, () => {}, f.store, "runner", undefined,
      fake.factory as never, f.dataDir, 1);
    const spec = claudeSpec("s_restart_queue", f.repo);
    await manager.start(spec);
    manager.prompt(spec.sessionId, HELD_TURN);
    await waitFor(() => fake.prompts.length === 1, "the first turn did not start");

    // Four prompts queue behind the turn in flight; the second is a durable workflow-decision resume.
    const lifecycle: string[] = [];
    manager.prompt(spec.sessionId, "first queued");
    assert.equal(manager.prompt(spec.sessionId, "decision resume", [], undefined, undefined,
      recordingLifecycle("decision-resume", lifecycle)), true);
    manager.prompt(spec.sessionId, "removed while restarting");
    manager.prompt(spec.sessionId, "fourth queued");
    assert.deepEqual(latestQueue(f.sent, spec.sessionId).map((item) => item.text),
      ["first queued", "decision resume", "removed while restarting", "fourth queued"]);

    const restarted = manager.start(spec);
    // Before the replacement provider is admitted, the queue is still reported and still editable
    // by removal, as any queued prompt is.
    await waitFor(() => fake.providers.length === 2, "the replacement provider was not constructed");
    const carried = latestQueue(f.sent, spec.sessionId);
    assert.deepEqual(carried.map((item) => item.text),
      ["first queued", "decision resume", "removed while restarting", "fourth queued"],
      "the restart keeps the queue, in order");
    manager.removeQueuedPrompt(spec.sessionId, carried[2]!.id);
    assert.deepEqual(latestQueue(f.sent, spec.sessionId).map((item) => item.text),
      ["first queued", "decision resume", "fourth queued"]);
    // A prompt sent during the restart queues after the carried ones.
    manager.prompt(spec.sessionId, "sent during restart");
    releaseInitialize();
    assert.equal(await restarted, true);
    await waitFor(() => fake.prompts.filter((prompt) => prompt.provider === 1).length === 4,
      "the carried prompts did not run after the restart");
    manager.prompt(spec.sessionId, "sent after restart");
    await waitFor(() => fake.prompts.filter((prompt) => prompt.provider === 1).length === 5,
      "a prompt sent after the restart did not run");

    assert.deepEqual(fake.prompts.map((prompt) => `${prompt.provider}:${prompt.text}`), [
      `0:${HELD_TURN}`,
      "1:first queued",
      "1:decision resume",
      "1:fourth queued",
      "1:sent during restart",
      "1:sent after restart",
    ]);
    await waitFor(() => lifecycle.includes("decision-resume:completed"), "the decision resume did not complete");
    assert.deepEqual(lifecycle, ["decision-resume:queued", "decision-resume:started", "decision-resume:completed"],
      "the durable resume is carried under its own receipt and never rejected");
    const timeline = timelineText(f.store, spec.sessionId);
    assert.equal(timeline.some((text) => /discard/iu.test(text)), false, timeline.join("\n"));
  } finally {
    manager?.shutdownAll();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a restart reports a finished background job's result to the new conversation once and records the job it ended as killed (#1779)", { skip: !haveGit() }, async () => {
  const f = fixture("background");
  let manager: SessionManager | undefined;
  try {
    const live = new Map<string, DriverBackgroundJob>();
    const report = (provider: ProviderProcess, terminalJobs: Array<DriverBackgroundJob & {
      status: "completed" | "failed" | "killed"; terminalAt: number; continuationRequired: boolean;
    }> = []) => {
      const jobs = [...live.values()];
      provider.cb.onBackgroundWork?.({
        state: jobs.length ? "running" : null,
        pendingTaskIds: jobs.map((job) => job.id).sort(),
        ...(jobs.length ? { jobs, observedTaskIds: jobs.map((job) => job.id).sort() } : {}),
        ...(terminalJobs.length ? { terminalJobs } : {}),
      });
    };
    const fake = fakeProvider({
      onPrompt: (provider, text) => {
        if (text !== "watch CI and review") return;
        const startedAt = Date.now();
        live.set("monitor-1", { id: "monitor-1", launchType: "monitor", startedAt });
        live.set("agent-1", { id: "agent-1", launchType: "agent", startedAt, outputFile: "/tmp/claude/tasks/agent-1.output" });
        report(provider);
      },
    });
    manager = new SessionManager((message) => { f.sent.push(message); }, () => {}, f.store, "runner", undefined,
      fake.factory as never, f.dataDir, 1);
    const spec = claudeSpec("s_restart_background", f.repo);
    await manager.start(spec);
    manager.prompt(spec.sessionId, "watch CI and review");
    await waitFor(() => f.store.readMeta(spec.sessionId)?.status === "idle" && fake.prompts.length === 1,
      "the launching turn did not finish");
    // The subagent finishes after its turn; the monitor never does, so the subagent's result waits.
    const agent = live.get("agent-1")!;
    live.delete("agent-1");
    report(fake.providers[0]!, [{ ...agent, status: "completed", terminalAt: Date.now(), continuationRequired: true }]);
    assert.equal(f.store.readMeta(spec.sessionId)?.backgroundJobs?.find((job) => job.id === "agent-1")
      ?.continuationQueuedAt, undefined, "the finished result is blocked behind the monitor");

    assert.equal(await manager.start(spec), true);
    await waitFor(() => fake.prompts.some((prompt) => prompt.text.startsWith(RESTART_CONTINUATION_PREFIX)),
      "the finished result was not reported to the restarted conversation");
    await waitFor(() => f.store.readMeta(spec.sessionId)?.backgroundJobs?.find((job) => job.id === "agent-1")
      ?.assistantResultPersistedAt !== undefined, "the report was not recorded as delivered");

    assert.deepEqual(fake.providers[1]!.seeded, [], "no task of the replaced conversation is seeded as pending");
    const continuation = fake.prompts.find((prompt) => prompt.text.startsWith(RESTART_CONTINUATION_PREFIX))!;
    assert.equal(continuation.provider, 1);
    const listed = JSON.parse(continuation.text.slice(continuation.text.lastIndexOf("\n") + 1)) as Array<Record<string, unknown>>;
    assert.deepEqual(listed.map((job) => ({ id: job.id, status: job.status, outputFile: job.outputFile, recoverable: job.recoverable })), [
      { id: "agent-1", status: "completed", outputFile: "/tmp/claude/tasks/agent-1.output", recoverable: undefined },
      { id: "monitor-1", status: "killed", outputFile: undefined, recoverable: false },
    ]);

    const meta = f.store.readMeta(spec.sessionId)!;
    const monitor = meta.backgroundJobs?.find((job) => job.id === "monitor-1");
    assert.equal(monitor?.terminalStatus, "killed");
    assert.equal(monitor?.endedBy?.reason, "session_restart");
    assert.equal(meta.backgroundWorkState, undefined, "nothing is left pending once the report is delivered");
    assert.deepEqual(meta.pendingBackgroundTaskIds ?? [], []);
    assert.equal(meta.orphanedWork, undefined);

    const delivered = f.store.readEvents(spec.sessionId).filter((event) =>
      event.payload.kind === "background_continuation_delivered" ||
      (event.payload.kind === "stderr" && event.payload.runnerMarker === "background_continuation_delivery"));
    assert.equal(delivered.length, 1, "the result is delivered once");
    // A later turn does not deliver it again.
    manager.prompt(spec.sessionId, "next");
    await waitFor(() => fake.prompts.at(-1)?.text === "next", "the next prompt did not run");
    assert.equal(fake.prompts.filter((prompt) => prompt.text.startsWith(RESTART_CONTINUATION_PREFIX)).length, 1);

    const timeline = timelineText(f.store, spec.sessionId);
    const notice = timeline.find((text) => text.startsWith("The restart ended"));
    assert.ok(notice, timeline.join("\n"));
    assert.match(notice, /a monitor \(job monitor-1, started [^)]+\)\. It is recorded as killed, and its result cannot be recovered\./u);
    assert.match(notice, /The result of a subagent \(job agent-1, started [^)]+\), which finished before the restart, never reached the conversation\./u);
    assert.ok(timeline.includes("Runner reported the background work of the conversation the restart replaced."));
    assert.equal(timeline.some((text) => text.includes("agent-1.output")), false,
      "the provider output path never reaches the timeline");
  } finally {
    manager?.shutdownAll();
    rmSync(f.root, { recursive: true, force: true });
  }
});

function storedClaudeSession(sessionId: string, repo: string, extra: Partial<SessionMeta>): SessionMeta {
  return {
    sessionId, agentId: "claude", workspaceId: "repo", repoPath: repo, worktreePath: null,
    driver: "claude-code", command: "claude", args: [], env: {}, context: { kind: "native" },
    agentSessionId: "provider-session-old", status: "idle", title: "restart", config: {},
    tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null, seq: 0,
    createdAt: 1_000, updatedAt: 1_000, ...extra,
  };
}

function storedJob(id: string, extra: Partial<DurableBackgroundJob>): DurableBackgroundJob {
  return {
    id, parentTurnId: "turn-old", runnerId: "runner", workspaceId: "repo", context: { kind: "native" },
    launchType: "shell", registeredAt: 2_000, ...extra,
  };
}

test("a restart never repeats a continuation already submitted to the replaced conversation (#1779)", { skip: !haveGit() }, async () => {
  const f = fixture("submitted");
  let manager: SessionManager | undefined;
  try {
    const spec = claudeSpec("s_restart_submitted", f.repo);
    f.store.create(storedClaudeSession(spec.sessionId, f.repo, {
      backgroundWorkState: "continuation_pending",
      backgroundJobs: [storedJob("shell-1", {
        terminalStatus: "completed", terminalObservedAt: 3_000, continuationRequired: true,
        continuationId: "bgcont_old", continuationQueuedAt: 3_000, continuationSubmittedAt: 3_100,
        outputReference: "/tmp/claude/tasks/shell-1.output",
      })],
    }));
    const fake = fakeProvider();
    manager = new SessionManager((message) => { f.sent.push(message); }, () => {}, f.store, "runner", undefined,
      fake.factory as never, f.dataDir, 1);
    assert.equal(await manager.start(spec), true);
    manager.prompt(spec.sessionId, "after restart");
    await waitFor(() => fake.prompts.length === 1, "the prompt did not run");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(fake.prompts.map((prompt) => prompt.text), ["after restart"],
      "the submitted continuation is not submitted again");
    const job = f.store.readMeta(spec.sessionId)?.backgroundJobs?.find((item) => item.id === "shell-1");
    assert.equal(job?.continuationSubmittedAt, 3_100);
    assert.ok(job?.continuationMissingResultAt, "its result is recorded as missing rather than pending forever");
    assert.equal(f.store.readMeta(spec.sessionId)?.backgroundWorkState, undefined);
  } finally {
    manager?.shutdownAll();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a restart that only ended unfinished work reports it as unrecoverable without a delivery turn (#1779)", { skip: !haveGit() }, async () => {
  const f = fixture("killed");
  let manager: SessionManager | undefined;
  try {
    const spec = claudeSpec("s_restart_killed", f.repo);
    // One tracked job never finished, and an orphaned task id has no record at all. A job that
    // finished inside a provider turn reached the conversation there and is owed nothing.
    const finishedInTurn = storedJob("shell-in-turn", {
      terminalStatus: "completed", terminalObservedAt: 2_100, continuationRequired: false,
    });
    f.store.create(storedClaudeSession(spec.sessionId, f.repo, {
      backgroundWorkState: "orphaned",
      backgroundJobs: [finishedInTurn, storedJob("monitor-1", { launchType: "monitor" })],
      pendingBackgroundTaskIds: ["monitor-1", "task-untracked"],
      orphanedWork: { pendingTaskIds: ["monitor-1", "task-untracked"], markedAt: 2_500, reason: "process_exit" },
    }));
    const fake = fakeProvider();
    manager = new SessionManager((message) => { f.sent.push(message); }, () => {}, f.store, "runner", undefined,
      fake.factory as never, f.dataDir, 1);
    assert.equal(await manager.start(spec), true);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(fake.prompts, [], "no turn starts only to say that work was lost");
    assert.deepEqual(fake.providers[0]!.seeded, [], "the fresh provider does not wait on dead work");
    const meta = f.store.readMeta(spec.sessionId)!;
    assert.equal(meta.orphanedWork, undefined, "orphan recovery has nothing left to resume");
    assert.equal(meta.backgroundWorkState, undefined);
    const history = meta.backgroundJobs?.find((job) => job.id === finishedInTurn.id);
    assert.ok(history?.restartedAt, "history is marked as the replaced conversation's");
    assert.deepEqual({ ...history, restartedAt: undefined }, { ...finishedInTurn, restartedAt: undefined },
      "a result the old conversation already received is otherwise kept as history, unchanged");
    assert.deepEqual(meta.backgroundJobs?.filter((job) => job.id !== finishedInTurn.id)
      .map((job) => [job.id, job.launchType, job.terminalStatus, job.endedBy?.reason]), [
      ["monitor-1", "monitor", "killed", "session_restart"],
      ["task-untracked", "unknown", "killed", "session_restart"],
    ]);
    const notice = timelineText(f.store, spec.sessionId).find((text) => text.startsWith("The restart ended"));
    assert.match(notice ?? "", /^The restart ended 2 background jobs: a monitor \(job monitor-1, [^)]+\); a job \(job task-untracked, [^)]+\)\. Each is recorded as killed, and their results cannot be recovered\.$/u);
  } finally {
    manager?.shutdownAll();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Stop still rejects the queued prompts and clears the background records (#1779)", { skip: !haveGit() }, async () => {
  const f = fixture("stop");
  let manager: SessionManager | undefined;
  try {
    const fake = fakeProvider({
      onPrompt: (provider, text) => {
        if (text !== HELD_TURN) return;
        const job = { id: "monitor-1", launchType: "monitor" as const, startedAt: Date.now() };
        provider.cb.onBackgroundWork?.({
          state: "running", pendingTaskIds: [job.id], jobs: [job], observedTaskIds: [job.id],
        });
      },
    });
    manager = new SessionManager((message) => { f.sent.push(message); }, () => {}, f.store, "runner", undefined,
      fake.factory as never, f.dataDir, 1);
    const spec = claudeSpec("s_stop_unchanged", f.repo);
    await manager.start(spec);
    manager.prompt(spec.sessionId, HELD_TURN);
    await waitFor(() => fake.prompts.length === 1, "the first turn did not start");
    const lifecycle: string[] = [];
    manager.prompt(spec.sessionId, "queued before stop", [], undefined, undefined, recordingLifecycle("queued", lifecycle));
    assert.ok(f.store.readMeta(spec.sessionId)?.backgroundJobs?.length);

    manager.stop(spec.sessionId);
    assert.deepEqual(lifecycle, ["queued:queued", "queued:failed:session stopped before queued command started"]);
    assert.deepEqual(latestQueue(f.sent, spec.sessionId), []);
    const meta = f.store.readMeta(spec.sessionId)!;
    assert.equal(meta.status, "stopped");
    assert.deepEqual(meta.backgroundJobs, []);
    assert.deepEqual(meta.pendingBackgroundTaskIds, []);
    assert.equal(timelineText(f.store, spec.sessionId).some((text) => text.startsWith("The restart ended")), false);
  } finally {
    manager?.shutdownAll();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("restarting a session held behind a job that never ends moves it, runs the held prompts in order, and reports the finished sibling once (#1651, #1779)", { skip: !haveGit() }, async () => {
  const f = fixture("hold");
  let manager: SessionManager | undefined;
  try {
    const live = new Map<string, DriverBackgroundJob>();
    const report = (provider: ProviderProcess, terminalJobs: Array<DriverBackgroundJob & {
      status: "completed" | "failed" | "killed"; terminalAt: number; continuationRequired: boolean;
    }> = []) => {
      const jobs = [...live.values()];
      provider.cb.onBackgroundWork?.({
        state: jobs.length ? "running" : null,
        pendingTaskIds: jobs.map((job) => job.id).sort(),
        ...(jobs.length ? { jobs, observedTaskIds: jobs.map((job) => job.id).sort() } : {}),
        ...(terminalJobs.length ? { terminalJobs } : {}),
      });
    };
    const fake = fakeProvider({
      onPrompt: (provider, text) => {
        if (text !== "watch CI and review") return;
        const startedAt = Date.now();
        live.set("monitor-1", { id: "monitor-1", launchType: "monitor", startedAt });
        live.set("agent-1", { id: "agent-1", launchType: "agent", startedAt });
        report(provider);
      },
    });
    manager = new SessionManager((message) => { f.sent.push(message); }, () => {}, f.store, "runner", undefined,
      fake.factory as never, f.dataDir, 1);
    const spec = claudeSpec("s_restart_hold", f.repo);
    await manager.start(spec);
    manager.prompt(spec.sessionId, "watch CI and review");
    await waitFor(() => fake.prompts.length === 1 && f.store.readMeta(spec.sessionId)?.status === "idle",
      "the launching turn did not finish");
    const agent = live.get("agent-1")!;
    live.delete("agent-1");
    report(fake.providers[0]!, [{ ...agent, status: "completed", terminalAt: Date.now(), continuationRequired: true }]);

    // The move to a worktree waits for the monitor; three prompts, one a decision resume, wait behind it.
    const requested = await manager.requestWorktree(spec.sessionId, { baseRef: "HEAD", branch: "fix/restart-hold" });
    const lifecycle: string[] = [];
    manager.prompt(spec.sessionId, "first queued");
    manager.prompt(spec.sessionId, "decision resume", [], undefined, undefined,
      recordingLifecycle("decision-resume", lifecycle), false, undefined, false, undefined, undefined, undefined, true);
    manager.prompt(spec.sessionId, "third queued");
    const holds = () => f.sent.filter((message) => message.type === "session_runtime_updated")
      .map((message) => (message as { snapshot: { queueHold?: { queuedPrompts: number; restartKeepsQueue?: true } | null } })
        .snapshot.queueHold);
    await waitFor(() => holds().some((hold) => hold?.queuedPrompts === 3), "the queued prompts were not reported as held");
    assert.equal(holds().find((hold) => hold?.queuedPrompts === 3)?.restartKeepsQueue, true,
      "the hold tells its reader that a restart keeps the queue");
    assert.equal(fake.prompts.length, 1, "nothing runs while the hold lasts");

    assert.equal(await manager.start(spec), true);
    await waitFor(() => fake.prompts.length === 5, "the held prompts and the report did not run after the restart");
    assert.deepEqual(fake.prompts.slice(1).map((prompt) => [prompt.provider, prompt.cwd, prompt.text.slice(0, 27)]), [
      [1, requested.worktree.path, "first queued"],
      [1, requested.worktree.path, "decision resume"],
      [1, requested.worktree.path, "third queued"],
      [1, requested.worktree.path, RESTART_CONTINUATION_PREFIX],
    ]);
    await waitFor(() => lifecycle.includes("decision-resume:completed"), "the decision resume did not complete");
    assert.deepEqual(lifecycle, ["decision-resume:queued", "decision-resume:started", "decision-resume:completed"]);
    await waitFor(() => f.store.readMeta(spec.sessionId)?.backgroundJobs?.find((job) => job.id === "agent-1")
      ?.assistantResultPersistedAt !== undefined, "the sibling's result was not recorded as delivered");
    const meta = f.store.readMeta(spec.sessionId)!;
    assert.equal(meta.backgroundJobs?.find((job) => job.id === "monitor-1")?.endedBy?.reason, "session_restart");
    assert.equal(meta.backgroundWorkState, undefined);
    assert.equal(holds().at(-1) ?? null, null, "no hold remains");
  } finally {
    manager?.shutdownAll();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a restart that overtakes a launch keeps that launch's queued prompts in order and drops its old continuation (#1779)", { skip: !haveGit() }, async () => {
  const f = fixture("overtaken");
  let manager: SessionManager | undefined;
  try {
    let releaseInitialize = () => {};
    const initializeGate = new Promise<void>((resolve) => { releaseInitialize = resolve; });
    const fake = fakeProvider({ initializeGate: (index) => index === 1 ? initializeGate : undefined });
    manager = new SessionManager((message) => { f.sent.push(message); }, () => {}, f.store, "runner", undefined,
      fake.factory as never, f.dataDir, 1);
    const spec = claudeSpec("s_restart_overtaken", f.repo);
    await manager.start(spec);
    manager.prompt(spec.sessionId, HELD_TURN);
    await waitFor(() => fake.prompts.length === 1, "the first turn did not start");
    manager.prompt(spec.sessionId, "first queued");
    // An overtaken launch (a rebind, say) left its own pre-admission FIFO: a prompt it accepted, and
    // a runner-owned continuation written for the conversation the restart replaces.
    const lifecycle: string[] = [];
    // The continuation it holds is for a finished subagent whose result is still owed.
    f.store.patchMeta(spec.sessionId, {
      backgroundJobs: [storedJob("agent-old", {
        launchType: "agent", terminalStatus: "completed", terminalObservedAt: 3_000, continuationRequired: true,
        continuationId: "bgcont_old", continuationQueuedAt: 3_100,
      })],
    });
    const internals = manager as unknown as { preLaunchQueues: Map<string, unknown[]> };
    internals.preLaunchQueues.set(spec.sessionId, [
      { id: "pre-admission", ordinal: 40, text: "accepted by the overtaken launch", images: [],
        durable: recordingLifecycle("pre-admission", lifecycle) },
      { id: "old-continuation", ordinal: 41, text: "Managed background jobs reached their terminal barrier.",
        images: [], syntheticRecovery: true, backgroundJobIds: ["agent-old"] },
    ]);

    const restarted = manager.start(spec);
    await waitFor(() => fake.providers.length === 2, "the replacement provider was not constructed");
    manager.prompt(spec.sessionId, "sent during restart");
    releaseInitialize();
    assert.equal(await restarted, true);
    await waitFor(() => fake.prompts.filter((prompt) => prompt.provider === 1).length === 4,
      "the kept prompts and the restart report did not run after the restart");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(fake.prompts.filter((prompt) => prompt.provider === 1).map((prompt) => prompt.text.startsWith(RESTART_CONTINUATION_PREFIX) ? RESTART_CONTINUATION_PREFIX : prompt.text),
      ["first queued", "accepted by the overtaken launch", "sent during restart", RESTART_CONTINUATION_PREFIX],
      "a later prompt queues behind every kept one, and the owed result is reported in the restart's own words");
    assert.equal(fake.prompts.some((prompt) => prompt.text.startsWith("Managed background jobs")), false,
      "the overtaken launch's continuation, written for the replaced conversation, never runs");
    await waitFor(() => lifecycle.includes("pre-admission:completed"), "the kept prompt did not complete");
    assert.deepEqual(lifecycle, ["pre-admission:started", "pre-admission:completed"]);
  } finally {
    manager?.shutdownAll();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a restart onto another provider records the Claude jobs it ended and the result it cannot report (#1779)", { skip: !haveGit() }, async () => {
  const f = fixture("driver-change");
  let manager: SessionManager | undefined;
  try {
    const spec = { ...claudeSpec("s_restart_driver_change", f.repo), driver: "codex" as const, command: "codex" };
    f.store.create(storedClaudeSession(spec.sessionId, f.repo, {
      backgroundWorkState: "running",
      backgroundJobs: [
        storedJob("monitor-1", { launchType: "monitor" }),
        storedJob("agent-1", {
          launchType: "agent", terminalStatus: "completed", terminalObservedAt: 3_000, continuationRequired: true,
          outputReference: "/tmp/claude/tasks/agent-1.output",
        }),
      ],
      pendingBackgroundTaskIds: ["monitor-1"],
    }));
    const fake = fakeProvider();
    manager = new SessionManager((message) => { f.sent.push(message); }, () => {}, f.store, "runner", undefined,
      fake.factory as never, f.dataDir, 1);
    assert.equal(await manager.start(spec), true);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(fake.prompts, [], "a Claude result is never handed to another provider");
    const meta = f.store.readMeta(spec.sessionId)!;
    assert.equal(meta.driver, "codex");
    assert.equal(meta.backgroundJobs?.find((job) => job.id === "monitor-1")?.endedBy?.reason, "session_restart");
    assert.ok(meta.backgroundJobs?.find((job) => job.id === "agent-1")?.continuationMissingResultAt,
      "the owed result is recorded as missing rather than pending");
    assert.equal(meta.backgroundWorkState, undefined);
    const notice = timelineText(f.store, spec.sessionId).find((text) => text.startsWith("The restart ended")) ?? "";
    assert.match(notice, /a monitor \(job monitor-1, [^)]+\)\. It is recorded as killed/u);
    assert.match(notice, /The result of a subagent \(job agent-1, [^)]+\), which finished before the restart, never reached the conversation and cannot be reported: the restarted session uses a different provider\./u);
    assert.equal(notice.includes("agent-1.output"), false);

    // Restarting the Codex session again keeps that history and does not report it twice.
    const carried = f.store.readMeta(spec.sessionId)!.backgroundJobs;
    assert.equal(await manager.start(spec), true);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(f.store.readMeta(spec.sessionId)!.backgroundJobs, carried);
    assert.equal(timelineText(f.store, spec.sessionId).filter((text) => text.startsWith("The restart ended")).length, 1);
    assert.deepEqual(fake.prompts, []);
  } finally {
    manager?.shutdownAll();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a restart with its own prompt keeps a full queue and refuses the new prompt instead (#1779)", { skip: !haveGit() }, async () => {
  const f = fixture("full-queue");
  let manager: SessionManager | undefined;
  try {
    const fake = fakeProvider();
    manager = new SessionManager((message) => { f.sent.push(message); }, () => {}, f.store, "runner", undefined,
      fake.factory as never, f.dataDir, 1);
    const spec = claudeSpec("s_restart_full_queue", f.repo);
    await manager.start(spec);
    manager.prompt(spec.sessionId, HELD_TURN);
    await waitFor(() => fake.prompts.length === 1, "the first turn did not start");
    const lifecycle: string[] = [];
    for (let index = 0; index < 99; index++) manager.prompt(spec.sessionId, `queued ${index}`);
    assert.equal(manager.prompt(spec.sessionId, "last accepted", [], undefined, undefined,
      recordingLifecycle("last", lifecycle)), true);
    assert.equal(manager.prompt(spec.sessionId, "over the limit"), false, "the queue is full");

    assert.equal(await manager.start(spec, "restart prompt", [], recordingLifecycle("initial", lifecycle)), true);
    await waitFor(() => lifecycle.includes("last:completed"), "the last accepted prompt did not run");
    assert.ok(lifecycle.includes("initial:failed:prompt queue is full"), lifecycle.join("\n"));
    assert.equal(lifecycle.some((entry) => entry.startsWith("last:failed")), false, "no accepted prompt is evicted");
    assert.equal(fake.prompts.filter((prompt) => prompt.provider === 1).length, 100);
  } finally {
    manager?.shutdownAll();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a restart reports every owed result, and every job it ended, when there are more than one continuation can list (#1779)", { skip: !haveGit() }, async () => {
  for (const shape of ["across parent turns", "in one barrier already queued"] as const) {
    const f = fixture("many-results");
    let manager: SessionManager | undefined;
    try {
      const spec = claudeSpec("s_restart_many_results", f.repo);
      // 129 finished subagents whose results are still owed, and a monitor that never finished.
      const finished = Array.from({ length: 129 }, (_, index) => storedJob(`agent-${index}`, {
        launchType: "agent", terminalStatus: "completed", terminalObservedAt: 3_000 + index, continuationRequired: true,
        ...(shape === "across parent turns"
          ? { parentTurnId: `turn-${index}` }
          : { parentTurnId: "turn-shared", continuationId: "bgcont_shared", continuationQueuedAt: 4_000 }),
      }));
      f.store.create(storedClaudeSession(spec.sessionId, f.repo, {
        backgroundWorkState: "running",
        backgroundJobs: [...finished, storedJob("monitor-1", { launchType: "monitor" })],
        pendingBackgroundTaskIds: ["monitor-1"],
      }));
      const fake = fakeProvider();
      manager = new SessionManager((message) => { f.sent.push(message); }, () => {}, f.store, "runner", undefined,
        fake.factory as never, f.dataDir, 1);
      assert.equal(await manager.start(spec), true);
      const reported = () => fake.prompts.filter((prompt) => prompt.text.startsWith(RESTART_CONTINUATION_PREFIX));
      await waitFor(() => reported().length === 2, `${shape}: the owed results were not reported in two continuations`);
      await waitFor(() => (f.store.readMeta(spec.sessionId)?.backgroundJobs ?? [])
        .filter((job) => job.assistantResultPersistedAt !== undefined).length === 129,
      `${shape}: not every reported result was recorded as delivered`);
      const listed = reported().map((prompt) =>
        JSON.parse(prompt.text.slice(prompt.text.lastIndexOf("\n") + 1)) as Array<{ id: string; status: string }>);
      for (const results of listed) {
        assert.ok(results.filter((job) => job.status === "completed").length <= 128, `${shape}: one continuation is bounded`);
        assert.ok(results.some((job) => job.id === "monitor-1" && job.status === "killed"),
          `${shape}: every continuation names the job the restart ended`);
      }
      const listedIds = listed.flatMap((results) => results.filter((job) => job.status === "completed").map((job) => job.id));
      assert.equal(listedIds.length, 129, `${shape}: each owed result is named exactly once`);
      assert.deepEqual(new Set(listedIds), new Set(finished.map((job) => job.id)));
      // Delivery proof is keyed by continuation id, so no id may cover a job its continuation did
      // not name: a runner restart between the two turns would otherwise count it delivered.
      const byId = new Map<string, number>();
      for (const job of f.store.readMeta(spec.sessionId)?.backgroundJobs ?? []) {
        if (job.id.startsWith("agent-")) byId.set(job.continuationId!, (byId.get(job.continuationId!) ?? 0) + 1);
      }
      assert.deepEqual([...byId.values()].sort((a, b) => a - b), [1, 128], `${shape}: two continuation ids`);
    } finally {
      manager?.shutdownAll();
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("a restart keeps a queued prompt whose steering promotion never reached the provider (#1779)", { skip: !haveGit() }, async () => {
  const f = fixture("promotion");
  let manager: SessionManager | undefined;
  try {
    const fake = fakeProvider();
    manager = new SessionManager((message) => { f.sent.push(message); }, () => {}, f.store, "runner", undefined,
      fake.factory as never, f.dataDir, 1);
    const spec = claudeSpec("s_restart_promotion", f.repo);
    await manager.start(spec);
    manager.prompt(spec.sessionId, HELD_TURN);
    await waitFor(() => fake.prompts.length === 1, "the first turn did not start");
    const lifecycle: string[] = [];
    manager.prompt(spec.sessionId, "being promoted", [], undefined, undefined, recordingLifecycle("promoted", lifecycle));
    manager.prompt(spec.sessionId, "queued after it");

    // The dashboard asked to steer the first queued prompt into the running turn. Admission took it
    // out of the FIFO and reserved it, as admitSteering does, before any provider write.
    const internals = manager as unknown as {
      active: Map<string, { queue: Array<{ id: string; text: string }>; reservedPromotions?: Map<string, unknown> }>;
      steeringRegistry: Map<string, Map<string, unknown>>;
    };
    const entry = internals.active.get(spec.sessionId)!;
    const source = entry.queue.shift()!;
    assert.equal(source.text, "being promoted");
    let settle!: (result: { disposition: string; reason: string }) => void;
    const promise = new Promise<{ disposition: string; reason: string }>((resolve) => { settle = resolve; });
    const operation = {
      request: { submissionId: "promotion-1", sessionId: spec.sessionId, turnId: "turn-a", promotePromptId: source.id },
      requestHash: "hash", ordinal: 0, effectiveConfig: {}, deadlineAt: Date.now() + 60_000, source,
      cancelRequested: false, providerStarted: false, fenceInstalled: false, settled: false, references: 1,
      promise, resolve: settle, lifecyclePromise: Promise.resolve(), resolveLifecycle: () => {}, lastAccessOrdinal: 0,
    };
    (entry.reservedPromotions ??= new Map()).set(source.id, operation);
    internals.steeringRegistry.set(spec.sessionId, new Map([["promotion-1", operation]]));

    assert.equal(await manager.start(spec), true);
    assert.equal((await promise).disposition, "rejected", "the steering attempt itself ends with the replaced process");
    await waitFor(() => fake.prompts.filter((prompt) => prompt.provider === 1).length === 2,
      "the kept prompts did not run after the restart");
    assert.deepEqual(fake.prompts.filter((prompt) => prompt.provider === 1).map((prompt) => prompt.text),
      ["being promoted", "queued after it"], "the unsubmitted promotion runs as the queued prompt it was, in order");
    await waitFor(() => lifecycle.includes("promoted:completed"), "the promoted prompt did not complete");
    assert.equal(lifecycle.some((entry) => entry.startsWith("promoted:failed")), false, lifecycle.join("\n"));
  } finally {
    manager?.shutdownAll();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a job the restarted conversation starts under a reused task id gets its own record and result (#1779)", { skip: !haveGit() }, async () => {
  const f = fixture("reused-id");
  let manager: SessionManager | undefined;
  try {
    const spec = claudeSpec("s_restart_reused_id", f.repo);
    // The replaced conversation's task-1 finished and was delivered long ago.
    f.store.create(storedClaudeSession(spec.sessionId, f.repo, {
      backgroundJobs: [storedJob("task-1", {
        terminalStatus: "completed", terminalObservedAt: 2_100, continuationRequired: false, assistantResultPersistedAt: 2_200,
      })],
    }));
    const fake = fakeProvider({
      onPrompt: (provider, text) => {
        if (text !== "start work") return;
        const job = { id: "task-1", launchType: "shell" as const, startedAt: Date.now() };
        provider.cb.onBackgroundWork?.({ state: "running", pendingTaskIds: [job.id], jobs: [job], observedTaskIds: [job.id] });
      },
    });
    manager = new SessionManager((message) => { f.sent.push(message); }, () => {}, f.store, "runner", undefined,
      fake.factory as never, f.dataDir, 1);
    assert.equal(await manager.start(spec), true);
    manager.prompt(spec.sessionId, "start work");
    await waitFor(() => f.store.readMeta(spec.sessionId)?.status === "idle" && fake.prompts.length === 1,
      "the launching turn did not finish");
    const record = f.store.readMeta(spec.sessionId)?.backgroundJobs?.find((job) => job.id === "task-1");
    assert.equal(record?.restartedAt, undefined, "the new job does not inherit the replaced conversation's record");
    assert.equal(record?.assistantResultPersistedAt, undefined);

    // It finishes after its turn; its result is owed to this conversation and delivered.
    fake.providers[0]!.cb.onBackgroundWork?.({
      state: null, pendingTaskIds: [],
      terminalJobs: [{ id: "task-1", launchType: "shell", startedAt: Date.now(), status: "completed",
        terminalAt: Date.now(), continuationRequired: true }],
    });
    await waitFor(() => fake.prompts.some((prompt) => prompt.text.startsWith("Managed background jobs reached")),
      "the new job's result was not delivered");
    await waitFor(() => f.store.readMeta(spec.sessionId)?.backgroundJobs?.find((job) => job.id === "task-1")
      ?.assistantResultPersistedAt !== undefined, "the new job's result was not recorded as delivered");
  } finally {
    manager?.shutdownAll();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a reused task id does not cost the replaced conversation's result that is still owed (#1779)", { skip: !haveGit() }, async () => {
  const f = fixture("reused-owed-id");
  let manager: SessionManager | undefined;
  try {
    const spec = claudeSpec("s_restart_reused_owed_id", f.repo);
    // The replaced conversation's task-1 finished, and its result is still owed.
    f.store.create(storedClaudeSession(spec.sessionId, f.repo, {
      backgroundWorkState: "continuation_pending",
      backgroundJobs: [storedJob("task-1", {
        terminalStatus: "completed", terminalObservedAt: 2_100, continuationRequired: true,
      })],
    }));
    const fake = fakeProvider({
      onPrompt: (provider, text) => {
        if (text !== "start work") return;
        const job = { id: "task-1", launchType: "shell" as const, startedAt: Date.now() };
        provider.cb.onBackgroundWork?.({ state: "running", pendingTaskIds: [job.id], jobs: [job], observedTaskIds: [job.id] });
      },
    });
    manager = new SessionManager((message) => { f.sent.push(message); }, () => {}, f.store, "runner", undefined,
      fake.factory as never, f.dataDir, 1);
    // The restart's own prompt starts a job under the same id before the owed result is reported.
    assert.equal(await manager.start(spec, "start work"), true);
    const reported = () => fake.prompts.find((prompt) => prompt.text.startsWith(RESTART_CONTINUATION_PREFIX));
    await waitFor(() => reported() !== undefined, "the owed result was not reported");
    assert.equal(fake.prompts[0]!.text, "start work");
    const listed = JSON.parse(reported()!.text.slice(reported()!.text.lastIndexOf("\n") + 1)) as Array<{ id: string; status: string }>;
    assert.deepEqual(listed.map((job) => job.status), ["completed"]);
    assert.match(listed[0]!.id, /^task-1~restart-\d+$/u, "the carried record moved aside under a distinct id");
    await waitFor(() => (f.store.readMeta(spec.sessionId)?.backgroundJobs ?? [])
      .some((job) => job.id === listed[0]!.id && job.assistantResultPersistedAt !== undefined),
    "the owed result was not recorded as delivered");
    const current = f.store.readMeta(spec.sessionId)?.backgroundJobs?.find((job) => job.id === "task-1");
    assert.equal(current?.restartedAt, undefined, "the new job keeps the original id with a fresh record");
    assert.equal(current?.terminalStatus, undefined);
  } finally {
    manager?.shutdownAll();
    rmSync(f.root, { recursive: true, force: true });
  }
});
