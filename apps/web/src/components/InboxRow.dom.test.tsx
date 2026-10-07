import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionReminderView, SessionView } from "@wollipog/protocol";
import { ACTIVITY_BUCKET_MS, recordSessionActivity, type SessionActivity } from "../activity.js";
import { InboxRow, type InboxRowProps } from "./InboxRow.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

/** A fixed row clock, on a minute boundary plus thirty seconds. */
const NOW = 1_000_000 * ACTIVITY_BUCKET_MS + 30_000;

const baseSession = (extra: Partial<SessionView> = {}): SessionView => ({
  id: "session", runnerId: "runner-1", title: "Session", status: "idle", column: "inbox", archived: false,
  pendingApproval: null, lastEventAt: null, updatedAt: NOW - 60_000, createdAt: NOW - 120_000, preview: null,
  agentId: "codex", agentName: "Codex", driver: "codex-app-server", ...extra,
} as unknown as SessionView);

type RowOptions = Partial<Omit<InboxRowProps, "session">>;

/** Renders one row (desktop shape unless asked), runs the assertions, and can re-render with new props. */
async function withRow(
  session: SessionView,
  assertions: (container: HTMLDivElement, rerender: (options: RowOptions) => Promise<void>) => void | Promise<void>,
  options: RowOptions = {},
): Promise<void> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = (extra: RowOptions) => act(async () => root.render(<InboxRow
    optionId="session-option" session={session} projectName="Project One"
    selected={false} unread={false} pinned={false} rowIndex={1}
    stalled={false} activityNow={NOW} threeRow={false}
    onSelect={() => undefined} onExpand={() => undefined} onSessionMenu={() => undefined}
    {...options} {...extra}
  />));
  await render({});
  try {
    await assertions(container, render);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

const badges = (container: Element) => [...container.querySelectorAll<HTMLElement>(".status")];
const minutesAgo = (minutes: number): SessionActivity => recordSessionActivity(undefined, NOW - minutes * ACTIVITY_BUCKET_MS);

test("a blocked row with an approval and two questions shows one badge plus \"+1\" and no lifecycle badge", async () => {
  const session = baseSession({
    status: "input_required",
    pendingApproval: {
      requestId: "a", options: [], title: "Run the migration?", additionalRequests: [
        { requestId: "q1", options: [], title: "Which database?", kind: "question" },
        { requestId: "q2", options: [], title: "Which region?", kind: "question" },
      ],
    },
  } as unknown as Partial<SessionView>);
  for (const threeRow of [false, true]) {
    await withRow(session, (container) => {
      const shown = badges(container);
      assert.equal(shown.length, 1, "one status badge per row");
      assert.equal(shown[0]!.textContent, "Answer Required2");
      assert.equal(shown[0]!.getAttribute("aria-label"), "Status: Answer Required, 2 Requests");
      assert.ok(shown[0]!.classList.contains("t-warning"));
      const more = container.querySelector<HTMLElement>(".row-status-more")!;
      assert.equal(more.querySelector('[aria-hidden="true"]')?.textContent, "+1");
      assert.equal(more.getAttribute("title"), "Approval Required");
      assert.match(more.textContent ?? "", /1 More: Approval Required/);
      assert.doesNotMatch(container.textContent ?? "", /Awaiting Input/, "the lifecycle is not said as well");
    }, { threeRow });
  }
});

test("an idle row shows no status badge, no strip and no Git words", async () => {
  await withRow(baseSession(), (container) => {
    assert.deepEqual(badges(container), []);
    assertNoDomNode(container.querySelector(".row-status"));
    assertNoDomNode(container.querySelector(".activity-strip"));
    assertNoDomNode(container.querySelector(".inbox-row-git"), "the branch shows only when there is one");
    assert.doesNotMatch(container.textContent ?? "", /Awaiting Prompt|No Branch|Branch Unavailable/);
  });
});

test("a stalled running row shows one badge, in the danger tone, saying how long it has been silent", async () => {
  const session = baseSession({ status: "running", lastEventAt: NOW - 14 * 60_000 });
  await withRow(session, (container) => {
    const shown = badges(container);
    assert.equal(shown.length, 1, "Stalled is not a second badge");
    assert.equal(shown[0]!.textContent, "Running");
    assert.ok(shown[0]!.classList.contains("t-danger"));
    assert.ok(!shown[0]!.classList.contains("pulse"), "a stalled badge does not pulse");
    assert.equal(shown[0]!.getAttribute("aria-label"), "Status: Running, Stalled");
    assert.match(shown[0]!.getAttribute("title") ?? "", /Stalled: no activity for 14 minutes\.$/);
  }, { stalled: true });
});

test("a running row with background work shows Running and the strip", async () => {
  await withRow(baseSession({ status: "running", backgroundWorkState: "running" }), (container) => {
    const shown = badges(container);
    assert.equal(shown.length, 1);
    assert.equal(shown[0]!.textContent, "Running");
    assert.ok(shown[0]!.classList.contains("pulse"));
    assert.notEqual(container.querySelector(".inbox-row-activity"), null);
    assertNoDomNode(container.querySelector('[data-group="background-work"]'), "no separate background-work badge");
  });
});

test("an idle row with running background work shows Waiting on External Job", async () => {
  for (const [state, label] of [
    ["running", "Waiting on External Job"],
    ["continuation_pending", "Continuation Pending"],
    ["orphaned", "Background Work Lost"],
  ] as const) {
    await withRow(baseSession({ backgroundWorkState: state }), (container) => {
      const shown = badges(container);
      assert.equal(shown.length, 1, label);
      assert.equal(shown[0]!.textContent, label);
      assert.equal(shown[0]!.getAttribute("aria-label"), `Status: ${label}`);
    });
  }
  // Attention outranks background work, which then shows nowhere on the row (#2182's ranking).
  await withRow(baseSession({
    backgroundWorkState: "running",
    pendingApproval: { kind: "permission", requestId: "approval", title: "Review external work", options: [] },
  } as unknown as Partial<SessionView>), (container) => {
    assert.deepEqual(badges(container).map((badge) => badge.textContent), ["Approval Required"]);
  });
});

test("the strip shows while Running or Starting and for ten minutes after tool activity, and on no other row", async () => {
  for (const status of ["running", "starting"] as const) {
    await withRow(baseSession({ status }), (container) => {
      assert.notEqual(container.querySelector(".inbox-row-activity"), null, status);
    });
  }
  // An Awaiting Prompt row active 9 minutes ago shows it, and loses it once ten minutes have passed.
  await withRow(baseSession(), async (container, rerender) => {
    assert.notEqual(container.querySelector(".inbox-row-activity"), null, "9 minutes after activity");
    await rerender({ activityNow: NOW + ACTIVITY_BUCKET_MS });
    assertNoDomNode(container.querySelector(".inbox-row-activity"), "10 minutes after activity");
  }, { activity: minutesAgo(9) });
  await withRow(baseSession(), (container) => {
    assertNoDomNode(container.querySelector(".inbox-row-activity"), "11 minutes after activity");
  }, { activity: minutesAgo(11) });
  for (const status of ["queued", "input_required"] as const) {
    await withRow(baseSession({ status }), (container) => {
      assertNoDomNode(container.querySelector(".inbox-row-activity"), `${status} with no recent activity`);
    }, { activity: minutesAgo(25) });
  }
});

test("the strip is a named image on the status line after the badge, never in the title line", async () => {
  for (const threeRow of [false, true]) {
    await withRow(baseSession({ status: "running" }), (container) => {
      const strip = container.querySelector<HTMLElement>(".inbox-row-activity")!;
      assert.equal(strip.getAttribute("role"), "img");
      assert.equal(strip.getAttribute("aria-label"), "Tool activity in the last 30 minutes");
      assert.equal(strip.getAttribute("title"), "Tool activity in the last 30 minutes");
      const statusLine = strip.closest(".inbox-row-status-line")!;
      assert.notEqual(statusLine, null, "on the status line");
      assertNoDomNode(strip.closest(".inbox-row-copy"), "never in the title line's box");
      const lines = [...container.querySelector(".inbox-row")!.children].map((line) => line.classList[0]);
      // Desktop: status line, then title line. Phone: sender, title, then the status line (line 3).
      assert.deepEqual(lines, threeRow
        ? ["inbox-row-line", "inbox-row-copy", "inbox-row-line"]
        : ["inbox-row-line", "inbox-row-copy"]);
      assert.equal(container.querySelector(".inbox-row")!.lastElementChild === statusLine, threeRow);
      const badge = statusLine.querySelector(".row-status")!;
      assert.ok(badge.compareDocumentPosition(strip as never) & 4, "the strip follows the badge");
    }, { threeRow });
  }
});

test("the title line holds the one-line title and the family chip, and nothing else", async () => {
  const session = baseSession({ status: "running", title: "Fix the parser\n\nRequirements: - one", backgroundWorkState: "running" });
  for (const threeRow of [false, true]) {
    await withRow(session, (container) => {
      const copy = container.querySelector<HTMLElement>(".inbox-row-copy")!;
      assert.deepEqual([...copy.children].map((child) => child.className), ["inbox-row-title"]);
      assert.equal(copy.textContent, "Fix the parser", "sessionDisplayTitle(): the first line names the session");
      assert.equal(container.querySelector(".inbox-row")!.getAttribute("title"), "Select Fix the parser");
    }, { threeRow });
  }
});

test("the branch shows with its icon, its base as \"from\", and its pull request as a neutral state word", async () => {
  const session = baseSession({
    status: "running", useWorktree: true, worktreePath: "/repos/alpha/wt",
    worktrees: [{
      id: "wt", path: "/repos/alpha/wt", branch: "fix/issue-2209", baseRef: "fix/issue-2146", defaultBranch: "main",
      source: "created", pullRequest: { url: "https://example.test/pull/1", state: "merged" },
    }],
  } as unknown as Partial<SessionView>);
  for (const threeRow of [false, true]) {
    await withRow(session, (container) => {
      const git = container.querySelector<HTMLElement>(".inbox-row-status-line .inbox-row-git")!;
      assert.notEqual(git, null, "on the status line");
      const branch = git.querySelector<HTMLElement>(".inbox-row-branch")!;
      assert.notEqual(branch.querySelector("svg"), null, "BranchIcon");
      assert.equal(branch.textContent, "Branch: fix/issue-2209");
      assert.equal(git.querySelector(".inbox-row-base")?.textContent, "from fix/issue-2146");
      assert.doesNotMatch(git.textContent ?? "", /←/);
      const pr = git.querySelector<HTMLElement>(".inbox-row-pr")!;
      assert.notEqual(pr.querySelector("svg"), null, "PullRequestIcon");
      assert.equal(pr.textContent, "Pull Request: Merged");
      assertNoDomNode(container.querySelector(".inbox-row-pr-pill"));
    }, { threeRow });
  }
  // A default base is what every reader assumes, so it is left off.
  await withRow(baseSession({
    useWorktree: true, worktreePath: "/repos/alpha/wt",
    worktrees: [{ id: "wt", path: "/repos/alpha/wt", branch: "fix/a", baseRef: "origin/main", source: "created" }],
  } as unknown as Partial<SessionView>), (container) => {
    assertNoDomNode(container.querySelector(".inbox-row-base"));
  });
});

test("a stop-failed row shows Stop Failed and its time", async () => {
  const session = baseSession({
    status: "stopped", lastEventAt: null, updatedAt: NOW - 3 * 60_000,
    stopOperation: {
      operationId: "stop-operation-1", status: "stop_failed", requestedAt: 1, lastAttemptAt: 2, attemptCount: 1,
      capacityReleased: false, failure: { code: "runner_rejected", message: "Stop failed.", failedAt: 3 },
    },
  } as unknown as Partial<SessionView>);
  await withRow(session, (container) => {
    assert.deepEqual(badges(container).map((badge) => badge.textContent), ["Stop Failed"]);
    const time = container.querySelector("time")!;
    assert.notEqual(time.textContent, "—");
    assert.equal(time.getAttribute("datetime"), new Date(NOW - 3 * 60_000).toISOString());
  });
});

test("a fired reminder's row says Returned; snoozed rows show the return time today or tomorrow", async (t) => {
  let now = Date.UTC(2026, 9, 7, 0, 15);
  const clock = t.mock.method(Date, "now", () => now);
  try {
    const scheduledFor = now - 60_000;
    const fired: SessionReminderView = {
      reminderId: "reminder-returned", sessionId: "session", scheduledFor, timeZone: "UTC",
      originalExpression: "one minute ago", wakePolicy: "regardless", state: "fired",
      revision: 2, createdAt: scheduledFor - 1_000, updatedAt: scheduledFor, firedAt: scheduledFor, wakeReason: "scheduled",
    };
    await withRow(baseSession(), (container) => {
      const shown = badges(container);
      assert.equal(shown.length, 1);
      assert.equal(shown[0]!.textContent, "Returned from Snooze");
      assert.equal(shown[0]!.getAttribute("aria-label"), "Status: Returned from Snooze");
      assert.match(shown[0]!.getAttribute("title") ?? "", /Snooze ended/);
      assert.doesNotMatch(container.textContent ?? "", /Overdue/);
    }, { reminder: fired });

    const pending: SessionReminderView = { ...fired, state: "pending", scheduledFor: now + 3_600_000, firedAt: undefined };
    // The reminder's UTC day decides the label; its words and time follow the host's locale.
    for (const { currentTime, weekday } of [
      { currentTime: Date.UTC(2026, 9, 7, 0, 15), weekday: undefined },
      { currentTime: Date.UTC(2026, 9, 6, 23, 55), weekday: "short" as const },
    ]) {
      now = currentTime;
      const reminder = { ...pending, scheduledFor: now + 3_600_000 };
      const returnTime = new Intl.DateTimeFormat(undefined, {
        weekday, hour: "numeric", minute: "2-digit", timeZone: "UTC",
      }).format(new Date(reminder.scheduledFor));
      for (const threeRow of [false, true]) {
        await withRow(baseSession(), (container) => {
          assert.deepEqual(badges(container), [], "the reminder is the time cell, not a badge");
          const cell = container.querySelector<HTMLElement>(".inbox-row-time.snoozed")!;
          assert.notEqual(cell.querySelector("svg"), null, "AlarmClockIcon");
          assert.equal(cell.textContent, `Snoozed Until ${returnTime}`);
          assert.match(cell.getAttribute("title") ?? "", /^Snoozed until /);
          assertNoDomNode(container.querySelector("time"), "instead of the relative time");
        }, { reminder, threeRow });
      }
    }
    const someday = { ...pending, scheduleKind: "someday", scheduledFor: undefined, timeZone: undefined } as unknown as SessionReminderView;
    await withRow(baseSession(), (container) => {
      assert.equal(container.querySelector(".inbox-row-time.snoozed")?.textContent, "Snoozed: Someday");
    }, { reminder: someday });
  } finally {
    clock.mock.restore();
  }
});

test("a snoozed row's lost or missing background result counts toward its one status", async () => {
  const pending = {
    reminderId: "r", sessionId: "session", scheduledFor: Date.now() + 3_600_000, timeZone: "UTC",
    originalExpression: "in an hour", wakePolicy: "regardless", state: "pending", revision: 1,
    createdAt: 1, updatedAt: 1,
  } as SessionReminderView;
  await withRow(baseSession({ backgroundWorkState: "orphaned" }), (container) => {
    assert.deepEqual(badges(container).map((badge) => badge.textContent), ["Background Work Lost"]);
  }, { reminder: pending });
});

test("selected, unread, and selected-and-unread rows each show their own treatment; phones show no selection", async () => {
  for (const [selected, unread] of [[true, false], [false, true], [true, true]] as const) {
    await withRow(baseSession(), (container) => {
      const shell = container.querySelector<HTMLElement>(".inbox-row-shell")!;
      assert.equal(shell.getAttribute("aria-selected"), String(selected));
      assert.equal(shell.classList.contains("selected"), selected);
      assert.equal(shell.classList.contains("unread"), unread);
      const dot = container.querySelector<HTMLElement>(".inbox-row-flags .inbox-unread-dot");
      if (unread) {
        assert.equal(dot?.getAttribute("role"), "img");
        assert.equal(dot?.getAttribute("aria-label"), "Unread Activity");
        assert.equal(dot?.textContent, "", "a dot, not a count");
      } else {
        assertNoDomNode(dot);
      }
      assertNoDomNode(container.querySelector(".inbox-unread-badge"));
    }, { selected, unread });
  }
  await withRow(baseSession(), (container) => {
    const shell = container.querySelector<HTMLElement>(".inbox-row-shell")!;
    assert.equal(shell.getAttribute("aria-selected"), "true", "the grid still knows the active row");
    assert.ok(!shell.classList.contains("selected"), "but a phone never draws it selected");
    assert.ok(shell.classList.contains("stacked"));
  }, { selected: true, threeRow: true });
});

test("the relative time renders once, trailing the status line on both shapes", async () => {
  const session = baseSession({ status: "running", lastEventAt: Date.now() - 15 * 60_000 });
  for (const threeRow of [true, false]) {
    await withRow(session, (container) => {
      const times = container.querySelectorAll("time");
      assert.equal(times.length, 1, "one element, so the instant is never said twice");
      assert.equal(times[0]!.textContent, "15m ago");
      assert.notEqual(times[0]!.closest(".inbox-row-status-line"), null);
      assert.equal(times[0]!.parentElement?.lastElementChild, times[0], "trailing");
    }, { threeRow });
  }
});

test("Inbox rows never render the message preview", async () => {
  await withRow(baseSession({ preview: "The first line of the last message." }), (container) => {
    assert.doesNotMatch(container.textContent ?? "", /first line of the last message/);
    assertNoDomNode(container.querySelector(".inbox-row-snippet"));
  });
});

test("a parent row carries the chevron and family chip, and a child row its thread position", async () => {
  const parent = { id: "parent", runnerId: "runner", title: "Orchestrator", status: "running",
    driver: "claude-code", pendingApproval: null } as unknown as SessionView;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const toggled: string[] = [];
  let selected = 0;
  const children = JSON.stringify({ count: 2, waiting: 1, children: [
    { id: "c1", title: "Child One", state: "blocked" }, { id: "c2", title: "Child Two", state: "done" },
  ] });
  try {
    await act(async () => root.render(<InboxRow optionId="row" session={parent} projectName="Project"
      selected={false} unread={false} pinned={false} rowIndex={1} stalled={false} activityNow={0}
      threeRow={false} threadChildren={children} threadCollapsed={false}
      onSelect={() => { selected++; }} onExpand={() => { selected++; }} onSessionMenu={() => {}}
      onToggleThread={(id) => toggled.push(id)} />));
    const shell = container.querySelector<HTMLElement>(".inbox-row-shell")!;
    assert.match(shell.className, /thread-parent/);
    const chevron = container.querySelector<HTMLButtonElement>(".inbox-thread-toggle")!;
    assert.equal(chevron.getAttribute("aria-label"), "Collapse Thread");
    assert.equal(chevron.getAttribute("aria-expanded"), "true");
    assert.equal(chevron.getAttribute("tabindex"), "-1", "the grid owns the keyboard; T toggles");
    assertNoDomNode(container.querySelector("button button"), "the chevron is not nested in the row button");
    const chip = container.querySelector<HTMLElement>(".inbox-thread-family")!;
    assert.match(chip.className, /waiting/);
    assert.equal(chip.querySelector(".inbox-thread-family-text")?.textContent, "2 Children · 1 Awaiting Input");
    assert.deepEqual([...chip.querySelectorAll(".inbox-thread-dot")].map((dot) => dot.className),
      ["inbox-thread-dot blocked", "inbox-thread-dot done"]);
    await act(async () => chevron.click());
    await act(async () => chip.click());
    assert.deepEqual(toggled, ["parent", "parent"]);
    assert.equal(selected, 0, "toggling never selects or expands the row");

    await act(async () => root.render(<InboxRow optionId="row" session={parent} projectName="Project"
      selected={false} unread={false} pinned={false} containsPinned rowIndex={1} stalled={false} activityNow={0}
      threeRow={false} threadChildren={children} threadCollapsed
      onSelect={() => {}} onExpand={() => {}} onSessionMenu={() => {}} />));
    assert.equal(container.querySelector(".inbox-thread-toggle")?.getAttribute("aria-label"), "Expand Thread");
    assert.equal(container.querySelector(".inbox-thread-family-text")?.textContent, "2 Children · 1 Awaiting Input",
      "the rollup reads the same while collapsed");
    assert.ok(container.querySelector('[aria-label="Contains Pinned Session"] svg'));
    assertNoDomNode(container.querySelector('[aria-label="Pinned Session"]'),
      "the promoted parent never claims the descendant's direct pin");

    const child = { ...parent, id: "c1", title: "Child One", parentSessionId: "parent" } as SessionView;
    await act(async () => root.render(<InboxRow optionId="row" session={child} projectName="Project"
      selected={false} unread={false} pinned={false} rowIndex={2} stalled={false} activityNow={0}
      threeRow={false} threadDepth={1} threadLast
      onSelect={() => {}} onExpand={() => {}} onSessionMenu={() => {}} />));
    assert.match(container.querySelector(".inbox-row-shell")!.className, /thread-child thread-last/);
    assertNoDomNode(container.querySelector(".inbox-thread-toggle"));
    assertNoDomNode(container.querySelector(".inbox-thread-family"));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
