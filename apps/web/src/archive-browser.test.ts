import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionStatus, SessionView } from "@wollipog/protocol";
import {
  ARCHIVE_PAGE_SIZE,
  CANONICAL_LIFECYCLE_LABELS,
  filterArchiveSessions,
  mergeArchiveSessionCatalog,
  pageArchiveSessions,
  sessionArchiveSearchDetail,
  type ArchiveBrowserFilters,
} from "./archive-browser.js";

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "session-1",
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    workspaceName: "Chicago",
    projectId: "project-1",
    projectName: "Wollipog",
    projectLocationId: "location-1",
    agentId: "codex",
    agentName: "Codex",
    title: "Archive browser",
    status: "idle",
    column: "review",
    runId: null,
    useWorktree: false,
    worktreePath: null,
    archived: true,
    createdAt: 1,
    updatedAt: 10,
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

const defaults: ArchiveBrowserFilters = {
  query: "",
  project: "all",
  location: "all",
  agent: "all",
  archive: "archived",
  lifecycle: "all",
};

test("archive search surfaces archive and every canonical lifecycle label independently", () => {
  const expected: Record<SessionStatus, string> = {
    queued: "Queued",
    starting: "Starting",
    running: "Running",
    input_required: "Input Required",
    idle: "Idle",
    completed: "Completed",
    failed: "Failed",
    stopped: "Stopped",
  };
  assert.deepEqual(CANONICAL_LIFECYCLE_LABELS, expected);
  for (const [status, label] of Object.entries(expected) as [SessionStatus, string][]) {
    assert.equal(sessionArchiveSearchDetail(session({ status })), `Archived · ${label} · Wollipog · Codex — Interactive`);
  }
  assert.equal(
    sessionArchiveSearchDetail(session({ archived: false, status: "queued" })),
    "Queued · Wollipog · Codex — Interactive",
  );
});

test("archive filters combine Project, Location, agent, archive, lifecycle, and metadata search", () => {
  const locations = new Map([["location-1", "Local Checkout"], ["location-2", "Remote Checkout"]]);
  const sessions = [
    session({ id: "match", title: "Release notes", status: "input_required" }),
    session({ id: "wrong-location", projectLocationId: "location-2", status: "input_required" }),
    session({ id: "not-archived", archived: false, status: "input_required" }),
    session({ id: "wrong-state", status: "running" }),
  ];
  const result = filterArchiveSessions({
    sessions,
    locationNames: locations,
    filters: {
      ...defaults,
      query: "release",
      project: "Wollipog",
      location: "Local Checkout",
      agent: "Codex — Interactive",
      lifecycle: "input_required",
    },
  });
  assert.deepEqual(result.map((item) => item.id), ["match"]);
});

test("the default Archived filter includes Stop Pending recovery but excludes ordinary active rows", () => {
  const archived = session({ id: "archived", updatedAt: 3 });
  const pending = session({
    id: "pending",
    archived: false,
    status: "stopped",
    archiveStatus: "stop_pending",
    updatedAt: 2,
  });
  const failed = session({
    id: "failed-stop",
    archived: false,
    status: "stopped",
    archiveStatus: "stop_failed",
    updatedAt: 2.5,
  });
  const active = session({ id: "active", archived: false, status: "running", updatedAt: 1 });
  assert.deepEqual(filterArchiveSessions({
    sessions: [archived, pending, failed, active],
    filters: defaults,
  }).map((item) => item.id), ["archived", "failed-stop", "pending"]);
  assert.deepEqual(filterArchiveSessions({
    sessions: [archived, pending, failed, active],
    filters: { ...defaults, archive: "unarchived" },
  }).map((item) => item.id), ["active"]);
});

test("transcript matches extend metadata search without bypassing the other filters", () => {
  const archived = session({ id: "archived", title: "Unrelated" });
  const visible = session({ id: "visible", archived: false, title: "Unrelated" });
  assert.deepEqual(filterArchiveSessions({
    sessions: [archived, visible],
    filters: { ...defaults, query: "needle" },
    transcriptSessionIds: new Set(["archived", "visible"]),
  }).map((item) => item.id), ["archived"]);
});

test("large archives have deterministic ordering and complete pagination", () => {
  const sessions = Array.from({ length: 125 }, (_, index) => session({
    id: `session-${String(index).padStart(3, "0")}`,
    updatedAt: index < 2 ? 999 : index,
  }));
  const filtered = filterArchiveSessions({ sessions, filters: defaults });
  assert.deepEqual(filtered.slice(0, 2).map((item) => item.id), ["session-000", "session-001"],
    "stable id ordering breaks equal-time ties");
  const first = pageArchiveSessions(filtered, 1);
  const last = pageArchiveSessions(filtered, 99);
  assert.equal(first.sessions.length, ARCHIVE_PAGE_SIZE);
  assert.equal(last.page, 3, "out-of-range deep state clamps to the last real page");
  assert.equal(last.sessions.length, 25);
  assert.equal(new Set([...first.sessions, ...pageArchiveSessions(filtered, 2).sessions, ...last.sessions]).size, 125);
});

test("multi-client upserts replace catalog rows without duplicating them", () => {
  const initial = session({ id: "shared", status: "running", updatedAt: 1 });
  const remoteUpdate = session({ id: "shared", status: "stopped", updatedAt: 2 });
  const added = session({ id: "new", status: "queued", updatedAt: 3 });
  const merged = mergeArchiveSessionCatalog(new Map([[initial.id, initial]]), [remoteUpdate, added]);
  assert.equal(merged.size, 2);
  assert.equal(merged.get("shared")?.status, "stopped");
  assert.equal(merged.get("new")?.status, "queued");
});
