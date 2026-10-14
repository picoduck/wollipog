import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { AgentDriverKind } from "@wollipog/protocol";
import { CodexAppServerDriver } from "./drivers/codex-app-server.js";
import type { Driver, DriverCallbacks, DriverOptions } from "./drivers/driver.js";
import { captureWorktreeTree } from "./git-ops.js";
import { isolateFromAmbientIgnores } from "./git-test-repo.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";
import type { AgentProcess } from "./spawn.js";
import { createWorktree } from "./worktree.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A fake app server that answers the launch handshake and `thread/fork`, but never answers
 * `thread/archive`, as when the server hung while cleaning up. */
function silentArchiveAppServer(methods: string[]): AgentProcess {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 4243,
  });
  child.stdin.setEncoding("utf8");
  let buffered = "";
  child.stdin.on("data", (chunk: string) => {
    buffered += chunk;
    for (let index = buffered.indexOf("\n"); index >= 0; index = buffered.indexOf("\n")) {
      const message = JSON.parse(buffered.slice(0, index));
      buffered = buffered.slice(index + 1);
      if (message.id === undefined) continue;
      methods.push(message.method);
      if (message.method === "thread/archive") continue;
      const id = message.method === "thread/fork" ? "thread-forked" : "thread-source";
      const result = message.method === "initialize" ? { userAgent: "codex-test" } :
        message.method.startsWith("thread/") ? { thread: { id, status: { type: "idle" } } } : {};
      child.stdout.write(JSON.stringify({ id: message.id, result }) + "\n");
    }
  });
  return child as unknown as AgentProcess;
}

test("a Codex fork that fails after thread/fork still reports its failure and removes its worktree when thread/archive never answers (#3146)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-codex-fork-bound-"));
  const repo = join(root, "repo");
  git(root, ["init", "-q", repo]);
  isolateFromAmbientIgnores(repo);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "file.txt"), "base");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  const sourceWorktree = await createWorktree(repo, "s_codex_source", { dataDir: root });
  writeFileSync(join(sourceWorktree.path, "file.txt"), "checkpoint");
  const tree = await captureWorktreeTree(sourceWorktree.path);
  const baseCommit = git(sourceWorktree.path, ["rev-parse", "HEAD"]);
  const store = new SessionStore(join(root, "sessions"));
  const source: SessionMeta = {
    sessionId: "s_codex_source", agentId: "codex-native", workspaceId: "workspace", repoPath: repo,
    worktreePath: sourceWorktree.path, worktreeBranch: sourceWorktree.branch, driver: "codex-app-server",
    command: "codex", args: [], env: {}, context: { kind: "native" }, agentSessionId: "thread-source",
    status: "idle", title: "Source", config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null,
    pendingApproval: null, turnCount: 1, seq: 0, createdAt: 1, updatedAt: 1,
    forkPoints: { "1": { agentTurnId: "turn-1", tree, baseCommit, eventSeq: 3 } },
  };
  store.create(source);
  store.appendEvent(source.sessionId, { kind: "user_message", text: "change it", final: true });
  store.appendEvent(source.sessionId, { kind: "conversation_checkpoint", turn: 1 });
  store.flush(source.sessionId);

  const methods: string[] = [];
  const logs: string[] = [];
  const factory = (kind: AgentDriverKind, options: DriverOptions, callbacks: DriverCallbacks): Driver => {
    assert.equal(kind, "codex-app-server");
    return new CodexAppServerDriver(options, callbacks, undefined, {
      spawn: () => silentArchiveAppServer(methods),
      kill: () => {},
      archiveRequestTimeoutMs: 50,
    });
  };
  const manager = new SessionManager(() => {}, (line) => logs.push(line), store, "runner", undefined, factory, root);
  // Fail the fork after thread/fork returned, so its failure cleanup must archive the provider fork.
  const appendEvent = store.appendEvent.bind(store);
  let targetWorktree = "";
  store.appendEvent = ((sessionId, payload, ts) => {
    if (sessionId === "s_codex_target" && payload.kind === "conversation_checkpoint") {
      targetWorktree = store.readMeta(sessionId)?.worktreePath ?? "";
      throw new Error("fork copy interrupted");
    }
    return appendEvent(sessionId, payload, ts);
  }) as SessionStore["appendEvent"];
  try {
    const started = Date.now();
    const result = await manager.forkConversation(source.sessionId, "s_codex_target", 1, "Fork");
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false);
    assert.equal(result.error, "fork copy interrupted", "the fork failure is reported, not the cleanup stall");
    assert.ok(elapsed < 5_000, `fork settled after ${elapsed} ms`);
    assert.deepEqual(methods.filter((method) => method === "thread/fork" || method === "thread/archive"),
      ["thread/fork", "thread/archive"]);
    assert.ok(logs.includes("failed to archive orphaned provider fork thread-forked: " +
      "Codex app-server did not answer thread/archive within 50 ms"), logs.join("\n"));
    assert.ok(targetWorktree, "the fork reached its target worktree before failing");
    assert.equal(existsSync(targetWorktree), false, "the fork's worktree is removed");
    assert.doesNotMatch(git(repo, ["worktree", "list", "--porcelain"]), /s_codex_target/);
    assert.equal(store.has("s_codex_target"), false);
  } finally {
    store.appendEvent = appendEvent;
    manager.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});
