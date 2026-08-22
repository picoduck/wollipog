import assert from "node:assert/strict";
import test from "node:test";
import type { SessionView } from "@wollipog/protocol";
import { ARCHIVE_SESSION_PAGE_SIZE, archiveSessionPage } from "./archive-session-page.js";

function session(index: number, overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: `session-${String(index).padStart(3, "0")}`,
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    workspaceName: "Chicago",
    projectId: "project-1",
    projectName: "Wollipog",
    projectLocationId: null,
    agentId: "codex",
    agentName: "Codex",
    title: `Archived Session ${index}`,
    status: "idle",
    column: "review",
    runId: null,
    useWorktree: false,
    worktreePath: null,
    archived: true,
    createdAt: 1_000 - index,
    updatedAt: 1_000 - index,
    lastEventAt: null,
    messageCount: 0,
    preview: null,
    pendingApproval: null,
    driver: "codex-app-server",
    model: null,
    effort: null,
    permissionMode: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    adopted: false,
    costBudgetUsd: null,
    maxToolCalls: null,
    ...overrides,
  } as SessionView;
}

test("large authorized catalogs return bounded, complete cursor pages", () => {
  const sessions = Array.from({ length: 125 }, (_, index) => session(index));
  const first = archiveSessionPage({ sessions, query: {} });
  assert.ok(!("error" in first));
  assert.equal(first.sessions.length, ARCHIVE_SESSION_PAGE_SIZE);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);

  const second = archiveSessionPage({ sessions, query: { cursor: first.nextCursor! } });
  assert.ok(!("error" in second));
  const third = archiveSessionPage({ sessions, query: { cursor: second.nextCursor! } });
  assert.ok(!("error" in third));
  assert.equal(third.sessions.length, 25);
  assert.equal(third.nextCursor, null);
  assert.equal(new Set([...first.sessions, ...second.sessions, ...third.sessions].map((item) => item.id)).size, 125);
});

test("cursor ordering is stable across live updates and excludes later inserts", () => {
  const sessions = Array.from({ length: 70 }, (_, index) => session(index));
  const first = archiveSessionPage({ sessions, query: {} });
  assert.ok(!("error" in first) && first.nextCursor);
  const changed = sessions.map((item) => item.id === "session-060"
    ? { ...item, updatedAt: 99_999, status: "stopped" as const }
    : item);
  changed.push(session(999, { id: "newer", createdAt: 2_000, updatedAt: 2_000 }));
  const second = archiveSessionPage({ sessions: changed, query: { cursor: first.nextCursor! } });
  assert.ok(!("error" in second));
  assert.deepEqual(second.sessions.map((item) => item.id), sessions.slice(50).map((item) => item.id));
  assert.equal(second.sessions.find((item) => item.id === "session-060")?.status, "stopped");
});

test("filters include Stop Pending and transcript matches without returning unscoped facets", () => {
  const pending = session(1, { archived: false, archiveStatus: "stop_pending", status: "stopped" });
  const metadataMatch = session(2, { title: "Release Needle" });
  const transcriptMatch = session(3, { title: "Unrelated", projectName: "Other" });
  const page = archiveSessionPage({
    sessions: [pending, metadataMatch, transcriptMatch],
    query: { q: "needle", archive: "archived" },
    transcriptHits: new Map([[transcriptMatch.id, "a ⟪needle⟫ appeared"]]),
  });
  assert.ok(!("error" in page));
  assert.deepEqual(page.sessions.map((item) => item.id), [metadataMatch.id, transcriptMatch.id]);
  assert.equal(page.snippets[transcriptMatch.id], "a ⟪needle⟫ appeared");
  assert.ok(page.facets.projects.includes("Other"));
  const pendingPage = archiveSessionPage({ sessions: [pending], query: {} });
  assert.ok(!("error" in pendingPage));
  assert.deepEqual(pendingPage.sessions.map((item) => item.id), [pending.id]);
});

test("malformed and mismatched cursors fail closed", () => {
  assert.deepEqual(archiveSessionPage({ sessions: [], query: { cursor: "not-json" } }), {
    error: "cursor is invalid",
  });
  const malformed = Buffer.from(JSON.stringify({ version: 1, anchorCreatedAt: -1 })).toString("base64url");
  assert.deepEqual(archiveSessionPage({ sessions: [], query: { cursor: malformed } }), {
    error: "cursor is invalid",
  });
  const sessions = Array.from({ length: 51 }, (_, index) => session(index));
  const first = archiveSessionPage({ sessions, query: { project: "Wollipog" } });
  assert.ok(!("error" in first) && first.nextCursor);
  assert.deepEqual(
    archiveSessionPage({ sessions, query: { cursor: first.nextCursor!, project: "Other" } }),
    { error: "cursor does not match filters" },
  );
});
