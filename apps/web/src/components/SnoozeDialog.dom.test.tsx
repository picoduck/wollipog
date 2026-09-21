import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionReminderView, SetSessionReminderRequest } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { parseReminderExpression } from "../reminder-schedule.js";
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
  PointerEvent: domWindow.PointerEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  CompositionEvent: domWindow.CompositionEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

test("Snooze Again requires a newly selected future schedule and replaces the exact fired reminder", async () => {
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
  assert.match(container.textContent ?? "", /Choose a new time to snooze it again\./);
  assert.equal(container.querySelector(".modal-head h2")?.textContent, "Snooze Again");
  const expression = container.querySelector<HTMLInputElement>("#snooze-expression")!;
  assert.equal(expression.getAttribute("aria-describedby"), "snooze-expression-hint");
  const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  assert.equal(submit.textContent, "Snooze Again");
  assert.equal(submit.disabled, true, "the fired reminder's stored past instant cannot be submitted");
  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((button) => button.textContent === "In 1 Day")!.click();
  });
  assert.equal(submit.disabled, false);
  await act(async () => {
    submit.click();
  });
  assert.ok(saved && saved.scheduledFor > Date.now());
  assert.equal(saved?.expectedRevision, 2);
  assert.equal(saved?.expectedReminderId, "reminder-1");
  assert.equal(saved?.rescheduleFired, true);
  assert.equal(container.querySelector(".form-error"), null);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("a removed fired reminder's preserved draft still requires a newly selected schedule", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const scheduledFor = Date.now() - 60_000;
  const fired: SessionReminderView = {
    reminderId: "reminder-fired",
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
  const props = {
    onClose: () => undefined,
    onSave: async (request: SetSessionReminderRequest) => { saved = request; },
    onRemove: async () => undefined,
  };

  await act(async () => { root.render(<SnoozeDialog reminder={fired} {...props} />); });
  await act(async () => { root.render(<SnoozeDialog reminder={undefined} {...props} />); });
  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Create New Reminder from Draft")!.click();
  });

  const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  assert.equal(submit.disabled, true, "the expired preserved draft remains unavailable");
  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((button) => button.textContent === "In 1 Day")!.click();
  });
  await act(async () => { submit.click(); });
  assert.ok(saved && saved.scheduledFor > Date.now());
  assert.equal(saved?.expectedRevision, 0);
  assert.equal(saved && "expectedReminderId" in saved, false);
  assert.equal(saved && "rescheduleFired" in saved, false);

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
      assert.equal(expression.value, "", "normal reset discards the natural-language draft without inventing input");
      assert.equal(exact.value, "", "normal reset discards the exact-time draft");
      assert.equal(container.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')
        ?.textContent?.includes("Until Activity"), true, "normal reset restores the default Wake Policy");
      assert.equal(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true,
        "a reset reminder remains unavailable until the user chooses a schedule");
      await act(async () => {
        [...container.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent === "Tomorrow Morning")!.click();
      });
    } else if (scenario.authoritative.state === "fired") {
      await act(async () => {
        [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
          .find((button) => button.textContent === "In 1 Day")!.click();
      });
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

test("new reminders start empty while existing natural-language expressions remain intact", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SnoozeDialog onClose={() => undefined} onSave={async () => undefined} />);
  });

  const expression = container.querySelector<HTMLInputElement>("#snooze-expression")!;
  const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  assert.equal(expression.value, "");
  assert.equal(expression.placeholder, "Try “in 2 hours”");
  assert.equal(expression.getAttribute("role"), "combobox");
  assert.equal(expression.getAttribute("aria-expanded"), "false");
  assert.equal(submit.disabled, true);
  assert.match(container.querySelector(".snooze-preview")?.textContent ?? "", /Choose a preset or enter a future schedule/);

  const existing: SessionReminderView = {
    reminderId: "reminder-existing", sessionId: "session-1", scheduledFor: Date.now() + 7_200_000,
    timeZone: "UTC", originalExpression: "in 2 hours", wakePolicy: "until_activity", state: "pending",
    revision: 1, createdAt: 1, updatedAt: 1,
  };
  await act(async () => { root.unmount(); });
  const secondRoot = createRoot(container);
  await act(async () => {
    secondRoot.render(<SnoozeDialog reminder={existing} onClose={() => undefined} onSave={async () => undefined} />);
  });
  assert.equal(container.querySelector<HTMLInputElement>("#snooze-expression")?.value, "in 2 hours");
  assert.match(container.querySelector(".snooze-preview")?.textContent ?? "", /Schedule Source: Stored Reminder/);

  await act(async () => { secondRoot.unmount(); });
  container.remove();
});

test("schedule suggestions expose listbox semantics and keyboard selection submits exactly once", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const saved: SetSessionReminderRequest[] = [];
  let closes = 0;
  await act(async () => {
    root.render(<SnoozeDialog onClose={() => { closes++; }} onSave={async (request) => { saved.push(request); }} />);
  });
  const expression = container.querySelector<HTMLInputElement>("#snooze-expression")!;
  await act(async () => { fireDomEvent.change(expression, { target: { value: "in 23" } }); });

  const listbox = container.querySelector<HTMLElement>('[role="listbox"]')!;
  const options = [...container.querySelectorAll<HTMLElement>('[role="option"]')];
  assert.equal(expression.getAttribute("aria-expanded"), "true");
  assert.equal(expression.getAttribute("aria-controls"), listbox.id);
  assert.equal(listbox.getAttribute("aria-label"), "Schedule Suggestions");
  assert.deepEqual(options.map((option) => option.textContent?.match(/^In 23 (?:Minutes|Hours|Days)/)?.[0]), [
    "In 23 Minutes", "In 23 Hours", "In 23 Days",
  ]);
  assert.equal(options.every((option) => option.tabIndex === -1), true);
  assert.equal(expression.hasAttribute("aria-activedescendant"), false,
    "typing alone must not make Enter replace an already-valid expression with a different suggestion");

  await act(async () => { fireDomEvent.keyDown(expression, { key: "ArrowDown" }); });
  assert.equal(expression.getAttribute("aria-activedescendant"), options[0]?.id);
  await act(async () => { fireDomEvent.keyDown(expression, { key: "ArrowDown" }); });
  assert.equal(expression.getAttribute("aria-activedescendant"), options[1]?.id);
  await act(async () => { fireDomEvent.keyDown(expression, { key: "ArrowUp" }); });
  assert.equal(expression.getAttribute("aria-activedescendant"), options[0]?.id);
  await act(async () => {
    fireDomEvent.keyDown(expression, { key: "Enter" });
    fireDomEvent.keyDown(expression, { key: "Enter" });
    await Promise.resolve();
  });
  assert.equal(expression.value, "In 23 Minutes");
  assert.equal(expression.getAttribute("aria-expanded"), "false");
  assert.equal(saved.length, 1, "suggestion acceptance and form bubbling must not submit twice");
  assert.equal(saved[0]?.originalExpression, "In 23 Minutes");
  assert.equal(closes, 1);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("Escape dismisses suggestions before the dialog and Tab leaves suggestion options out of traversal", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  let closes = 0;
  await act(async () => {
    root.render(<SnoozeDialog onClose={() => { closes++; }} onSave={async () => undefined} />);
  });
  const expression = container.querySelector<HTMLInputElement>("#snooze-expression")!;
  await act(async () => { fireDomEvent.change(expression, { target: { value: "tom" } }); });
  assert.equal(expression.getAttribute("aria-expanded"), "true");
  await act(async () => { fireDomEvent.keyDown(expression, { key: "Escape" }); });
  assert.equal(expression.getAttribute("aria-expanded"), "false");
  assert.equal(closes, 0, "the popup owns the first Escape");
  await act(async () => { fireDomEvent.keyDown(expression, { key: "Escape" }); });
  assert.equal(closes, 1, "the dialog owns the next Escape");

  await act(async () => { fireDomEvent.change(expression, { target: { value: "in 7" } }); });
  const tab = new domWindow.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  await act(async () => { expression.dispatchEvent(tab as never); });
  assert.equal(tab.defaultPrevented, false, "native focus traversal remains available");
  assert.equal(expression.getAttribute("aria-expanded"), "false");
  assert.equal([...container.querySelectorAll<HTMLElement>('[role="option"]')].every((option) => option.tabIndex === -1), true);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("touch selection remains focus-safe and IME Enter never selects or submits", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const saved: SetSessionReminderRequest[] = [];
  await act(async () => {
    root.render(<SnoozeDialog onClose={() => undefined} onSave={async (request) => { saved.push(request); }} />);
  });
  const expression = container.querySelector<HTMLInputElement>("#snooze-expression")!;
  await act(async () => { fireDomEvent.change(expression, { target: { value: "in 7" } }); });
  const option = container.querySelector<HTMLElement>('[role="option"]')!;
  const originalActive = expression.getAttribute("aria-activedescendant");
  await act(async () => { fireDomEvent.keyDown(expression, { key: "Enter", isComposing: true }); });
  assert.equal(saved.length, 0);
  assert.equal(expression.getAttribute("aria-expanded"), "true");
  assert.equal(expression.getAttribute("aria-activedescendant"), originalActive);

  expression.focus();
  await act(async () => {
    fireDomEvent.pointerDown(option, { pointerType: "touch" });
    fireDomEvent.click(option);
  });
  assert.equal(expression.value, "In 7 Days");
  assert.equal(domWindow.document.activeElement, expression);
  assert.equal(saved.length, 0, "pointer and touch selection choose a schedule without implicitly submitting");
  assert.equal(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled, false);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("presets stay distinct from text input and every invalid schedule gets an actionable explanation", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SnoozeDialog onClose={() => undefined} onSave={async () => undefined} />);
  });
  const expression = container.querySelector<HTMLInputElement>("#snooze-expression")!;
  const exact = container.querySelector<HTMLInputElement>("#snooze-exact")!;
  const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const preview = () => container.querySelector(".snooze-preview")?.textContent ?? "";
  const tomorrow = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "Tomorrow Morning")!;
  await act(async () => { tomorrow.click(); });
  assert.equal(expression.value, "", "a preset must not masquerade as authored natural language");
  assert.equal(tomorrow.getAttribute("aria-checked"), "true");
  assert.equal(submit.disabled, false);
  assert.match(preview(), /Schedule Source: Preset — Tomorrow Morning/);

  await act(async () => { fireDomEvent.change(expression, { target: { value: "08\/22\/2026" } }); });
  assert.equal(submit.disabled, true);
  assert.match(preview(), /Numeric dates are ambiguous.*Exact Date and Time/);
  await act(async () => { fireDomEvent.change(expression, { target: { value: "whenever is good" } }); });
  assert.match(preview(), /Complete a supported phrase or choose a schedule suggestion/);
  await act(async () => { fireDomEvent.change(expression, { target: { value: "in 0 hours" } }); });
  assert.match(preview(), /not in the future.*positive interval/);
  await act(async () => { fireDomEvent.change(expression, { target: { value: "today at 25" } }); });
  assert.match(preview(), /valid clock time.*today at 3:30 PM/);
  await act(async () => { fireDomEvent.change(exact, { target: { value: "2000-01-01T00:00" } }); });
  assert.match(preview(), /exact date and time in the future/);
  assert.match(preview(), /Schedule Source: Exact Date and Time/);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("a complete natural-language expression leaves Enter available to the enclosing form", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const saved: SetSessionReminderRequest[] = [];
  await act(async () => {
    root.render(<SnoozeDialog onClose={() => undefined} onSave={async (request) => { saved.push(request); }} />);
  });
  const expression = container.querySelector<HTMLInputElement>("#snooze-expression")!;
  await act(async () => { fireDomEvent.change(expression, { target: { value: "in 2 hours" } }); });
  assert.equal(expression.getAttribute("aria-expanded"), "false");
  const enter = new domWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  await act(async () => { expression.dispatchEvent(enter as never); });
  assert.equal(enter.defaultPrevented, false, "closed autocomplete must not take Enter away from the form");
  await act(async () => { fireDomEvent.submit(container.querySelector("form")!); });
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.originalExpression, "in 2 hours");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("Enter submits a complete typed schedule even when broader suggestions remain visible", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const saved: SetSessionReminderRequest[] = [];
  await act(async () => {
    root.render(<SnoozeDialog onClose={() => undefined} onSave={async (request) => { saved.push(request); }} />);
  });
  const expression = container.querySelector<HTMLInputElement>("#snooze-expression")!;
  await act(async () => { fireDomEvent.change(expression, { target: { value: "tomorrow at 3 pm" } }); });
  assert.equal(expression.getAttribute("aria-expanded"), "true");
  assert.equal(expression.hasAttribute("aria-activedescendant"), false);
  assert.match(container.querySelector(".snooze-preview")?.textContent ?? "", /3:00 PM/);

  const expected = parseReminderExpression("tomorrow at 3 pm");
  const enter = new domWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  await act(async () => { expression.dispatchEvent(enter as never); });
  assert.equal(enter.defaultPrevented, false, "a suggestion is selected only after explicit arrow or pointer intent");
  await act(async () => { fireDomEvent.submit(container.querySelector("form")!); });
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.originalExpression, "tomorrow at 3 pm");
  assert.equal(saved[0]?.scheduledFor, expected?.scheduledFor);

  await act(async () => { root.unmount(); });
  container.remove();
});
