import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
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

test("live reminder changes preserve the complete draft and require an explicit reload", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const original: SessionReminderView = {
    reminderId: "reminder-original",
    sessionId: "session-1",
    scheduledFor: Date.now() + 86_400_000,
    timeZone: "America/Chicago",
    originalExpression: "tomorrow morning",
    wakePolicy: "until_activity",
    state: "pending",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const updated: SessionReminderView = {
    ...original,
    scheduledFor: Date.now() + 172_800_000,
    timeZone: "Asia/Tokyo",
    originalExpression: "2099-05-06T07:45",
    wakePolicy: "until_activity",
    revision: 2,
    updatedAt: 2,
  };
  const saved: SetSessionReminderRequest[] = [];
  const render = async (reminder: SessionReminderView | undefined) => {
    await act(async () => {
      root.render(<SnoozeDialog
        reminder={reminder}
        onClose={() => undefined}
        onSave={async (request) => { saved.push(request); }}
        onRemove={async () => undefined}
      />);
    });
  };

  await render(original);
  const expression = container.querySelector<HTMLInputElement>("#snooze-expression")!;
  const exact = container.querySelector<HTMLInputElement>("#snooze-exact")!;
  await act(async () => {
    expression.value = "today at 3:30 pm";
    Simulate.change(expression);
    exact.value = "2099-04-05T06:30";
    Simulate.change(exact);
    [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((button) => button.textContent?.includes("Regardless"))!.click();
    exact.focus();
  });
  const draftTimeZone = [...container.querySelectorAll(".snooze-preview span")].at(-1)?.textContent;

  await render(updated);

  assert.equal(domWindow.document.activeElement, exact, "a live update must not remount or move focus");
  assert.equal(expression.value, "today at 3:30 pm");
  assert.equal(exact.value, "2099-04-05T06:30");
  assert.equal(container.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')?.textContent?.includes("Regardless"), true);
  assert.equal([...container.querySelectorAll(".snooze-preview span")].at(-1)?.textContent, draftTimeZone);
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /updated in another client.*local draft is preserved/i);
  const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  assert.equal(submit.disabled, true);
  await act(async () => { submit.click(); });
  assert.equal(saved.length, 0);

  const reload = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "Reload Reminder")!;
  await act(async () => { reload.click(); });
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.equal(expression.value, "");
  assert.equal(exact.value, "2099-05-06T07:45");
  assert.equal(container.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')?.textContent?.includes("Until Activity"), true);
  assert.match([...container.querySelectorAll(".snooze-preview span")].at(-1)?.textContent ?? "", /Asia\/Tokyo/);

  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  });
  assert.equal(saved[0]?.expectedRevision, 2);
  assert.equal(saved[0]?.expectedReminderId, "reminder-original");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("fired, removed, and recreated reminders have distinct live-conflict messages", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const original: SessionReminderView = {
    reminderId: "reminder-original",
    sessionId: "session-1",
    scheduledFor: Date.now() + 60_000,
    timeZone: "UTC",
    originalExpression: "in 1 hour",
    wakePolicy: "until_activity",
    state: "pending",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const render = async (reminder: SessionReminderView | undefined) => {
    await act(async () => {
      root.render(<SnoozeDialog
        reminder={reminder}
        onClose={() => undefined}
        onSave={async () => undefined}
        onRemove={async () => undefined}
      />);
    });
  };

  await render(original);
  await render({ ...original, state: "fired", revision: 2, firedAt: 2, wakeReason: "scheduled" });
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /fired in another client/i);

  await render(undefined);
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /removed in another client/i);
  assert.equal([...container.querySelectorAll<HTMLButtonElement>("button")]
    .some((button) => button.textContent === "Start New Reminder"), true);

  await render({ ...original, reminderId: "reminder-recreated", revision: 1 });
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /removed and recreated in another client/i);

  await act(async () => { root.unmount(); });
  container.remove();
});
