/**
 * A managed-worktree guard whose protection list cannot be kept in step is not a guard.
 *
 * SessionManager mirrors the live worktree inventory into the guard's state file on every
 * `worktrees` patch. When that refresh fails, the session must NOT keep running in the permission
 * mode it was launched with while the guard trusts a stale list: the state is removed so every
 * later guard invocation fails closed, and when even that is impossible the provider is stopped
 * through the ordinary stop path (issue #1313, review round 1).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunnerToControlPlane } from "@wollipog/protocol";
import type { ClaudeGuardRefreshOutcome } from "./hook-settings.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: "s_guard",
    agentId: "claude-native",
    workspaceId: "repo",
    repoPath: "/home/me/repo",
    worktreePath: null,
    driver: "claude-code",
    command: "claude",
    args: [],
    env: {},
    context: { kind: "native" },
    agentSessionId: null,
    status: "idle",
    title: "guard test",
    config: {},
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    preview: null,
    pendingApproval: null,
    seq: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function harness(outcome: ClaudeGuardRefreshOutcome) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-guard-"));
  const sent: RunnerToControlPlane[] = [];
  const store = new SessionStore(root);
  store.create(meta());
  const sm = new SessionManager((m) => sent.push(m), () => {}, store, "test-runner");
  const refreshes: string[] = [];
  sm.setManagedWorktreeGuardRefresh((session) => {
    refreshes.push(session.sessionId);
    return outcome;
  });
  const disposals: string[] = [];
  const stub = {
    resolvePermission: () => true,
    answerQuestion: () => true,
    cancel: () => {},
    dispose: () => { disposals.push("disposed"); },
    prompt: () => Promise.resolve("end_turn" as const),
    setConfig: () => {},
    agentSessionId: () => null,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sm as any).active.set("s_guard", {
    sessionId: "s_guard",
    client: stub,
    repoPath: "/home/me/repo",
    cwd: "/home/me/repo",
    worktree: null,
    status: "idle",
    running: false,
    queue: [],
  });
  return { sm, sent, store, refreshes, disposals, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const worktreePatch = (store: SessionStore) =>
  store.patchMeta("s_guard", {
    worktrees: [{
      id: "wt_1",
      path: "/home/me/repo-worktrees/s_guard",
      branch: "agent/s_guard",
      source: "created",
      createdAt: 1000,
    }] as SessionMeta["worktrees"],
  });

const stderrNotices = (sent: RunnerToControlPlane[]) =>
  sent.flatMap((message) => message.type === "session_event" &&
      (message as { payload: { kind: string; text?: string } }).payload.kind === "stderr"
    ? [(message as { payload: { text?: string } }).payload.text ?? ""]
    : []);

test("a successful refresh is silent and leaves the session alone", (t) => {
  const h = harness({ state: "refreshed" });
  t.after(h.cleanup);
  worktreePatch(h.store);
  assert.deepEqual(h.refreshes, ["s_guard"], "every worktree inventory change refreshes the guard");
  assert.deepEqual(stderrNotices(h.sent), []);
  assert.equal(h.store.readMeta("s_guard")!.status, "idle");
});

test("an invalidated guard surfaces a visible notice and leaves the process to fail closed", (t) => {
  const h = harness({ state: "invalidated", reason: "the protected worktree list was modified outside the runner" });
  t.after(h.cleanup);
  worktreePatch(h.store);
  const notices = stderrNotices(h.sent);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /managed worktree protection was invalidated/u);
  assert.match(notices[0]!, /modified outside the runner/u);
  // The guard state is gone, so the running provider's next tool call fails closed; stopping it
  // as well would be gratuitous.
  assert.deepEqual(h.disposals, []);
  assert.equal(h.store.readMeta("s_guard")!.status, "idle");
});

test("a guard whose state could not be retired stops the provider", (t) => {
  const h = harness({ state: "unprotected", reason: "the protected worktree list could not be updated" });
  t.after(h.cleanup);
  worktreePatch(h.store);
  const notices = stderrNotices(h.sent);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /provider is being stopped/u);
  assert.deepEqual(h.disposals, ["disposed"], "the ordinary stop path retires the provider");
  assert.equal(h.store.readMeta("s_guard")!.status, "stopped");
});

test("an exception from the refresh is treated as unprotected, never as success", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-guard-"));
  const sent: RunnerToControlPlane[] = [];
  const store = new SessionStore(root);
  store.create(meta());
  const sm = new SessionManager((m) => sent.push(m), () => {}, store, "test-runner");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  sm.setManagedWorktreeGuardRefresh(() => { throw new Error("disk exploded"); });
  const disposals: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sm as any).active.set("s_guard", {
    sessionId: "s_guard",
    client: {
      resolvePermission: () => true, answerQuestion: () => true, cancel: () => {},
      dispose: () => { disposals.push("disposed"); },
      prompt: () => Promise.resolve("end_turn" as const), setConfig: () => {}, agentSessionId: () => null,
    },
    repoPath: "/home/me/repo", cwd: "/home/me/repo", worktree: null,
    status: "idle", running: false, queue: [],
  });
  worktreePatch(store);
  assert.match(stderrNotices(sent).join("\n"), /disk exploded/u);
  assert.deepEqual(disposals, ["disposed"]);
});
