import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { SessionReminderView, SessionView } from "@wollipog/protocol";
import { ACTIVITY_BUCKET_MS, recordSessionActivity, type SessionActivity } from "../activity.js";
import { InboxList, type InboxListEntry } from "../components/InboxList.js";
import { threadInboxRows } from "../inbox.js";
import "../styles.css";

/**
 * The Sessions list with one row in every status and treatment (#2209): idle, running with its
 * strip, starting, queued, recently active but idle, blocked with "+N", stalled, waiting on an
 * external job, snoozed, returned, failed, stop failed, unread, selected, and selected and unread.
 *
 * It mounts the list component the Sessions page mounts, inside the same `.inbox-view` and
 * `.inbox-list-pane` wrappers, so the row rules, the list's size container and its padding all apply.
 * The list's own props stand in for the store: the row clock, each row's activity, the stalled set,
 * selection and unread. `?theme=light|dark`, `?density=comfortable`, `?selected=<id>` (default
 * `session-selected`), `?selectedUnread=1` to make the selected row unread too, `?listWidth=<px>` for a
 * narrow list, and `?focus=1` to put keyboard focus in the list.
 *
 * `?family=1` leads with a thread family (#2215): a running parent with a waiting, a stalled, a
 * running and a completed child, threaded by `threadInboxRows()` as InboxView threads them, and its
 * chevron and chip toggle it. `?collapsed=1` starts it collapsed; `?familyTitle=long` gives the
 * parent a title too long for its line.
 */

const QUERY = new URLSearchParams(window.location.search);
const THEME = QUERY.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.theme = THEME;
if (QUERY.get("density") === "comfortable") document.documentElement.dataset.density = "comfortable";
/** A list narrower than its window, as Preview Right draws it. */
const LIST_WIDTH = Number(QUERY.get("listWidth")) || null;

/** The row clock: now, at the middle of its minute, so relative times and the strip agree with the real clock. */
const SESSION_ROWS_NOW = Math.floor(Date.now() / ACTIVITY_BUCKET_MS) * ACTIVITY_BUCKET_MS + 30_000;
const minutes = (count: number) => count * 60_000;

function session(id: string, title: string, extra: Partial<SessionView> = {}): SessionView {
  return {
    id, title, runnerId: "runner-1", workspaceId: "alpha-workspace", projectId: "alpha", status: "idle",
    column: "inbox", archived: false, pendingApproval: null, lastEventAt: SESSION_ROWS_NOW - minutes(42),
    updatedAt: SESSION_ROWS_NOW - minutes(42), createdAt: SESSION_ROWS_NOW - minutes(300), preview: null,
    agentId: "claude-code", agentName: "Claude Code", driver: "claude-code", eventEpoch: 1,
    ...extra,
  } as unknown as SessionView;
}

const branch = (name: string, extra: Record<string, unknown> = {}): Partial<SessionView> => ({
  useWorktree: true,
  worktreePath: `/repos/alpha/.agent-worktrees/${name}`,
  worktrees: [{ id: name, path: `/repos/alpha/.agent-worktrees/${name}`, branch: name, baseRef: "origin/main",
    defaultBranch: "main", source: "created", ...extra }],
} as unknown as Partial<SessionView>);

function activityAt(...minutesAgo: number[]): SessionActivity {
  let activity: SessionActivity | undefined;
  for (const ago of minutesAgo) activity = recordSessionActivity(activity, SESSION_ROWS_NOW - minutes(ago), 1);
  return activity!;
}

const pendingReminder: SessionReminderView = {
  reminderId: "reminder-snoozed", sessionId: "session-snoozed", scheduledFor: SESSION_ROWS_NOW + minutes(150),
  timeZone: "UTC", originalExpression: "in 2.5 hours", wakePolicy: "until_activity", state: "pending",
  revision: 1, createdAt: SESSION_ROWS_NOW - minutes(30), updatedAt: SESSION_ROWS_NOW - minutes(30),
};
const firedReminder: SessionReminderView = {
  reminderId: "reminder-returned", sessionId: "session-returned", scheduledFor: SESSION_ROWS_NOW - minutes(20),
  timeZone: "UTC", originalExpression: "at 2:40 pm", wakePolicy: "regardless", state: "fired", revision: 2,
  createdAt: SESSION_ROWS_NOW - minutes(80), updatedAt: SESSION_ROWS_NOW - minutes(20),
  firedAt: SESSION_ROWS_NOW - minutes(20), wakeReason: "scheduled",
};

/** Every row, in the order the evidence reads them. Ids name what each row demonstrates. */
const SESSION_ROWS: readonly InboxListEntry[] = [
  { session: session("session-selected", "Selected: Wire the Row Status Into the Board Card", {
    status: "running", lastEventAt: SESSION_ROWS_NOW - minutes(1), ...branch("feat/board-row-status") }),
    projectName: "Wollipog", unread: false },
  { session: session("session-running", "Running: Rebuild the Activity Strip at 48 by 12", {
    status: "running", lastEventAt: SESSION_ROWS_NOW - minutes(0),
    ...branch("fix/activity-strip-size", { pullRequest: { url: "https://example.test/pull/1", state: "open" } }) }),
    projectName: "Wollipog", unread: false },
  { session: session("session-recent", "Recently Active but Idle: Summarize the Benchmark Run", {
    lastEventAt: SESSION_ROWS_NOW - minutes(4) }), projectName: "Benchmarks", unread: false },
  { session: session("session-blocked", "Blocked: Approve the Migration and Answer Two Questions", {
    status: "input_required", lastEventAt: SESSION_ROWS_NOW - minutes(6),
    pendingApproval: { requestId: "a", options: [], title: "Run the migration?", additionalRequests: [
      { requestId: "q1", options: [], title: "Which database?", kind: "question" },
      { requestId: "q2", options: [], title: "Which region?", kind: "question" },
    ] } } as unknown as Partial<SessionView>), projectName: "Wollipog", unread: true },
  { session: session("session-stalled", "Stalled: Index the Archive While the Runner Is Silent", {
    status: "running", lastEventAt: SESSION_ROWS_NOW - minutes(17), ...branch("chore/archive-index") }),
    projectName: "Wollipog", unread: false },
  { session: session("session-unread", "Unread: Review the Overnight Test Failures", {
    lastEventAt: SESSION_ROWS_NOW - minutes(25) }), projectName: "Wollipog", unread: true },
  { session: session("session-snoozed", "Snoozed: Revisit the Flaky Merge-Group Test", {}),
    projectName: "Wollipog", unread: false, reminder: pendingReminder },
  // The densest phone status line: a long badge, the strip and a weekday return time at once.
  { session: session("session-snoozed-blocked", "Snoozed and Blocked: Sign In to the Package Registry", {
    status: "input_required", lastEventAt: SESSION_ROWS_NOW - minutes(3),
    pendingApproval: { kind: "authentication", requestId: "provider-auth:registry", title: "Authentication Required", options: [] },
  } as unknown as Partial<SessionView>), projectName: "Wollipog", unread: false,
  reminder: { ...pendingReminder, reminderId: "reminder-snoozed-blocked", sessionId: "session-snoozed-blocked",
    scheduledFor: SESSION_ROWS_NOW + minutes(60 * 24 * 3) } },
  { session: session("session-returned","Returned From Snooze: Check the Release Notes", {}),
    projectName: "Docs", unread: false, reminder: firedReminder },
  { session: session("session-external", "Waiting on an External Job: Nightly Bundle Build", {
    backgroundWorkState: "running" }), projectName: "Wollipog", unread: false },
  { session: session("session-starting", "Starting: Draft the Phone Card Copy", { status: "starting",
    lastEventAt: SESSION_ROWS_NOW - minutes(0) }), projectName: "Wollipog", unread: false },
  { session: session("session-queued", "Queued: Port the Settings Rows", { status: "queued" }),
    projectName: "Wollipog", unread: false },
  { session: session("session-stop-failed", "Stop Failed: Long-Running Profiler", {
    status: "stopped", lastEventAt: null, updatedAt: SESSION_ROWS_NOW - minutes(9),
    stopOperation: { operationId: "stop-1", status: "stop_failed", requestedAt: 1, lastAttemptAt: 2, attemptCount: 3,
      capacityReleased: false, failure: { code: "runner_rejected", message: "Stop failed.", failedAt: 3 } },
  } as unknown as Partial<SessionView>), projectName: "Wollipog", unread: false },
  { session: session("session-failed", "Failed: Generate the Changelog", { status: "failed",
    lastEventAt: SESSION_ROWS_NOW - minutes(95) }), projectName: "Docs", unread: false },
  { session: session("session-idle", "Idle: Plan the Next Sessions List Unit", {
    lastEventAt: SESSION_ROWS_NOW - minutes(180), ...branch("plan/sessions-list") }), projectName: "Wollipog", unread: false },
];

const FAMILY = QUERY.has("family");
const FAMILY_TITLE = QUERY.get("familyTitle") === "long"
  ? "Family Parent: Ship the Usage and Cost Overhaul Across the Control Plane, the Runner, the Web App, the Phone "
    + "App and Every Desktop Build, With Budgets, Allowance Windows, Cost Sources and the Daily Rollover Report"
  : "Family Parent: Ship the Usage Overhaul";
const familyChild = (id: string, title: string, extra: Partial<SessionView>) =>
  ({ session: session(id, title, { parentSessionId: "family-parent", ...extra }), projectName: "Wollipog", unread: false });
/** A thread family (#2215), in the order InboxView would hand it over. */
const FAMILY_ROWS: readonly InboxListEntry[] = [
  { session: session("family-parent", FAMILY_TITLE, { status: "running", lastEventAt: SESSION_ROWS_NOW - minutes(1),
    role: "orchestrator", preview: "Four children are working through the usage overhaul; one is waiting on you." } as Partial<SessionView>),
  projectName: "Wollipog", unread: false },
  familyChild("family-waiting", "Waiting Child: Keep Protocol 105 or Bump to 106?", {
    status: "input_required", lastEventAt: SESSION_ROWS_NOW - minutes(3),
    pendingApproval: { requestId: "family-ask", kind: "question", title: "Keep protocol 105 or bump to 106?", options: [] },
  } as unknown as Partial<SessionView>),
  familyChild("family-stalled", "Stalled Child: Normalize the Allowance Window", {
    status: "running", lastEventAt: SESSION_ROWS_NOW - minutes(14) }),
  familyChild("family-running", "Running Child: Add the Usage Table", {
    status: "running", lastEventAt: SESSION_ROWS_NOW - minutes(0) }),
  familyChild("family-done", "Completed Child: Roll the Daily Budget Over", {
    status: "completed", lastEventAt: SESSION_ROWS_NOW - minutes(30) }),
];
const STALLED = new Set(["session-stalled", "family-stalled"]);

const ACTIVITY = new Map<string, SessionActivity>([
  ["family-parent", activityAt(1, 2, 4, 9)],
  ["family-stalled", activityAt(14, 15, 19)],
  ["family-running", activityAt(0, 0, 1, 3)],
  ["session-selected", activityAt(1, 2, 2, 3, 5, 8, 9, 12, 14, 20)],
  ["session-running", activityAt(0, 0, 0, 1, 1, 2, 4, 6, 6, 7, 11, 15, 16, 22, 28)],
  ["session-recent", activityAt(4, 5, 5, 7, 9, 13, 18)],
  ["session-blocked", activityAt(6, 7, 8, 12)],
  ["session-stalled", activityAt(17, 18, 21, 23)],
  ["session-starting", activityAt(0)],
  ["session-snoozed-blocked", activityAt(3, 4, 6)],
]);

function SessionRows() {
  const [selected, setSelected] = useState(QUERY.get("selected") ?? "session-selected");
  // The selected row is also unread when asked, so one capture shows selected-and-unread.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(QUERY.get("collapsed") ? ["family-parent"] : []));
  const rows = SESSION_ROWS.map((entry) => QUERY.get("selectedUnread") && entry.session.id === selected
    ? { ...entry, unread: true }
    : entry);
  const entries = FAMILY ? threadInboxRows([...FAMILY_ROWS, ...rows], collapsed, STALLED) : rows;
  const toggleThread = (sessionId: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (!next.delete(sessionId)) next.add(sessionId);
    return next;
  });
  return (
    <div className="inbox-view" style={{ height: "100vh" }}>
      <div className="inbox-list-pane" style={{ flex: 1, width: LIST_WIDTH ? `${LIST_WIDTH}px` : undefined }}>
        <InboxList
          entries={entries}
          selectedSessionId={selected}
          pinnedSessionIds={new Set(["session-running"])}
          activityBySession={ACTIVITY}
          stalledSessionIds={STALLED}
          activityNow={SESSION_ROWS_NOW}
          runningCount={2}
          queuedCount={1}
          startingCount={1}
          filtered={false}
          onNewSession={() => undefined}
          onSelect={setSelected}
          onToggleThread={toggleThread}
          onExpand={() => undefined}
          onSessionMenu={() => undefined}
          onScrollPosition={() => undefined}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<SessionRows />);
if (QUERY.get("focus")) {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(".inbox-list")?.focus({ focusVisible: true } as FocusOptions));
}
