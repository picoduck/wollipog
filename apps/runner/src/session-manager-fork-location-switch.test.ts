import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunnerToControlPlane } from "@wollipog/protocol";
import type { DriverCallbacks } from "./drivers/driver.js";
import { captureWorktreeTree } from "./git-ops.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";
import { createWorktree } from "./worktree.js";

// An approved Location switch is the session's its person approved it for (#4138). A fork of that
// session starts where the source is, and neither carries out, shows nor resumes the source's switch.

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

/** A repository with one commit. Only a switch's target needs an origin, which names its repository:
 * creating a worktree fetches a repository's origin, and an unreachable one costs that fetch's timeout. */
function repository(root: string, name: string, origin?: string): string {
  const path = join(root, name);
  mkdirSync(path);
  git(path, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(path, "file.txt"), "base");
  git(path, "add", ".");
  git(path, "commit", "--quiet", "-m", "base");
  if (origin) git(path, "remote", "add", "origin", origin);
  return realpathSync(path);
}

/** A provider whose every process answers prompts at once and forks to its own thread. */
function fakeProvider() {
  const prompts: Array<{ cwd: string; text: string }> = [];
  const factory = (_driver: unknown, launch: { cwd: string }, cb: DriverCallbacks) => ({
    pid: 1, newSession: async () => {}, close: async () => {}, initialize: async () => {},
    forkSession: async () => "thread-forked",
    prompt: async (text: string) => {
      prompts.push({ cwd: launch.cwd, text });
      cb.onPromptAccepted?.();
      cb.onEvent({ kind: "agent_message", text: "done", final: true });
      return "end_turn" as const;
    },
    cancel: () => {}, dispose: () => {}, setConfig: () => {}, resolvePermission: () => false,
    agentSessionId: () => "thread-forked",
  });
  return { factory, prompts };
}

interface Fixture {
  manager: SessionManager;
  store: SessionStore;
  source: SessionMeta;
  app: string;
  docs: string;
  fake: ReturnType<typeof fakeProvider>;
  sent: RunnerToControlPlane[];
}

async function withSource(name: string, body: (f: Fixture) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `wollipog-fork-location-${name}-`)));
  const sent: RunnerToControlPlane[] = [];
  const fake = fakeProvider();
  const store = new SessionStore(join(root, "sessions"));
  const manager = new SessionManager((message) => { sent.push(message); }, () => {}, store, "runner", undefined,
    fake.factory as never, root);
  try {
    const app = repository(root, "app");
    const docs = repository(root, "docs", "git@github.com:acme/docs.git");
    git(docs, "branch", "fix/install-link");
    manager.configureSharedDirectories([{ id: "app", name: "App", path: app }, { id: "docs", name: "Docs", path: docs }] as never);
    const sessionId = `s_${name.replaceAll("-", "_")}_source`;
    const sourceWorktree = await createWorktree(app, sessionId, { dataDir: root });
    writeFileSync(join(sourceWorktree.path, "file.txt"), "checkpoint");
    const tree = await captureWorktreeTree(sourceWorktree.path);
    const baseCommit = git(sourceWorktree.path, "rev-parse", "HEAD");
    const source: SessionMeta = {
      sessionId, agentId: "codex-native", workspaceId: "app", repoPath: app,
      worktreePath: sourceWorktree.path, worktreeBranch: sourceWorktree.branch, driver: "codex-app-server",
      command: "codex", args: [], env: {}, context: { kind: "native" }, agentSessionId: "thread-source",
      status: "idle", title: "Source", config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null,
      pendingApproval: null, turnCount: 1, seq: 0, createdAt: 1, updatedAt: 1, keptWorktreesTracked: true,
      forkPoints: { "1": { agentTurnId: "turn-1", tree, baseCommit, eventSeq: 3 } },
    };
    store.create(source);
    store.appendEvent(sessionId, { kind: "user_message", text: "fix the install link", final: true });
    store.appendEvent(sessionId, { kind: "conversation_checkpoint", turn: 1 });
    store.flush(sessionId);
    await body({ manager, store, source, app, docs, fake, sent });
  } finally {
    manager.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
}

/** The source's approved switch, accepted by this runner and waiting for its next turn boundary. */
const pendingSwitch = (docs: string) => ({
  requestId: "request-1", occurrenceId: "occurrence-source", workspaceId: "docs", repoPath: docs,
  repository: "acme/docs", locationName: "Docs", continuation: "Your person approved moving this session.",
  recoverBranch: "fix/install-link", requestedAt: 1,
});

test("a fork never carries out its source's approved Location switch: it starts, and stays, where the source is", async () => {
  if (process.platform === "win32") return;
  await withSource("pending", async (f) => {
    f.store.patchMeta(f.source.sessionId, { pendingLocationSwitch: pendingSwitch(f.docs) });
    f.store.flush(f.source.sessionId);
    const result = await f.manager.forkConversation(f.source.sessionId, "s_fork_target", 1, "Fork");
    assert.equal(result.ok, true, result.error ?? "the fork failed");
    const forked = f.store.readMeta("s_fork_target")!;
    assert.equal(forked.pendingLocationSwitch, undefined, "the source's approval is not the fork's to carry out");
    assert.equal(result.snapshot?.locationSwitch ?? null, null, "and the fork shows no switch in progress");
    assert.equal(forked.workspaceId, "app");

    // Its first message launches it where it is, and nothing moves it. On a runner that copied the
    // switch, this launch moved the fork into acme/docs on the person's fix/install-link branch and
    // told it its person had approved that, before it answered.
    f.manager.prompt("s_fork_target", "go on");
    await waitFor(() => f.fake.prompts.some((prompt) => prompt.text === "go on") &&
      f.store.readMeta("s_fork_target")?.status === "idle", "the fork did not answer its message");
    const after = f.store.readMeta("s_fork_target")!;
    assert.deepEqual([after.workspaceId, after.repoPath, after.worktreePath, after.locationHistory],
      ["app", f.app, forked.worktreePath, undefined], "the fork is still in the source's Location, in its own worktree");
    assert.deepEqual(f.fake.prompts.map((prompt) => [prompt.cwd, prompt.text]), [[forked.worktreePath, "go on"]],
      "its only turn is its person's message, there, and it was never told it moved");
    assert.equal(after.locationSwitchFailure, undefined);
    assert.ok(!f.sent.some((message) => message.type === "session_runtime_updated" && message.snapshot.id === "s_fork_target" &&
      message.snapshot.locationSwitch), "the control plane is never told the fork is switching");
    assert.ok(!git(f.docs, "worktree", "list", "--porcelain").includes("fix/install-link"),
      "and the person's branch in the other repository is checked out nowhere");
    // The source still holds its own approved switch.
    assert.equal(f.store.readMeta(f.source.sessionId)?.pendingLocationSwitch?.occurrenceId, "occurrence-source");
  });
});

test("a fork inherits neither the continuation its source's move owes nor the source's failed switch", async () => {
  if (process.platform === "win32") return;
  await withSource("owed", async (f) => {
    f.store.patchMeta(f.source.sessionId, {
      pendingLocationContinuation: { occurrenceId: "occurrence-source", text: "Your person approved moving this session.",
        path: f.source.worktreePath!, branch: f.source.worktreeBranch!, locationName: "App", repository: "acme/app" },
      locationSwitchFailure: { state: "failed", repository: "acme/docs", workspaceId: "docs", locationName: "Docs",
        reason: "the target worktree could not be prepared", at: 1 },
    });
    f.store.flush(f.source.sessionId);
    const result = await f.manager.forkConversation(f.source.sessionId, "s_fork_target", 1, "Fork");
    assert.equal(result.ok, true, result.error ?? "the fork failed");
    const forked = f.store.readMeta("s_fork_target")!;
    assert.equal(forked.pendingLocationContinuation, undefined, "the fork owes no move's turn");
    assert.equal(forked.locationSwitchFailure, undefined, "and shows no switch of its own that failed");
    assert.equal(result.snapshot?.locationSwitch ?? null, null);
    const source = f.store.readMeta(f.source.sessionId)!;
    assert.equal(source.pendingLocationContinuation?.occurrenceId, "occurrence-source", "the source keeps what is its own");
    assert.equal(source.locationSwitchFailure?.locationName, "Docs");
  });
});
