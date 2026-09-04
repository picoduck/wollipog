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
