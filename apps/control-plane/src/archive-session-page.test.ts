import assert from "node:assert/strict";
import test from "node:test";
import {
  ARCHIVE_SESSION_PAGE_SIZE,
  archiveSessionPage,
  parseArchiveSessionPageQuery,
  type ArchiveSessionCandidate,
} from "./archive-session-page.js";

function session(index: number, overrides: Partial<ArchiveSessionCandidate> = {}): ArchiveSessionCandidate {
  return {
    id: `session-${String(index).padStart(3, "0")}`,
    workspaceId: "workspace-1",
    locationName: "Chicago",
    projectId: "project-1",
    projectName: "Wollipog",
    agentId: "codex",
    agentName: "Codex",
    title: `Archived Session ${index}`,
    status: "idle",
    archived: true,
    createdAt: 1_000 - index,
    driver: "codex-app-server",
    ...overrides,
  };
}

test("large authorized catalogs return bounded, complete cursor pages", () => {
  const sessions = Array.from({ length: 125 }, (_, index) => session(index));
  const first = archiveSessionPage({ sessions, query: {} });
  assert.ok(!("error" in first));
  assert.equal(first.sessionIds.length, ARCHIVE_SESSION_PAGE_SIZE);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);

  const second = archiveSessionPage({ sessions, query: { cursor: first.nextCursor! } });
  assert.ok(!("error" in second));
  const third = archiveSessionPage({ sessions, query: { cursor: second.nextCursor! } });
  assert.ok(!("error" in third));
  assert.equal(third.sessionIds.length, 25);
  assert.equal(third.nextCursor, null);
  assert.equal(new Set([...first.sessionIds, ...second.sessionIds, ...third.sessionIds]).size, 125);
});

test("cursor ordering is stable across live updates and excludes later inserts", () => {
  const sessions = Array.from({ length: 70 }, (_, index) => session(index));
  const first = archiveSessionPage({ sessions, query: {} });
  assert.ok(!("error" in first) && first.nextCursor);
  const changed = sessions.map((item) => item.id === "session-060"
    ? { ...item, status: "stopped" as const }
    : item);
  changed.push(session(999, { id: "newer", createdAt: 2_000 }));
  const second = archiveSessionPage({ sessions: changed, query: { cursor: first.nextCursor! } });
  assert.ok(!("error" in second));
  assert.deepEqual(second.sessionIds, sessions.slice(50).map((item) => item.id));
});

test("opaque cursor ids use the same UTF-8 BINARY tie-break as SQLite", () => {
  const ids = ["sa1", "sB1", "𐀀", ""];
  const sessions = ids.map((id, index) => session(index, { id, createdAt: 1_000 }));
  const page = archiveSessionPage({ sessions, query: {} });
  assert.ok(!("error" in page));
  assert.deepEqual(page.sessionIds, [...ids].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))));
});

test("filters include recoverable Stop states and transcript matches without returning unscoped facets", () => {
  const pending = session(1, { archived: false, archiveStatus: "stop_pending", status: "stopped" });
  const failed = session(4, { archived: false, archiveStatus: "stop_failed", status: "stopped" });
  const metadataMatch = session(2, { title: "Release Needle" });
  const transcriptMatch = session(3, { title: "Unrelated", projectName: "Other" });
  const page = archiveSessionPage({
    sessions: [pending, metadataMatch, transcriptMatch],
    query: { q: "needle", archive: "archived" },
    transcriptHits: new Map([[transcriptMatch.id, "a ⟪needle⟫ appeared"]]),
  });
  assert.ok(!("error" in page));
  assert.deepEqual(page.sessionIds, [metadataMatch.id, transcriptMatch.id]);
  assert.equal(page.snippets[transcriptMatch.id], "a ⟪needle⟫ appeared");
  assert.ok(page.facets.projects.includes("Other"));
  const pendingPage = archiveSessionPage({ sessions: [pending], query: {} });
  assert.ok(!("error" in pendingPage));
  assert.deepEqual(pendingPage.sessionIds, [pending.id]);
  const failedPage = archiveSessionPage({ sessions: [failed], query: {} });
  assert.ok(!("error" in failedPage));
  assert.deepEqual(failedPage.sessionIds, [failed.id]);
});

test("server metadata canonicalizes conductor labels and stays aligned with cursor order", () => {
  const conductor = session(1, {
    agentId: "conductor",
    agentName: "Custom Conductor",
    driver: "codex-app-server",
  });
  const page = archiveSessionPage({ sessions: [conductor], query: {} });
  assert.ok(!("error" in page));
  assert.equal(page.metadata[conductor.id]?.agent, "Conductor (Wollipog)");
  assert.deepEqual(page.sessionIds, [conductor.id]);
});

test("server metadata uses the canonical Codex App Server archive label", () => {
  const appServer = session(1, { agentName: "Codex", driver: "codex-app-server" });
  const page = archiveSessionPage({ sessions: [appServer], query: {} });
  assert.ok(!("error" in page));
  assert.equal(page.metadata[appServer.id]?.agent, "Codex App Server");
  assert.deepEqual(page.facets.agents, ["Codex App Server"]);
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

test("repeated query parameters fail closed before filter evaluation", () => {
  assert.deepEqual(parseArchiveSessionPageQuery({ q: ["one", "two"] }), {
    error: "q must be specified at most once",
  });
  assert.deepEqual(parseArchiveSessionPageQuery({ q: "one", archive: "archived" }), {
    q: "one",
    archive: "archived",
  });
});
