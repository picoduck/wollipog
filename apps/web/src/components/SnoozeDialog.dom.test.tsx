import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionReminderView, SetSessionReminderRequest } from "@wollipog/protocol";
import { SnoozeDialog } from "./SnoozeDialog.js";

const domWindow = new Window({ url: "http://localhost/inbox" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

test("a fired reminder can update policy without changing its stored past instant", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const scheduledFor = Date.now() - 60_000;
  const reminder: SessionReminderView = {
    reminderId: "reminder-1",
    sessionId: "session-1",
    scheduledFor,
    timeZone: "UTC",
    originalExpression: "one minute ago",
    wakePolicy: "until_activity",
    state: "fired",
    revision: 2,
    createdAt: scheduledFor - 1_000,
    updatedAt: scheduledFor,
    firedAt: scheduledFor,
    wakeReason: "scheduled",
  };
  let saved: SetSessionReminderRequest | undefined;

  await act(async () => {
    root.render(<SnoozeDialog
      reminder={reminder}
      onClose={() => undefined}
      onSave={async (request) => { saved = request; }}
      onRemove={async () => undefined}
    />);
  });
  const expression = container.querySelector<HTMLInputElement>("#snooze-expression")!;
  assert.equal(expression.getAttribute("aria-describedby"), "snooze-expression-hint");
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  });
  assert.equal(saved?.scheduledFor, scheduledFor);
  assert.equal(saved?.expectedRevision, 2);
  assert.equal(container.querySelector(".form-error"), null);

  await act(async () => { root.unmount(); });
  container.remove();
});
