import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionReminderView, SetSessionReminderRequest } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import {
  formatReminderReturnDay,
  formatReminderTileTime,
  parseReminderExpression,
} from "../reminder-schedule.js";
import { SnoozeDialog } from "./SnoozeDialog.js";
import { ariaReferencedText, assertNoDomNode } from "../dom-test-assertions.js";

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

const TITLE = "Fix the half-cent rounding bug";
// Dialogs are portalled to <body>, so the tests query the body.
const body = domWindow.document.body as unknown as HTMLElement;

/** Mount `element`; `rerender` replaces it in the same root, so the dialog keeps its state. */
async function mount(element: ReactElement) {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  await act(async () => { root.render(element); });
  return {
    rerender: async (next: ReactElement) => { await act(async () => { root.render(next); }); },
    unmount: async () => {
      await act(async () => { root.unmount(); });
      mountPoint.remove();
    },
  };
}

const tiles = () => [...body.querySelectorAll<HTMLButtonElement>(".choice-tile")];
const tileNamed = (name: string) => tiles().find((tile) => ariaReferencedText(tile, "aria-labelledby") === name);
/** A pointer click reports a click count; arrows, Space and Enter do not. */
async function chooseTile(name: string, pointer = true) {
  const tile = tileNamed(name);
  assert.ok(tile, `the ${name} tile exists`);
  await act(async () => { fireDomEvent.click(tile, { detail: pointer ? 1 : 0 }); });
}
const field = () => body.querySelector<HTMLInputElement>("#snooze-expression");
async function typeSchedule(value: string) {
  await act(async () => { fireDomEvent.change(field()!, { target: { value } }); });
}
const primary = () => body.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const buttonNamed = (name: string) => [...body.querySelectorAll<HTMLButtonElement>("button")]
  .find((button) => button.textContent === name);
const summary = () => body.querySelector(".snooze-summary")?.textContent ?? "";
const returnEarly = () => body.querySelector<HTMLInputElement>('.checkbox input[type="checkbox"]')!;
const alertText = () => body.querySelector('[role="alert"]')?.textContent ?? "";
async function press(button: HTMLButtonElement | undefined) {
  assert.ok(button, "the button exists");
  await act(async () => { button.click(); await Promise.resolve(); });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(cause: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const pendingReminder = (overrides: Partial<SessionReminderView> = {}): SessionReminderView => ({
  reminderId: "reminder-original",
  sessionId: "session-1",
  scheduledFor: Date.now() + 3_600_000,
  timeZone: "UTC",
  originalExpression: "in 1 hour",
  wakePolicy: "until_activity",
  state: "pending",
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
} as SessionReminderView);

test("the default dialog is the session's title, six tiles with their times, one checkbox and the footer", async () => {
  const saved: SetSessionReminderRequest[] = [];
  const view = await mount(<SnoozeDialog
    sessionTitle={TITLE}
    supportsSomeday
    onClose={() => undefined}
    onSave={async (request) => { saved.push(request); }}
  />);
  try {
    assert.equal(body.querySelector(".modal-title")?.textContent, "Snooze Session");
    const dialog = body.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.equal(ariaReferencedText(dialog, "aria-describedby"), TITLE, "the description is the session's title");

    const group = body.querySelector<HTMLElement>('[role="radiogroup"]')!;
    assert.equal(group.getAttribute("aria-label"), "Return Time");
    assert.deepEqual(tiles().map((tile) => ariaReferencedText(tile, "aria-labelledby")),
      ["Later Today", "Tomorrow Morning", "Next Week", "Next Month", "Someday", "Custom…"]);
    assert.equal(tiles().every((tile) => tile.getAttribute("role") === "radio"), true);
    assert.equal(tiles().some((tile) => tile.getAttribute("aria-checked") === "true"), false, "nothing is chosen yet");
    // Each tile shows, and is described by, the time it resolves to.
    for (const [name, expression] of [["Tomorrow Morning", "tomorrow morning"], ["Next Week", "next week"], ["Next Month", "next month"]] as const) {
      const expected = formatReminderTileTime(parseReminderExpression(expression)!);
      assert.equal(ariaReferencedText(tileNamed(name)!, "aria-describedby"), expected, `${name} shows its time`);
    }
    assert.equal(ariaReferencedText(tileNamed("Someday")!, "aria-describedby"), "No set time");
    assert.equal(ariaReferencedText(tileNamed("Custom…")!, "aria-describedby"), "Type a time");

    assertNoDomNode(field(), "Snooze Until appears only for Custom…");
    assert.equal(returnEarly().checked, true, "Return Early is on by default");
    assert.equal(body.querySelector(".checkbox-label")?.textContent, "Return Early If It Needs Me");
    assert.equal(summary(), "", "there is nothing to summarize yet");
    assert.equal(primary().textContent, "Snooze Session");
    assert.equal(primary().disabled, false, "the primary stays enabled in a short form (§8.5)");
    assert.equal(buttonNamed("Cancel")?.className, "btn");
    assert.equal(domWindow.document.activeElement, tiles()[0], "the tiles' one stop takes opening focus");

    // No system words, uppercase labels or retired fields remain.
    const text = body.textContent ?? "";
    for (const retired of ["Schedule Source", "Time Zone:", "parser", "Scheduled Instant", "Exact Date and Time", "Wake Policy", "lifecycle"]) {
      assert.equal(text.includes(retired), false, `${retired} is gone`);
    }
    assertNoDomNode(body.querySelector('input[type="datetime-local"]'));
    assertNoDomNode(body.querySelector(".snooze-preview"));

    // Pressing the primary with nothing chosen says so under the tiles and moves focus there.
    await press(primary());
    assert.equal(saved.length, 0);
    assert.equal(group.getAttribute("aria-invalid"), "true");
    assert.equal(ariaReferencedText(group, "aria-describedby"), "Choose when it returns.");
    assert.equal(body.querySelector(".snooze-choice > .field-error")?.textContent, "Choose when it returns.");
    assert.equal(domWindow.document.activeElement, tiles()[0]);
    await chooseTile("Next Week");
    assert.equal(group.hasAttribute("aria-invalid"), false, "choosing clears the error");
    assertNoDomNode(body.querySelector(".field-error"));
  } finally {
    await view.unmount();
  }
});

test("Tomorrow Morning saves the same reminder as before, and the summary says when it returns", async () => {
  const saved: SetSessionReminderRequest[] = [];
  let closes = 0;
  const view = await mount(<SnoozeDialog
    sessionTitle={TITLE}
    onClose={() => { closes++; }}
    onSave={async (request) => { saved.push(request); }}
  />);
  try {
    assert.equal(tileNamed("Someday"), undefined, "Someday needs a server that supports it");
    assert.equal(tiles().length, 5);
    await chooseTile("Tomorrow Morning");
    assert.equal(tileNamed("Tomorrow Morning")?.getAttribute("aria-checked"), "true");
    assert.ok(tileNamed("Tomorrow Morning")?.querySelector(".choice-tile-check"), "the selected tile has a trailing check");
    const expected = parseReminderExpression("tomorrow morning")!;
    assert.equal(expected.scheduleKind, "timed");
    if (expected.scheduleKind !== "timed") return;
    assert.equal(summary(), `Returns ${formatReminderReturnDay(expected.scheduledFor, expected.timeZone)}.`);
    assert.match(summary(), / at 9:00 AM\.$/);
    assert.ok(body.querySelector(".snooze-summary svg"), "the summary leads with the alarm clock");

    await press(primary());
    assert.deepEqual(saved, [{ ...expected, wakePolicy: "until_activity", expectedRevision: 0 }]);
    assert.equal(closes, 1);
  } finally {
    await view.unmount();
  }
});

test("arrows move and select the tiles; only a pointer on Custom… goes on to its field", async () => {
  const view = await mount(<SnoozeDialog sessionTitle={TITLE} supportsSomeday onClose={() => undefined} onSave={async () => undefined} />);
  try {
    const group = body.querySelector<HTMLElement>('[role="radiogroup"]')!;
    tiles()[0]!.focus();
    await act(async () => { fireDomEvent.keyDown(tiles()[0]!, { key: "ArrowRight" }); });
    assert.equal(domWindow.document.activeElement, tileNamed("Tomorrow Morning"));
    assert.equal(tileNamed("Tomorrow Morning")?.getAttribute("aria-checked"), "true");
    assert.equal(tileNamed("Tomorrow Morning")?.tabIndex, 0, "the selected tile is the group's one stop");
    await act(async () => { fireDomEvent.keyDown(domWindow.document.activeElement as unknown as Element, { key: "End" }); });
    assert.equal(tileNamed("Custom…")?.getAttribute("aria-checked"), "true");
    assert.equal(domWindow.document.activeElement, tileNamed("Custom…"), "arrows keep focus in the tiles");
    assert.ok(field(), "Custom… reveals Snooze Until");
    assert.equal(group.contains(domWindow.document.activeElement as never), true);

    await chooseTile("Next Week");
    assertNoDomNode(field());
    await chooseTile("Custom…", true);
    assert.equal(domWindow.document.activeElement, field(), "a pointer on Custom… goes on to its field");
  } finally {
    await view.unmount();
  }
});

test("Custom… takes a named date, and a numeric date is an error at the field with its fix", async () => {
  const saved: SetSessionReminderRequest[] = [];
  const view = await mount(<SnoozeDialog
    sessionTitle={TITLE}
    onClose={() => undefined}
    onSave={async (request) => { saved.push(request); }}
  />);
  try {
    await chooseTile("Custom…");
    const input = field()!;
    const label = body.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`);
    assert.equal(label?.textContent, "Snooze Until");
    assert.equal(label?.closest(".field"), input.closest(".field"), "one §8.1 field");
    assert.equal(input.getAttribute("role"), "combobox");
    assert.equal(input.hasAttribute("placeholder"), false);
    assert.match(ariaReferencedText(input, "aria-describedby") ?? "",
      /^Try “in 2 hours”, “tomorrow 3pm” or “dec 10 9am”\. Times use .+\.$/);
    assertNoDomNode(body.querySelector("#snooze-exact"), "the Exact Date and Time input is gone");

    await typeSchedule("dec 10 9am");
    const expected = parseReminderExpression("dec 10 9am")!;
    assert.equal(expected.scheduleKind, "timed");
    if (expected.scheduleKind !== "timed") return;
    assert.equal(new Date(expected.scheduledFor).getMonth(), 11);
    assert.equal(new Date(expected.scheduledFor).getDate(), 10);
    assert.equal(summary(), `Returns ${formatReminderReturnDay(expected.scheduledFor, expected.timeZone)}.`);
    assert.match(summary(), /^Returns \w+day, Dec 10(?:, \d{4})? at 9:00 AM\.$/);
    assert.equal(ariaReferencedText(tileNamed("Custom…")!, "aria-describedby"), formatReminderTileTime(expected));

    // An ambiguous numeric date: shown on leaving the field (§8.5), under it, in place of the helper.
    await typeSchedule("12/10/26");
    assert.equal(input.hasAttribute("aria-invalid"), false, "typing alone does not flag the field");
    input.focus();
    await act(async () => { returnEarly().focus(); });
    const message = "“12/10/26” could be December 10 or October 12. Write the month, like “Dec 10”.";
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.equal(ariaReferencedText(input, "aria-describedby"), message);
    const error = body.querySelector(".field-error");
    assert.equal(error?.textContent, message);
    assert.equal(error?.getAttribute("role"), null, "the error is not an alert; focus announces it");
    assertNoDomNode(body.querySelector(".field-helper"), "the error replaces the helper");
    assert.equal(summary(), "");

    // The primary stays enabled, refuses to save, and puts focus on the field.
    tileNamed("Custom…")!.focus();
    assert.equal(primary().disabled, false);
    await press(primary());
    assert.equal(saved.length, 0);
    assert.equal(domWindow.document.activeElement, input);

    // The error clears as soon as the value resolves.
    await typeSchedule("Dec 10 9am");
    assert.equal(input.hasAttribute("aria-invalid"), false);
    assertNoDomNode(body.querySelector(".field-error"));
    await press(primary());
    assert.equal(saved[0]?.originalExpression, "Dec 10 9am");
    assert.equal(saved[0]?.scheduledFor, expected.scheduledFor);
  } finally {
    await view.unmount();
  }
});

test("every invalid entry gets one actionable sentence", async () => {
  const view = await mount(<SnoozeDialog sessionTitle={TITLE} onClose={() => undefined} onSave={async () => undefined} />);
  try {
    await chooseTile("Custom…");
    await press(primary());
    const error = () => body.querySelector(".field-error")?.textContent ?? "";
    assert.equal(error(), "Enter when it returns, like “tomorrow 3pm”.");
    for (const [entry, message] of [
      ["whenever is good", /^Wollipog can't read “whenever is good” as a time\. Try “in 2 hours”, “tomorrow 3pm” or “dec 10 9am”\.$/],
      ["Someday", /^Someday needs a newer version of Wollipog\. Enter a time instead\.$/],
      ["in 0 hours", /^Choose a time in the future, like “in 2 hours”\.$/],
      ["today at 25", /^Enter a real time of day, like “3:30pm”\.$/],
      ["feb 30", /^“feb 30” isn't a date on the calendar\. Check the day and the month\.$/],
      ["jan 1 2000", /^That time has passed\. Choose a later one\.$/],
      ["25/12/26", /^“25\/12\/26” is a date in numbers only\. Write the month, like “Dec 25”\.$/],
    ] as const) {
      await typeSchedule(entry);
      assert.match(error(), message, entry);
    }
  } finally {
    await view.unmount();
  }
});

test("Return Early maps to the wake policy: unchecked saves regardless, checked saves until_activity", async () => {
  const saved: SetSessionReminderRequest[] = [];
  for (const checked of [false, true]) {
    const view = await mount(<SnoozeDialog
      sessionTitle={TITLE}
      onClose={() => undefined}
      onSave={async (request) => { saved.push(request); }}
    />);
    try {
      const helper = body.querySelector(".checkbox-helper")?.textContent;
      assert.equal(helper, "An approval, a question, a failure or finished background work brings it back sooner.");
      await chooseTile("Next Week");
      if (!checked) await act(async () => { returnEarly().click(); });
      assert.equal(returnEarly().checked, checked);
      await press(primary());
    } finally {
      await view.unmount();
    }
  }
  assert.deepEqual(saved.map((request) => request.wakePolicy), ["regardless", "until_activity"]);
});

test("the primary shows the busy spinner while saving and keeps its label", async () => {
  const pending = deferred<void>();
  const view = await mount(<SnoozeDialog sessionTitle={TITLE} onClose={() => undefined} onSave={() => pending.promise} />);
  try {
    await chooseTile("Next Week");
    await press(primary());
    assert.equal(primary().getAttribute("aria-busy"), "true");
    assert.equal(primary().getAttribute("aria-disabled"), "true");
    assert.ok(primary().querySelector(".spinner, [data-spinner], svg"), "a spinner is shown");
    assert.equal(primary().textContent, "Snooze Session", "the label never becomes a progress word");
    assert.equal((body.textContent ?? "").includes("Saving…"), false);
    assert.match(body.querySelector('.modal-foot [role="status"]')?.textContent ?? "", /Snoozing the session…/);
    await act(async () => { pending.resolve(); await pending.promise; });
  } finally {
    await view.unmount();
  }
});

test("Edit Reminder starts on Custom… with the stored words and saves the stored instant untouched", async () => {
  const stored = pendingReminder({
    scheduledFor: Date.UTC(2099, 4, 6, 12, 45),
    timeZone: "Asia/Tokyo",
    originalExpression: "2099-05-06T21:45",
    wakePolicy: "regardless",
    revision: 4,
  });
  const saved: SetSessionReminderRequest[] = [];
  const view = await mount(<SnoozeDialog
    sessionTitle={TITLE}
    reminder={stored}
    onClose={() => undefined}
    onSave={async (request) => { saved.push(request); }}
    onRemove={async () => undefined}
  />);
  try {
    assert.equal(body.querySelector(".modal-title")?.textContent, "Edit Reminder");
    assert.equal(tileNamed("Custom…")?.getAttribute("aria-checked"), "true");
    assert.equal(field()?.value, "2099-05-06T21:45");
    assert.equal(domWindow.document.activeElement, field(), "a fine pointer opens on the field");
    assert.equal(returnEarly().checked, false);
    assert.match(summary(), /^Returns Wednesday, May 6, 2099 at 9:45 PM GMT\+9\.$/, "a stored zone is named");
    assert.equal(primary().textContent, "Update Reminder");
    assert.ok(buttonNamed("Remove Reminder"), "Remove Reminder stays the tertiary");
    await press(primary());
    assert.equal(saved[0]?.scheduledFor, stored.scheduledFor);
    assert.equal(saved[0]?.timeZone, "Asia/Tokyo");
    assert.equal(saved[0]?.expectedRevision, 4);
    assert.equal(saved[0]?.expectedReminderId, stored.reminderId);
    assert.equal(saved[0]?.wakePolicy, "regardless");
  } finally {
    await view.unmount();
  }
});

test("Snooze Again requires a newly chosen schedule and replaces the exact fired reminder", async () => {
  const scheduledFor = Date.now() - 60_000;
  const fired = pendingReminder({
    reminderId: "reminder-1",
    scheduledFor,
    originalExpression: "one minute ago",
    state: "fired",
    revision: 2,
    firedAt: scheduledFor,
    wakeReason: "scheduled",
  });
  const saves: SetSessionReminderRequest[] = [];
  const view = await mount(<SnoozeDialog
    sessionTitle={TITLE}
    reminder={fired}
    onClose={() => undefined}
    onSave={async (request) => { saves.push(request); }}
    onRemove={async () => undefined}
  />);
  try {
    assert.equal(body.querySelector(".modal-title")?.textContent, "Snooze Again");
    assert.equal(primary().textContent, "Snooze Again");
    assert.ok(buttonNamed("Dismiss Reminder"));
    assert.equal(tiles().some((tile) => tile.getAttribute("aria-checked") === "true"), false);
    await press(primary());
    assert.equal(saves.length, 0, "the fired reminder's past instant is never resubmitted");
    assert.equal(body.querySelector(".snooze-choice > .field-error")?.textContent, "Choose when it returns.");
    await chooseTile("Next Week");
    await press(primary());
    const saved = saves[0];
    assert.ok((saved?.scheduledFor ?? 0) > Date.now());
    assert.equal(saved?.expectedRevision, 2);
    assert.equal(saved?.expectedReminderId, "reminder-1");
    assert.equal(saved?.rescheduleFired, true);
  } finally {
    await view.unmount();
  }
});

test("Snooze Again submits a keyboard-selected suggestion on the first Enter", async () => {
  const fired = pendingReminder({
    reminderId: "reminder-activity-fired",
    scheduledFor: Date.now() + 7_200_000,
    originalExpression: "in 2",
    state: "fired",
    revision: 2,
    firedAt: 2,
    wakeReason: "agent_response",
  });
  const saved: SetSessionReminderRequest[] = [];
  const view = await mount(<SnoozeDialog
    sessionTitle={TITLE}
    reminder={fired}
    onClose={() => undefined}
    onSave={async (request) => { saved.push(request); }}
  />);
  try {
    await chooseTile("Custom…");
    const input = field()!;
    assert.equal(input.value, "in 2", "the fired reminder's words are kept to start from");
    await act(async () => { fireDomEvent.keyDown(input, { key: "ArrowDown" }); });
    assert.equal(input.getAttribute("aria-expanded"), "true");
    await act(async () => {
      fireDomEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.rescheduleFired, true);
    assert.equal(saved[0]?.expectedReminderId, fired.reminderId);
    assert.ok((saved[0]?.scheduledFor ?? 0) > Date.now());
  } finally {
    await view.unmount();
  }
});

test("a live change keeps the whole draft, refuses the primary with a reason, and reloads on request", async () => {
  const original = pendingReminder({
    scheduledFor: Date.now() + 86_400_000,
    timeZone: "America/Chicago",
    originalExpression: "tomorrow morning",
  });
  const updated = pendingReminder({
    scheduledFor: Date.now() + 172_800_000,
    timeZone: "Asia/Tokyo",
    originalExpression: "2099-05-06T07:45",
    revision: 2,
    updatedAt: 2,
  });
  const saved: SetSessionReminderRequest[] = [];
  const dialog = (reminder: SessionReminderView | undefined) => <SnoozeDialog
    sessionTitle={TITLE}
    reminder={reminder}
    onClose={() => undefined}
    onSave={async (request) => { saved.push(request); }}
    onRemove={async () => undefined}
  />;
  const view = await mount(dialog(original));
  try {
    const input = field()!;
    await typeSchedule("today at 11:59 pm");
    await act(async () => { returnEarly().click(); });
    input.focus();

    await view.rerender(dialog(updated));
    assert.equal(domWindow.document.activeElement, input, "a live update must not remount or move focus");
    assert.equal(input.value, "today at 11:59 pm");
    assert.equal(returnEarly().checked, false);
    const notice = body.querySelector(".notice.t-warning[role=\"alert\"]");
    assert.ok(notice, "the conflict is one warning notice");
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Reminder Changed");
    assert.match(notice.textContent ?? "", /updated in another client.*Your changes here are kept/i);
    assert.equal(primary().disabled, false);
    assert.equal(primary().getAttribute("aria-disabled"), "true");
    assert.equal(ariaReferencedText(primary(), "aria-describedby"), "Reload the reminder before saving.");
    assert.equal(body.querySelector(".modal-foot > .snooze-blocked-reason")?.textContent, "Reload the reminder before saving.");
    await press(primary());
    assert.equal(saved.length, 0);

    await press(buttonNamed("Reload Reminder"));
    assertNoDomNode(body.querySelector('[role="alert"]'));
    assertNoDomNode(body.querySelector(".snooze-blocked-reason"));
    assert.equal(domWindow.document.activeElement, field(), "reloading keeps focus in the dialog");
    assert.equal(field()?.value, "2099-05-06T07:45");
    assert.equal(returnEarly().checked, true);
    assert.match(summary(), /GMT\+9\.$/);

    await press(primary());
    assert.equal(saved[0]?.expectedRevision, 2);
    assert.equal(saved[0]?.expectedReminderId, "reminder-original");
    assert.equal(saved[0]?.scheduledFor, updated.scheduledFor);
  } finally {
    await view.unmount();
  }
});

test("the server echo from the dialog's own save is not announced as a remote conflict", async () => {
  const original = pendingReminder();
  const pending = deferred<void>();
  const dialog = (reminder: SessionReminderView) => <SnoozeDialog
    sessionTitle={TITLE}
    reminder={reminder}
    onClose={() => undefined}
    onSave={() => pending.promise}
    onRemove={async () => undefined}
  />;
  const view = await mount(dialog(original));
  try {
    await press(primary());
    await view.rerender(dialog({ ...original, revision: 2, updatedAt: 2 }));
    assertNoDomNode(body.querySelector('[role="alert"]'));
    await act(async () => { pending.resolve(); await pending.promise; });
  } finally {
    await view.unmount();
  }
});

test("fired, removed, and recreated reminders have distinct live-conflict messages", async () => {
  const original = pendingReminder();
  const dialog = (reminder: SessionReminderView | undefined) => <SnoozeDialog
    sessionTitle={TITLE}
    reminder={reminder}
    onClose={() => undefined}
    onSave={async () => undefined}
    onRemove={async () => undefined}
  />;
  const view = await mount(dialog(original));
  try {
    const submit = primary();
    submit.focus();
    await view.rerender(dialog({ ...original, state: "fired", revision: 2, firedAt: 2, wakeReason: "scheduled" } as SessionReminderView));
    assert.match(alertText(), /already fired/i);
    assert.equal(domWindow.document.activeElement, submit);
    assert.equal(submit.getAttribute("aria-disabled"), "true");

    await press(buttonNamed("Reload Reminder"));
    const dismiss = buttonNamed("Dismiss Reminder")!;
    dismiss.focus();
    await view.rerender(dialog(undefined));
    assert.match(alertText(), /removed in another client/i);
    assert.match(alertText(), /Create a new reminder from them, or start over/);
    assert.equal(domWindow.document.activeElement, dismiss);
    assert.equal(dismiss.disabled, false);
    assert.equal(dismiss.getAttribute("aria-disabled"), "true");
    assert.ok(buttonNamed("Start New Reminder"));
    assert.ok(buttonNamed("Create New Reminder from Draft"));
    assert.equal(body.querySelector(".snooze-blocked-reason")?.textContent, "Create a new reminder or start over before saving.");

    await view.rerender(dialog({ ...original, reminderId: "reminder-recreated", revision: 1 }));
    assert.match(alertText(), /removed and recreated in another client/i);
  } finally {
    await view.unmount();
  }
});

test("409 reconciliation distinguishes authoritative reminder states without live delivery", async () => {
  const original = pendingReminder({ timeZone: "America/Chicago" });
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
      authoritative: { ...original, state: "fired", revision: 2, updatedAt: 2, firedAt: 2, wakeReason: "scheduled" } as SessionReminderView,
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
    let saveCalls = 0;
    let reconciliations = 0;
    let accepted: SetSessionReminderRequest | undefined;
    let acceptedPrevious: SessionReminderView | undefined;
    const view = await mount(<SnoozeDialog
      sessionTitle={TITLE}
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
    try {
      const input = field()!;
      await typeSchedule("in 3 hours");
      await act(async () => { returnEarly().click(); });
      input.focus();
      await act(async () => {
        primary().click();
        await Promise.resolve();
      });

      assert.equal(saveCalls, 1, `${scenario.name}: the stale mutation is not retried`);
      assert.equal(reconciliations, 1, `${scenario.name}: exactly one authoritative read follows the conflict`);
      assert.equal(input.value, "in 3 hours", `${scenario.name}: the typed draft`);
      assert.equal(returnEarly().checked, false, `${scenario.name}: the Return Early draft`);
      assert.match(alertText(), scenario.message, scenario.name);
      assert.equal(domWindow.document.activeElement, input, `${scenario.name}: reconciliation keeps focus`);

      await press(buttonNamed(scenario.action));
      const active = domWindow.document.activeElement as unknown as HTMLElement | null;
      assert.ok(active && body.querySelector('[role="dialog"]')?.contains(active as never), `${scenario.name}: focus stays in the dialog`);
      if (scenario.authoritative === null) {
        assertNoDomNode(field(), "a reset starts from the tiles");
        assert.equal(tiles().some((tile) => tile.getAttribute("aria-checked") === "true"), false);
        assert.equal(returnEarly().checked, true, "a reset restores Return Early");
        assert.equal(active, tiles()[0]);
        await chooseTile("Tomorrow Morning");
      } else if (scenario.authoritative.state === "fired") {
        await chooseTile("Next Week");
      } else {
        assert.equal(active, field());
      }
      await press(primary());
      assert.equal(accepted?.expectedRevision, scenario.expectedRevision, scenario.name);
      assert.equal(accepted?.expectedReminderId, scenario.expectedReminderId, scenario.name);
      assert.equal(acceptedPrevious?.reminderId, scenario.authoritative?.reminderId, scenario.name);
    } finally {
      await view.unmount();
    }
  }
});

test("a removed reminder can be recreated explicitly from the complete preserved draft", async () => {
  const original = pendingReminder({ scheduledFor: Date.now() + 86_400_000, originalExpression: "tomorrow morning" });
  let accepted: SetSessionReminderRequest | undefined;
  let acceptedPrevious: SessionReminderView | undefined;
  let closes = 0;
  const dialog = (reminder: SessionReminderView | undefined) => <SnoozeDialog
    sessionTitle={TITLE}
    reminder={reminder}
    onClose={() => { closes++; }}
    onSave={async (request, previous) => { accepted = request; acceptedPrevious = previous; }}
    onRemove={async () => undefined}
  />;
  const view = await mount(dialog(original));
  try {
    const input = field()!;
    await typeSchedule("in 3 hours");
    await act(async () => { returnEarly().click(); });
    input.focus();

    await view.rerender(dialog(undefined));
    assert.match(alertText(), /removed in another client/i);
    assert.equal(domWindow.document.activeElement, input, "remote removal keeps the active draft field focused");
    await press(buttonNamed("Create New Reminder from Draft"));

    assert.equal(body.querySelector(".modal-title")?.textContent, "Create New Reminder");
    assert.equal(ariaReferencedText(body.querySelector<HTMLElement>('[role="dialog"]')!, "aria-describedby"), TITLE);
    assert.match(body.querySelector('.snooze-form > [role="status"].sr-only')?.textContent ?? "",
      /creating a new reminder from the preserved draft.*will not be restored/i);
    assert.equal(domWindow.document.activeElement, input, "draft reuse keeps focus in the dialog");
    assert.equal(input.value, "in 3 hours");
    assert.equal(returnEarly().checked, false);
    assert.equal(buttonNamed("Remove Reminder"), undefined, "a new reminder has nothing to remove");

    await press(primary());
    assert.equal(accepted?.expectedRevision, 0, "draft reuse is create-only");
    assert.equal(accepted && "expectedReminderId" in accepted, false);
    assert.equal(accepted?.originalExpression, "in 3 hours");
    assert.equal(accepted?.wakePolicy, "regardless");
    assert.equal(acceptedPrevious, undefined);
    assert.equal(closes, 1);
  } finally {
    await view.unmount();
  }
});

test("draft reuse retains an untouched stored instant and time zone", async () => {
  const scheduledFor = Date.UTC(2099, 4, 6, 12, 45);
  const original = pendingReminder({
    scheduledFor,
    timeZone: "Asia/Tokyo",
    originalExpression: "2099-05-06T21:45",
    wakePolicy: "regardless",
    revision: 4,
  });
  let accepted: SetSessionReminderRequest | undefined;
  const dialog = (reminder: SessionReminderView | undefined) => <SnoozeDialog
    sessionTitle={TITLE}
    reminder={reminder}
    onClose={() => undefined}
    onSave={async (request) => { accepted = request; }}
    onRemove={async () => undefined}
  />;
  const view = await mount(dialog(original));
  try {
    await view.rerender(dialog(undefined));
    await press(buttonNamed("Create New Reminder from Draft"));
    await press(primary());
    assert.equal(accepted?.scheduledFor, scheduledFor);
    assert.equal(accepted?.timeZone, "Asia/Tokyo");
    assert.equal(accepted?.originalExpression, "2099-05-06T21:45");
    assert.equal(accepted?.wakePolicy, "regardless");
    assert.equal(accepted?.expectedRevision, 0);
    assert.equal(accepted && "expectedReminderId" in accepted, false);
  } finally {
    await view.unmount();
  }
});

test("a concurrent recreation blocks preserved-draft creation and reload keeps focus in the dialog", async () => {
  const original = pendingReminder();
  const recreated = pendingReminder({ reminderId: "reminder-recreated", originalExpression: "in 2 hours", updatedAt: 2 });
  const saved: SetSessionReminderRequest[] = [];
  const dialog = (reminder: SessionReminderView | undefined) => <SnoozeDialog
    sessionTitle={TITLE}
    reminder={reminder}
    onClose={() => undefined}
    onSave={async (request) => { saved.push(request); }}
    onRemove={async () => undefined}
  />;
  const view = await mount(dialog(original));
  try {
    await view.rerender(dialog(undefined));
    await press(buttonNamed("Create New Reminder from Draft"));
    const input = field()!;
    assert.equal(domWindow.document.activeElement, input);

    await view.rerender(dialog(recreated));
    assert.match(alertText(), /created in another client/i);
    assert.equal(domWindow.document.activeElement, input, "the new conflict does not move focus");
    assert.equal(primary().getAttribute("aria-disabled"), "true");
    await press(primary());
    assert.equal(saved.length, 0, "the create-only write is blocked when recreation is known");

    await press(buttonNamed("Reload Reminder"));
    assert.equal(domWindow.document.activeElement, field());
    assert.equal(field()?.value, "in 2 hours");
    await press(primary());
    assert.equal(saved[0]?.expectedRevision, 1);
    assert.equal(saved[0]?.expectedReminderId, "reminder-recreated");
  } finally {
    await view.unmount();
  }
});

test("a create-only race reconciles a reminder recreated without live delivery", async () => {
  const original = pendingReminder();
  const recreated = pendingReminder({ reminderId: "reminder-recreated", originalExpression: "in 2 hours", updatedAt: 2 });
  const saved: SetSessionReminderRequest[] = [];
  let reconciliations = 0;
  const dialog = (reminder: SessionReminderView | undefined) => <SnoozeDialog
    sessionTitle={TITLE}
    reminder={reminder}
    onClose={() => undefined}
    onSave={async (request) => {
      saved.push(request);
      if (saved.length === 1) throw new ApiError("reminder changed in another client", 409);
    }}
    onRemove={async () => undefined}
    onReconcile={async () => { reconciliations++; return recreated; }}
  />;
  const view = await mount(dialog(original));
  try {
    await view.rerender(dialog(undefined));
    await press(buttonNamed("Create New Reminder from Draft"));
    const input = field()!;
    await press(primary());

    assert.equal(saved.length, 1, "the stale create is never retried automatically");
    assert.equal(saved[0]?.expectedRevision, 0);
    assert.equal(reconciliations, 1);
    assert.match(alertText(), /created in another client/i);
    assert.equal(domWindow.document.activeElement, input, "reconciliation keeps focus in the dialog");

    await press(buttonNamed("Reload Reminder"));
    assert.equal(field()?.value, "in 2 hours");
    await press(primary());
    assert.equal(saved[1]?.expectedRevision, 1);
    assert.equal(saved[1]?.expectedReminderId, "reminder-recreated");
  } finally {
    await view.unmount();
  }
});

test("a failed reconciliation is a danger notice above the footer, and only the safe read is retried", async () => {
  const original = pendingReminder();
  const updated = { ...original, originalExpression: "in 2 hours", revision: 2, updatedAt: 2 };
  let saveCalls = 0;
  let readCalls = 0;
  const view = await mount(<SnoozeDialog
    sessionTitle={TITLE}
    reminder={original}
    onClose={() => undefined}
    onSave={async () => { saveCalls++; throw new ApiError("stale reminder", 409); }}
    onReconcile={async () => {
      readCalls++;
      if (readCalls === 1) throw new ApiError("not found", 404);
      if (readCalls === 2) throw new ApiError("Wollipog is unavailable", 503);
      return updated;
    }}
  />);
  try {
    await act(async () => {
      primary().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const failure = body.querySelector('.notice.t-danger[role="alert"]');
    assert.ok(failure, "a danger notice");
    assert.equal(failure.parentElement?.lastElementChild, failure, "at the body's end, above the footer (§7.3)");
    assert.match(failure.textContent ?? "", /Couldn't load the current reminder\. not found/);
    assert.equal(saveCalls, 1);
    assert.equal(readCalls, 1);

    await press(buttonNamed("Retry Reconciliation"));
    assert.match(alertText(), /Couldn't load the current reminder\. Wollipog is unavailable/);
    assert.equal(saveCalls, 1, "a failed read never retries the mutation");
    assert.equal(readCalls, 2);

    await press(buttonNamed("Retry Reconciliation"));
    assert.match(alertText(), /updated in another client/i);
    assert.equal(saveCalls, 1);
    assert.equal(readCalls, 3);
  } finally {
    await view.unmount();
  }
});

test("a newer live update wins when it arrives during authoritative reconciliation", async () => {
  const original = pendingReminder();
  const readResult = { ...original, originalExpression: "in 2 hours", revision: 2, updatedAt: 2 };
  const newerLive = { ...original, originalExpression: "in 3 hours", revision: 3, updatedAt: 3 };
  const pendingRead = deferred<SessionReminderView | null>();
  let saveCalls = 0;
  let accepted: SetSessionReminderRequest | undefined;
  const dialog = (reminder: SessionReminderView) => <SnoozeDialog
    sessionTitle={TITLE}
    reminder={reminder}
    onClose={() => undefined}
    onSave={async (request) => {
      saveCalls++;
      if (saveCalls === 1) throw new ApiError("stale reminder", 409);
      accepted = request;
    }}
    onReconcile={() => pendingRead.promise}
  />;
  const view = await mount(dialog(original));
  try {
    await press(primary());
    await view.rerender(dialog(newerLive));
    await act(async () => { pendingRead.resolve(readResult); await pendingRead.promise; });
    assert.match(alertText(), /updated in another client/i);
    await press(buttonNamed("Reload Reminder"));
    assert.equal(field()?.value, "in 3 hours");
    await press(primary());
    assert.equal(accepted?.expectedRevision, 3);
    assert.equal(accepted?.expectedReminderId, "reminder-original");
  } finally {
    await view.unmount();
  }
});

test("schedule suggestions expose listbox semantics and keyboard selection submits exactly once", async () => {
  const saved: SetSessionReminderRequest[] = [];
  let closes = 0;
  const view = await mount(<SnoozeDialog
    sessionTitle={TITLE}
    onClose={() => { closes++; }}
    onSave={async (request) => { saved.push(request); }}
  />);
  try {
    await chooseTile("Custom…");
    const input = field()!;
    await typeSchedule("in 23");
    const listbox = body.querySelector<HTMLElement>('[role="listbox"]')!;
    const options = [...body.querySelectorAll<HTMLElement>('[role="option"]')];
    assert.equal(input.getAttribute("aria-expanded"), "true");
    assert.equal(input.getAttribute("aria-controls"), listbox.id);
    assert.equal(listbox.getAttribute("aria-label"), "Schedule Suggestions");
    assert.equal(listbox.closest(".snooze-form"), input.closest(".snooze-form"), "the list stays in the dialog's flow");
    // Each suggestion is named by its phrase and described by the instant it resolves to (#2369).
    assert.deepEqual(options.map((option) => ariaReferencedText(option, "aria-labelledby")), [
      "In 23 Minutes", "In 23 Hours", "In 23 Days",
    ]);
    for (const option of options) {
      const name = ariaReferencedText(option, "aria-labelledby");
      const description = ariaReferencedText(option, "aria-describedby");
      assert.ok(description, `${name} has an accessible description`);
      assert.equal(option.textContent, `${name}${description}`);
    }
    assert.equal(options.every((option) => option.tabIndex === -1), true);
    assert.equal(input.hasAttribute("aria-activedescendant"), false,
      "typing alone must not make Enter replace an already-valid expression with a different suggestion");

    await act(async () => { fireDomEvent.keyDown(input, { key: "ArrowDown" }); });
    assert.equal(input.getAttribute("aria-activedescendant"), options[0]?.id);
    await act(async () => { fireDomEvent.keyDown(input, { key: "ArrowDown" }); });
    assert.equal(input.getAttribute("aria-activedescendant"), options[1]?.id);
    await act(async () => { fireDomEvent.keyDown(input, { key: "ArrowUp" }); });
    assert.equal(input.getAttribute("aria-activedescendant"), options[0]?.id);
    await act(async () => {
      fireDomEvent.keyDown(input, { key: "Enter" });
      fireDomEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    assert.equal(input.value, "In 23 Minutes");
    assert.equal(saved.length, 1, "suggestion acceptance and form bubbling must not submit twice");
    assert.equal(saved[0]?.originalExpression, "In 23 Minutes");
    assert.equal(closes, 1);
  } finally {
    await view.unmount();
  }
});

test("a named date suggests its morning and afternoon", async () => {
  const view = await mount(<SnoozeDialog sessionTitle={TITLE} onClose={() => undefined} onSave={async () => undefined} />);
  try {
    await chooseTile("Custom…");
    await typeSchedule("dec 10");
    assert.deepEqual([...body.querySelectorAll<HTMLElement>('[role="option"]')]
      .map((option) => ariaReferencedText(option, "aria-labelledby")), ["December 10 at 9 AM", "December 10 at 1 PM"]);
  } finally {
    await view.unmount();
  }
});

test("a Someday suggestion is named by its expression and described as having no return time", async () => {
  const view = await mount(<SnoozeDialog sessionTitle={TITLE} supportsSomeday onClose={() => undefined} onSave={async () => undefined} />);
  try {
    await chooseTile("Custom…");
    await typeSchedule("some");
    const someday = [...body.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => ariaReferencedText(option, "aria-labelledby") === "Someday");
    assert.ok(someday, "Someday is suggested");
    assert.equal(ariaReferencedText(someday, "aria-describedby"), "No automatic return time");
  } finally {
    await view.unmount();
  }
});

test("Escape dismisses suggestions before the dialog and Tab leaves suggestion options out of traversal", async () => {
  let closes = 0;
  const view = await mount(<SnoozeDialog sessionTitle={TITLE} onClose={() => { closes++; }} onSave={async () => undefined} />);
  try {
    await chooseTile("Custom…");
    const input = field()!;
    await typeSchedule("tom");
    assert.equal(input.getAttribute("aria-expanded"), "true");
    await act(async () => { fireDomEvent.keyDown(input, { key: "Escape" }); });
    assert.equal(input.getAttribute("aria-expanded"), "false");
    assert.equal(closes, 0, "the popup owns the first Escape");
    await act(async () => { fireDomEvent.keyDown(input, { key: "Escape" }); });
    assert.equal(closes, 1, "the dialog owns the next Escape");

    await typeSchedule("in 7");
    const tab = new domWindow.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => { input.dispatchEvent(tab as never); });
    assert.equal(tab.defaultPrevented, false, "native focus traversal remains available");
    assert.equal(input.getAttribute("aria-expanded"), "false");
  } finally {
    await view.unmount();
  }
});

test("touch selection remains focus-safe and IME Enter never selects or submits", async () => {
  const saved: SetSessionReminderRequest[] = [];
  const view = await mount(<SnoozeDialog sessionTitle={TITLE} onClose={() => undefined} onSave={async (request) => { saved.push(request); }} />);
  try {
    await chooseTile("Custom…");
    const input = field()!;
    await typeSchedule("in 7");
    const option = body.querySelector<HTMLElement>('[role="option"]')!;
    const originalActive = input.getAttribute("aria-activedescendant");
    await act(async () => { fireDomEvent.keyDown(input, { key: "Enter", isComposing: true }); });
    assert.equal(saved.length, 0);
    assert.equal(input.getAttribute("aria-expanded"), "true");
    assert.equal(input.getAttribute("aria-activedescendant"), originalActive);

    input.focus();
    await act(async () => {
      fireDomEvent.pointerDown(option, { pointerType: "touch" });
      fireDomEvent.click(option);
    });
    assert.equal(input.value, "In 7 Days");
    assert.equal(domWindow.document.activeElement, input);
    assert.equal(saved.length, 0, "pointer and touch selection choose a schedule without submitting");
    assert.match(summary(), /^Returns /);
  } finally {
    await view.unmount();
  }
});

test("Someday saves without a timer, says it stays snoozed, and can be edited into a timed reminder", async () => {
  const saved: SetSessionReminderRequest[] = [];
  const first = await mount(<SnoozeDialog
    sessionTitle={TITLE}
    supportsSomeday
    onClose={() => undefined}
    onSave={async (request) => { saved.push(request); }}
  />);
  try {
    await chooseTile("Someday");
    assert.equal(summary(), "Stays snoozed until it needs you or you wake it.");
    await act(async () => { returnEarly().click(); });
    assert.equal(summary(), "Stays snoozed until you wake it.");
    await act(async () => { returnEarly().click(); });
    await act(async () => { fireDomEvent.submit(body.querySelector("form")!); });
    assert.deepEqual(saved[0], {
      scheduleKind: "someday",
      originalExpression: "someday",
      wakePolicy: "until_activity",
      expectedRevision: 0,
    });
  } finally {
    await first.unmount();
  }

  const existing: SessionReminderView = {
    reminderId: "rem-someday",
    sessionId: "session-1",
    scheduleKind: "someday",
    originalExpression: "Someday",
    wakePolicy: "regardless",
    state: "pending",
    revision: 2,
    createdAt: 1,
    updatedAt: 2,
  };
  const second = await mount(<SnoozeDialog
    sessionTitle={TITLE}
    reminder={existing}
    supportsSomeday
    onClose={() => undefined}
    onSave={async (request) => { saved.push(request); }}
  />);
  try {
    assert.equal(tileNamed("Someday")?.getAttribute("aria-checked"), "true", "a Someday reminder starts on its tile");
    assert.equal(summary(), "Stays snoozed until you wake it.");
    await chooseTile("Custom…");
    await typeSchedule("in 2 hours");
    await act(async () => { fireDomEvent.submit(body.querySelector("form")!); });
    assert.equal(saved[1]?.scheduleKind, "timed");
    assert.equal(saved[1]?.expectedReminderId, "rem-someday");
    assert.equal(saved[1]?.expectedRevision, 2);
  } finally {
    await second.unmount();
  }
});

test("a complete typed schedule leaves Enter to the form even while broader suggestions show", async () => {
  const saved: SetSessionReminderRequest[] = [];
  const view = await mount(<SnoozeDialog sessionTitle={TITLE} onClose={() => undefined} onSave={async (request) => { saved.push(request); }} />);
  try {
    await chooseTile("Custom…");
    const input = field()!;
    await typeSchedule("tomorrow at 3 pm");
    assert.equal(input.getAttribute("aria-expanded"), "true");
    assert.equal(input.hasAttribute("aria-activedescendant"), false);
    assert.match(summary(), / at 3:00 PM\.$/);

    const expected = parseReminderExpression("tomorrow at 3 pm");
    const enter = new domWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => { input.dispatchEvent(enter as never); });
    assert.equal(enter.defaultPrevented, false, "a suggestion is selected only after explicit arrow or pointer intent");
    await act(async () => { fireDomEvent.submit(body.querySelector("form")!); });
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.originalExpression, "tomorrow at 3 pm");
    assert.equal(saved[0]?.scheduledFor, expected?.scheduleKind === "timed" ? expected.scheduledFor : undefined);
  } finally {
    await view.unmount();
  }
});
