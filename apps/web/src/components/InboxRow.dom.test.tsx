import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionReminderView, SessionView } from "@wollipog/protocol";
import { InboxRow } from "./InboxRow.js";
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

test("Inbox request navigation keeps exact identity and never selects or approves another row", async () => {
  const session = { id: "session", eventEpoch: 7, runnerId: "runner", title: "Session",
    status: "input_required", driver: "codex-app-server", pendingApproval: {
      requestId: "a", options: [], title: "First", additionalRequests: [{
        requestId: "b / %", options: [], title: "Second", ownerToolUseId: "child",
      }],
    } } as unknown as SessionView;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const navigated: unknown[] = [];
  let selected = 0;
  try {
    await act(async () => root.render(<InboxRow optionId="row" session={session} projectName="Project"
      selected={false} unread={false} pinned={false} rowIndex={1} stalled={false} activityNow={0}
      onSelect={() => { selected++; }} onExpand={() => { selected++; }} onSessionMenu={() => {}}
      onNavigate={(view) => navigated.push(view)} />));
    assert.equal(container.querySelector("button button"), null, "request actions are not nested in the row button");
    const picker = container.querySelector(".attention-requests")!;
    await act(async () => picker.querySelectorAll("button")[1]!.click());
    assert.deepEqual(navigated, [{ name: "session", id: "session", attention: { eventEpoch: 7, requestId: "b / %" } }]);
    assert.equal(selected, 0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Inbox rows expose plain Stop Failed instead of Diff Ready", async () => {
  const session = {
    id: "session-stop-failed", runnerId: "runner-1", title: "Failed Stop",
    status: "stopped", column: "review", archived: false,
    stopOperation: {
      operationId: "stop-operation-1",
      status: "stop_failed",
      requestedAt: 1,
      lastAttemptAt: 2,
      attemptCount: 1,
      capacityReleased: false,
      failure: { code: "runner_rejected", message: "Stop failed.", failedAt: 3 },
    },
    pendingApproval: null, lastEventAt: null, preview: null,
    agentId: "codex", agentName: "Codex", driver: "codex-app-server",
  } as unknown as SessionView;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<InboxRow
    optionId="session-option" session={session} projectName="Project One"
    selected={false} unread={false} pinned={false} rowIndex={1}
    stalled={false} activityNow={2}
    onSelect={() => undefined} onExpand={() => undefined}
      onSessionMenu={() => undefined}
  />));
  assert.match(container.textContent ?? "", /Stop Failed/);
  assert.doesNotMatch(container.textContent ?? "", /Diff Ready/);
  await act(async () => root.unmount());
  container.remove();
});

test("returned-from-snooze rows expose the ended instant without overdue copy", async () => {
  const session = {
    id: "session-returned", runnerId: "runner-1", title: "Returned Session",
    status: "idle", column: "inbox", archived: false, pendingApproval: null,
    lastEventAt: null, preview: null, agentId: "codex", agentName: "Codex",
    driver: "codex-app-server",
  } as unknown as SessionView;
  const scheduledFor = Date.now() - 60_000;
  const reminder: SessionReminderView = {
    reminderId: "reminder-returned", sessionId: session.id, scheduledFor, timeZone: "UTC",
    originalExpression: "one minute ago", wakePolicy: "regardless", state: "fired",
    revision: 2, createdAt: scheduledFor - 1_000, updatedAt: scheduledFor,
    firedAt: scheduledFor, wakeReason: "scheduled",
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<InboxRow
    optionId="session-option" session={session} projectName="Project One"
    selected={false} unread={false} pinned={false} rowIndex={1}
    stalled={false} activityNow={Date.now()} reminder={reminder}
    onSelect={() => undefined} onExpand={() => undefined} onSessionMenu={() => undefined}
  />));
  const pill = container.querySelector<HTMLElement>(".inbox-status-pill.reminder")!;
  assert.equal(pill.textContent, "Returned from Snooze");
  assert.match(pill.getAttribute("aria-label") ?? "", /Snooze ended/);
  assert.doesNotMatch(pill.textContent, /Overdue/);
  await act(async () => root.unmount());
  container.remove();
});

async function withRow(
  session: SessionView,
  assertions: (container: HTMLDivElement) => void,
): Promise<void> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<InboxRow
    optionId="session-option" session={session} projectName="Project One"
    selected={false} unread={false} pinned={false} rowIndex={1}
    stalled={false} activityNow={2}
    onSelect={() => undefined} onExpand={() => undefined} onSessionMenu={() => undefined}
  />));
  try {
    assertions(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

const worktreeSession = (worktree: Record<string, unknown> | null): SessionView => ({
  id: "session-worktree", runnerId: "runner-1", title: "Worktree Session",
  status: "running", column: "review", archived: false, pendingApproval: null,
  lastEventAt: null, preview: "The first line of the last message.",
  agentId: "codex", agentName: "Codex", driver: "codex-app-server",
  worktreePath: worktree ? "/repos/alpha/wt" : null,
  worktrees: worktree ? [worktree] : undefined,
} as unknown as SessionView);

test("idle Inbox rows retain authoritative background work alongside attention", async () => {
  for (const [state, visible, accessible] of [
    ["running", "Waiting on External Job", "Waiting on External Job"],
    ["continuation_pending", "Continuation Pending", "Continuation Pending"],
    ["orphaned", "Background Work Orphaned", "Orphaned"],
    ["resumed", null, null],
    [undefined, null, null],
  ] as const) {
    await withRow({
      ...worktreeSession(null), status: "idle", backgroundWorkState: state,
      pendingApproval: { kind: "permission", requestId: "background-approval", title: "Review external work", options: [] },
    }, (container) => {
      assert.ok(container.querySelector('[aria-label="Activity: Awaiting Prompt"]'));
      assert.ok(container.querySelector('[aria-label="Attention: Approval Required"]'));
      const badge = container.querySelector(".inbox-row-background-work .background-work-badge");
      if (visible) {
        assert.equal(badge?.getAttribute("aria-label"), `Background Work: ${accessible}`);
        assert.equal(badge?.querySelector('span[aria-hidden="true"]:last-child')?.textContent, visible);
        assert.equal(badge?.getAttribute("role"), null, "rows must not create hundreds of live regions");
      } else {
        assert.equal(badge, null);
        assert.equal(container.querySelector(".inbox-row-background-work"), null);
      }
    });
  }
});

test("a session with a worktree gets a third line, and a default base ref is left off it", async () => {
  await withRow(
    worktreeSession({
      id: "wt", path: "/repos/alpha/wt", branch: "fix/issue-664", baseRef: "origin/main",
      source: "created", pullRequest: { url: "https://example.test/pull/1", state: "open" },
    }),
    (container) => {
      const line = container.querySelector<HTMLElement>(".inbox-row-git")!;
      assert.equal(line.querySelector(".inbox-row-branch")?.textContent, "fix/issue-664");
      assert.equal(line.querySelector(".inbox-row-base"), null, "origin/main is what every reader assumes");
      assert.equal(line.querySelector(".inbox-row-pr-pill")?.textContent, "Open PR");
      assert.equal(line.querySelector(".inbox-row-pr-pill")?.getAttribute("aria-label"), "Pull Request: Open");
    },
  );
});

test("a base ref that is not the default is spelled out on the worktree line", async () => {
  await withRow(
    worktreeSession({
      id: "wt", path: "/repos/alpha/wt", branch: "fix/issue-664-follow-up",
      baseRef: "fix/issue-664", source: "created",
      pullRequest: { url: "https://example.test/pull/2", state: "merged" },
    }),
    (container) => {
      const line = container.querySelector<HTMLElement>(".inbox-row-git")!;
      // The arrow is hidden from assistive technology; the word it stands for is not.
      assert.equal(line.querySelector(".inbox-row-base")?.textContent, "Base: ← fix/issue-664");
      assert.equal(line.querySelector(".inbox-row-pr-pill")?.textContent, "Merged PR");
    },
  );
});

test("Inbox rows no longer render the message preview, and every row keeps its Git line", async () => {
  await withRow(worktreeSession(null), (container) => {
    assert.doesNotMatch(container.textContent ?? "", /first line of the last message/);
    assert.equal(container.querySelector(".inbox-row-snippet"), null);
    // #782: line three is unconditional, so a session with no worktree says so instead of vanishing.
    assert.notEqual(container.querySelector(".inbox-row-meta"), null);
    assert.equal(container.querySelector(".inbox-row-branch-state")?.textContent, "No Branch");
    // The strip is still there for a busy session; it is the line's only fixed-width item.
    assert.notEqual(container.querySelector(".inbox-row-activity"), null);
  });
});

// #782: three states, and the distinction between the last two is the whole point. A session that
// holds a worktree the client cannot name must not be described as having no branch at all.
test("a session's Git line names its branch, admits to none, or admits to not knowing", async () => {
  const cases: Array<[Partial<SessionView>, string, string | null]> = [
    [{ useWorktree: false, worktreePath: null }, "No Branch", "none"],
    [{ useWorktree: true, worktreePath: null }, "Branch Unavailable", "unknown"],
    [{ useWorktree: true, worktreePath: "/repos/alpha/wt", worktrees: undefined }, "Branch Unavailable", "unknown"],
    [{
      useWorktree: true,
      worktreePath: "/repos/alpha/wt",
      // An inventory that names a DIFFERENT worktree still leaves the active one unnamed.
      worktrees: [{ id: "other", path: "/repos/alpha/other", branch: "fix/other", source: "created" }],
    } as Partial<SessionView>, "Branch Unavailable", "unknown"],
    [{
      useWorktree: true,
      worktreePath: "/repos/alpha/wt",
      worktrees: [{ id: "wt", path: "/repos/alpha/wt", branch: "fix/issue-782", source: "created" }],
    } as Partial<SessionView>, "fix/issue-782", null],
  ];
  for (const [extra, label, stateClass] of cases) {
    await withRow({ ...worktreeSession(null), ...extra } as SessionView, (container) => {
      const line = container.querySelector<HTMLElement>(".inbox-row-git")!;
      assert.notEqual(line, null, `${label}: line three is always present`);
      const state = line.querySelector<HTMLElement>(".inbox-row-branch-state");
      if (stateClass) {
        assert.equal(state?.textContent, label);
        assert.ok(state!.classList.contains(stateClass), `${label} carries its own state class`);
        assert.equal(line.querySelector(".inbox-row-branch"), null);
      } else {
        assert.equal(state, null);
        assert.equal(line.querySelector(".inbox-row-branch")?.textContent, label);
      }
      // The accessible name says which of the three it is, not just what the text happens to read.
      assert.match(container.querySelector<HTMLElement>(".inbox-row")!.textContent ?? "", new RegExp(`Branch: ${label}`));
    });
  }
});

// #782: the badge shares line three with the Git state instead of taking a fourth line.
test("background work sits on the Git line, whatever the session's branch state", async () => {
  for (const extra of [
    { useWorktree: false, worktreePath: null },
    {
      useWorktree: true,
      worktreePath: "/repos/alpha/wt",
      worktrees: [{ id: "wt", path: "/repos/alpha/wt", branch: "fix/issue-782", source: "created" }],
    },
  ] as Partial<SessionView>[]) {
    await withRow({ ...worktreeSession(null), ...extra, backgroundWorkState: "running" } as SessionView, (container) => {
      const meta = container.querySelector<HTMLElement>(".inbox-row-meta")!;
      assert.notEqual(meta.querySelector(".inbox-row-git"), null);
      const badge = meta.querySelector(".inbox-row-background-work .background-work-badge");
      assert.equal(badge?.getAttribute("aria-label"), "Background Work: Waiting on External Job");
      // Nothing outside line three carries it, which is what a fourth row would look like.
      assert.equal(container.querySelectorAll(".inbox-row-background-work").length, 1);
    });
  }
});
