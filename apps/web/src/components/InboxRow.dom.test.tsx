import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionReminderView, SessionView } from "@wollipog/protocol";
import { InboxRow } from "./InboxRow.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

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

test("a session with a worktree gets a third line, and a default base ref is left off it", async () => {
  await withRow(
    worktreeSession({
      id: "wt", path: "/repos/alpha/wt", branch: "fix/issue-664", baseRef: "origin/main",
      source: "created", pullRequest: { url: "https://example.test/pull/1", state: "open" },
    }),
    (container) => {
      const line = container.querySelector<HTMLElement>(".inbox-row-worktree")!;
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
      const line = container.querySelector<HTMLElement>(".inbox-row-worktree")!;
      // The arrow is hidden from assistive technology; the word it stands for is not.
      assert.equal(line.querySelector(".inbox-row-base")?.textContent, "Base: ← fix/issue-664");
      assert.equal(line.querySelector(".inbox-row-pr-pill")?.textContent, "Merged PR");
    },
  );
});

test("Inbox rows no longer render the message preview, and rows without a worktree stay two lines", async () => {
  await withRow(worktreeSession(null), (container) => {
    assert.doesNotMatch(container.textContent ?? "", /first line of the last message/);
    assert.equal(container.querySelector(".inbox-row-snippet"), null);
    assert.equal(container.querySelector(".inbox-row-worktree"), null);
    // The strip is still there for a busy session; it is the line's only fixed-width item.
    assert.notEqual(container.querySelector(".inbox-row-activity"), null);
  });
});
