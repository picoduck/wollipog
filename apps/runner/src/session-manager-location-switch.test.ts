import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import type { RunnerToControlPlane, SessionLaunchSpec, SessionLocationSwitchMessage } from "@wollipog/protocol";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync,
  writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeProjectPathKey } from "./claude-background-work.js";
import type { DriverCallbacks } from "./drivers/driver.js";
import { LOCATION_SWITCH_FAILURES, moveClaudeTranscriptToCwd, originNamesRepository } from "./location-switch.js";
import { bindPullRequestScope } from "./review-snapshot.js";
import { buildCodexTurnParams } from "./drivers/codex-app-server.js";
import { managedWorktreeLaunchRefusal } from "./execution-isolation.js";
import { commandTargetsManagedWorktree } from "./managed-worktree-protection.js";
import { reusedWorktreeNotice, SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";
import { nativePathSpelling, parseWorktreePorcelain, recoveredBranchPlacement, sameWorktreePath } from "./worktree.js";

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

test("a Codex session continuing in a reused worktree can commit there, and the guard and veto protect it", async () => {
  await withSession("codex-reuse", async (h) => {
    await establishConversation(h);
    const busy = busyWorktree(h);
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.fake.prompts.length === 2, "the Codex session did not continue in the reused worktree");
    const meta = h.store.readMeta(h.sessionId)!;
    assert.equal(meta.worktreePath, busy);
    assert.equal(h.fake.resumed[1], "provider-session-id");
    // The reused worktree is one of the session's managed worktrees, for the sandbox and the guard.
    const protections = h.manager.managedWorktreeProtections(meta);
    assert.deepEqual(protections.map((protection) => protection.worktreePath), [busy]);
    assert.deepEqual(h.manager.managedWorktreeGuardProtections(meta).map((protection) => protection.worktreePath), [busy]);
    // Codex gets the worktree's own Git administration as writable roots, so `git add` and
    // `git commit` work without an escalation, and full access narrows so the veto stays enforceable.
    const params = buildCodexTurnParams({ permissionMode: "danger-full-access" } as never, "thread", busy, [], undefined,
      protections) as { approvalPolicy: string; sandboxPolicy: { type: string; writableRoots?: string[] } };
    const admin = git(busy, "rev-parse", "--absolute-git-dir");
    assert.equal(params.sandboxPolicy.type, "workspaceWrite");
    assert.equal(params.approvalPolicy, "on-request");
    assert.ok(params.sandboxPolicy.writableRoots?.includes(busy));
    assert.ok(params.sandboxPolicy.writableRoots?.includes(admin), JSON.stringify(params.sandboxPolicy));
    // The driver's veto refuses removing the person's worktree.
    assert.notEqual(commandTargetsManagedWorktree(`git worktree remove --force ${busy}`, busy, protections), null);
    assert.notEqual(commandTargetsManagedWorktree(`rm -rf ${busy}`, h.docs, protections), null);
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
    // The branch to recover is checked out in the Location's own checkout, where a session never
    // works, so it is refused rather than moved.
    git(h.docs, "checkout", "--quiet", "fix/install-link");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.store.readMeta(h.sessionId)?.locationSwitchFailure !== undefined, "the failure was not recorded");
    const meta = h.store.readMeta(h.sessionId)!;
    assert.equal(meta.workspaceId, "app");
    assert.equal(meta.repoPath, h.app);
    assert.equal(meta.pendingLocationSwitch, undefined);
    assert.match(meta.locationSwitchFailure!.reason!, /branch fix\/install-link is checked out in the Location's primary checkout/u);
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

/** Check the branch to recover out in a worktree of its own, beside the docs checkout, with work in
 * it that was never committed: a modified file, a staged new file and an untracked one. */
function busyWorktree(h: Harness): string {
  const busy = join(h.docs, "..", "docs-busy");
  git(h.docs, "worktree", "add", "--quiet", busy, "fix/install-link");
  writeFileSync(join(busy, "README.md"), "v1\n");
  git(busy, "add", "README.md");
  git(busy, "commit", "--quiet", "-m", "readme");
  writeFileSync(join(busy, "README.md"), "v2, edited but never committed\n");
  writeFileSync(join(busy, "staged.txt"), "staged only\n");
  git(busy, "add", "staged.txt");
  writeFileSync(join(busy, "notes.txt"), "untracked notes\n");
  return realpathSync(busy);
}

/** Every file in a worktree, byte for byte. */
function files(root: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(out, files(root, path));
    else out[path] = readFileSync(join(root, path)).toString("base64");
  }
  return out;
}

test("an existing worktree nothing holds is reused in place: its uncommitted work stays byte for byte and its pull request is reviewable", async () => {
  await withSession("reuse", async (h) => {
    await establishConversation(h);
    const busy = busyWorktree(h);
    const before = files(busy);
    const status = git(busy, "status", "--porcelain=v1", "--untracked-files=all");
    const head = git(busy, "rev-parse", "HEAD");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.fake.prompts.length === 2, "the session did not continue in the existing worktree");
    const meta = h.store.readMeta(h.sessionId)!;
    assert.equal(meta.locationSwitchFailure, undefined);
    assert.equal(meta.repoPath, h.docs);
    assert.equal(meta.worktreePath, busy, "the session continues in the worktree that already had the branch");
    assert.deepEqual(meta.worktrees?.map((worktree) => [worktree.path, worktree.branch, worktree.source, worktree.reusedInPlace]),
      [[busy, "fix/install-link", "attached", true]]);
    // What the agent reads first says it is in an existing worktree whose changes are not its own.
    assert.deepEqual(h.fake.prompts[1], { cwd: busy,
      text: `${reusedWorktreeNotice(busy, "fix/install-link", 3)}\n\nContinue the docs fix here.` });
    assert.match(h.fake.prompts[1]!.text, /It holds 3 uncommitted changes that this session did not make\./u);
    assert.match(h.fake.prompts[1]!.text, /never discard them \(git reset --hard/u);
    // The switch's claim ends once the session's own record holds the worktree.
    await waitFor(() => (h.manager as unknown as { reusedWorktreeClaims: Map<string, string> }).reusedWorktreeClaims.size === 0,
      "the claim outlived the move");
    // Nothing in it moved: the same files, bytes, branch, commit and uncommitted state.
    assert.deepEqual(files(busy), before);
    assert.equal(git(busy, "rev-parse", "--abbrev-ref", "HEAD"), "fix/install-link");
    assert.equal(git(busy, "rev-parse", "HEAD"), head);
    assert.equal(git(busy, "status", "--porcelain=v1", "--untracked-files=all"), status);
    const notices = h.store.readEvents(h.sessionId).flatMap((event) => event.payload.kind === "stderr" ? [event.payload.text] : []);
    assert.ok(notices.includes(`Moved this session to Location "Docs" (acme/docs). It continues on fix/install-link in the existing ` +
      `worktree ${busy}, as it was, with its 3 uncommitted changes kept.`), notices.join("\n"));
    // It keeps the boundary a new worktree would have had.
    const sandbox = h.manager as unknown as { requiresManagedWorktreeBwrap: (meta: unknown) => boolean };
    assert.equal(sandbox.requiresManagedWorktreeBwrap(meta), process.platform === "linux");

    // Hosted review admits the pull request of the reused branch, proving the registration again.
    const review = (state: typeof meta) => bindPullRequestScope({
      meta: state, request: { repository: "acme/docs", number: 12, headSha: head }, tools: { git: "git", gh: "gh" }, env: process.env,
      exec: async (command, args, options) => execFileSync(command, args, { encoding: "utf8", env: options?.env }),
      pullRequest: async () => ({ state: "open", baseRepository: "acme/docs", headRepository: "acme/docs",
        headRef: "fix/install-link", headSha: head, baseSha: head }),
    });
    assert.equal((await review(meta)).branch, "fix/install-link");
    // An attached worktree without the runner's mark stays outside hosted review.
    await assert.rejects(review({ ...meta, worktrees: meta.worktrees!.map((worktree) => ({ ...worktree, reusedInPlace: undefined })) }),
      /the session's own native managed worktree/u);
    // The registration is proven again at review time: once the worktree is on another branch, the
    // runner's record of it no longer admits the branch's pull request.
    git(busy, "switch", "--quiet", "-c", "elsewhere");
    await assert.rejects(review(meta), /no longer registered on this session's expected branch/u);
    git(busy, "switch", "--quiet", "fix/install-link");
    git(h.docs, "branch", "-D", "elsewhere");

    // Deleting the session leaves the person's worktree, and everything in it, where it was.
    h.manager.stop(h.sessionId);
    await h.manager.delete(h.sessionId);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(files(busy), before);
    assert.equal(git(busy, "rev-parse", "--abbrev-ref", "HEAD"), "fix/install-link");
  });
});

test("a worktree another session holds is refused with that session named, and nothing in it changes", async () => {
  await withSession("held", async (h) => {
    await establishConversation(h);
    const busy = busyWorktree(h);
    const before = files(busy);
    const holder = "s_location_holder";
    // Another session of the docs Location, running, with the worktree attached: a runner record.
    h.store.create({ ...h.store.readMeta(h.sessionId)!, sessionId: holder, workspaceId: "docs", repoPath: h.docs, status: "running",
      agentSessionId: null, worktreePath: busy, worktreeBranch: "fix/install-link",
      worktrees: [{ id: "held", path: busy, branch: "fix/install-link", source: "attached" }] });
    h.store.flush(holder);
    const failure = async (occurrenceId: string) => {
      assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ occurrenceId })), { ok: true });
      await waitFor(() => !h.store.readMeta(h.sessionId)?.pendingLocationSwitch && !!h.store.readMeta(h.sessionId)?.locationSwitchFailure,
        "the refusal was not recorded");
      return h.store.readMeta(h.sessionId)!.locationSwitchFailure!.reason!;
    };
    assert.equal(await failure("occurrence-1"), "the target worktree could not be prepared: branch fix/install-link is checked out in " +
      `worktree ${busy}, which session ${holder} is using; continue the task in that session instead, so the work and its pull request stay with it`);
    // A stopped holder still owns it: its record would remove or reuse it later.
    h.store.patchMeta(holder, { status: "stopped" });
    h.store.flush(holder);
    assert.match(await failure("occurrence-2"), new RegExp(`worktree ${busy}, which session ${holder} still owns although it is not running`, "u"));
    // Another switch that chose the worktree and has not recorded it yet holds it too.
    h.store.remove(holder);
    const claims = (h.manager as unknown as { reusedWorktreeClaims: Map<string, string> }).reusedWorktreeClaims;
    claims.set(busy, "s_location_racing");
    assert.match(await failure("occurrence-3"), new RegExp(`worktree ${busy}, which session s_location_racing is using`, "u"));
    claims.clear();
    const meta = h.store.readMeta(h.sessionId)!;
    assert.equal(meta.repoPath, h.app, "the session stays where it was");
    assert.deepEqual(files(busy), before);
  });
});

test("two switches racing for one worktree: the one that claims it first wins, and the other is refused naming it", async () => {
  await withSession("race", async (h) => {
    await establishConversation(h);
    const busy = busyWorktree(h);
    const before = files(busy);
    // This switch passes its first holder check; while it is still verifying the worktree, another
    // session's switch gets there first and claims it (as its own final check would).
    const runner = h.manager as unknown as {
      worktreeHolder: (sessionId: string, context: unknown, path: string) => unknown;
      reusedWorktreeClaims: Map<string, string>;
    };
    const holder = runner.worktreeHolder.bind(h.manager);
    let raced = false;
    runner.worktreeHolder = (sessionId, context, path) => {
      const found = holder(sessionId, context, path);
      if (!raced) {
        raced = true;
        setImmediate(() => runner.reusedWorktreeClaims.set(busy, "s_location_winner"));
      }
      return found;
    };
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.store.readMeta(h.sessionId)?.locationSwitchFailure !== undefined, "the losing switch was not refused");
    const meta = h.store.readMeta(h.sessionId)!;
    assert.equal(raced, true);
    assert.match(meta.locationSwitchFailure!.reason!, new RegExp(`worktree ${busy}, which session s_location_winner took while it was ` +
      "being verified; continue the task in that session instead", "u"));
    assert.equal(meta.repoPath, h.app, "the loser stays where it was");
    assert.equal(h.fake.launches(), 1, "the loser's provider was never retired");
    assert.equal(runner.reusedWorktreeClaims.get(busy), "s_location_winner", "the loser never releases the winner's claim");
    assert.deepEqual(files(busy), before);
  });
});

test("a registered worktree reached through a symbolic link, or whose .git names another worktree, is refused", async () => {
  await withSession("redirected", async (h) => {
    await establishConversation(h);
    const busy = busyWorktree(h);
    const failure = async (occurrenceId: string) => {
      assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ occurrenceId })), { ok: true });
      await waitFor(() => !h.store.readMeta(h.sessionId)?.pendingLocationSwitch && !!h.store.readMeta(h.sessionId)?.locationSwitchFailure,
        "the refusal was not recorded");
      return h.store.readMeta(h.sessionId)!.locationSwitchFailure!.reason!;
    };
    // The registered path is now a link to the real directory: what was checked must be what is used.
    renameSync(busy, `${busy}-real`);
    symlinkSync(`${busy}-real`, busy);
    assert.match(await failure("occurrence-1"), /which could not be verified as this Location's repository: its registered path is not its real path/u);
    rmSync(busy);
    renameSync(`${busy}-real`, busy);
    // Its .git link names another worktree's admin directory of the same repository: the Git
    // directory is shared, but the branch and index are someone else's.
    const other = join(h.docs, "..", "docs-other");
    git(h.docs, "worktree", "add", "--quiet", "-b", "other-work", other);
    const before = files(busy);
    const otherGitDir = git(other, "rev-parse", "--absolute-git-dir");
    writeFileSync(join(busy, ".git"), `gitdir: ${otherGitDir}\n`);
    assert.match(await failure("occurrence-2"), /the directory does not have that branch checked out as its own worktree/u);
    assert.equal(h.store.readMeta(h.sessionId)!.repoPath, h.app);
    assert.equal(h.fake.launches(), 1, "the provider was never retired");
    assert.deepEqual(Object.keys(files(busy)).sort(), Object.keys(before).sort());
  });
});

test("a worktree whose files no longer belong to the target Location's repository is refused and left alone", async () => {
  await withSession("foreign", async (h) => {
    await establishConversation(h);
    const busy = busyWorktree(h);
    // The docs repository still registers the path on the branch, but the directory now resolves to
    // another repository.
    writeFileSync(join(busy, ".git"), `gitdir: ${join(h.app, ".git")}\n`);
    const before = files(busy);
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.store.readMeta(h.sessionId)?.locationSwitchFailure !== undefined, "the refusal was not recorded");
    const meta = h.store.readMeta(h.sessionId)!;
    assert.match(meta.locationSwitchFailure!.reason!, new RegExp(`branch fix/install-link is checked out in worktree ${busy}, which could ` +
      "not be verified as this Location's repository: registered worktree belongs to a different repository than the session", "u"));
    assert.equal(meta.repoPath, h.app);
    assert.equal(h.fake.launches(), 1, "the provider was never retired");
    assert.deepEqual(files(busy), before);
  });
});

test("a switch deferred after choosing a clean existing worktree gives nothing back: the worktree stays on disk", async () => {
  await withSession("reuse-deferred", async (h) => {
    await establishConversation(h);
    // Clean, so `git worktree remove` would succeed on it if the switch tried to give it back.
    const clean = join(h.docs, "..", "docs-clean");
    git(h.docs, "worktree", "add", "--quiet", clean, "fix/install-link");
    const path = realpathSync(clean);
    const before = files(path);
    // A Stop lands while the switch has the worktree chosen and claimed, before anything moves.
    const runner = h.manager as unknown as {
      worktreeRebindCanProceed: (sessionId: string, entry: unknown) => boolean;
      reusedWorktreeClaims: Map<string, string>;
    };
    const canProceed = runner.worktreeRebindCanProceed.bind(h.manager);
    let stopped = false;
    runner.worktreeRebindCanProceed = (sessionId, entry) => {
      if (!stopped && runner.reusedWorktreeClaims.has(path)) {
        stopped = true;
        h.manager.stop(h.sessionId);
      }
      return canProceed(sessionId, entry);
    };
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => stopped, "the switch never chose the existing worktree");
    await waitFor(() => runner.reusedWorktreeClaims.size === 0, "the deferred switch kept its claim");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(h.store.readMeta(h.sessionId)?.repoPath, h.app, "nothing moved");
    assert.equal(h.fake.launches(), 1);
    assert.ok(existsSync(path), "the person's worktree was removed");
    assert.deepEqual(files(path), before);
    assert.match(git(h.docs, "worktree", "list", "--porcelain"), new RegExp(`worktree ${path}\\n`, "u"));
  });
});

test("a reused worktree and its mark survive a runner restart, and the session keeps working there", async () => {
  await withSession("reuse-restart", async (h) => {
    await establishConversation(h);
    const busy = busyWorktree(h);
    const before = files(busy);
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.fake.prompts.length === 2 && h.store.readMeta(h.sessionId)?.status === "idle",
      "the session did not continue in the reused worktree");
    const restarted = h.restartRunner();
    restarted.manager.recoverAllOrphanedWork();
    const meta = restarted.store.readMeta(h.sessionId)!;
    assert.equal(meta.worktreePath, busy);
    assert.deepEqual(meta.worktrees?.map((worktree) => [worktree.path, worktree.source, worktree.reusedInPlace]),
      [[busy, "attached", true]]);
    // The restarted runner still protects it as the session's own, sandboxes it as one it created,
    // and admits the branch's pull request to hosted review.
    assert.deepEqual(restarted.manager.managedWorktreeProtections(meta).map((protection) => protection.worktreePath), [busy]);
    const sandbox = restarted.manager as unknown as { requiresManagedWorktreeBwrap: (meta: unknown) => boolean };
    assert.equal(sandbox.requiresManagedWorktreeBwrap(meta), process.platform === "linux");
    const head = git(busy, "rev-parse", "HEAD");
    const bound = await bindPullRequestScope({
      meta, request: { repository: "acme/docs", number: 12, headSha: head }, tools: { git: "git", gh: "gh" }, env: process.env,
      exec: async (command, args, options) => execFileSync(command, args, { encoding: "utf8", env: options?.env }),
      pullRequest: async () => ({ state: "open", baseRepository: "acme/docs", headRepository: "acme/docs",
        headRef: "fix/install-link", headSha: head, baseSha: head }),
    });
    assert.equal(bound.branch, "fix/install-link");
    // Deleting the session through the restarted runner still leaves the person's worktree alone.
    restarted.manager.stop(h.sessionId);
    await restarted.manager.delete(h.sessionId);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(files(busy), before);
    assert.equal(git(busy, "rev-parse", "--abbrev-ref", "HEAD"), "fix/install-link");
  });
});

test("a worktree directly in the temporary directory is refused before the provider is retired or anything moves",
  { skip: process.platform !== "linux" && "the managed bubblewrap boundary applies on native Linux only" }, async () => {
  await withSession("reuse-tmp", async (h) => {
    await establishConversation(h);
    const temporary = realpathSync(tmpdir());
    const placed = join(temporary, `wollipog-location-reuse-${process.pid}-${Date.now()}`);
    git(h.docs, "worktree", "add", "--quiet", placed, "fix/install-link");
    try {
      writeFileSync(join(placed, "notes.txt"), "kept\n");
      const before = files(placed);
      assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
      await waitFor(() => h.store.readMeta(h.sessionId)?.locationSwitchFailure !== undefined, "the refusal was not recorded");
      const meta = h.store.readMeta(h.sessionId)!;
      assert.equal(meta.locationSwitchFailure!.reason, "the target worktree could not be prepared: branch fix/install-link is " +
        `checked out in worktree ${placed}, which this session cannot continue in: it sits directly in the temporary directory ` +
        `${temporary}, where the session's sandbox cannot protect it; move that worktree (git worktree move) or switch it to ` +
        "another branch, then ask again");
      assert.equal(meta.repoPath, h.app, "nothing moved");
      assert.equal(h.fake.launches(), 1, "the provider was never retired");
      assert.equal((h.manager as unknown as { reusedWorktreeClaims: Map<string, string> }).reusedWorktreeClaims.size, 0);
      assert.deepEqual(files(placed), before);
    } finally {
      git(h.docs, "worktree", "remove", "--force", placed);
    }
  });
});

test("the reuse check refuses exactly the placements the managed boundary's launch refuses", () => {
  const tmp = ["/tmp"];
  assert.match(managedWorktreeLaunchRefusal("/tmp/docs-wt", "/src/docs/.git", [], tmp)!, /directly in the temporary directory \/tmp/u);
  assert.equal(managedWorktreeLaunchRefusal("/tmp/work/docs-wt", "/src/docs/.git", [], tmp), null);
  // As at launch, a shared writable directory may sit beside the worktree, be the worktree itself
  // (already its working directory) or be exactly its parent, but nothing wider and never inside the
  // worktree or around its Git directory. execution-isolation.test.ts checks these against the launch.
  assert.equal(managedWorktreeLaunchRefusal("/work/docs-wt", "/src/docs/.git", ["/work/cache"], tmp), null);
  assert.equal(managedWorktreeLaunchRefusal("/work/docs-wt", "/src/docs/.git", ["/work/docs-wt"], tmp), null);
  assert.equal(managedWorktreeLaunchRefusal("/work/docs-wt", "/src/docs/.git", ["/work"], tmp), null);
  assert.match(managedWorktreeLaunchRefusal("/work/docs-wt", "/src/docs/.git", ["/"], tmp)!, /overlaps the shared writable directory \/,/u);
  assert.match(managedWorktreeLaunchRefusal("/work/docs-wt", "/src/docs/.git", ["/work/docs-wt/out"], tmp)!, /overlaps/u);
  assert.match(managedWorktreeLaunchRefusal("/work/docs-wt", "/src/docs/.git", ["/src/docs/.git/objects"], tmp)!, /overlaps/u);
});

test("on Direct WSL, where a recovered branch continues is decided on the distro's own paths", async () => {
  const wsl = { kind: "wsl" as const, distro: "Ubuntu" };
  const head = (digit: string) => digit.repeat(40);
  const listed = parseWorktreePorcelain([
    `worktree /home/me/docs\0HEAD ${head("a")}\0branch refs/heads/main\0`,
    `worktree /home/me/docs-wt\0HEAD ${head("b")}\0branch refs/heads/fix/x\0`,
    `worktree /home/me/locked-wt\0HEAD ${head("c")}\0branch refs/heads/fix/locked\0locked kept for a demo\0`,
    `worktree /home/me/.wollipog/worktrees/s_1/fix-slot\0HEAD ${head("d")}\0branch refs/heads/fix/slot\0`,
  ].join("\0") + "\0");
  // Each branch has its own recovery slot, named here with a trailing slash: the same distro path.
  const slot = (branch: string) => `/home/me/.wollipog/worktrees/s_1/${branch.replace("/", "-")}/`;
  const nobody = () => undefined;
  // A record that names the worktree with a trailing slash is the same distro path.
  const records = [{ sessionId: "s_other", path: "/home/me/docs-wt/" }];
  const holderOf = (path: string) => records.find((record) => sameWorktreePath(wsl, record.path, path)) &&
    { sessionId: "s_other", live: true };
  assert.equal(recoveredBranchPlacement(wsl, listed, "fix/slot", slot("fix/slot"), nobody).kind, "slot");
  assert.equal(recoveredBranchPlacement(wsl, listed, "fix/new", slot("fix/new"), nobody).kind, "new");
  const reuse = recoveredBranchPlacement(wsl, listed, "fix/x", slot("fix/x"), nobody);
  assert.equal(reuse.kind === "reuse" && reuse.entry.path, "/home/me/docs-wt");
  assert.deepEqual(recoveredBranchPlacement(wsl, listed, "fix/x", slot("fix/x"), holderOf), { kind: "refuse", reason: "branch fix/x is checked " +
    "out in worktree /home/me/docs-wt, which session s_other is using; continue the task in that session instead, so the work and " +
    "its pull request stay with it" });
  assert.match((recoveredBranchPlacement(wsl, listed, "main", slot("main"), nobody) as { reason: string }).reason, /primary checkout \(\/home\/me\/docs\)/u);
  assert.match((recoveredBranchPlacement(wsl, listed, "fix/locked", slot("fix/locked"), nobody) as { reason: string }).reason, /which is locked/u);

  // A native Windows worktree as Git for Windows lists it matches its real path; a POSIX path keeps its case.
  assert.equal(nativePathSpelling("C:/Repos/docs-wt", "win32"), nativePathSpelling("c:\\repos\\docs-wt\\", "win32"));
  assert.notEqual(nativePathSpelling("C:/repos/docs-wt", "win32"), nativePathSpelling("C:\\repos\\docs-link", "win32"));
  assert.equal(nativePathSpelling("/srv/docs-wt/", "linux"), "/srv/docs-wt");
  assert.notEqual(nativePathSpelling("/srv/Docs-wt", "linux"), nativePathSpelling("/srv/docs-wt", "linux"));

  // The runner's own records are compared the same way.
  await withSession("wsl-holder", async (h) => {
    h.store.patchMeta(h.sessionId, { worktrees: [{ id: "wsl", path: "/home/me/docs-wt/", branch: "fix/x", source: "created" }] });
    const runner = h.manager as unknown as { worktreeHolder: (sessionId: string, context: typeof wsl, path: string) => unknown };
    assert.deepEqual(runner.worktreeHolder("s_someone_else", wsl, "/home/me/docs-wt"), { sessionId: h.sessionId, live: true });
    assert.deepEqual(runner.worktreeHolder(h.sessionId, wsl, "/home/me/docs-wt"), { sessionId: h.sessionId, self: true, live: true });
    assert.equal(runner.worktreeHolder("s_someone_else", wsl, "/home/me/docs-wt-2"), undefined);
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
