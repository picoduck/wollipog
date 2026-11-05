import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import type { RunnerToControlPlane, SessionLaunchSpec, SessionLocationSwitchMessage } from "@wollipog/protocol";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

function fakeProvider() {
  const prompts: Array<{ cwd: string; text: string }> = [];
  let launches = 0;
  const factory = (_driver: unknown, launch: { cwd: string }, cb: DriverCallbacks) => {
    launches++;
    return {
      pid: launches, initialize: async () => {}, newSession: async () => {}, close: async () => {},
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
  return { factory, prompts, launches: () => launches };
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
  message: (overrides?: Partial<SessionLocationSwitchMessage>) => SessionLocationSwitchMessage;
}

async function withSession(name: string, body: (h: Harness) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `wollipog-location-switch-${name}-`));
  const previousClaudeHome = process.env.CLAUDE_CONFIG_DIR;
  const claudeHome = join(root, "claude-home");
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  let manager: SessionManager | undefined;
  try {
    const app = repository(root, "app", "git@github.com:acme/app.git");
    const docs = repository(root, "docs", "git@github.com:acme/docs.git");
    git(docs, "branch", "fix/install-link");
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    const sent: RunnerToControlPlane[] = [];
    const fake = fakeProvider();
    manager = new SessionManager((message) => { sent.push(message); }, () => {}, store, "runner", undefined,
      fake.factory as never, dataDir, 1);
    manager.configureSharedDirectories([{ id: "app", name: "App", path: app }, { id: "docs", name: "Docs", path: docs }] as never);
    const sessionId = `s_location_${name.replaceAll("-", "_")}`;
    const spec: SessionLaunchSpec = { sessionId, workspaceId: "app", workspacePath: app, agentId: "claude", command: "claude",
      args: [], env: {}, useWorktree: false, driver: "claude-code", context: { kind: "native" } };
    await manager.start(spec);
    const message = (overrides: Partial<SessionLocationSwitchMessage> = {}): SessionLocationSwitchMessage => ({
      type: "session_location_switch", requestId: "request-1", sessionId, workspaceId: "docs", workspacePath: docs,
      repository: "acme/docs", locationName: "Docs", occurrenceId: "occurrence-1", continuation: "Continue the docs fix here.",
      recoverBranch: "fix/install-link", ...overrides,
    });
    await body({ manager, store, sessionId, fake, sent, app, docs, claudeHome, message });
  } finally {
    manager?.shutdownAll();
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
    assert.equal(await moveClaudeTranscriptToCwd([join(root, "missing"), projects], "conv", "/src/docs/worktree"), true);
    const target = join(projects, claudeProjectPathKey("/src/docs/worktree"));
    assert.equal(readFileSync(join(target, "conv.jsonl"), "utf8"), "history\n");
    assert.equal(readFileSync(join(target, "conv", "agent.jsonl"), "utf8"), "subagent\n");
    assert.equal(readFileSync(join(source, "conv.jsonl"), "utf8"), "history\n");
    assert.equal(await moveClaudeTranscriptToCwd([projects], "conv", "/src/docs/worktree"), true, "already in place");
    assert.equal(await moveClaudeTranscriptToCwd([projects], "other", "/src/docs/worktree"), false);
    await assert.rejects(moveClaudeTranscriptToCwd([projects], "../conv", "/x"), /unsafe/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
