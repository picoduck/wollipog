/**
 * Worktree pull request reconciliation records merge-queue facts (#604), so Inbox rows show a
 * queued or removed pull request without anyone opening the session.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForgeMergeQueueFacts, RunnerToControlPlane, SessionWorktreeView } from "@wollipog/protocol";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

const URL = "https://github.com/o/r/pull/7";

function harness(pullRequest: NonNullable<SessionWorktreeView["pullRequest"]>) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-merge-queue-"));
  const path = join(root, "worktree");
  const store = new SessionStore(join(root, "state"));
  const meta: SessionMeta = {
    sessionId: "s_queue", agentId: "claude-native", workspaceId: "repo", repoPath: "/repo", worktreePath: path,
    driver: "claude-code", command: "claude", args: [], env: {}, context: { kind: "native" }, agentSessionId: null,
    status: "idle", title: "queue", config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null,
    pendingApproval: null, seq: 0, createdAt: 1000, updatedAt: 1000,
    worktrees: [{ id: "w1", path, branch: "feature", source: "created", pullRequest }],
  };
  store.create(meta);
  const sent: RunnerToControlPlane[] = [];
  const sm = new SessionManager((message) => sent.push(message), () => {}, store, "test-runner");
  const reads: Array<[string, string]> = [];
  let answer: ForgeMergeQueueFacts | undefined;
  (sm as any).resolveWorktreeMergeQueue = async (url: string, _context: unknown, cwd: string) => {
    reads.push([url, cwd]);
    return answer;
  };
  const refresh = () => (sm as any).refreshWorktreeMergeQueue("s_queue", path, URL) as Promise<void>;
  const recorded = () => store.readMeta("s_queue")!.worktrees![0]!.pullRequest;
  const snapshots = () => sent.filter((message) => message.type === "session_runtime_updated");
  return {
    path, reads, refresh, recorded, snapshots,
    answer: (value: ForgeMergeQueueFacts | undefined) => { answer = value; },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const queued: ForgeMergeQueueFacts = {
  enabled: true, removal: null, entry: { state: "awaiting_checks", position: 1, enqueuedAt: 5, groupChecks: "pending" },
};
const removed: ForgeMergeQueueFacts = { enabled: true, entry: null, removal: { reason: "failed_checks", removedAt: 9 } };

test("a queued, then removed, pull request is recorded on its worktree link and sent once per change", async () => {
  const h = harness({ url: URL, state: "open", provider: "github", kind: "pull_request" });
  try {
    h.answer(queued);
    await h.refresh();
    assert.deepEqual(h.reads, [[URL, h.path]]);
    assert.deepEqual(h.recorded(), { url: URL, state: "open", provider: "github", kind: "pull_request", mergeQueue: queued });
    assert.equal(h.snapshots().length, 1);
    const sent = h.snapshots()[0]!;
    assert.deepEqual(sent.type === "session_runtime_updated" && sent.snapshot.worktrees?.[0]?.pullRequest?.mergeQueue, queued);

    await h.refresh();
    assert.equal(h.snapshots().length, 1, "an unchanged observation writes and sends nothing");

    h.answer(removed);
    await h.refresh();
    assert.deepEqual(h.recorded()?.mergeQueue, removed);
    assert.equal(h.snapshots().length, 2);

    // Queued again and landed: a queue-enabled base with no entry or removal clears the record.
    h.answer({ enabled: true, entry: null, removal: null });
    await h.refresh();
    assert.equal(h.recorded()?.mergeQueue, undefined);
    assert.equal("mergeQueue" in h.recorded()!, false);
    assert.equal(h.snapshots().length, 3);
  } finally {
    h.cleanup();
  }
});

test("a failed read keeps the last observation", async () => {
  const h = harness({ url: URL, state: "open", provider: "github", kind: "pull_request", mergeQueue: queued });
  try {
    h.answer(undefined);
    await h.refresh();
    assert.deepEqual(h.recorded()?.mergeQueue, queued);
    assert.equal(h.snapshots().length, 0);
  } finally {
    h.cleanup();
  }
});

test("a merge request, a closed pull request, or another link is never read", async () => {
  for (const pullRequest of [
    { url: URL, state: "open" as const, provider: "gitlab" as const, kind: "merge_request" as const },
    { url: URL, state: "closed" as const, provider: "github" as const },
    { url: "https://github.com/o/r/pull/8", state: "open" as const, provider: "github" as const },
  ]) {
    const h = harness(pullRequest);
    try {
      h.answer(queued);
      await h.refresh();
      assert.deepEqual(h.reads, [], JSON.stringify(pullRequest));
      assert.equal(h.recorded()?.mergeQueue, undefined);
    } finally {
      h.cleanup();
    }
  }
});
