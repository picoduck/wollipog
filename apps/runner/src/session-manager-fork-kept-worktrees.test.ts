import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

// #4209: deleting one session never removes a worktree that another session lists, and a fork does
// not take on the worktrees its source left in other Locations.

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false",
    "-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** Every file under `root`, byte for byte, without its Git link. */
function files(root: string, prefix = ""): Record<string, string> {
  const found: Record<string, string> = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.name === ".git") continue;
    if (entry.isDirectory()) Object.assign(found, files(root, path));
    else found[path] = readFileSync(join(root, path)).toString("base64");
  }
  return found;
}

/** A fake app server that answers the launch handshake and `thread/fork`. */
function appServer(): AgentProcess {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 4244 });
  child.stdin.setEncoding("utf8");
  let buffered = "";
  child.stdin.on("data", (chunk: string) => {
    buffered += chunk;
    for (let index = buffered.indexOf("\n"); index >= 0; index = buffered.indexOf("\n")) {
      const message = JSON.parse(buffered.slice(0, index));
      buffered = buffered.slice(index + 1);
      if (message.id === undefined) continue;
      const id = message.method === "thread/fork" ? "thread-forked" : "thread-source";
      const result = message.method === "initialize" ? { userAgent: "codex-test" } :
        message.method.startsWith("thread/") ? { thread: { id, status: { type: "idle" } } } : {};
      child.stdout.write(JSON.stringify({ id: message.id, result }) + "\n");
    }
  });
  return child as unknown as AgentProcess;
}

interface Fixture {
  root: string;
  store: SessionStore;
  manager: SessionManager;
  source: SessionMeta;
  /** The source's worktree in the Location it left, with uncommitted work in it. */
  left: string;
  leftRepo: string;
}

async function withSource(name: string, body: (f: Fixture) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `wollipog-fork-kept-${name}-`)));
  const store = new SessionStore(join(root, "sessions"));
  const factory = (kind: AgentDriverKind, options: DriverOptions, callbacks: DriverCallbacks): Driver => {
    assert.equal(kind, "codex-app-server");
    return new CodexAppServerDriver(options, callbacks, undefined, { spawn: () => appServer(), kill: () => {}, archiveRequestTimeoutMs: 50 });
  };
  const manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory, root);
  try {
    const repo = join(root, "repo");
    const leftRepo = join(root, "left-repo");
    for (const path of [repo, leftRepo]) {
      mkdirSync(path);
      git(path, ["init", "-q", "--initial-branch=main"]);
      isolateFromAmbientIgnores(path);
      writeFileSync(join(path, "file.txt"), "base");
      git(path, ["add", "."]);
      git(path, ["commit", "-qm", "base"]);
    }
    // The source worked in left-repo first, on its own branch, and left uncommitted work there.
    const left = join(root, "left-worktree");
    git(leftRepo, ["worktree", "add", "-q", "-b", "fix/left", left]);
    writeFileSync(join(left, "file.txt"), "uncommitted work in the Location the source left");
    const sourceWorktree = await createWorktree(repo, `s_${name}_source`, { dataDir: root });
    writeFileSync(join(sourceWorktree.path, "file.txt"), "checkpoint");
    const tree = await captureWorktreeTree(sourceWorktree.path);
    const baseCommit = git(sourceWorktree.path, ["rev-parse", "HEAD"]);
    const source: SessionMeta = {
      sessionId: `s_${name}_source`, agentId: "codex-native", workspaceId: "workspace", repoPath: repo,
      worktreePath: sourceWorktree.path, worktreeBranch: sourceWorktree.branch, driver: "codex-app-server",
      command: "codex", args: [], env: {}, context: { kind: "native" }, agentSessionId: "thread-source",
      status: "idle", title: "Source", config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null,
      pendingApproval: null, turnCount: 1, seq: 0, createdAt: 1, updatedAt: 1, keptWorktreesTracked: true,
      forkPoints: { "1": { agentTurnId: "turn-1", tree, baseCommit, eventSeq: 3 } },
      locationHistory: [{ occurrenceId: "occurrence-1", workspaceId: "left", repoPath: leftRepo, worktreePath: left,
        worktreeBranch: "fix/left", switchedAt: 1, toWorkspaceId: "workspace",
        worktrees: [{ id: "left-worktree", path: left, branch: "fix/left", source: "created" }] }],
    };
    store.create(source);
    store.appendEvent(source.sessionId, { kind: "user_message", text: "change it", final: true });
    store.appendEvent(source.sessionId, { kind: "conversation_checkpoint", turn: 1 });
    store.flush(source.sessionId);
    await body({ root, store, manager, source, left, leftRepo });
  } finally {
    manager.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
}

test("a fork does not take on the worktrees its source left in other Locations, so deleting it leaves them", async () => {
  if (process.platform === "win32") return;
  await withSource("fork", async (f) => {
    const before = files(f.left);
    const result = await f.manager.forkConversation(f.source.sessionId, "s_fork_target", 1, "Fork");
    assert.equal(result.ok, true, result.error ?? "the fork failed");
    assert.equal(f.store.readMeta("s_fork_target")?.locationHistory, undefined, "the fork has no Locations of its own to have left");
    assert.equal(f.store.readMeta("s_fork_target")?.keptWorktreesTracked, true, "and it records every keep from the start");
    await f.manager.delete("s_fork_target");
    assert.deepEqual(files(f.left), before, "the source's work there is all there");
    assert.equal(git(f.leftRepo, ["rev-parse", "--verify", "refs/heads/fix/left"]).length, 40, "on its branch");
    assert.ok(f.store.readMeta(f.source.sessionId)?.locationHistory?.[0]?.worktrees.length, "and the source still lists it");
  });
});

test("a provider fork gets its own runner restart recovery identity", async () => {
  if (process.platform === "win32") return;
  await withSource("fork-recovery", async (f) => {
    const sourceRequestId = "runner-recovery:source";
    f.store.patchMeta(f.source.sessionId, { runnerRestartRecoveryRequestId: sourceRequestId,
      orchestrator: { strictProjectIsolation: false, integrationIsolation: false } });
    const result = await f.manager.forkConversation(f.source.sessionId, "s_recovery_target", 1, "Fork");
    assert.equal(result.ok, true, result.error);
    f.manager.reconcileStore();
    f.manager.reconcileRunnerRestartRecovery(["s_recovery_target"]);
    const request = f.store.readMeta("s_recovery_target")!.pendingApproval!;
    assert.equal(request.kind, "runner_recovery");
    assert.notEqual(request.requestId, sourceRequestId);
  });
});

test("a failed fork whose rollback keeps its worktree still stops what ran there and gives back its port block", async () => {
  if (process.platform === "win32") return;
  await withSource("fork-kept-rollback", async (f) => {
    const internals = f.manager as unknown as {
      prepareWorktreeSetup: (...args: unknown[]) => Promise<string>;
      terminateRollbackProcesses: (marker: string) => Promise<boolean>;
      worktreePortAllocator: { allocate(owner: string, preferred?: unknown): unknown; get(owner: string): unknown };
    };
    const owners: string[] = [];
    const allocate = internals.worktreePortAllocator.allocate.bind(internals.worktreePortAllocator);
    internals.worktreePortAllocator.allocate = (owner, preferred) => {
      owners.push(owner);
      return allocate(owner, preferred);
    };
    const stopped: string[] = [];
    internals.terminateRollbackProcesses = async (marker) => { stopped.push(marker); return true; };
    let forkWorktree = "";
    const prepare = internals.prepareWorktreeSetup.bind(f.manager);
    internals.prepareWorktreeSetup = async (...args) => {
      // Setup takes the fork's port block and process marker, then is canceled. An index flag left in
      // the worktree means nothing can prove what is in it, so its rollback keeps it.
      await prepare(...args);
      forkWorktree = (args[1] as { path: string }).path;
      git(forkWorktree, ["update-index", "--assume-unchanged", "file.txt"]);
      throw new Error("worktree setup was canceled");
    };
    const result = await f.manager.forkConversation(f.source.sessionId, "s_fork_kept_target", 1, "Fork");
    assert.equal(result.ok, false);
    assert.ok(forkWorktree, "the fork made a worktree and set it up");
    const forkOwners = owners.filter((owner) => owner.startsWith("s_fork_kept_target\0"));
    assert.ok(forkOwners.length > 0, "its setup took a port block");
    assert.equal(readdirSync(forkWorktree).includes("file.txt"), true, "the worktree is kept");
    assert.equal(f.store.has("s_fork_kept_target"), false, "the fork's row is gone");
    assert.deepEqual(forkOwners.filter((owner) => internals.worktreePortAllocator.get(owner) !== undefined), [],
      "and no port block outlives it");
    assert.ok(stopped.length > 0, "and what its setup started there is stopped");
    // The fork's row is gone, so the session it was forked from is told, and no next launch is promised.
    const notices = f.store.readEvents(f.source.sessionId).map((event) => event.payload)
      .filter((payload) => payload.kind === "error").map((payload) => String((payload as { message?: string }).message));
    const notice = notices.find((text) => text.includes(forkWorktree));
    assert.ok(notice, "the fork's source is told the worktree was kept");
    assert.match(notice, /a fork of this session that failed made/u);
    assert.doesNotMatch(notice, /next launch/u);
  });
});

for (const how of ["in its history", "as its selected worktree", "as one of its worktrees"] as const) {
  test(`deleting a session leaves a worktree another session lists ${how}`, async () => {
    if (process.platform === "win32") return;
    await withSource(`listed-${how.split(" ").at(-2)}`, async (f) => {
      const before = files(f.left);
      // The session being deleted lists the worktree in its history, as an older runner's fork copied it.
      f.store.create({ ...f.source, sessionId: "s_listed_copy", worktreePath: null, worktreeBranch: undefined, worktrees: [],
        forkPoints: {}, agentSessionId: null });
      // The source, the one that really works there, holds it in one way only.
      const row = f.source.locationHistory![0]!.worktrees[0]!;
      f.store.patchMeta(f.source.sessionId, how === "in its history" ? {} : {
        locationHistory: undefined,
        ...(how === "as its selected worktree"
          ? { worktreePath: f.left, worktreeBranch: "fix/left", worktrees: [] }
          : { worktrees: [...(f.store.readMeta(f.source.sessionId)!.worktrees ?? []), row] }),
      });
      await f.manager.delete("s_listed_copy");
      assert.deepEqual(files(f.left), before);
      assert.equal(git(f.leftRepo, ["rev-parse", "--verify", "refs/heads/fix/left"]).length, 40);
    });
  });
}
