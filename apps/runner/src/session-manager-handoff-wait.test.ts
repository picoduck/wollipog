import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import type { RunnerToControlPlane, SessionLaunchSpec, SessionQueueHoldView } from "@wollipog/protocol";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  DriverBackgroundJob,
  DriverBackgroundTerminalJob,
  DriverBackgroundWorkEndResult,
  DriverCallbacks,
} from "./drivers/driver.js";
import { SessionManager, type DurableCommandLifecycle, type ProviderAccountResolver } from "./session-manager.js";
import { SessionStore } from "./session-store.js";

// #1778: a worktree or provider-account handoff deferred behind background work that never ends
// must not hold the prompts queued behind it until someone restarts the session.

const ORPHAN_RECOVERY_PREFIX = "Continue after runner restart:";
const CONTINUATION_PREFIX = "Managed background jobs reached their terminal barrier.";

async function waitFor(predicate: () => boolean, message: string, attempts = 800): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function initRepo(root: string): string {
  const repo = join(root, "repo");
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
  return repo;
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
  cwd: string;
  home?: string;
  cb: DriverCallbacks;
}

/**
 * A Claude-shaped provider. Its background jobs live in one ledger shared by every process
 * generation, as Claude's task files do; `endBackgroundWork` behaves like the real driver's
 * (every unfinished job is reported killed and runner-ended, none is orphaned).
 */
function fakeProvider(options: {
  handoffWaitMaxMs: number;
  onPrompt?: (provider: ProviderProcess, text: string) => void;
}) {
  const providers: ProviderProcess[] = [];
  const prompts: Array<{ cwd: string; home?: string; text: string }> = [];
  const live = new Map<string, DriverBackgroundJob>();
  const endCalls: number[] = [];
  const factory = (_driver: unknown, launch: { cwd: string; env: Record<string, string> }, cb: DriverCallbacks) => {
    const provider: ProviderProcess = { cwd: launch.cwd, home: launch.env.CLAUDE_CONFIG_DIR, cb };
    providers.push(provider);
    return {
      pid: providers.length,
      initialize: async () => {},
      newSession: async () => {},
      close: async () => {},
      handoffWaitMaxMs: options.handoffWaitMaxMs,
      endBackgroundWork: async (): Promise<DriverBackgroundWorkEndResult> => {
        endCalls.push(Date.now());
        if (live.size === 0) return { status: "none" };
        const terminalAt = Date.now();
        const jobs: DriverBackgroundTerminalJob[] = [...live.values()].map((job) => ({
          ...job, status: "killed", terminalAt, continuationRequired: false, endedByRunner: true,
        }));
        live.clear();
        cb.onBackgroundWork?.({ state: null, pendingTaskIds: [], terminalJobs: jobs });
        return { status: "ended", jobs };
      },
      prompt: async (text: string) => {
        prompts.push({ cwd: launch.cwd, home: provider.home, text });
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
  /** Report the ledger as the driver would after a lifecycle change. */
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
  return { factory, providers, prompts, live, endCalls, report };
}

/** A turn that launches a monitor that never fires and a subagent, as the incident's did. */
function launchesMonitorAndSubagent(live: Map<string, DriverBackgroundJob>, report: (provider: ProviderProcess) => void) {
  return (provider: ProviderProcess, text: string) => {
    if (text !== "watch CI and review") return;
    const startedAt = Date.now();
    live.set("monitor-1", { id: "monitor-1", launchType: "monitor", startedAt });
    live.set("agent-1", { id: "agent-1", launchType: "agent", startedAt });
    report(provider);
  };
}

/** The subagent finishes after its parent turn ended; the monitor does not. */
function finishSubagent(fake: ReturnType<typeof fakeProvider>): void {
  const agent = fake.live.get("agent-1")!;
  fake.live.delete("agent-1");
  fake.report(fake.providers.at(-1)!, [{
    ...agent, status: "completed", terminalAt: Date.now(), continuationRequired: true,
  }]);
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

function claudeSpec(sessionId: string, repo: string, extra: Partial<SessionLaunchSpec> = {}): SessionLaunchSpec {
  return {
    sessionId, workspaceId: "repo", workspacePath: repo, agentId: "claude",
    command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code",
    context: { kind: "native" }, ...extra,
  };
}

test("a monitor that never ends is killed after the bound, the sibling result is delivered once, the rebind applies, and queued prompts run in order (#1778)", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-handoff-wait-rebind-"));
  let manager: SessionManager | undefined;
  try {
    const repo = initRepo(root);
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    const sent: RunnerToControlPlane[] = [];
    const bound = 250;
    let onPrompt: (provider: ProviderProcess, text: string) => void = () => {};
    const fake = fakeProvider({ handoffWaitMaxMs: bound, onPrompt: (provider, text) => onPrompt(provider, text) });
    onPrompt = launchesMonitorAndSubagent(fake.live, (provider) => fake.report(provider));
    manager = new SessionManager((message) => { sent.push(message); }, () => {}, store, "runner", undefined,
      fake.factory as never, dataDir, 1);
    const spec = claudeSpec("s_handoff_wait", repo);
    await manager.start(spec);

    manager.prompt(spec.sessionId, "watch CI and review");
    await waitFor(() => fake.prompts.length === 1 && store.readMeta(spec.sessionId)?.status === "idle",
      "the launching turn did not finish");
    finishSubagent(fake);
    const blocked = store.readMeta(spec.sessionId)!;
    assert.equal(blocked.backgroundWorkState, "running");
    assert.equal(blocked.backgroundJobs?.find((job) => job.id === "agent-1")?.continuationQueuedAt, undefined,
      "the finished sibling's result waits for the monitor from the same turn");

    // The session selected a worktree during a turn; the move waits for the background work.
    const requested = await manager.requestWorktree(spec.sessionId, { baseRef: "HEAD", branch: "fix/handoff-wait" });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(fake.providers.map((provider) => provider.cwd), [repo]);

    // Three prompts queue behind it, the second a durable workflow-decision resume.
    const lifecycle: string[] = [];
    manager.prompt(spec.sessionId, "first queued");
    assert.equal(manager.prompt(spec.sessionId, "decision resume", [], undefined, undefined,
      recordingLifecycle("decision-resume", lifecycle), false, undefined, false, undefined, undefined, undefined, true), true);
    manager.prompt(spec.sessionId, "third queued");
    await waitFor(() => publishedHolds(sent).some((hold) => hold?.queuedPrompts === 3),
      "the queued prompts were not reported as held");
    const hold = publishedHolds(sent).find((candidate) => candidate?.queuedPrompts === 3)!;
    assert.equal(hold.kind, "worktree_rebind");
    assert.equal(hold.endsAt, hold.since + bound, "the hold says when Wollipog ends the work");
    assert.equal(fake.endCalls.length, 0, "nothing is ended before the bound");

    await waitFor(() => fake.prompts.length === 5, "the handoff and the queued prompts did not proceed after the bound");
    assert.equal(fake.endCalls.length, 1, "the work is ended once");
    assert.ok(fake.endCalls[0]! >= hold.endsAt!, "the work is not ended before the bound");

    // The sibling's continuation runs once, in the old worktree, before the handoff; it names the
    // killed monitor so the provider does not wait for it. Then the queue runs in FIFO order in
    // the selected worktree. Nothing is discarded, and no restart happened.
    const [launching, continuation, ...queued] = fake.prompts;
    assert.equal(launching!.text, "watch CI and review");
    assert.equal(continuation!.cwd, repo);
    assert.ok(continuation!.text.startsWith(CONTINUATION_PREFIX));
    assert.match(continuation!.text, /"id":"agent-1","launchType":"agent","status":"completed"/);
    assert.match(continuation!.text, /"id":"monitor-1","launchType":"monitor","status":"killed"/);
    assert.deepEqual(queued, [
      { cwd: requested.worktree.path, home: undefined, text: "first queued" },
      { cwd: requested.worktree.path, home: undefined, text: "decision resume" },
      { cwd: requested.worktree.path, home: undefined, text: "third queued" },
    ]);
    assert.deepEqual(fake.providers.map((provider) => provider.cwd), [repo, requested.worktree.path]);
    await waitFor(() => lifecycle.includes("decision-resume:completed"), "the decision resume did not complete");
    assert.deepEqual(lifecycle, ["decision-resume:queued", "decision-resume:started", "decision-resume:completed"]);
    assert.equal(fake.prompts.filter((prompt) => prompt.text.startsWith(ORPHAN_RECOVERY_PREFIX)).length, 0,
      "an ended job is not handed to orphan recovery");

    const meta = store.readMeta(spec.sessionId)!;
    const monitor = meta.backgroundJobs?.find((job) => job.id === "monitor-1");
    assert.equal(monitor?.terminalStatus, "killed");
    assert.deepEqual(monitor?.endedBy && { actor: monitor.endedBy.actor, reason: monitor.endedBy.reason },
      { actor: { kind: "runner" }, reason: "handoff_wait_bound" });
    assert.ok(meta.backgroundJobs?.find((job) => job.id === "agent-1")?.assistantResultPersistedAt);
    assert.equal(meta.backgroundWorkState, undefined);
    assert.equal(meta.orphanedWork, undefined);

    // The timeline says why the job ended, before anything the kill unblocked.
    const events = store.readEvents(spec.sessionId);
    const deliveries = events.filter((event) => event.payload.kind === "background_continuation_delivered");
    assert.equal(deliveries.length, 1, "the sibling's result is delivered exactly once");
    const notices = events.filter((event) => event.payload.kind === "stderr" &&
      event.payload.text.startsWith("Wollipog ended"));
    assert.equal(notices.length, 1);
    const notice = (notices[0]!.payload as { text: string }).text;
    assert.match(notice, /^Wollipog ended a monitor \(job monitor-1, started \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\)\./);
    assert.ok(notice.includes(`move to worktree ${requested.worktree.path}`));
    assert.match(notice, /the 3 queued messages waited behind it/);
    assert.match(notice, /It is recorded as killed\./);
    const continuationTurn = events.findIndex((event) => event.payload.kind === "stderr" &&
      event.payload.text === "Runner continued after managed background work completed.");
    const firstQueued = events.findIndex((event) => event.payload.kind === "user_message" &&
      event.payload.text === "first queued");
    assert.ok(continuationTurn > 0 && firstQueued > continuationTurn);
    assert.ok(events.indexOf(notices[0]!) < continuationTurn, "the kill is recorded before the continuation");

    const holds = publishedHolds(sent);
    assert.equal(holds.at(-1), null, "the hold is cleared explicitly");
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a provider-account switch held by a never-ending monitor is bounded the same way (#1778)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-handoff-wait-account-"));
  let manager: SessionManager | undefined;
  try {
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    const sent: RunnerToControlPlane[] = [];
    const bound = 250;
    let onPrompt: (provider: ProviderProcess, text: string) => void = () => {};
    const fake = fakeProvider({ handoffWaitMaxMs: bound, onPrompt: (provider, text) => onPrompt(provider, text) });
    onPrompt = launchesMonitorAndSubagent(fake.live, (provider) => fake.report(provider));
    manager = new SessionManager((message) => { sent.push(message); }, () => {}, store, "runner", undefined,
      fake.factory as never, dataDir, 1);
    const accounts = [
      { id: "claude-work", label: "work@example.test", provider: "claude" as const, credentialHome: "/claude/work" },
      { id: "claude-personal", label: "personal@example.test", provider: "claude" as const, credentialHome: "/claude/personal" },
    ];
    const internals = manager as unknown as {
      resolveProviderAccount: ProviderAccountResolver;
      prepareLaunch: (meta: { providerCredentialHome?: string; env: Record<string, string> }) => void;
    };
    internals.resolveProviderAccount = (spec) => accounts.find((account) => account.id === spec.providerAccountId);
    internals.prepareLaunch = (meta) => {
      if (meta.providerCredentialHome) meta.env = { CLAUDE_CONFIG_DIR: meta.providerCredentialHome };
    };
    const spec = claudeSpec("s_handoff_wait_account", root, { providerAccountId: "claude-work" });
    assert.equal(await manager.start(spec), true);
    store.patchMeta(spec.sessionId, { agentSessionId: "provider-session-id" });

    manager.prompt(spec.sessionId, "watch CI and review");
    await waitFor(() => fake.prompts.length === 1 && store.readMeta(spec.sessionId)?.status === "idle",
      "the launching turn did not finish");
    finishSubagent(fake);

    assert.deepEqual(await manager.switchProviderAccount(spec.sessionId, "claude-personal"), { ok: true, scheduled: true });
    const lifecycle: string[] = [];
    manager.prompt(spec.sessionId, "first queued");
    manager.prompt(spec.sessionId, "decision resume", [], undefined, undefined,
      recordingLifecycle("decision-resume", lifecycle), false, undefined, false, undefined, undefined, undefined, true);
    await waitFor(() => publishedHolds(sent).some((hold) => hold?.queuedPrompts === 2),
      "the queued prompts were not reported as held");
    const hold = publishedHolds(sent).find((candidate) => candidate?.queuedPrompts === 2)!;
    assert.equal(hold.kind, "provider_account_switch");
    assert.equal(hold.endsAt, hold.since + bound);

    await waitFor(() => fake.prompts.length === 4, "the account switch and the queued prompts did not proceed");
    assert.equal(fake.endCalls.length, 1);
    const [, continuation, ...queued] = fake.prompts;
    assert.equal(continuation!.home, "/claude/work", "the sibling's result is delivered before the switch");
    assert.match(continuation!.text, /"id":"agent-1","launchType":"agent","status":"completed"/);
    assert.deepEqual(queued, [
      { cwd: root, home: "/claude/personal", text: "first queued" },
      { cwd: root, home: "/claude/personal", text: "decision resume" },
    ]);
    await waitFor(() => lifecycle.includes("decision-resume:completed"), "the decision resume did not complete");
    assert.deepEqual(lifecycle, ["decision-resume:queued", "decision-resume:started", "decision-resume:completed"]);

    const meta = store.readMeta(spec.sessionId)!;
    assert.equal(meta.providerAccountId, "claude-personal");
    assert.equal(meta.backgroundJobs?.find((job) => job.id === "monitor-1")?.terminalStatus, "killed");
    assert.equal(meta.backgroundJobs?.find((job) => job.id === "monitor-1")?.endedBy?.reason, "handoff_wait_bound");
    const events = store.readEvents(spec.sessionId);
    assert.equal(events.filter((event) => event.payload.kind === "background_continuation_delivered").length, 1);
    const notice = events.map((event) => event.payload)
      .find((payload) => payload.kind === "stderr" && payload.text.startsWith("Wollipog ended")) as { text: string };
    assert.match(notice.text, /switch to the selected provider account/);
    assert.equal(notice.text.includes("@example.test"), false, "the transcript names no account");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a job that ends on its own before the bound is left alone, and the handoff proceeds (#1778)", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-handoff-wait-natural-"));
  let manager: SessionManager | undefined;
  try {
    const repo = initRepo(root);
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    const sent: RunnerToControlPlane[] = [];
    const bound = 300;
    const fake = fakeProvider({
      handoffWaitMaxMs: bound,
      onPrompt: (provider, text) => {
        if (text !== "watch CI") return;
        fake.live.set("monitor-1", { id: "monitor-1", launchType: "monitor", startedAt: Date.now() });
        fake.report(provider);
      },
    });
    manager = new SessionManager((message) => { sent.push(message); }, () => {}, store, "runner", undefined,
      fake.factory as never, dataDir, 1);
    const spec = claudeSpec("s_handoff_wait_natural", repo);
    await manager.start(spec);
    manager.prompt(spec.sessionId, "watch CI");
    await waitFor(() => store.readMeta(spec.sessionId)?.status === "idle", "the launching turn did not finish");
    const requested = await manager.requestWorktree(spec.sessionId, { baseRef: "HEAD", branch: "fix/handoff-natural" });
    manager.prompt(spec.sessionId, "queued");
    await waitFor(() => publishedHolds(sent).some((hold) => hold?.endsAt !== undefined), "the hold was not bounded");

    // The monitor's condition fires well inside the bound.
    const monitor = fake.live.get("monitor-1")!;
    fake.live.delete("monitor-1");
    fake.report(fake.providers[0]!, [{ ...monitor, status: "completed", terminalAt: Date.now(), continuationRequired: false }]);
    await waitFor(() => fake.prompts.length === 2, "the queued prompt did not run once the monitor ended");
    assert.deepEqual(fake.prompts[1], { cwd: requested.worktree.path, home: undefined, text: "queued" });

    await new Promise<void>((resolve) => setTimeout(resolve, bound + 100));
    assert.deepEqual(fake.endCalls, [], "nothing is ended once the wait is over");
    const job = store.readMeta(spec.sessionId)?.backgroundJobs?.find((candidate) => candidate.id === "monitor-1");
    assert.equal(job?.terminalStatus, "completed");
    assert.equal(job?.endedBy, undefined);
    assert.equal(store.readEvents(spec.sessionId).some((event) => event.payload.kind === "stderr" &&
      event.payload.text.startsWith("Wollipog ended")), false);
    assert.equal((manager as unknown as { handoffWaitTimers: Map<string, unknown> }).handoffWaitTimers.size, 0,
      "the bound's timer is cleared with the hold");
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a disabled bound keeps the previous behavior: the hold names no end and nothing is ended (#1778)", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-handoff-wait-disabled-"));
  let manager: SessionManager | undefined;
  try {
    const repo = initRepo(root);
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    const sent: RunnerToControlPlane[] = [];
    const fake = fakeProvider({
      handoffWaitMaxMs: 0,
      onPrompt: (provider, text) => {
        if (text !== "watch CI") return;
        fake.live.set("monitor-1", { id: "monitor-1", launchType: "monitor", startedAt: Date.now() });
        fake.report(provider);
      },
    });
    manager = new SessionManager((message) => { sent.push(message); }, () => {}, store, "runner", undefined,
      fake.factory as never, dataDir, 1);
    const spec = claudeSpec("s_handoff_wait_disabled", repo);
    await manager.start(spec);
    manager.prompt(spec.sessionId, "watch CI");
    await waitFor(() => store.readMeta(spec.sessionId)?.status === "idle", "the launching turn did not finish");
    await manager.requestWorktree(spec.sessionId, { baseRef: "HEAD", branch: "fix/handoff-disabled" });
    manager.prompt(spec.sessionId, "queued");
    await waitFor(() => publishedHolds(sent).some(Boolean), "the hold was not reported");
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    assert.equal(publishedHolds(sent).some((hold) => hold?.endsAt !== undefined), false);
    assert.deepEqual(fake.endCalls, []);
    assert.equal(fake.prompts.length, 1, "the queued prompt still waits");
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ending the work keeps orphan recovery at most once: a recovered monitor that never ends gets no second recovery turn (#1778)", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-handoff-wait-orphan-"));
  let manager: SessionManager | undefined;
  try {
    const repo = initRepo(root);
    const home = join(root, "home");
    mkdirSync(home);
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    const sent: RunnerToControlPlane[] = [];
    const bound = 250;
    const fake = fakeProvider({
      handoffWaitMaxMs: bound,
      onPrompt: (provider, text) => {
        // The recovery turn re-observes the monitor, which is still alive and never fires.
        if (!text.startsWith(ORPHAN_RECOVERY_PREFIX)) return;
        fake.live.set("monitor-1", { id: "monitor-1", launchType: "monitor", startedAt: 1_000 });
        fake.report(provider);
      },
    });
    manager = new SessionManager((message) => { sent.push(message); }, () => {}, store, "runner", undefined,
      fake.factory as never, dataDir, 1);
    const spec = claudeSpec("s_handoff_wait_orphan", repo, { env: { HOME: home } });
    await manager.start(spec);
    // A previous provider process exited with the monitor pending: it is orphaned, and its one
    // unattended recovery turn has not run yet.
    store.patchMeta(spec.sessionId, {
      agentSessionId: "provider-session-id",
      backgroundWorkState: "orphaned",
      pendingBackgroundTaskIds: ["monitor-1"],
      backgroundJobs: [{
        id: "monitor-1", parentTurnId: "turn-1", runnerId: "runner", workspaceId: "repo",
        context: { kind: "native" }, launchType: "monitor", registeredAt: 1_000,
      }],
      orphanedWork: { pendingTaskIds: ["monitor-1"], markedAt: Date.now(), reason: "process_exit" },
    });
    manager.recoverOrphanedWork(spec.sessionId);
    await waitFor(() => fake.prompts.some((prompt) => prompt.text.startsWith(ORPHAN_RECOVERY_PREFIX)) &&
      store.readMeta(spec.sessionId)?.status === "idle" && !store.readMeta(spec.sessionId)?.orphanedWork,
    "the one recovery turn did not run and settle");
    assert.equal(store.readMeta(spec.sessionId)?.backgroundWorkState, "running",
      "the recovered process owns the still-running monitor");

    const requested = await manager.requestWorktree(spec.sessionId, { baseRef: "HEAD", branch: "fix/handoff-orphan" });
    manager.prompt(spec.sessionId, "queued after recovery");
    await waitFor(() => fake.prompts.some((prompt) => prompt.text === "queued after recovery"),
      "the queued prompt did not run after the bound");
    assert.equal(fake.endCalls.length, 1);
    assert.equal(fake.prompts.at(-1)?.cwd, requested.worktree.path);
    const meta = store.readMeta(spec.sessionId)!;
    assert.equal(meta.orphanedWork, undefined, "the kill writes no orphan marker");
    assert.equal(meta.backgroundJobs?.find((job) => job.id === "monitor-1")?.terminalStatus, "killed");
    // Whatever wakes orphan recovery next — a retry timer, a reconnect scan — has nothing to submit.
    await (manager as unknown as { runOrphanRecovery(sessionId: string): Promise<void> })
      .runOrphanRecovery(spec.sessionId);
    manager.recoverOrphanedWork(spec.sessionId);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(fake.prompts.filter((prompt) => prompt.text.startsWith(ORPHAN_RECOVERY_PREFIX)).length, 1,
      "orphan recovery was submitted at most once");
    manager.stop(spec.sessionId);
    await manager.delete(spec.sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});
