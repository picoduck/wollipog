import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionView } from "@wollipog/protocol";
import {
  matchSessions,
  paletteSections,
  snippetFromWordBoundary,
  transcriptQueryTooShort,
  type PaletteEntry,
} from "./palette.js";

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
  assert.match(hits[0]?.detail ?? "", /Awaiting Prompt/, "archive and lifecycle remain independent metadata");
});


const destinations: PaletteEntry[] = [
  { kind: "destination", key: "go-to:inbox", label: "Sessions", icon: "inbox", view: { name: "inbox" }, keys: "1" },
  { kind: "destination", key: "go-to:projects", label: "Projects", icon: "projects", view: { name: "projects" }, keys: "3" },
  { kind: "destination", key: "go-to:settings:Appearance", label: "Appearance", detail: "Settings", icon: "settings",
    view: { name: "settings", section: "appearance" } },
];
const actions: PaletteEntry[] = [
  { kind: "action", key: "action:toggle-sessions-view", action: "toggle-sessions-view", label: "Switch to Board View", icon: "board" },
  { kind: "action", key: "action:toggle-rail-labels", action: "toggle-rail-labels", label: "Show Navigation Labels", icon: "labels-on" },
];
const byId = (...sessions: SessionView[]) => new Map(sessions.map((session) => [session.id, session]));
const shape = (sections: ReturnType<typeof paletteSections>) =>
  sections.map((section) => [section.label, section.entries.map((entry) => entry.label)]);

test("paletteSections: an empty query is Recent, Go To and Actions, in that order", () => {
  const sessions = byId(s({ id: "a", title: "Alpha", updatedAt: 9 }), s({ id: "b", title: "Beta", updatedAt: 1 }));
  const sections = paletteSections({ query: "  ", sessions, recent: ["b", "gone", "a"], hits: [], destinations, actions });
  assert.deepEqual(shape(sections), [
    ["Recent", ["Beta", "Alpha"]],
    ["Go To", ["Sessions", "Projects", "Appearance"]],
    ["Actions", ["Switch to Board View", "Show Navigation Labels"]],
  ], "Recent keeps the opened order, not recency of update, and skips a session it cannot name");
  assert.equal(sections[1]!.entries[2]!.detail, "Settings", "a Settings section reads as the section over Settings");
  assert.equal(sections[1]!.entries[0]!.keys, "1", "a destination keeps its digit");
});

test("paletteSections: nothing opened yet leaves Recent out rather than showing it empty", () => {
  const sections = paletteSections({ query: "", sessions: byId(s({ id: "a" })), recent: [], hits: [], destinations, actions });
  assert.deepEqual(sections.map((section) => section.id), ["go-to", "actions"]);
});

test("paletteSections: a query lists Sessions, In Transcripts, Go To and Actions that match", () => {
  const sessions = byId(
    s({ id: "a", title: "Board migration", updatedAt: 2 }),
    s({ id: "b", title: "Other work", updatedAt: 1 }),
  );
  const sections = paletteSections({
    query: "board",
    sessions,
    recent: ["b"],
    hits: [{ sessionId: "b", title: "Other work", snippet: "moved the ⟪board⟫ columns" }],
    destinations,
    actions,
  });
  assert.deepEqual(shape(sections), [
    ["Sessions", ["Board migration"]],
    ["In Transcripts", ["Other work"]],
    ["Actions", ["Switch to Board View"]],
  ]);
  assert.equal(sections[1]!.entries[0]!.kind, "transcript");
  assert.equal(paletteSections({ query: "settings", sessions, recent: [], hits: [], destinations, actions })[0]!.entries[0]!.label,
    "Appearance", "Go To matches a row's second line too, so \"settings\" finds every section");
});

test("paletteSections: a session matched by title and by transcript appears once, snippet third", () => {
  const sessions = byId(s({ id: "a", title: "Fix the login bug" }));
  const sections = paletteSections({
    query: "login",
    sessions,
    recent: [],
    hits: [
      { sessionId: "a", title: "Fix the login bug", snippet: "the ⟪login⟫ form" },
      { sessionId: "a", title: "Fix the login bug", snippet: "a weaker ⟪login⟫ hit" },
    ],
    destinations,
    actions,
  });
  assert.deepEqual(shape(sections), [["Sessions", ["Fix the login bug"]]]);
  const row = sections[0]!.entries[0]!;
  assert.equal(row.snippet, "the ⟪login⟫ form", "the server's best hit for the session is its third line");
  assert.match(row.detail ?? "", /Awaiting Prompt/, "the second line is still the session's facts");
});

test("paletteSections: a session row's dot says what the session needs before its lifecycle", () => {
  const running = paletteSections({ query: "a", sessions: byId(s({ id: "a", title: "a", status: "running" })), recent: [], hits: [], destinations: [], actions: [] });
  const entry = running[0]!.entries[0]!;
  assert.equal(entry.kind === "session" && entry.status.tone, "info");
  assert.equal(entry.kind === "session" && entry.status.pulse, true);
  const waiting = s({ id: "w", title: "w", status: "running",
    pendingApproval: { requestId: "r", kind: "permission", toolName: "Bash", input: {}, createdAt: 1 } as never });
  const approval = paletteSections({ query: "w", sessions: byId(waiting), recent: [], hits: [], destinations: [], actions: [] })[0]!.entries[0]!;
  assert.equal(approval.kind === "session" && approval.status.tone, "warning");
});

test("transcriptQueryTooShort: one or two characters get the hint; none and three do not", () => {
  assert.equal(transcriptQueryTooShort(""), false);
  assert.equal(transcriptQueryTooShort("   "), false);
  assert.equal(transcriptQueryTooShort("a"), true);
  assert.equal(transcriptQueryTooShort(" ab "), true);
  assert.equal(transcriptQueryTooShort("abc"), false);
});

test("snippetFromWordBoundary: a snippet cut mid-text starts at a whole word", () => {
  assert.equal(snippetFromWordBoundary("…t work because the ⟪login⟫ failed"), "…work because the ⟪login⟫ failed",
    "the fragment after the ellipsis is dropped");
  assert.equal(snippetFromWordBoundary("…name, and then ⟪login⟫"), "…and then ⟪login⟫",
    "punctuation left in front of the next word goes too");
  assert.equal(snippetFromWordBoundary("…⟪login⟫ failed"), "…⟪login⟫ failed", "a first word holding the match stays");
  assert.equal(snippetFromWordBoundary("…mid⟪login⟫ failed"), "…mid⟪login⟫ failed");
  assert.equal(snippetFromWordBoundary("The ⟪login⟫ failed"), "The ⟪login⟫ failed", "the start of a text is kept whole");
  assert.equal(snippetFromWordBoundary("…lonely"), "…lonely", "a snippet of one word keeps it");
});
