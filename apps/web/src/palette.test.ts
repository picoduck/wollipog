import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionView } from "@wollipog/protocol";
import { matchSessions } from "./palette.js";

function s(over: Partial<SessionView>): SessionView {
  return {
    id: "s1",
    runnerId: "r1",
    workspaceId: "w",
    workspaceName: "repo",
    agentId: "a",
    agentName: "Claude Code",
    title: "Fix the login bug",
    status: "idle",
    column: "review",
    runId: null,
    useWorktree: false,
    worktreePath: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    lastEventAt: null,
    messageCount: 0,
    preview: null,
    pendingApproval: null,
    driver: "claude-code",
    model: null,
    effort: null,
    permissionMode: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    adopted: false,
    costBudgetUsd: null,
    maxToolCalls: null,
    ...over,
  } as SessionView;
}

test("matchSessions: all terms must match; title hits outrank workspace hits; recency breaks ties", () => {
  const sessions = [
    s({ id: "a", title: "Fix the login bug", updatedAt: 1 }),
    s({ id: "b", title: "Refactor auth", workspaceName: "login-service", updatedAt: 2 }),
    s({ id: "c", title: "Unrelated", workspaceName: "other", updatedAt: 3 }),
  ];
  const hits = matchSessions(sessions, "login", 10);
  assert.deepEqual(
    hits.map((h) => (h.view as { id: string }).id),
    ["a", "b"],
    "title match first, workspace match second, non-match dropped",
  );
  assert.equal(matchSessions(sessions, "login bug", 10).length, 1, "every term must match");
});

test("matchSessions: empty query lists recent live and archived sessions", () => {
  const sessions = [
    s({ id: "a", updatedAt: 1 }),
    s({ id: "b", updatedAt: 5 }),
    s({ id: "z", archived: true, updatedAt: 99 }),
  ];
  const hits = matchSessions(sessions, "", 10);
  assert.deepEqual(
    hits.map((h) => (h.view as { id: string }).id),
    ["z", "b", "a"],
  );
  assert.match(hits[0]?.detail ?? "", /Archived/);
});

test("matchSessions normalizes both persisted Conductor labels for display and search", () => {
  const sessions = [
    s({ id: "legacy", agentId: "conductor", agentName: "Conductor (Agent Manager)" }),
    s({ id: "current", agentId: "conductor", agentName: "Conductor (Wollipog)" }),
  ];
  const hits = matchSessions(sessions, "wollipog", 10);
  assert.deepEqual(hits.map((hit) => (hit.view as { id: string }).id), ["legacy", "current"]);
  for (const hit of hits) {
    assert.match(hit.detail ?? "", /Conductor \(Wollipog\)/);
    assert.doesNotMatch(hit.detail ?? "", /Agent Manager/);
  }
});
