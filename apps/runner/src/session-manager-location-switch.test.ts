import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import type { RunnerToControlPlane, SessionLaunchSpec, SessionLocationSwitchMessage } from "@wollipog/protocol";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeProjectPathKey } from "./claude-background-work.js";
import type { DriverCallbacks } from "./drivers/driver.js";
import { LOCATION_SWITCH_FAILURES, moveClaudeTranscriptToCwd, originNamesRepository } from "./location-switch.js";
import { bindPullRequestScope } from "./review-snapshot.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";

// #4138: an approved Location switch moves a live session into another repository's Location on
// the same runner at its next turn boundary, keeping its conversation, and continues the task.

const git = (cwd: string, ...args: string[]) => execFileSync("git", [
  "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
  "-C", cwd, ...args,
], { encoding: "utf8" }).trim();

async function waitFor(predicate: () => boolean, message: string, attempts = 800): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function repository(root: string, name: string, origin: string): string {
  const path = join(root, name);
  mkdirSync(path);
  git(path, "init", "--quiet", "--initial-branch=main");
  git(path, "commit", "--quiet", "--allow-empty", "-m", "base");
  git(path, "remote", "add", "origin", origin);
  return realpathSync(path);
}

function fakeProvider(options: { failLaunch?: number } = {}) {
  const prompts: Array<{ cwd: string; text: string }> = [];
  const resumed: Array<string | undefined> = [];
  const callbacks: DriverCallbacks[] = [];
  let launches = 0;
  const factory = (_driver: unknown, launch: { cwd: string; resumeId?: string }, cb: DriverCallbacks) => {
    launches++;
    const generation = launches;
    resumed.push(launch.resumeId);
    callbacks.push(cb);
    return {
      pid: launches, newSession: async () => {}, close: async () => {},
      initialize: async () => { if (generation === options.failLaunch) throw new Error("provider failed to start"); },
      prompt: async (text: string) => {
        prompts.push({ cwd: launch.cwd, text });
        cb.onPromptAccepted?.();
        cb.onEvent({ kind: "agent_message", text: "done", final: true });
        return "end_turn" as const;
      },
      cancel: () => {}, dispose: () => {}, setConfig: () => {}, resolvePermission: () => false,
      agentSessionId: () => "provider-session-id",
    };
  };
  return { factory, prompts, resumed, callbacks, launches: () => launches };
}

interface Harness {
  manager: SessionManager;
  store: SessionStore;
  sessionId: string;
  fake: ReturnType<typeof fakeProvider>;
  sent: RunnerToControlPlane[];
  app: string;
  docs: string;
  claudeHome: string;
  dataDir: string;
  message: (overrides?: Partial<SessionLocationSwitchMessage>) => SessionLocationSwitchMessage;
  /** A fresh runner process over the same session store, as after a crash and restart. */
  restartRunner: (fake?: ReturnType<typeof fakeProvider>) => { manager: SessionManager; store: SessionStore; fake: ReturnType<typeof fakeProvider> };
}

async function withSession(name: string, body: (h: Harness) => Promise<void>,
  options: { driver?: "claude-code" | "codex-app-server"; failLaunch?: number } = {}): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `wollipog-location-switch-${name}-`));
  const previousClaudeHome = process.env.CLAUDE_CONFIG_DIR;
  const claudeHome = join(root, "claude-home");
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  const managers: SessionManager[] = [];
  try {
    const app = repository(root, "app", "git@github.com:acme/app.git");
    const docs = repository(root, "docs", "git@github.com:acme/docs.git");
    git(docs, "branch", "fix/install-link");
    const dataDir = join(root, "data");
    const sent: RunnerToControlPlane[] = [];
    const runner = (fake: ReturnType<typeof fakeProvider>) => {
      const store = new SessionStore(join(dataDir, "sessions"));
      const manager = new SessionManager((message) => { sent.push(message); }, () => {}, store, "runner", undefined,
        fake.factory as never, dataDir, 1);
      manager.configureSharedDirectories([{ id: "app", name: "App", path: app }, { id: "docs", name: "Docs", path: docs }] as never);
      managers.push(manager);
      return { manager, store, fake };
    };
    const { manager, store, fake } = runner(fakeProvider({ failLaunch: options.failLaunch }));
    const sessionId = `s_location_${name.replaceAll("-", "_")}`;
    const driver = options.driver ?? "claude-code";
    const spec: SessionLaunchSpec = { sessionId, workspaceId: "app", workspacePath: app, agentId: driver, command: driver,
      args: [], env: {}, useWorktree: false, driver, context: { kind: "native" } };
    await manager.start(spec);
    const message = (overrides: Partial<SessionLocationSwitchMessage> = {}): SessionLocationSwitchMessage => ({
      type: "session_location_switch", requestId: "request-1", sessionId, workspaceId: "docs", workspacePath: docs,
      repository: "acme/docs", locationName: "Docs", occurrenceId: "occurrence-1", continuation: "Continue the docs fix here.",
      recoverBranch: "fix/install-link", ...overrides,
    });
    await body({ manager, store, sessionId, fake, sent, app, docs, claudeHome, dataDir, message,
      restartRunner: (next = fakeProvider()) => {
        manager.shutdownAll();
        // A crashed process's session lock goes stale; model that rather than wait a minute.
        const lock = join(dataDir, "sessions", sessionId, "lock");
        if (existsSync(lock)) utimesSync(lock, new Date(0), new Date(0));
        return runner(next);
      } });
  } finally {
    for (const manager of managers) manager.shutdownAll();
    if (previousClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeHome;
    rmSync(root, { recursive: true, force: true });
  }
}

/** One finished turn, so the session has a provider conversation to carry over. */
async function establishConversation(h: Harness): Promise<string> {
  h.manager.prompt(h.sessionId, "start the task");
  await waitFor(() => h.fake.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the first turn did not finish");
  const transcript = join(h.claudeHome, "projects", claudeProjectPathKey(h.app), "provider-session-id.jsonl");
  mkdirSync(join(h.claudeHome, "projects", claudeProjectPathKey(h.app)), { recursive: true });
  writeFileSync(transcript, "{\"type\":\"user\"}\n");
  return transcript;
}

test("an approved switch moves the live session to the target repository, keeps its conversation and continues there", async () => {
  await withSession("moves", async (h) => {
    await establishConversation(h);
    const accepted = await h.manager.requestLocationSwitch(h.message());
    assert.deepEqual(accepted, { ok: true });
    await waitFor(() => h.fake.prompts.length === 2, "the session did not continue in its new Location");
    const meta = h.store.readMeta(h.sessionId)!;
    const worktree = meta.worktrees![0]!;
    assert.equal(meta.workspaceId, "docs");
    assert.equal(meta.repoPath, h.docs);
    assert.equal(meta.worktreePath, worktree.path);
    assert.deepEqual([worktree.branch, worktree.source, worktree.branchPreexisted], ["fix/install-link", "created", true]);
    assert.equal(git(worktree.path, "rev-parse", "--abbrev-ref", "HEAD"), "fix/install-link");
    assert.equal(git(worktree.path, "rev-parse", "--path-format=absolute", "--git-common-dir"), join(h.docs, ".git"));
    // The relaunched provider works in the new worktree, with the same conversation, and the
    // continuation is its first turn there.
    assert.equal(h.fake.launches(), 2);
    assert.deepEqual(h.fake.prompts[1], { cwd: worktree.path, text: "Continue the docs fix here." });
    assert.equal(meta.agentSessionId, "provider-session-id");
    assert.ok(existsSync(join(h.claudeHome, "projects", claudeProjectPathKey(worktree.path), "provider-session-id.jsonl")),
      "the conversation is where Claude resumes it from the new working directory");
    // The earlier Location is kept with what the session owned there; no switch state remains.
    assert.deepEqual(meta.locationHistory?.map((left) => [left.workspaceId, left.repoPath, left.toWorkspaceId, left.occurrenceId]),
      [["app", h.app, "docs", "occurrence-1"]]);
    assert.equal(meta.pendingLocationSwitch, undefined);
    assert.equal(meta.locationSwitchFailure, undefined);
    const automatic = h.store.readEvents(h.sessionId).filter((event) => event.payload.kind === "user_message");
    assert.equal(automatic.length, 1, "the continuation is never shown as something a person typed");

    // Hosted review admits the switched session's pull request on the target repository's branch.
    const head = git(worktree.path, "rev-parse", "HEAD");
    const bound = await bindPullRequestScope({
      meta, request: { repository: "acme/docs", number: 12, headSha: head }, tools: { git: "git", gh: "gh" }, env: process.env,
      exec: async (command, args, options) => execFileSync(command, args, { encoding: "utf8", env: options?.env }),
      pullRequest: async () => ({ state: "open", baseRepository: "acme/docs", headRepository: "acme/docs",
        headRef: "fix/install-link", headSha: head, baseSha: head }),
    });
    assert.equal(bound.branch, "fix/install-link");
    await assert.rejects(bindPullRequestScope({
      meta, request: { repository: "acme/app", number: 3, headSha: head }, tools: { git: "git", gh: "gh" }, env: process.env,
      exec: async (command, args, options) => execFileSync(command, args, { encoding: "utf8", env: options?.env }),
      pullRequest: async () => ({ state: "open", baseRepository: "acme/app", headRepository: "acme/app",
        headRef: "fix/install-link", headSha: head, baseSha: head }),
    }), "the earlier repository's pull requests are no longer this session's");

    // Deleting the session removes the recovered worktree and keeps the person's branch.
    h.manager.stop(h.sessionId);
    await h.manager.delete(h.sessionId);
    await waitFor(() => !existsSync(worktree.path), "the recovered worktree was not removed");
    assert.equal(git(h.docs, "rev-parse", "--verify", "refs/heads/fix/install-link").length > 0, true, "the recovered branch stays");
  });
});

test("a Codex session switches too: the same thread resumes in the new working directory and continues", async () => {
  await withSession("codex", async (h) => {
    await establishConversation(h);
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.fake.prompts.length === 2, "the Codex session did not continue in its new Location");
    const meta = h.store.readMeta(h.sessionId)!;
    assert.equal(meta.repoPath, h.docs);
    assert.equal(h.fake.launches(), 2);
    assert.equal(h.fake.resumed[1], "provider-session-id", "the relaunch resumes the same Codex thread");
    assert.deepEqual(h.fake.prompts[1], { cwd: meta.worktreePath, text: "Continue the docs fix here." });
    assert.equal(meta.agentSessionId, "provider-session-id");
  }, { driver: "codex-app-server" });
});

test("a runner that stops between the move and the relaunch shows it on the session and keeps the continuation owed", async () => {
  await withSession("interrupted", async (h) => {
    await establishConversation(h);
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.fake.prompts.length === 2 && h.store.readMeta(h.sessionId)?.status === "idle", "the switch did not finish");
    const moved = h.store.readMeta(h.sessionId)!;
    // The move's single write owes the continuation; model a runner that stopped before the relaunch
    // consumed it, so the provider never started in the new Location.
    h.store.patchMeta(h.sessionId, { pendingLocationContinuation: { occurrenceId: "occurrence-1", text: "Continue the docs fix here.",
      path: moved.worktreePath!, branch: "fix/install-link", locationName: "Docs", repository: "acme/docs" } });
    h.store.flush(h.sessionId);
    const restarted = h.restartRunner();
    restarted.manager.recoverAllOrphanedWork();
    // Never silent: the session says it moved and how to continue, and it is not left looking busy.
    const noted = restarted.store.readMeta(h.sessionId)!;
    assert.equal(noted.locationSwitchFailure?.state, "failed");
    assert.match(noted.locationSwitchFailure!.reason!, /the runner restarted before it continued the task\. Send it a message/u);
    assert.notEqual(noted.status, "running");
    assert.equal(noted.repoPath, h.docs, "nothing is half-applied: the session is in its new Location");
    const snapshot = h.sent.filter((message) => message.type === "session_runtime_updated").at(-1);
    assert.equal(snapshot?.type === "session_runtime_updated" && snapshot.snapshot.locationSwitch?.state, "failed");
    assert.ok(noted.pendingLocationContinuation, "the continuation stays owed to the next launch");
    // Noting it again (a later reconnect) changes nothing.
    restarted.manager.recoverAllOrphanedWork();
    assert.equal(restarted.store.readMeta(h.sessionId)?.locationSwitchFailure?.at, noted.locationSwitchFailure!.at);
  });
});

test("a move whose relaunch fails stays visible, and the next message runs the owed continuation first, in the new Location", async () => {
  await withSession("relaunch-fails", async (h) => {
    await establishConversation(h);
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.store.readMeta(h.sessionId)?.locationSwitchFailure !== undefined, "the failed relaunch was not recorded");
    const meta = h.store.readMeta(h.sessionId)!;
    assert.equal(meta.repoPath, h.docs, "the move itself completed in one write");
    assert.match(meta.locationSwitchFailure!.reason!, /moved, but its provider could not start in the new Location; send it a message/u);
    assert.equal(meta.status, "idle", "it waits for a message rather than looking busy");
    assert.ok(meta.pendingLocationContinuation, "the continuation is still owed");
    h.manager.prompt(h.sessionId, "carry on");
    await waitFor(() => h.fake.prompts.length === 3, "the session did not continue after the next message");
    assert.deepEqual(h.fake.prompts.slice(1).map((prompt) => [prompt.cwd, prompt.text]),
      [[meta.worktreePath, "Continue the docs fix here."], [meta.worktreePath, "carry on"]]);
    assert.equal(h.store.readMeta(h.sessionId)?.pendingLocationContinuation, undefined);
  }, { failLaunch: 2 });
});

test("a switch that cannot prepare its target leaves the session where it was, visibly, and it keeps working there", async () => {
  await withSession("fails", async (h) => {
    await establishConversation(h);
    // The branch to recover is checked out elsewhere, so it is refused rather than moved.
    git(h.docs, "worktree", "add", join(h.docs, "..", "docs-busy"), "fix/install-link");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.store.readMeta(h.sessionId)?.locationSwitchFailure !== undefined, "the failure was not recorded");
    const meta = h.store.readMeta(h.sessionId)!;
    assert.equal(meta.workspaceId, "app");
    assert.equal(meta.repoPath, h.app);
    assert.equal(meta.pendingLocationSwitch, undefined);
    assert.match(meta.locationSwitchFailure!.reason!, /branch fix\/install-link is checked out in another worktree/u);
    assert.equal(h.fake.launches(), 1, "the provider was never retired for a target that could not be prepared");
    const snapshot = h.sent.filter((message) => message.type === "session_runtime_updated").at(-1);
    assert.equal(snapshot?.type === "session_runtime_updated" && snapshot.snapshot.locationSwitch?.state, "failed");
    const errors = h.store.readEvents(h.sessionId).flatMap((event) => event.payload.kind === "error" ? [event.payload.message] : []);
    assert.ok(errors.some((text) => text.startsWith("The Location switch to \"Docs\" failed")), errors.join("\n"));
    h.manager.prompt(h.sessionId, "keep going here");
    await waitFor(() => h.fake.prompts.length === 2, "the session did not keep working in its Location");
    assert.equal(h.fake.prompts[1]!.cwd, h.app);
  });
});

test("a Stop while the target is being prepared wins: nothing moves or relaunches, and the worktree is given back", async () => {
  await withSession("stop-during-prepare", async (h) => {
    await establishConversation(h);
    const worktrees = () => git(h.docs, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length;
    // Model the person's Stop landing while preparation awaits: the first readiness check that
    // finds the target worktree already checked out stops the session before answering.
    const manager = h.manager as unknown as { worktreeRebindCanProceed: (sessionId: string, entry: unknown) => boolean };
    const canProceed = manager.worktreeRebindCanProceed.bind(h.manager);
    let stopped = false;
    manager.worktreeRebindCanProceed = (sessionId, entry) => {
      if (!stopped && worktrees() > 1) {
        stopped = true;
        h.manager.stop(h.sessionId);
      }
      return canProceed(sessionId, entry);
    };
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => stopped, "the target was never prepared");
    await waitFor(() => worktrees() === 1, "the unused target worktree was not released");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const meta = h.store.readMeta(h.sessionId)!;
    assert.equal(meta.status, "stopped");
    assert.equal(meta.workspaceId, "app");
    assert.equal(meta.repoPath, h.app);
    assert.equal(meta.locationHistory, undefined);
    assert.equal(h.fake.launches(), 1, "no provider was launched for a stopped session");
    assert.equal(h.fake.prompts.length, 1);
    assert.ok(git(h.docs, "rev-parse", "--verify", "refs/heads/fix/install-link"), "the branch to recover stays");
    // The approved switch stays owed, as it is when Stop lands before preparation starts.
    assert.equal(meta.pendingLocationSwitch?.occurrenceId, "occurrence-1");
  });
});

test("a provider-initiated turn that begins during preparation defers the switch, and its settlement carries it out", async () => {
  await withSession("provider-turn-during-prepare", async (h) => {
    await establishConversation(h);
    const worktrees = () => git(h.docs, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length;
    // The provider starts a turn of its own (a background task finishing, say) while the target is
    // being prepared: the first readiness check that finds the target checked out sees it begin.
    const manager = h.manager as unknown as { worktreeRebindCanProceed: (sessionId: string, entry: unknown) => boolean };
    const canProceed = manager.worktreeRebindCanProceed.bind(h.manager);
    let started = false;
    manager.worktreeRebindCanProceed = (sessionId, entry) => {
      if (!started && worktrees() > 1) {
        started = true;
        h.fake.callbacks[0]!.onProviderInitiatedTurn?.("started", "provider-turn-1");
      }
      return canProceed(sessionId, entry);
    };
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => started, "the target was never prepared");
    await waitFor(() => worktrees() === 1, "the deferred switch did not give its worktree back");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(h.store.readMeta(h.sessionId)?.repoPath, h.app, "nothing moves while the provider's own turn runs");
    assert.equal(h.fake.launches(), 1);
    // Settling the provider's turn, with nothing else happening, carries the switch out.
    h.fake.callbacks[0]!.onProviderInitiatedTurn?.("settled", "provider-turn-1");
    await waitFor(() => h.fake.prompts.length === 2, "the switch did not run after the provider's turn settled");
    const meta = h.store.readMeta(h.sessionId)!;
    assert.equal(meta.repoPath, h.docs);
    assert.equal(meta.pendingLocationSwitch, undefined);
    assert.deepEqual(h.fake.prompts[1], { cwd: meta.worktreePath, text: "Continue the docs fix here." });
  });
});

test("the runner re-verifies everything it was asked to switch to before accepting", async () => {
  await withSession("refusals", async (h) => {
    await establishConversation(h);
    const refused = async (overrides: Partial<SessionLocationSwitchMessage>) => (await h.manager.requestLocationSwitch(h.message(overrides))).error;
    assert.equal(await refused({ workspaceId: "unknown" }), LOCATION_SWITCH_FAILURES.unknown_workspace);
    assert.equal(await refused({ workspacePath: h.app }), LOCATION_SWITCH_FAILURES.path_changed);
    assert.equal(await refused({ repository: "acme/other" }), LOCATION_SWITCH_FAILURES.repository_changed);
    assert.equal(await refused({ workspaceId: "app", workspacePath: h.app, repository: "acme/app" }), LOCATION_SWITCH_FAILURES.same_repository);
    assert.match((await refused({ recoverBranch: "-bad" }))!, /not a valid branch name/u);
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch: undefined, occurrenceId: "occurrence-2" })), { ok: true });
    assert.equal(await refused({ occurrenceId: "occurrence-3" }), LOCATION_SWITCH_FAILURES.busy, "one switch at a time");
    assert.equal(h.store.readMeta(h.sessionId)?.pendingLocationSwitch?.occurrenceId, "occurrence-2");
  });
});

test("an origin names a repository the way the control plane's inspection reports it", () => {
  assert.equal(originNamesRepository("git@github.com:Acme/Docs.git", "acme/docs"), true);
  assert.equal(originNamesRepository("https://github.com/acme/docs", "acme/docs"), true);
  assert.equal(originNamesRepository("https://github.com/acme/docs-fork", "acme/docs"), false);
  assert.equal(originNamesRepository("git@gitlab.example.com:group/sub/docs.git", "gitlab.example.com/group/sub/docs"), true);
  assert.equal(originNamesRepository("/local/path", "acme/docs"), false);
});

test("a conversation is copied into the new working directory's project and its source is left alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-location-transcript-"));
  try {
    const projects = join(root, "projects");
    const source = join(projects, claudeProjectPathKey("/src/app"));
    mkdirSync(join(source, "conv"), { recursive: true });
    writeFileSync(join(source, "conv.jsonl"), "history\n");
    writeFileSync(join(source, "conv", "agent.jsonl"), "subagent\n");
    assert.equal(await moveClaudeTranscriptToCwd([join(root, "missing"), projects], "conv", "/src/app", "/src/docs/worktree"), true);
    const target = join(projects, claudeProjectPathKey("/src/docs/worktree"));
    assert.equal(readFileSync(join(target, "conv.jsonl"), "utf8"), "history\n");
    assert.equal(readFileSync(join(target, "conv", "agent.jsonl"), "utf8"), "subagent\n");
    assert.equal(readFileSync(join(source, "conv.jsonl"), "utf8"), "history\n");
    assert.equal(await moveClaudeTranscriptToCwd([projects], "conv", "/src/docs/worktree", "/src/docs/worktree"), true, "already in place");
    assert.equal(await moveClaudeTranscriptToCwd([projects], "other", "/src/app", "/src/docs/worktree"), false);
    await assert.rejects(moveClaudeTranscriptToCwd([projects], "../conv", "/src/app", "/x"), /unsafe/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a session that moves again carries its latest conversation, including back to a Location it left", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-location-transcript-again-"));
  try {
    const projects = join(root, "projects");
    const transcript = (cwd: string) => join(projects, claudeProjectPathKey(cwd), "conv.jsonl");
    mkdirSync(join(projects, claudeProjectPathKey("/src/a")), { recursive: true });
    writeFileSync(transcript("/src/a"), "turn 1\n");
    // A to B, then a turn in B.
    assert.equal(await moveClaudeTranscriptToCwd([projects], "conv", "/src/a", "/src/b"), true);
    writeFileSync(transcript("/src/b"), "turn 1\nturn 2 in b\n");
    // B to C: A's older copy does not make the move ambiguous, and C gets B's history.
    assert.equal(await moveClaudeTranscriptToCwd([projects], "conv", "/src/b", "/src/c"), true);
    assert.equal(readFileSync(transcript("/src/c"), "utf8"), "turn 1\nturn 2 in b\n");
    writeFileSync(transcript("/src/c"), "turn 1\nturn 2 in b\nturn 3 in c\n");
    // C back to A: A's stale copy is replaced by the latest history.
    assert.equal(await moveClaudeTranscriptToCwd([projects], "conv", "/src/c", "/src/a"), true);
    assert.equal(readFileSync(transcript("/src/a"), "utf8"), "turn 1\nturn 2 in b\nturn 3 in c\n");
    // Earlier copies stay where they were saved.
    assert.equal(readFileSync(transcript("/src/b"), "utf8"), "turn 1\nturn 2 in b\n");
    // Several copies and none where the session last ran is refused rather than guessed.
    await assert.rejects(moveClaudeTranscriptToCwd([projects], "conv", "/src/elsewhere", "/src/d"), /none where the session last ran/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
