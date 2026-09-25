/**
 * A managed-worktree guard whose protection list cannot be kept in step is not a guard.
 *
 * SessionManager mirrors the live worktree inventory into the guard's state file on every
 * `worktrees` patch, and on a legacy `worktreePath`/`worktreeBranch` patch that changes it. When that refresh fails, the session must NOT keep running in the permission
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
import { UnguardedAgentTuiRegistry } from "./agent-tui-guard-notice.js";
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

function harness(outcome: ClaudeGuardRefreshOutcome, initial: Partial<SessionMeta> = {}) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-guard-"));
  const sent: RunnerToControlPlane[] = [];
  const store = new SessionStore(root);
  store.create(meta(initial));
  const sm = new SessionManager((m) => sent.push(m), () => {}, store, "test-runner");
  const refreshes: string[] = [];
  const protected_: string[][] = [];
  sm.setManagedWorktreeGuardRefresh((session, protections) => {
    refreshes.push(session.sessionId);
    protected_.push(protections.map((protection) => protection.worktreePath));
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
  return { sm, sent, store, refreshes, protected: protected_, disposals, cleanup: () => rmSync(root, { recursive: true, force: true }) };
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

// The protection list is built from the attributed worktrees, and those include the legacy
// `worktreePath` field as a synthetic entry. A patch that moves only that field changes what the
// guard must protect exactly as a `worktrees` patch does (#1474).

test("a patch that sets only the legacy worktreePath refreshes the guard with the new path", (t) => {
  const h = harness({ state: "refreshed" });
  t.after(h.cleanup);
  h.store.patchMeta("s_guard", { worktreePath: "/home/me/repo-worktrees/legacy-a" });
  assert.deepEqual(h.protected, [["/home/me/repo-worktrees/legacy-a"]]);
  h.store.patchMeta("s_guard", { worktreePath: "/home/me/repo-worktrees/legacy-b" });
  assert.deepEqual(h.protected.at(-1), ["/home/me/repo-worktrees/legacy-b"]);
  h.store.patchMeta("s_guard", { worktreePath: null });
  assert.deepEqual(h.protected.at(-1), [], "clearing the legacy field retires its protection");
  assert.equal(h.refreshes.length, 3);
});

test("a patch that changes only the legacy worktreeBranch refreshes the guard", (t) => {
  const h = harness({ state: "refreshed" }, { worktreePath: "/home/me/repo-worktrees/legacy-a" });
  t.after(h.cleanup);
  h.store.patchMeta("s_guard", { worktreeBranch: "fix/renamed" });
  assert.deepEqual(h.protected, [["/home/me/repo-worktrees/legacy-a"]]);
});

test("a failed refresh from a worktreePath-only patch is handled like any other", (t) => {
  const h = harness({ state: "unprotected", reason: "the protected worktree list could not be updated" });
  t.after(h.cleanup);
  h.store.patchMeta("s_guard", { worktreePath: "/home/me/repo-worktrees/legacy-a" });
  assert.match(stderrNotices(h.sent).join("\n"), /provider is being stopped/u);
  assert.deepEqual(h.disposals, ["disposed"]);
});

test("a patch that leaves the attributed worktrees alone does not refresh the guard", (t) => {
  const h = harness({ state: "refreshed" }, {
    worktreePath: "/home/me/repo-worktrees/s_guard",
    worktreeBranch: "agent/s_guard",
    worktrees: [{
      id: "wt_1",
      path: "/home/me/repo-worktrees/s_guard",
      branch: "agent/s_guard",
      source: "created",
      createdAt: 1000,
    }] as SessionMeta["worktrees"],
  });
  t.after(h.cleanup);
  h.store.patchMeta("s_guard", { title: "renamed" });
  h.store.patchMeta("s_guard", { status: "running" });
  // The fields are carried but name what is already attributed: nothing to protect changed.
  h.store.patchMeta("s_guard", { worktreePath: "/home/me/repo-worktrees/s_guard" });
  h.store.patchMeta("s_guard", { worktreePath: "/home/me/repo-worktrees/s_guard", worktreeBranch: "agent/s_guard" });
  // The branch of a path already recorded in `worktrees` is that record's, not the legacy field's.
  h.store.patchMeta("s_guard", { worktreeBranch: "fix/renamed" });
  assert.deepEqual(h.refreshes, []);
});

test("a context patch that stops the legacy path matching a recorded worktree refreshes the guard", (t) => {
  // Whether the legacy path is the recorded worktree is decided per context: natively the two
  // spellings below resolve to one path, and under WSL they are compared as written.
  const h = harness({ state: "refreshed" }, {
    worktreePath: "/home/me/repo-worktrees/s_guard//",
    worktrees: [{
      id: "wt_1",
      path: "/home/me/repo-worktrees/s_guard",
      branch: "agent/s_guard",
      source: "created",
      createdAt: 1000,
    }] as SessionMeta["worktrees"],
  });
  t.after(h.cleanup);
  h.store.patchMeta("s_guard", { context: { kind: "native" } });
  assert.deepEqual(h.refreshes, [], "a context carried unchanged attributes nothing new");
  h.store.patchMeta("s_guard", { context: { kind: "wsl", distro: "Ubuntu" } });
  assert.deepEqual(h.protected, [["/home/me/repo-worktrees/s_guard", "/home/me/repo-worktrees/s_guard//"]]);
});

test("a worktreeBranch patch with no legacy worktree does not refresh the guard", (t) => {
  const h = harness({ state: "refreshed" });
  t.after(h.cleanup);
  h.store.patchMeta("s_guard", { worktreeBranch: "fix/renamed" });
  assert.deepEqual(h.refreshes, []);
});

test("the unguarded-TUI notice is evaluated on a worktreePath-only patch", (t) => {
  // Wired as the runner wires it: the notice rides the refresh callback (#1438), so whatever
  // triggers the refresh is what evaluates the notice.
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-guard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  store.create(meta());
  const sm = new SessionManager(() => {}, () => {}, store, "test-runner");
  const unguarded = new UnguardedAgentTuiRegistry();
  const notices: string[] = [];
  sm.setManagedWorktreeGuardRefresh((session, protections) => {
    const notice = unguarded.protectionsChanged(session.sessionId, protections.length);
    if (notice) notices.push(notice);
    return { state: "absent" };
  });
  assert.equal(unguarded.opened("shell_1", "s_guard", { active: false, reason: "untrusted hooks" }, 0), null);
  store.patchMeta("s_guard", { title: "renamed" });
  assert.deepEqual(notices, []);
  store.patchMeta("s_guard", { worktreePath: "/home/me/repo-worktrees/legacy-a" });
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /started without Wollipog managed worktree protection \(untrusted hooks\)/u);
});

test("an Orchestrator's guard list is every runner-created worktree on the runner, kept in step by any session's change (#1473)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-guard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const child = meta();
  const orchestrator = meta({
    sessionId: "s_orch",
    repoPath: "/home/me/scratch",
    config: { permissionMode: "orchestrator" },
    orchestrator: { strictProjectIsolation: true },
  });
  const bystander = meta({
    sessionId: "s_other",
    worktrees: [{ id: "wt_o", path: "/home/me/repo-worktrees/s_other", branch: "agent/s_other", source: "created", createdAt: 1 }],
  });
  const attached = meta({
    sessionId: "s_attached",
    worktrees: [{ id: "wt_a", path: "/home/me/repo-worktrees/operator", branch: "main", source: "attached", createdAt: 1 }],
  });
  for (const session of [child, orchestrator, bystander, attached]) store.create(session);
  const sm = new SessionManager(() => {}, () => {}, store, "test-runner");
  const refreshed: Array<{ id: string; paths: string[] }> = [];
  sm.setManagedWorktreeGuardRefresh((session, protections) => {
    refreshed.push({ id: session.sessionId, paths: protections.map((entry) => entry.worktreePath) });
    return { state: "refreshed" };
  });

  // The runner has no lineage record, so the Orchestrator's list is every runner-created worktree
  // of every session here — never an attached operator worktree, and never a duplicate.
  assert.deepEqual(sm.managedWorktreeGuardProtections(store.readMeta("s_orch")!),
    [{ worktreePath: "/home/me/repo-worktrees/s_other", repoPath: "/home/me/repo" }]);
  // An ordinary session's list is still its own.
  assert.deepEqual(sm.managedWorktreeGuardProtections(store.readMeta("s_other")!),
    [{ worktreePath: "/home/me/repo-worktrees/s_other", repoPath: "/home/me/repo" }]);
  assert.deepEqual(sm.managedWorktreeGuardProtections(store.readMeta("s_guard")!), []);

  // A child acquiring a worktree refreshes the child's own guard AND the Orchestrator's, with the
  // new worktree in the Orchestrator's list; the bystander is left alone.
  worktreePatch(store);
  assert.deepEqual(refreshed.map((entry) => entry.id).sort(), ["s_guard", "s_orch"]);
  assert.deepEqual(refreshed.find((entry) => entry.id === "s_guard")!.paths, ["/home/me/repo-worktrees/s_guard"]);
  assert.deepEqual(refreshed.find((entry) => entry.id === "s_orch")!.paths.sort(),
    ["/home/me/repo-worktrees/s_guard", "/home/me/repo-worktrees/s_other"]);
});

test("only a session's own default worktree is pinned to its branch (#1650)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-guard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  store.create(meta({
    worktreePath: "/home/me/repo-worktrees/s_guard",
    worktreeBranch: "agent/s_guard",
    worktrees: [
      { id: "wt_c", path: "/home/me/repo-worktrees/s_guard.requested/wt_c", branch: "fix/issue-1650", source: "created", createdAt: 1 },
      { id: "wt_a", path: "/home/me/repo-worktrees/operator", branch: "main", source: "attached", createdAt: 1 },
    ],
  }));
  const sm = new SessionManager(() => {}, () => {}, store, "test-runner");
  assert.deepEqual(sm.managedWorktreeProtections(store.readMeta("s_guard")!), [
    { worktreePath: "/home/me/repo-worktrees/s_guard.requested/wt_c", repoPath: "/home/me/repo" },
    { worktreePath: "/home/me/repo-worktrees/s_guard", repoPath: "/home/me/repo", pinnedBranch: "agent/s_guard" },
  ]);
});
