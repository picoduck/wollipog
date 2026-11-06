/**
 * An oversized per-turn worktree diff must never make a session unreadable (#4288). Before the
 * bound, a turn that pulled in a large upstream range wrote one `file_edit` record bigger than the
 * history reader's page budget; every later read, restart and prompt then failed with
 * `history_event_too_large`. These tests drive a real worktree through a real turn end.
 */

import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentDriverKind } from "@wollipog/protocol";
import type { Driver, DriverCallbacks, DriverOptions } from "./drivers/driver.js";
import { captureWorktreeTree } from "./git-ops.js";
import { isolateFromAmbientIgnores } from "./git-test-repo.js";
import { TURN_DIFF_MAX_BYTES } from "./history-event-bound.js";
import { SessionManager } from "./session-manager.js";
import { HISTORY_PAGE_MAX_BYTES, SessionStore, type SessionMeta } from "./session-store.js";
import { captureTurnDiff, createWorktree } from "./worktree.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true, message);
}

async function setup(sessionId: string) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-oversized-diff-"));
  const repo = join(root, "repo");
  git(root, ["init", "-q", repo]);
  isolateFromAmbientIgnores(repo);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "committed.txt"), "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  const worktree = await createWorktree(repo, sessionId, { dataDir: root });
  const store = new SessionStore(join(root, "sessions"));
  const meta: SessionMeta = {
    sessionId, agentId: "codex-native", workspaceId: "workspace", repoPath: repo,
    worktreePath: worktree.path, driver: "codex-app-server", command: "codex", args: [],
    env: {}, context: { kind: "native" }, agentSessionId: "thread-oversized",
    status: "idle", title: "Oversized", config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0,
    preview: null, pendingApproval: null, turnCount: 0, seq: 0, createdAt: 1, updatedAt: 1,
  };
  store.create(meta);
  store.flush(sessionId);
  return { root, repo, worktree, store, sessionId, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

interface StubState {
  prompts: string[];
  launches: number;
  onPrompt?: (text: string) => void;
}

function stubFactory(state: StubState) {
  return (_kind: AgentDriverKind, options: DriverOptions, _callbacks: DriverCallbacks): Driver => {
    state.launches += 1;
    return {
      get pid() { return undefined; },
      initialize: async () => {},
      newSession: async () => options.resumeId ?? "thread-oversized",
      agentSessionId: () => options.resumeId ?? "thread-oversized",
      agentTurnId: () => `turn-${state.prompts.length}`,
      forkSession: async () => "thread-fork",
      archiveSession: async () => {},
      prompt: async (text) => {
        state.prompts.push(text);
        state.onPrompt?.(text);
        return "end_turn";
      },
      setConfig: () => {},
      cancel: () => {},
      resolvePermission: () => false,
      dispose: () => {},
    };
  };
}

/** A file whose diff alone is larger than the history page budget. */
function writeHugeFile(path: string): void {
  const line = `${"u".repeat(127)}\n`;
  writeFileSync(path, line.repeat(Math.ceil((HISTORY_PAGE_MAX_BYTES + 1024 * 1024) / line.length)));
}

test("an oversized turn diff is stored bounded, and the session still reads, restarts and accepts a prompt", async () => {
  const fixture = await setup("s_oversized_turn");
  const state: StubState = { prompts: [], launches: 0 };
  state.onPrompt = () => {
    writeHugeFile(join(fixture.worktree.path, "pulled-upstream.txt"));
    writeFileSync(join(fixture.worktree.path, "own-change.txt"), "the agent's own work\n");
  };
  let manager = new SessionManager(
    () => {}, () => {}, fixture.store, "runner", undefined, stubFactory(state), fixture.root,
  );
  try {
    manager.prompt(fixture.sessionId, "pull upstream and make a change");
    await waitFor(() => fixture.store.readEvents(fixture.sessionId)
      .some((event) => event.payload.kind === "file_edit"), "the turn's diff is recorded");
    await waitFor(() => fixture.store.readMeta(fixture.sessionId)?.status === "idle", "the turn settles");

    const meta = fixture.store.readMeta(fixture.sessionId)!;
    assert.notEqual(meta.status, "failed");
    const edit = fixture.store.readEvents(fixture.sessionId).find((event) => event.payload.kind === "file_edit")!;
    assert.ok(edit.payload.kind === "file_edit" && edit.payload.path === "worktree");
    const diff = edit.payload.diff ?? "";
    assert.ok(Buffer.byteLength(diff) <= TURN_DIFF_MAX_BYTES, "the stored diff is bounded");
    assert.match(diff, /too large to keep in session history: [\d,]+ bytes across 2 files/);
    assert.match(diff, /1 of 2 files is shown here/);
    assert.ok(diff.includes("diff --git a/own-change.txt b/own-change.txt"), "the agent's own small change is kept");
    assert.ok(Buffer.byteLength(JSON.stringify(edit)) < HISTORY_PAGE_MAX_BYTES);
  } finally {
    manager.shutdownAll();
  }

  // A fresh process reads the same store, exactly as a runner restart would. Its first append
  // re-validates the whole log, which is where an oversized record used to fail every restart.
  const store = new SessionStore(join(fixture.root, "sessions"));
  const page = store.readEventPage(fixture.sessionId, { afterSeq: 0, limit: 200 });
  assert.equal(page.ok, true, page.ok ? "" : page.error);
  // The worktree lease is keyed by process id. A real restart finds the old runner's pid dead and
  // reclaims it; this in-process restart shares the pid, so release the retired runner's lease.
  const lease = store.readWorktreeLease(fixture.sessionId);
  if (lease) store.releaseWorktreeLease(fixture.sessionId, lease.owner);
  const restarted: StubState = { prompts: [], launches: 0 };
  manager = new SessionManager(
    () => {}, () => {}, store, "runner", undefined, stubFactory(restarted), fixture.root,
  );
  try {
    assert.equal(manager.prompt(fixture.sessionId, "continue after the restart"), true);
    await waitFor(() => restarted.prompts.length === 1, "the restarted session accepts a prompt");
    await waitFor(() => store.readMeta(fixture.sessionId)?.status === "idle", "the resumed turn settles");
    assert.deepEqual(restarted.prompts, ["continue after the restart"]);
    const after = store.readEventPage(fixture.sessionId, { afterSeq: 0, limit: 200 });
    assert.equal(after.ok, true, after.ok ? "" : after.error);
    if (after.ok) {
      assert.ok(after.events.some((event) => event.payload.kind === "user_message" &&
        event.payload.text === "continue after the restart"));
    }
  } finally {
    manager.shutdownAll();
    fixture.cleanup();
  }
});

test("a turn diff too large to read is summarized, and the turn base still advances", async () => {
  const fixture = await setup("s_unreadable_turn");
  try {
    const base = await captureWorktreeTree(fixture.worktree.path);
    writeFileSync(join(fixture.worktree.path, "a.txt"), "a\n".repeat(10_000));
    writeFileSync(join(fixture.worktree.path, "b.txt"), "b\n".repeat(10_000));
    const captured = await captureTurnDiff(fixture.worktree.path, base, {}, 1024);
    assert.ok(captured);
    assert.match(captured.diff, /more than 1,024 bytes across 2 files/);
    assert.match(captured.diff, /0 of 2 files are shown here/);
    assert.equal(captured.tree, await captureWorktreeTree(fixture.worktree.path),
      "the next turn diffs from this tree instead of repeating the same range");
  } finally {
    fixture.cleanup();
  }
});
