import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bindPullRequestScope } from "./review-snapshot.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", [
  "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-C", cwd, ...args,
], { encoding: "utf8" }).trim();

for (const mode of ["relaunch", "resume"] as const) test(`automatic launch records durable review proof; an old session gains it on ${mode}`, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-launch-review-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "--quiet", "--allow-empty", "-m", "base");
  git(repo, "remote", "add", "origin", "https://github.com/acme/widget.git");
  const storePath = join(root, "sessions");
  let store = new SessionStore(storePath);
  let providerStarted: (() => void) | undefined;
  const factory = (_driver: unknown, _options: unknown, callbacks: { onExit(code: number | null): void }) => {
    providerStarted?.();
    return {
    pid: 1, initialize: async () => {}, newSession: async () => "provider-session",
    prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => callbacks.onExit(0),
    setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => "provider-session",
    };
  };
  const messages: unknown[] = [];
  const makeManager = () => new SessionManager(
    (message) => messages.push(message), () => {}, store, "runner", undefined, factory as never, root, 1,
  );
  let manager = makeManager();
  t.after(() => { manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); });
  const spec = { sessionId: "s_automatic", workspaceId: "repo", workspacePath: repo,
    agentId: "claude", command: "claude", args: [], env: {}, useWorktree: true,
    driver: "claude-code" as const };
  assert.equal(await manager.start(spec), true);
  const first = store.readMeta(spec.sessionId)!;
  const expected = { sessionId: spec.sessionId, repoPath: repo, path: first.worktreePath!, branch: "agent/s_automatic" };
  assert.deepEqual(first.launchWorktreeProof, expected);
  assert.equal(first.worktrees?.[0]?.source, "legacy", "automatic worktree semantics stay intact");
  assert.deepEqual(new SessionStore(storePath).readMeta(spec.sessionId)?.launchWorktreeProof, expected);

  const head = git(repo, "rev-parse", "HEAD");
  const bind = () => bindPullRequestScope({
    meta: store.readMeta(spec.sessionId),
    request: { repository: "acme/widget", number: 7, headSha: head },
    tools: { git: "git", gh: "gh" }, env: process.env,
    exec: async (command, args, options) => execFileSync(command, args, { encoding: "utf8", env: options?.env }),
    pullRequest: async () => ({ state: "open", baseRepository: "acme/widget", headRepository: "acme/widget",
      headRef: expected.branch, headSha: head, baseSha: head }),
  });
  assert.equal((await bind()).branch, expected.branch);
  manager.shutdownAll();
  // Model persisted metadata from before this proof existed, then a fresh runner process.
  store.patchMeta(spec.sessionId, { launchWorktreeProof: undefined, worktrees: undefined,
    worktreeBranch: undefined, agentSessionId: "provider-session", status: "stopped" });
  store = new SessionStore(storePath);
  await assert.rejects(bind(), /resume this session once/);
  manager = makeManager();
  messages.length = 0;
  if (mode === "relaunch") assert.equal(await manager.start(spec), true, JSON.stringify(messages));
  else await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(JSON.stringify(messages))), 5_000);
    providerStarted = () => { clearTimeout(timer); resolve(); };
    manager.prompt(spec.sessionId, "Continue");
  });
  assert.deepEqual(store.readMeta(spec.sessionId)?.launchWorktreeProof, expected);
  assert.equal((await bind()).branch, expected.branch);
});
