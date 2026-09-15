import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionReminderView, SetSessionReminderRequest } from "@wollipog/protocol";
import { ApiError } from "../api.js";
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
  assert.match(container.textContent ?? "", /Approvals, questions, and failures remain available on the session in Snoozed\./);
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
    fireDomEvent.change(expression);
    exact.value = "2099-04-05T06:30";
    fireDomEvent.change(exact);
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
  assert.equal(submit.disabled, false);
  assert.equal(submit.getAttribute("aria-disabled"), "true");
  await act(async () => { submit.click(); });
  assert.equal(saved.length, 0);

  const reload = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "Reload Reminder")!;
  reload.focus();
  assert.equal(domWindow.document.activeElement, reload);
  await act(async () => { reload.click(); });
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.equal(domWindow.document.activeElement, expression, "reloading must restore focus inside the dialog");
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

test("the server echo from the dialog's own save is not announced as a remote conflict", async () => {
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
  let resolveSave!: () => void;
  const savePending = new Promise<void>((resolve) => { resolveSave = resolve; });
  const props = {
    onClose: () => undefined,
    onSave: async () => savePending,
    onRemove: async () => undefined,
  };

  await act(async () => { root.render(<SnoozeDialog reminder={original} {...props} />); });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    root.render(<SnoozeDialog reminder={{ ...original, revision: 2, updatedAt: 2 }} {...props} />);
  });
  assert.equal(container.querySelector('[role="alert"]'), null);

  await act(async () => {
    resolveSave();
    await savePending;
  });
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
  const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  submit.focus();
  await render({ ...original, state: "fired", revision: 2, firedAt: 2, wakeReason: "scheduled" });
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /already fired/i);
  assert.equal(domWindow.document.activeElement, submit);
  assert.equal(submit.disabled, false);
  assert.equal(submit.getAttribute("aria-disabled"), "true");

  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Reload Reminder")!.click();
  });
  const remove = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "Dismiss Reminder")!;
  remove.focus();
  await render(undefined);
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /removed in another client/i);
  assert.equal(domWindow.document.activeElement, remove);
  assert.equal(remove.isConnected, true);
  assert.equal(remove.disabled, false);
  assert.equal(remove.getAttribute("aria-disabled"), "true");
  assert.equal([...container.querySelectorAll<HTMLButtonElement>("button")]
    .some((button) => button.textContent === "Start New Reminder"), true);

  await render({ ...original, reminderId: "reminder-recreated", revision: 1 });
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /removed and recreated in another client/i);

  await act(async () => { root.unmount(); });
  container.remove();
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(cause: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("409 reconciliation distinguishes authoritative reminder states without live delivery", async () => {
  const original: SessionReminderView = {
    reminderId: "reminder-original",
    sessionId: "session-1",
    scheduledFor: Date.now() + 60_000,
    timeZone: "America/Chicago",
    originalExpression: "in 1 hour",
    wakePolicy: "until_activity",
    state: "pending",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const cases: Array<{
    name: string;
    authoritative: SessionReminderView | null;
    message: RegExp;
    action: "Reload Reminder" | "Start New Reminder";
    expectedRevision: number;
    expectedReminderId?: string;
  }> = [
    {
      name: "updated",
      authoritative: { ...original, originalExpression: "in 2 hours", revision: 2, updatedAt: 2 },
      message: /updated in another client/i,
      action: "Reload Reminder",
      expectedRevision: 2,
      expectedReminderId: "reminder-original",
    },
    {
      name: "fired",
      authoritative: {
        ...original,
        state: "fired",
        revision: 2,
        updatedAt: 2,
        firedAt: 2,
        wakeReason: "scheduled",
      },
      message: /already fired/i,
      action: "Reload Reminder",
      expectedRevision: 2,
      expectedReminderId: "reminder-original",
    },
    {
      name: "removed",
      authoritative: null,
      message: /removed in another client/i,
      action: "Start New Reminder",
      expectedRevision: 0,
    },
    {
      name: "removed and recreated at the same revision",
      authoritative: { ...original, reminderId: "reminder-recreated", revision: 1, updatedAt: 3 },
      message: /removed and recreated in another client/i,
      action: "Reload Reminder",
      expectedRevision: 1,
      expectedReminderId: "reminder-recreated",
    },
  ];

  for (const scenario of cases) {
    const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
    domWindow.document.body.append(container as never);
    const root = createRoot(container);
    let saveCalls = 0;
    let reconciliations = 0;
    let accepted: SetSessionReminderRequest | undefined;
    let acceptedPrevious: SessionReminderView | undefined;
    await act(async () => {
      root.render(<SnoozeDialog
        reminder={original}
        onClose={() => undefined}
        onSave={async (request, previous) => {
          saveCalls++;
          if (saveCalls === 1) throw new ApiError("reminder changed in another client", 409);
          accepted = request;
          acceptedPrevious = previous;
        }}
        onRemove={async () => undefined}
        onReconcile={async () => { reconciliations++; return scenario.authoritative; }}
      />);
    });
    const expression = container.querySelector<HTMLInputElement>("#snooze-expression")!;
    const exact = container.querySelector<HTMLInputElement>("#snooze-exact")!;
    await act(async () => {
      expression.value = "today at 3:30 pm";
      fireDomEvent.change(expression);
      exact.value = "2099-04-05T06:30";
      fireDomEvent.change(exact);
      [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
        .find((button) => button.textContent?.includes("Regardless"))!.click();
      exact.focus();
      container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
      await Promise.resolve();
    });

    assert.equal(saveCalls, 1, `${scenario.name}: the stale mutation is not retried`);
    assert.equal(reconciliations, 1, `${scenario.name}: exactly one authoritative read follows the conflict`);
    assert.equal(expression.value, "today at 3:30 pm", `${scenario.name}: natural-language draft`);
    assert.equal(exact.value, "2099-04-05T06:30", `${scenario.name}: exact-time draft`);
    assert.equal(container.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')
      ?.textContent?.includes("Regardless"), true, `${scenario.name}: Wake Policy draft`);
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", scenario.message, scenario.name);
    assert.equal(domWindow.document.activeElement, exact, `${scenario.name}: reconciliation keeps focus`);

    const reload = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === scenario.action)!;
    await act(async () => { reload.click(); });
    assert.equal(domWindow.document.activeElement, expression, `${scenario.name}: reload restores dialog focus`);
    if (scenario.authoritative === null) {
      assert.equal(expression.value, "tomorrow morning", "normal reset discards the natural-language draft");
      assert.equal(exact.value, "", "normal reset discards the exact-time draft");
      assert.equal(container.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')
        ?.textContent?.includes("Until Activity"), true, "normal reset restores the default Wake Policy");
    }
    await act(async () => { container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
    assert.equal(accepted?.expectedRevision, scenario.expectedRevision, scenario.name);
    assert.equal(accepted?.expectedReminderId, scenario.expectedReminderId, scenario.name);
    assert.equal(acceptedPrevious?.reminderId, scenario.authoritative?.reminderId, scenario.name);

    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a removed reminder can be recreated explicitly from the complete preserved draft", async () => {
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
  let accepted: SetSessionReminderRequest | undefined;
  let acceptedPrevious: SessionReminderView | undefined;
  let closeCalls = 0;
  const props = {
    onClose: () => { closeCalls++; },
    onSave: async (request: SetSessionReminderRequest, previous?: SessionReminderView) => {
      accepted = request;
      acceptedPrevious = previous;
    },
    onRemove: async () => undefined,
  };

  await act(async () => { root.render(<SnoozeDialog reminder={original} {...props} />); });
  const expression = container.querySelector<HTMLInputElement>("#snooze-expression")!;
  const exact = container.querySelector<HTMLInputElement>("#snooze-exact")!;
  await act(async () => {
    expression.value = "today at 3:30 pm";
    fireDomEvent.change(expression);
    exact.value = "2099-04-05T06:30";
    fireDomEvent.change(exact);
    [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((button) => button.textContent?.includes("Regardless"))!.click();
    exact.focus();
  });
  const draftTimeZone = [...container.querySelectorAll(".snooze-preview span")].at(-1)?.textContent;

  await act(async () => { root.render(<SnoozeDialog reminder={undefined} {...props} />); });
  const conflict = container.querySelector('[role="alert"]')!;
  assert.match(conflict.textContent ?? "", /removed in another client/i);
  assert.match(conflict.textContent ?? "", /create a new reminder from this draft.*discard it.*defaults/i);
  assert.equal(domWindow.document.activeElement, exact, "remote removal keeps the active draft field focused");
  assert.equal([...container.querySelectorAll<HTMLButtonElement>("button")]
    .some((button) => button.textContent === "Start New Reminder"), true, "the normal reset remains separate");

  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Create New Reminder from Draft")!.click();
  });

  assert.equal(container.querySelector(".modal-head h2")?.textContent, "Create New Reminder");
  assert.match(container.querySelector("#snooze-description")?.textContent ?? "", /will create a new reminder.*will not be restored/i);
  assert.match(container.querySelector('[role="status"].sr-only')?.textContent ?? "",
    /creating a new reminder from the preserved draft.*will not be restored/i);
  assert.equal(domWindow.document.activeElement, expression, "activating draft reuse keeps focus in the dialog");
  assert.equal(expression.value, "today at 3:30 pm", "natural-language input is retained");
  assert.equal(exact.value, "2099-04-05T06:30", "exact date and time are retained");
  assert.equal(container.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')
    ?.textContent?.includes("Regardless"), true, "Wake Policy is retained");
  assert.equal([...container.querySelectorAll(".snooze-preview span")].at(-1)?.textContent, draftTimeZone,
    "time-zone context is retained");

  await act(async () => { container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
  assert.equal(accepted?.expectedRevision, 0, "draft reuse is create-only");
  assert.equal(accepted && "expectedReminderId" in accepted, false, "create-only requests cannot target the removed reminder");
  assert.equal(accepted?.originalExpression, "2099-04-05T06:30");
  assert.equal(accepted?.wakePolicy, "regardless");
  assert.equal(acceptedPrevious, undefined, "undo behavior also treats the write as a new reminder");
  assert.equal(closeCalls, 1);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("draft reuse retains an untouched stored instant and time zone", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const scheduledFor = Date.UTC(2099, 4, 6, 12, 45);
  const original: SessionReminderView = {
    reminderId: "reminder-original",
    sessionId: "session-1",
    scheduledFor,
    timeZone: "Asia/Tokyo",
    originalExpression: "2099-05-06T21:45",
    wakePolicy: "regardless",
    state: "pending",
    revision: 4,
    createdAt: 1,
    updatedAt: 4,
  };
  let accepted: SetSessionReminderRequest | undefined;
  const props = {
    onClose: () => undefined,
    onSave: async (request: SetSessionReminderRequest) => { accepted = request; },
    onRemove: async () => undefined,
  };

  await act(async () => { root.render(<SnoozeDialog reminder={original} {...props} />); });
  await act(async () => { root.render(<SnoozeDialog reminder={undefined} {...props} />); });
  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Create New Reminder from Draft")!.click();
  });
  await act(async () => { container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });

  assert.equal(accepted?.scheduledFor, scheduledFor);
  assert.equal(accepted?.timeZone, "Asia/Tokyo");
  assert.equal(accepted?.originalExpression, "2099-05-06T21:45");
  assert.equal(accepted?.wakePolicy, "regardless");
  assert.equal(accepted?.expectedRevision, 0);
  assert.equal(accepted && "expectedReminderId" in accepted, false);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("a concurrent recreation blocks preserved-draft creation and reload keeps focus in the dialog", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const original: SessionReminderView = {
    reminderId: "reminder-original", sessionId: "session-1", scheduledFor: Date.now() + 60_000,
    timeZone: "UTC", originalExpression: "in 1 hour", wakePolicy: "until_activity", state: "pending",
    revision: 1, createdAt: 1, updatedAt: 1,
  };
  const recreated: SessionReminderView = {
    ...original,
    reminderId: "reminder-recreated",
    originalExpression: "in 2 hours",
    scheduledFor: Date.now() + 120_000,
    updatedAt: 2,
  };
  const saved: SetSessionReminderRequest[] = [];
  const props = {
    onClose: () => undefined,
    onSave: async (request: SetSessionReminderRequest) => { saved.push(request); },
    onRemove: async () => undefined,
  };

  await act(async () => { root.render(<SnoozeDialog reminder={original} {...props} />); });
  await act(async () => { root.render(<SnoozeDialog reminder={undefined} {...props} />); });
  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Create New Reminder from Draft")!.click();
  });
  const expression = container.querySelector<HTMLInputElement>("#snooze-expression")!;
  assert.equal(domWindow.document.activeElement, expression);

  await act(async () => { root.render(<SnoozeDialog reminder={recreated} {...props} />); });
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /created in another client/i);
  assert.equal(domWindow.document.activeElement, expression, "the new conflict does not move focus");
  const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  assert.equal(submit.getAttribute("aria-disabled"), "true");
  await act(async () => { submit.click(); });
  assert.equal(saved.length, 0, "the create-only write is blocked before submission when recreation is known");

  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Reload Reminder")!.click();
  });
  assert.equal(domWindow.document.activeElement, expression, "resolving the new conflict keeps focus in the dialog");
  assert.equal(expression.value, "in 2 hours");
  await act(async () => { submit.click(); });
  assert.equal(saved[0]?.expectedRevision, 1);
  assert.equal(saved[0]?.expectedReminderId, "reminder-recreated");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("a create-only race reconciles a reminder recreated without live delivery", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const original: SessionReminderView = {
    reminderId: "reminder-original", sessionId: "session-1", scheduledFor: Date.now() + 60_000,
    timeZone: "UTC", originalExpression: "in 1 hour", wakePolicy: "until_activity", state: "pending",
    revision: 1, createdAt: 1, updatedAt: 1,
  };
  const recreated: SessionReminderView = {
    ...original,
    reminderId: "reminder-recreated",
    originalExpression: "in 2 hours",
    scheduledFor: Date.now() + 120_000,
    updatedAt: 2,
  };
  const saved: SetSessionReminderRequest[] = [];
  let reconciliations = 0;
  const props = {
    onClose: () => undefined,
    onSave: async (request: SetSessionReminderRequest) => {
      saved.push(request);
      if (saved.length === 1) throw new ApiError("reminder changed in another client", 409);
    },
    onRemove: async () => undefined,
    onReconcile: async () => { reconciliations++; return recreated; },
  };

  await act(async () => { root.render(<SnoozeDialog reminder={original} {...props} />); });
  await act(async () => { root.render(<SnoozeDialog reminder={undefined} {...props} />); });
  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Create New Reminder from Draft")!.click();
  });
  const expression = container.querySelector<HTMLInputElement>("#snooze-expression")!;
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await Promise.resolve();
  });

  assert.equal(saved.length, 1, "the stale create is never retried automatically");
  assert.equal(saved[0]?.expectedRevision, 0);
  assert.equal(saved[0] && "expectedReminderId" in saved[0], false);
  assert.equal(reconciliations, 1);
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /created in another client/i);
  assert.equal(domWindow.document.activeElement, expression, "authoritative reconciliation keeps focus in the dialog");

  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Reload Reminder")!.click();
  });
  assert.equal(domWindow.document.activeElement, expression);
  assert.equal(expression.value, "in 2 hours");
  await act(async () => { container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
  assert.equal(saved[1]?.expectedRevision, 1);
  assert.equal(saved[1]?.expectedReminderId, "reminder-recreated");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("unsupported and failed reconciliation remains visible and safely retryable", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const original: SessionReminderView = {
    reminderId: "reminder-original", sessionId: "session-1", scheduledFor: Date.now() + 60_000,
    timeZone: "UTC", originalExpression: "in 1 hour", wakePolicy: "until_activity", state: "pending",
    revision: 1, createdAt: 1, updatedAt: 1,
  };
  const updated = { ...original, originalExpression: "in 2 hours", revision: 2, updatedAt: 2 };
  let saveCalls = 0;
  let readCalls = 0;
  await act(async () => {
    root.render(<SnoozeDialog
      reminder={original}
      onClose={() => undefined}
      onSave={async () => { saveCalls++; throw new ApiError("stale reminder", 409); }}
      onReconcile={async () => {
        readCalls++;
        if (readCalls === 1) throw new ApiError("not found", 404);
        if (readCalls === 2) throw new ApiError("control plane unavailable", 503);
        return updated;
      }}
    />);
  });

  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /unable to load.*not found/i);
  assert.equal(saveCalls, 1);
  assert.equal(readCalls, 1);

  const retry = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "Retry Reconciliation")!;
  await act(async () => { retry.click(); await Promise.resolve(); });
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /unable to load.*control plane unavailable/i);
  assert.equal(saveCalls, 1, "an unsupported or unavailable read never retries the mutation");
  assert.equal(readCalls, 2);

  const retryAgain = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "Retry Reconciliation")!;
  await act(async () => { retryAgain.click(); await Promise.resolve(); });
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /updated in another client/i);
  assert.equal(saveCalls, 1, "retry performs only the safe read");
  assert.equal(readCalls, 3);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("a newer live update wins when it arrives during authoritative reconciliation", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const original: SessionReminderView = {
    reminderId: "reminder-original", sessionId: "session-1", scheduledFor: Date.now() + 60_000,
    timeZone: "UTC", originalExpression: "in 1 hour", wakePolicy: "until_activity", state: "pending",
    revision: 1, createdAt: 1, updatedAt: 1,
  };
  const readResult = { ...original, originalExpression: "in 2 hours", revision: 2, updatedAt: 2 };
  const newerLive = { ...original, originalExpression: "in 3 hours", revision: 3, updatedAt: 3 };
  const pendingRead = deferred<SessionReminderView | null>();
  let saveCalls = 0;
  let accepted: SetSessionReminderRequest | undefined;
  const props = {
    onClose: () => undefined,
    onSave: async (request: SetSessionReminderRequest) => {
      saveCalls++;
      if (saveCalls === 1) throw new ApiError("stale reminder", 409);
      accepted = request;
    },
    onReconcile: () => pendingRead.promise,
  };
  await act(async () => { root.render(<SnoozeDialog reminder={original} {...props} />); });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await Promise.resolve();
  });
  await act(async () => { root.render(<SnoozeDialog reminder={newerLive} {...props} />); });
  await act(async () => { pendingRead.resolve(readResult); await pendingRead.promise; });

  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /updated in another client/i);
  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Reload Reminder")!.click();
  });
  assert.equal(container.querySelector<HTMLInputElement>("#snooze-expression")?.value, "in 3 hours");
  await act(async () => { container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
  assert.equal(accepted?.expectedRevision, 3);
  assert.equal(accepted?.expectedReminderId, "reminder-original");

  await act(async () => { root.unmount(); });
  container.remove();
});
