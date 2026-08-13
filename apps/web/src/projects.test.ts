import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionView } from "@wollipog/protocol";
import { groupLegacySessionsByWorkspace, legacyWorkspaceLocationsByName } from "./projects.js";

function s(over: Partial<SessionView>): SessionView {
  return {
    id: "s1",
    runnerId: "r1",
    workspaceId: null,
    workspaceName: null,
    agentId: "a1",
    agentName: "Claude",
    title: "t",
    status: "idle",
    column: "review",
    runId: null,
    useWorktree: false,
    worktreePath: null,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
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
    ...over,
  };
}

test("legacy workspace locations remain distinct by runner and workspace", () => {
  const locs = legacyWorkspaceLocationsByName(
    [
      s({ id: "a", runnerId: "box-1", workspaceId: "ws", workspaceName: "nexus", updatedAt: 10 }),
      s({ id: "b", runnerId: "box-1", workspaceId: "ws", workspaceName: "nexus", updatedAt: 40 }), // same loc, newer
      s({ id: "c", runnerId: "box-2", workspaceId: "ws", workspaceName: "nexus", updatedAt: 30 }), // other machine
      s({ id: "d", runnerId: "box-2", workspaceId: "ws", workspaceName: "other", updatedAt: 99 }), // different project
      s({ id: "e", runnerId: "box-3", workspaceId: "ws", workspaceName: "nexus", updatedAt: 20, archived: true }), // archived
      s({ id: "f", runnerId: "box-4", workspaceId: null, updatedAt: 50 }), // repo-less
    ],
    "nexus",
  );
  assert.deepEqual(locs, [
    { runnerId: "box-1", workspaceId: "ws", lastUpdated: 40, count: 2 },
    { runnerId: "box-2", workspaceId: "ws", lastUpdated: 30, count: 1 },
  ]);
});

test("legacy workspace grouping buckets null under Chats and preserves ordering", () => {
  const groups = groupLegacySessionsByWorkspace([
    s({ id: "a", workspaceId: "ws-b", workspaceName: "beta", updatedAt: 10 }),
    s({ id: "b", workspaceId: "ws-a", workspaceName: "alpha", updatedAt: 20 }),
    s({ id: "c", workspaceId: "ws-a", workspaceName: "alpha", updatedAt: 30 }),
    s({ id: "d", workspaceId: null, updatedAt: 5 }), // repo-less → Chats
  ]);

  assert.deepEqual(
    groups.map((g) => [g.name, g.sessions.length]),
    [
      ["alpha", 2],
      ["beta", 1],
      ["Chats", 1],
    ], // projects alphabetical, Chats last
  );
  // within alpha: most-recently-updated first
  assert.deepEqual(
    groups[0].sessions.map((x) => x.id),
    ["c", "b"],
  );
  assert.equal(groups[2].id, null); // Chats bucket carries a null id
});

test("legacy workspace grouping excludes archived sessions", () => {
  const groups = groupLegacySessionsByWorkspace([
    s({ id: "a", workspaceId: "ws-a", workspaceName: "alpha" }),
    s({ id: "b", workspaceId: "ws-a", workspaceName: "alpha", archived: true }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sessions.length, 1);
  assert.equal(groups[0].sessions[0].id, "a");
});

test("legacy workspace grouping falls back to workspaceId when the name is missing", () => {
  const groups = groupLegacySessionsByWorkspace([s({ id: "a", workspaceId: "ws-x", workspaceName: null })]);
  assert.equal(groups[0].name, "ws-x");
});

test("legacy pinned workspace groups sort first while Chats stays last", () => {
  const sessions = [
    s({ id: "a", workspaceId: "ws-b", workspaceName: "beta" }),
    s({ id: "b", workspaceId: "ws-a", workspaceName: "alpha" }),
    s({ id: "c", workspaceId: "ws-z", workspaceName: "zeta" }),
    s({ id: "d", workspaceId: null }),
  ];
  const unpinned = groupLegacySessionsByWorkspace(sessions);
  assert.deepEqual(unpinned.map((g) => g.name), ["alpha", "beta", "zeta", "Chats"]);

  const zetaKey = unpinned.find((g) => g.name === "zeta")!.key;
  const pinned = groupLegacySessionsByWorkspace(sessions, new Set([zetaKey]));
  assert.deepEqual(pinned.map((g) => g.name), ["zeta", "alpha", "beta", "Chats"]);

  // Pinning the Chats key must not hoist it — Chats is always last.
  const chatsKey = unpinned.find((g) => g.id === null)!.key;
  const chatsPinned = groupLegacySessionsByWorkspace(sessions, new Set([chatsKey]));
  assert.equal(chatsPinned[chatsPinned.length - 1]!.id, null);
});

test("legacy grouping sorts pinned sessions first within each workspace", () => {
  const sessions = [
    s({ id: "a", workspaceId: "ws-a", workspaceName: "alpha", updatedAt: 30 }),
    s({ id: "b", workspaceId: "ws-a", workspaceName: "alpha", updatedAt: 20 }),
    s({ id: "c", workspaceId: "ws-a", workspaceName: "alpha", updatedAt: 10 }),
    s({ id: "d", workspaceId: "ws-b", workspaceName: "beta", updatedAt: 5 }),
  ];
  // No pins → pure recency.
  assert.deepEqual(
    groupLegacySessionsByWorkspace(sessions)[0].sessions.map((x) => x.id),
    ["a", "b", "c"],
  );
  // Pin the two OLDEST — they hoist above the newest, keeping recency between themselves.
  const groups = groupLegacySessionsByWorkspace(sessions, undefined, new Set(["c", "b"]));
  assert.deepEqual(
    groups[0].sessions.map((x) => x.id),
    ["b", "c", "a"],
  );
  // A pin in one group must not leak ordering into another.
  assert.deepEqual(
    groups[1].sessions.map((x) => x.id),
    ["d"],
  );
});

test("legacy grouping does not merge the same workspaceId across runners", () => {
  // Remote boxes commonly reuse ids like "home" — these must stay separate projects.
  const groups = groupLegacySessionsByWorkspace([
    s({ id: "a", runnerId: "box-1", workspaceId: "home", workspaceName: "home" }),
    s({ id: "b", runnerId: "box-2", workspaceId: "home", workspaceName: "home" }),
  ]);
  assert.equal(groups.length, 2, "one project per runner, not merged");
  assert.deepEqual(
    groups.map((g) => g.sessions.length),
    [1, 1],
  );
  assert.notEqual(groups[0].key, groups[1].key); // distinct, runner-scoped keys
});

test("project keys with spaces in ids never collide", () => {
  const a = s({ id: "1", runnerId: "box a", workspaceId: "repo", workspaceName: "repo" });
  const b = s({ id: "2", runnerId: "box", workspaceId: "a repo", workspaceName: "a repo" });
  const groups = groupLegacySessionsByWorkspace([a, b]);
  assert.equal(groups.length, 2, "distinct (runner, workspace) pairs must stay distinct groups");
});
