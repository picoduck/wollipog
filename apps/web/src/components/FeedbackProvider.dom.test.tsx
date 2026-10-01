import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React, { act, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { FeedbackProvider, useFeedback, type ConfirmationOptions } from "./FeedbackProvider.js";
import { Modal } from "./common.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { statusMeta } from "../status-meta.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  KeyboardEvent: domWindow.KeyboardEvent,
  MouseEvent: domWindow.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

const document = domWindow.document as unknown as Document;
const tick = () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0));
let finishPendingAction: (() => void) | undefined;

function Harness() {
  const feedback = useFeedback();
  const [result, setResult] = useState("idle");
  const [undoCount, setUndoCount] = useState(0);
  const [actionCount, setActionCount] = useState(0);
  const [confirmedCount, setConfirmedCount] = useState(0);
  return (
    <>
      <button data-testid="ask" onClick={async () => {
        const answer = await feedback.confirm({ title: "Delete Item", message: "This cannot be undone.", confirmLabel: "Delete Item", tone: "danger" });
        if (answer) setConfirmedCount((count) => count + 1);
        setResult(String(answer));
      }}>Ask</button>
      <button data-testid="queue" onClick={async () => {
        const first = feedback.confirm({ title: "First", message: "First request", confirmLabel: "First Action" });
        const second = feedback.confirm({ title: "Second", message: "Second request", confirmLabel: "Second Action" });
        setResult((await Promise.all([first, second])).join(","));
      }}>Queue</button>
      <button data-testid="chain" onClick={async () => {
        const first = await feedback.confirm({ title: "First", message: "First request", confirmLabel: "First Action" });
        const second = first ? await feedback.confirm({ title: "Second", message: "Second request", confirmLabel: "Second Action" }) : false;
        setResult(`${first},${second}`);
      }}>Chain</button>
      <button data-testid="undo" onClick={() => feedback.showUndo("Session archived.", () => setUndoCount((count) => count + 1))}>Archive</button>
      <button data-testid="broken-undo" onClick={() => feedback.showUndo("Session archived.", async () => { throw new Error("runner offline"); })}>Broken undo</button>
      <button data-testid="broken-recovery" onClick={() => feedback.showToast("Partial archive.", { tone: "error", durationMs: 0, action: { label: "Restore sessions", run: async () => { throw new Error("runner offline"); } } })}>Broken recovery</button>
      <button data-testid="toast-burst" onClick={() => {
        feedback.showToast("Persistent recovery.", { tone: "error", durationMs: 0, action: { label: "Restore sessions", run: () => {} } });
        for (let index = 1; index <= 4; index += 1) feedback.showToast(`Transient ${index}.`);
      }}>Toast burst</button>
      <button data-testid="persistent-burst" onClick={() => {
        for (let index = 1; index <= 5; index += 1) {
          feedback.showToast(`Persistent ${index}.`, { tone: "error", durationMs: 0, action: { label: `Recover ${index}`, run: () => {} } });
        }
      }}>Persistent burst</button>
      <button data-testid="info" onClick={() => feedback.showToast("Saved.")}>Info</button>
      <button data-testid="double-action" onClick={() => feedback.showToast("Run once.", { action: { label: "Run", run: () => { setActionCount((count) => count + 1); } } })}>Double action</button>
      <button data-testid="pending-action" onClick={() => feedback.showToast("Opening link.", { action: { label: "Retry", progress: "Opening the link again…", run: () => new Promise<void>((resolve) => { finishPendingAction = resolve; }) } })}>Pending Action</button>
      <output data-testid="result">{result}</output>
      <output data-testid="undo-count">{undoCount}</output>
      <output data-testid="action-count">{actionCount}</output>
      <output data-testid="confirmed-count">{confirmedCount}</output>
    </>
  );
}

async function renderHarness() {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<StrictMode><FeedbackProvider><Harness /></FeedbackProvider></StrictMode>); });
  return { container, root };
}

test("confirmation is focus-safe, cancellable with Escape, and serializes queued requests", async () => {
  const { container, root } = await renderHarness();
  const ask = container.querySelector<HTMLButtonElement>('[data-testid="ask"]')!;
  ask.focus();
  await act(async () => { ask.click(); });
  assert.equal(document.querySelector('[role="dialog"] h2')?.textContent, "Delete Item");
  assert.equal((domWindow.document.activeElement as unknown as HTMLElement | null)?.textContent, "Cancel");

  await act(async () => {
    domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape" }));
    await tick();
  });
  assert.equal(container.querySelector('[data-testid="result"]')?.textContent, "false");
  assert.equal(domWindow.document.activeElement, ask);

  await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="queue"]')!.click(); });
  assert.equal(document.querySelector('[role="dialog"] h2')?.textContent, "First");
  await act(async () => {
    document.querySelector<HTMLButtonElement>('.modal-foot .primary')!.click();
    await tick();
  });
  assert.equal(document.querySelector('[role="dialog"] h2')?.textContent, "Second");
  await act(async () => {
    document.querySelector<HTMLButtonElement>('.modal-foot .btn')!.click();
    await tick();
  });
  assert.equal(container.querySelector('[data-testid="result"]')?.textContent, "true,false");
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 0);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("a sequential confirmation keeps focus trapped and restores the original invoker", async () => {
  const { container, root } = await renderHarness();
  const chain = container.querySelector<HTMLButtonElement>('[data-testid="chain"]')!;
  chain.focus();
  await act(async () => { chain.click(); });
  await act(async () => {
    document.querySelector<HTMLButtonElement>('.modal-foot .primary')!.click();
    await tick();
  });
  assert.equal(document.querySelector('[role="dialog"] h2')?.textContent, "Second");
  // A non-destructive confirmation opens on its primary (§7.4).
  assert.equal((domWindow.document.activeElement as unknown as HTMLElement | null)?.textContent, "Second Action");
  await act(async () => { document.querySelector<HTMLButtonElement>('.modal-foot .btn')!.click(); await tick(); });
  assert.equal(domWindow.document.activeElement, chain);
  await act(async () => { root.unmount(); });
  container.remove();
});

test("same-frame duplicate activation cannot queue or execute one confirmation twice", async () => {
  const { container, root } = await renderHarness();
  const ask = container.querySelector<HTMLButtonElement>('[data-testid="ask"]')!;
  await act(async () => { ask.click(); ask.click(); await tick(); });
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
  await act(async () => { document.querySelector<HTMLButtonElement>('.modal-foot .danger')!.click(); await tick(); });
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 0);
  assert.equal(container.querySelector('[data-testid="confirmed-count"]')?.textContent, "1");
  await act(async () => { root.unmount(); });
  container.remove();
});

test("undo runs once, dismisses on success, and keeps actionable failure feedback", async () => {
  const { container, root } = await renderHarness();
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="undo"]')!.click(); });
  assert.match(container.querySelector('.toast')?.textContent ?? "", /Session archived.*Undo/);
  await act(async () => { container.querySelector<HTMLButtonElement>('.toast .btn')!.click(); });
  assert.equal(container.querySelector('[data-testid="undo-count"]')?.textContent, "1");
  assertNoDomNode(container.querySelector('.toast'));

  await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="broken-undo"]')!.click(); });
  await act(async () => { container.querySelector<HTMLButtonElement>('.toast .btn')!.click(); });
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /Undo failed: runner offline.*Retry Undo/);

  await act(async () => { container.querySelector<HTMLButtonElement>('.toast .icon-btn')!.click(); });
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="broken-recovery"]')!.click(); });
  await act(async () => { container.querySelector<HTMLButtonElement>('.toast .btn')!.click(); });
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /Restore sessions failed: runner offline.*Retry/);
  assert.doesNotMatch(container.querySelector('[role="alert"]')?.textContent ?? "", /Retry Undo/);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("a burst shows three toasts newest on top and keeps the persistent recovery action behind +N More", async () => {
  const { container, root } = await renderHarness();
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="toast-burst"]')!.click(); });
  // docs/design-system.md §13.1: at most three visible on desktop, newest on top.
  const visible = [...container.querySelectorAll<HTMLElement>('.toast-region > .toast')];
  assert.deepEqual(visible.map((toast) => toast.querySelector(".toast-message")?.textContent),
    ["Transient 4.", "Transient 3.", "Transient 2."]);
  const more = container.querySelector<HTMLButtonElement>(".toast-more")!;
  assert.equal(more.textContent, "+2 More");
  assert.equal(more.getAttribute("aria-expanded"), "false");
  await act(async () => { more.click(); });
  const older = [...container.querySelectorAll<HTMLElement>('.toast-more-list .toast')];
  assert.match(older.map((toast) => toast.textContent).join("\n"), /Persistent recovery.*Restore sessions/,
    "no recovery action is evicted out of reach");
  assert.match(older.map((toast) => toast.textContent).join("\n"), /Transient 1/);
  await act(async () => { root.unmount(); });
  container.remove();
});

test("dismissing the newest toast brings the next one out of +N More", async () => {
  const { container, root } = await renderHarness();
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="persistent-burst"]')!.click(); });
  let visible = [...container.querySelectorAll<HTMLElement>('.toast-region > .toast')];
  assert.equal(visible.length, 3);
  assert.match(visible[0]!.textContent ?? "", /Persistent 5.*Recover 5/);
  assert.equal(container.querySelector(".toast-more")?.textContent, "+2 More");

  await act(async () => { visible[0]!.querySelector<HTMLButtonElement>('[aria-label="Dismiss Notification"]')!.click(); });
  visible = [...container.querySelectorAll<HTMLElement>('.toast-region > .toast')];
  assert.equal(visible.length, 3);
  assert.match(visible.map((toast) => toast.textContent).join("\n"), /Persistent 2.*Recover 2/);
  assert.equal(container.querySelector(".toast-more")?.textContent, "+1 More");
  await act(async () => { root.unmount(); });
  container.remove();
});

test("a toast carries a tone icon and an icon close named Dismiss Notification", async () => {
  const { container, root } = await renderHarness();
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="broken-recovery"]')!.click(); });
  const toast = container.querySelector<HTMLElement>(".toast")!;
  assert.ok(toast.classList.contains("t-danger"), "an error toast takes the danger tone");
  assert.ok(toast.querySelector(".toast-icon svg"), "the tone icon carries the tone, not colour alone");
  const close = toast.querySelector<HTMLButtonElement>('[aria-label="Dismiss Notification"]')!;
  assert.ok(close.querySelector("svg"));
  assert.doesNotMatch(close.textContent ?? "", /×/);
  await act(async () => { root.unmount(); });
  container.remove();
});

test("an info toast dismisses after five seconds unless the stack is hovered, and an error persists", async () => {
  const { container, root } = await renderHarness();
  const originalNow = Date.now;
  let now = 1_000_000;
  const timers: Array<{ id: number; at: number; run: () => void }> = [];
  let nextId = 1;
  const realSet = domWindow.setTimeout;
  const realClear = domWindow.clearTimeout;
  Date.now = () => now;
  domWindow.setTimeout = ((run: () => void, delay = 0) => {
    const id = nextId++;
    timers.push({ id, at: now + delay, run });
    return id;
  }) as never;
  domWindow.clearTimeout = ((id: number) => {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index >= 0) timers.splice(index, 1);
  }) as never;
  const advance = async (ms: number) => {
    now += ms;
    for (const timer of [...timers].filter((candidate) => candidate.at <= now)) {
      timers.splice(timers.indexOf(timer), 1);
      await act(async () => { timer.run(); });
    }
  };
  try {
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="broken-recovery"]')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="info"]')!.click(); });
    assert.equal(container.querySelectorAll(".toast").length, 2);
    const region = container.querySelector<HTMLElement>(".toast-region")!;
    await act(async () => { region.dispatchEvent(new domWindow.MouseEvent("mouseover", { bubbles: true }) as never); });
    await advance(20_000);
    assert.equal(container.querySelectorAll(".toast").length, 2, "hovering the stack pauses every timer");
    await act(async () => { region.dispatchEvent(new domWindow.MouseEvent("mouseout", { bubbles: true }) as never); });
    await advance(5_000);
    const remaining = [...container.querySelectorAll(".toast")].map((toast) => toast.textContent ?? "");
    assert.equal(remaining.length, 1, "the info toast dismissed once its five seconds ran after the pause");
    assert.match(remaining[0]!, /Partial archive/, "an error persists until dismissed");
  } finally {
    Date.now = originalNow;
    domWindow.setTimeout = realSet;
    domWindow.clearTimeout = realClear;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a synchronous double-click cannot run one toast action twice", async () => {
  const { container, root } = await renderHarness();
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="double-action"]')!.click(); });
  const action = container.querySelector<HTMLButtonElement>('.toast .btn')!;
  await act(async () => { action.click(); action.click(); await tick(); });
  assert.equal(container.querySelector('[data-testid="action-count"]')?.textContent, "1");
  await act(async () => { root.unmount(); });
  container.remove();
});

test("a running toast action keeps its label beside a spinner and announces its progress", async () => {
  const { container, root } = await renderHarness();
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="pending-action"]')!.click(); });
  const action = container.querySelector<HTMLButtonElement>(".toast .btn")!;
  assert.equal(action.getAttribute("aria-busy"), null);
  action.focus();
  await act(async () => { action.click(); await Promise.resolve(); });
  assert.equal(action.textContent, "Retry", "the label names the action that is running");
  assert.equal(action.getAttribute("aria-busy"), "true");
  assert.equal(action.getAttribute("aria-disabled"), "true");
  assert.equal(action.disabled, false, "aria-disabled, so the button keeps the focus it was pressed with");
  assert.equal(domWindow.document.activeElement, action as unknown);
  assert.equal(action.firstElementChild?.className, "spinner");
  assert.equal(action.firstElementChild?.getAttribute("aria-hidden"), "true");
  const toast = container.querySelector(".toast")!;
  assert.doesNotMatch(toast.textContent ?? "", /Retrying…|Undoing…|Installing…|Working…/);
  assert.equal(toast.querySelector('.sr-only[role="status"]')?.textContent, "Opening the link again…");
  await act(async () => { finishPendingAction?.(); await tick(); });
  assertNoDomNode(container.querySelector(".toast"));
  finishPendingAction = undefined;
  await act(async () => { root.unmount(); });
  container.remove();
});

/** A confirmation whose confirm action the test settles by hand, and what `confirm()` resolved to. */
async function renderPendingConfirmation(options: { cancelWhileRunning?: boolean } = {}) {
  const runs: Array<{ signal: AbortSignal; resolve: () => void; reject: (cause: Error) => void }> = [];
  const outcome: { value?: boolean } = {};
  function PendingConfirmHarness() {
    const feedback = useFeedback();
    return <button data-testid="stop" onClick={() => {
      void feedback.confirm({
        title: "Stop Session",
        message: "The session stops now.",
        confirmLabel: "Stop Session",
        tone: "danger",
        progress: "Stopping the session…",
        ...options,
        onConfirm: (signal) => new Promise<void>((resolve, reject) => { runs.push({ signal, resolve, reject }); }),
      }).then((value) => { outcome.value = value; });
    }}>Stop</button>;
  }
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<FeedbackProvider><PendingConfirmHarness /></FeedbackProvider>); });
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="stop"]')!.click(); });
  const confirmButton = () => document.querySelector<HTMLButtonElement>(".modal-foot .danger");
  const cancelButton = () => [...document.querySelectorAll<HTMLButtonElement>(".modal-foot .btn")].find((button) => button.textContent === "Cancel")!;
  const cleanup = async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  };
  return { runs, outcome, confirmButton, cancelButton, cleanup };
}

/** Unmounted after every test, even a failing one, so its dialog cannot leak into the next. */
const mountedServices = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const cleanup of mountedServices) await cleanup();
});

/** A provider whose `confirm` the test calls directly, recording what each request resolved to. */
async function renderConfirmationService() {
  let feedback: ReturnType<typeof useFeedback> | undefined;
  function Capture() {
    feedback = useFeedback();
    return <button data-testid="invoker">Invoker</button>;
  }
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<StrictMode><FeedbackProvider><Capture /></FeedbackProvider></StrictMode>); });
  const outcomes: Array<boolean | undefined> = [];
  const open = async (options: ConfirmationOptions) => {
    const index = outcomes.push(undefined) - 1;
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="invoker"]')!.focus();
      void feedback!.confirm(options).then((value) => { outcomes[index] = value; });
      await tick();
    });
    return index;
  };
  const footButtons = () => [...document.querySelectorAll<HTMLButtonElement>(".modal-foot button")];
  const activeText = () => (domWindow.document.activeElement as unknown as HTMLElement | null)?.textContent;
  const cleanup = async () => {
    if (!mountedServices.delete(cleanup)) return;
    await act(async () => { root.unmount(); });
    container.remove();
  };
  mountedServices.add(cleanup);
  return { open, outcomes, footButtons, activeText, cleanup };
}

const INTERRUPT: ConfirmationOptions = {
  title: "Interrupt Sessions and Update",
  message: "Updating this runner will interrupt 7 active sessions.",
  confirmLabel: "Interrupt Sessions and Update",
  tone: "danger",
};

test("a confirmation shows five detail rows with their status badges, then \"and N more\", in its accessible description", async () => {
  const { open, cleanup } = await renderConfirmationService();
  const detailRows = Array.from({ length: 7 }, (_, index) => ({
    label: `Session ${index + 1} with a title long enough to truncate on one line`,
    ...(index === 1 ? { meta: "3 Queued" } : {}),
    status: statusMeta("session", index % 2 === 0 ? "running" : "input_required"),
  }));
  await open({ ...INTERRUPT, detailRows });

  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const rows = [...dialog.querySelectorAll<HTMLElement>(".surface.confirmation-rows > li.row.dense")];
  assert.equal(rows.length, 5, "at most five rows show");
  assert.deepEqual(rows.map((row) => row.querySelector(".row-title")?.textContent), detailRows.slice(0, 5).map((row) => row.label));
  // The full label is the tooltip of the truncated one.
  assert.deepEqual(rows.map((row) => row.querySelector(".row-title")?.getAttribute("title")), detailRows.slice(0, 5).map((row) => row.label));
  // Each status is the shared inline badge, from the one vocabulary.
  assert.deepEqual(rows.map((row) => row.querySelector(".status.inline")?.textContent),
    ["Running", "Awaiting Input", "Running", "Awaiting Input", "Running"]);
  assert.equal(rows[0]!.querySelector(".status.inline")?.className.includes("t-info"), true);
  assert.equal(rows[1]!.querySelector(".row-trail")?.textContent, "3 Queued");
  assert.equal(dialog.querySelector(".confirmation-rows-more")?.textContent, "and 2 more");

  // A screen reader hears the message, the rows and the overflow as the dialog's description.
  const description = (dialog.getAttribute("aria-describedby") ?? "").split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
  assert.match(description, /^Updating this runner will interrupt 7 active sessions\./);
  for (const row of detailRows.slice(0, 5)) assert.ok(description.includes(row.label), row.label);
  assert.ok(description.includes("and 2 more"));
  await cleanup();
});

test("rows a caller cannot list join the \"and N more\" count, and no rows means no surface", async () => {
  const { open, footButtons, cleanup } = await renderConfirmationService();
  await open({ ...INTERRUPT, detailRows: [{ label: "Only Listed Session" }], detailRowsOverflow: 3 });
  assert.equal(document.querySelectorAll(".confirmation-rows > li").length, 1);
  assertNoDomNode(document.querySelector(".confirmation-rows .status"), "a row without a status draws no badge");
  assert.equal(document.querySelector(".confirmation-rows-more")?.textContent, "and 3 more");
  await act(async () => { footButtons().find((button) => button.textContent === "Cancel")!.click(); await tick(); });

  await open(INTERRUPT);
  assertNoDomNode(document.querySelector(".confirmation-rows"), "no surface without rows");
  assertNoDomNode(document.querySelector(".confirmation-rows-more"), "no overflow line without overflow");
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  assert.equal(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent, INTERRUPT.message);
  await cleanup();
});

test("a cancel label names the safe choice, and Escape, the backdrop and that button all resolve false", async () => {
  const { open, outcomes, footButtons, cleanup } = await renderConfirmationService();
  const quit: ConfirmationOptions = {
    title: "Quit Wollipog",
    message: "Quitting stops the sessions running on this computer.",
    confirmLabel: "Quit Wollipog",
    cancelLabel: "Keep Open",
    tone: "danger",
  };
  const first = await open(quit);
  assert.deepEqual(footButtons().map((button) => button.textContent), ["Keep Open", "Quit Wollipog"]);
  const keepOpen = footButtons()[0]!;
  assert.equal(keepOpen.className, "btn", "it keeps the secondary style");
  await act(async () => { domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape" })); await tick(); });
  assert.equal(outcomes[first], false);

  const second = await open(quit);
  await act(async () => {
    const backdrop = document.querySelector(".modal-backdrop")!;
    backdrop.dispatchEvent(new domWindow.MouseEvent("mousedown", { bubbles: true }) as unknown as Event);
    await tick();
  });
  assert.equal(outcomes[second], false);
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 0);

  const third = await open(quit);
  await act(async () => { footButtons().find((button) => button.textContent === "Keep Open")!.click(); await tick(); });
  assert.equal(outcomes[third], false);
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 0);
  await cleanup();
});

test("a secondary action is a ghost button before Cancel that runs, closes and resolves false", async () => {
  const { open, outcomes, footButtons, cleanup } = await renderConfirmationService();
  let shown = 0;
  const index = await open({
    title: "Quit Wollipog",
    message: "Quitting stops the sessions running on this computer.",
    confirmLabel: "Quit Wollipog",
    cancelLabel: "Keep Open",
    secondaryAction: { label: "Show Sessions", run: () => { shown += 1; } },
    tone: "danger",
  });
  // Spacer, then [ghost] [secondary] [primary] (§3.2): the footer is end-aligned, so the space before
  // the ghost button is the spacer.
  assert.deepEqual(footButtons().map((button) => [button.textContent, button.className]), [
    ["Show Sessions", "btn ghost"],
    ["Keep Open", "btn"],
    ["Quit Wollipog", "btn danger"],
  ]);
  await act(async () => { footButtons()[0]!.click(); await tick(); });
  assert.equal(shown, 1);
  assert.equal(outcomes[index], false);
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 0);
  await cleanup();
});

test("a double click on the secondary action runs it once", async () => {
  const { open, outcomes, footButtons } = await renderConfirmationService();
  let shown = 0;
  const index = await open({
    title: "Quit Wollipog",
    message: "Quitting stops the sessions running on this computer.",
    confirmLabel: "Quit Wollipog",
    secondaryAction: { label: "Show Sessions", run: () => { shown += 1; } },
    tone: "danger",
  });
  const secondary = footButtons()[0]!;
  // Both clicks land in one batch, before React removes the dialog.
  await act(async () => { secondary.click(); secondary.click(); await tick(); });
  assert.equal(shown, 1);
  assert.equal(outcomes[index], false);
});

test("crossing to a phone while the secondary action has focus hands focus to the cancel button", async () => {
  const previousWidth = domWindow.innerWidth;
  try {
    const { open, footButtons, activeText } = await renderConfirmationService();
    await open({
      title: "Quit Wollipog",
      message: "Quitting stops the sessions running on this computer.",
      confirmLabel: "Quit Wollipog",
      cancelLabel: "Keep Open",
      secondaryAction: { label: "Show Sessions", run: () => undefined },
      tone: "danger",
    });
    await act(async () => { footButtons()[0]!.focus(); });
    assert.equal(activeText(), "Show Sessions");
    await act(async () => {
      domWindow.happyDOM.setViewport({ width: 390, height: 844 });
      domWindow.dispatchEvent(new domWindow.Event("resize"));
      await tick();
    });
    assert.deepEqual(footButtons().map((button) => button.textContent), ["Keep Open", "Quit Wollipog"]);
    assert.equal(activeText(), "Keep Open", "focus stays inside the dialog");
  } finally {
    domWindow.happyDOM.setViewport({ width: previousWidth, height: 768 });
  }
});

test("on a phone a confirmation leaves out its secondary action, so the footer holds two buttons", async () => {
  const previousWidth = domWindow.innerWidth;
  domWindow.happyDOM.setViewport({ width: 390, height: 844 });
  try {
    const { open, footButtons, cleanup } = await renderConfirmationService();
    await open({
      title: "Quit Wollipog",
      message: "Quitting stops the sessions running on this computer.",
      confirmLabel: "Quit Wollipog",
      cancelLabel: "Keep Open",
      secondaryAction: { label: "Show Sessions", run: () => undefined },
      tone: "danger",
    });
    assert.deepEqual(footButtons().map((button) => button.textContent), ["Keep Open", "Quit Wollipog"]);
    await cleanup();
  } finally {
    domWindow.happyDOM.setViewport({ width: previousWidth, height: 768 });
  }
});

test("a destructive confirmation opens on its cancel button, and any other on its primary", async () => {
  const { open, activeText, footButtons, cleanup } = await renderConfirmationService();
  const close = async () => { await act(async () => { footButtons().at(-2)!.click(); await tick(); }); };
  await open(INTERRUPT);
  assert.equal(activeText(), "Cancel");
  await close();
  await open({ ...INTERRUPT, cancelLabel: "Keep Running" });
  assert.equal(activeText(), "Keep Running");
  await close();
  await open({ title: "Recover Session", message: "The session restarts from its last checkpoint.", confirmLabel: "Recover Session" });
  assert.equal(activeText(), "Recover Session");
  await close();
  await open({ title: "Install Update", message: "Wollipog restarts to finish installing.", confirmLabel: "Install Update", cancelLabel: "Install Later", tone: "default" });
  assert.equal(activeText(), "Install Update");
  await cleanup();
});

test("confirmations that differ only in rows, overflow or labels are not merged, and identical ones are", async () => {
  const { open, outcomes, footButtons, cleanup } = await renderConfirmationService();
  const base: ConfirmationOptions = { ...INTERRUPT, detailRows: [{ label: "First Session", status: statusMeta("session", "running") }] };
  const variants: ConfirmationOptions[] = [
    { ...base, detailRows: [{ label: "Second Session", status: statusMeta("session", "running") }] },
    { ...base, detailRows: [{ label: "First Session", status: statusMeta("session", "idle") }] },
    { ...base, detailRows: [{ label: "First Session", meta: "3 Queued", status: statusMeta("session", "running") }] },
    { ...base, detailRowsOverflow: 1 },
    { ...base, cancelLabel: "Keep Running" },
    { ...base, secondaryAction: { label: "Show Sessions", run: () => undefined } },
    { ...base, typeToConfirm: "Review Team" },
  ];
  await open(base);
  const duplicate = await open({ ...base, detailRows: [...base.detailRows!] });
  assert.equal(outcomes[duplicate], false, "an identical request is dropped");
  const queued = [];
  for (const variant of variants) queued.push(await open(variant));
  for (const index of queued) assert.equal(outcomes[index], undefined, "a request that differs waits in the queue");
  for (let shown = 0; shown <= variants.length; shown += 1) {
    await act(async () => { footButtons().at(-2)!.click(); await tick(); });
  }
  for (const index of queued) assert.equal(outcomes[index], false);
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 0);
  await cleanup();
});

/** Types into a controlled field as a person would: React's change plugin watches the focused input. */
async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")?.set;
  assert.ok(setter);
  await act(async () => {
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true, key: value.at(-1) ?? "" }) as unknown as Event);
  });
}

test("a type-to-confirm confirmation focuses its field and keeps the danger button disabled until the text matches", async () => {
  const { open, outcomes, footButtons, cleanup } = await renderConfirmationService();
  const deleteGroup: ConfirmationOptions = {
    title: "Delete Group",
    message: "“Review Team” and its 2 assignments are deleted.",
    confirmLabel: "Delete Group",
    tone: "danger",
    typeToConfirm: "Review Team",
  };
  const first = await open(deleteGroup);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const field = dialog.querySelector<HTMLInputElement>(".modal-body .field input")!;
  assert.equal(dialog.querySelector(".modal-body .field > span")?.textContent, "Type Review Team to Confirm");
  assert.ok(domWindow.document.activeElement === (field as unknown), "the name field has focus, not Cancel");
  const confirmButton = () => footButtons().find((button) => button.textContent === "Delete Group")!;
  assert.equal(confirmButton().disabled, true, "nothing is typed yet");
  assert.ok(confirmButton().className.includes("danger"));

  // Near misses keep it disabled: case and spaces count, and so does a missing letter.
  for (const near of ["review team", "Review Tea", " Review Team", "Review Team "]) {
    await typeInto(field, near);
    assert.equal(confirmButton().disabled, true, JSON.stringify(near));
    await act(async () => {
      field.dispatchEvent(new domWindow.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }) as unknown as Event);
      await tick();
    });
    assert.equal(outcomes[first], undefined, `Enter does not confirm ${JSON.stringify(near)}`);
  }
  await typeInto(field, "Review Team");
  assert.equal(confirmButton().disabled, false);
  await act(async () => { confirmButton().click(); await tick(); });
  assert.equal(outcomes[first], true);
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 0);

  // Cancel changes nothing, and Enter in the field confirms once the name matches.
  const second = await open(deleteGroup);
  await act(async () => { footButtons().find((button) => button.textContent === "Cancel")!.click(); await tick(); });
  assert.equal(outcomes[second], false);
  const third = await open(deleteGroup);
  const again = document.querySelector<HTMLInputElement>('[role="dialog"] .modal-body .field input')!;
  assert.equal(again.value, "", "a new confirmation starts empty");
  await typeInto(again, "Review Team");
  await act(async () => {
    again.dispatchEvent(new domWindow.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }) as unknown as Event);
    await tick();
  });
  assert.equal(outcomes[third], true);

  // Without typeToConfirm there is no field.
  await open(INTERRUPT);
  assertNoDomNode(document.querySelector('[role="dialog"] .modal-body input'));
  await cleanup();
});

test("a pending confirmation shows its confirm button busy with the label unchanged, and closes when the action succeeds", async () => {
  const { runs, outcome, confirmButton, cancelButton, cleanup } = await renderPendingConfirmation();
  const confirm = confirmButton()!;
  confirm.focus();
  await act(async () => { confirm.click(); await Promise.resolve(); });
  assert.equal(runs.length, 1);
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1, "the dialog waits for the action");
  assert.equal(confirm.textContent, "Stop Session");
  assert.equal(confirm.getAttribute("aria-busy"), "true");
  assert.equal(confirm.firstElementChild?.className, "spinner");
  assert.equal(domWindow.document.activeElement, confirm as unknown, "the pressed button keeps focus");
  assert.equal(cancelButton().disabled, false, "Cancel stays available");
  assert.equal(document.querySelector('.modal-foot .sr-only[role="status"]')?.textContent, "Stopping the session…");

  await act(async () => { confirm.click(); await Promise.resolve(); });
  assert.equal(runs.length, 1, "pressing a busy button does not run the action again");

  await act(async () => { runs[0]!.resolve(); await tick(); });
  assert.equal(outcome.value, true);
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 0);
  assert.equal(runs[0]!.signal.aborted, false, "a finished action is not aborted when the dialog closes");
  await cleanup();
});

test("a failed pending confirmation stays open with the error, and can be tried again", async () => {
  const { runs, outcome, confirmButton, cancelButton, cleanup } = await renderPendingConfirmation();
  await act(async () => { confirmButton()!.click(); await Promise.resolve(); });
  await act(async () => { runs[0]!.reject(new Error("The runner is offline.")); await tick(); });
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
  assert.equal(outcome.value, undefined, "a failure does not settle the confirmation");
  assert.equal(confirmButton()!.getAttribute("aria-busy"), null);
  assert.equal(confirmButton()!.textContent, "Stop Session");
  assert.equal(document.querySelector('[role="dialog"] .notice[role="alert"]')?.textContent?.includes("The runner is offline."), true);

  await act(async () => { confirmButton()!.click(); await Promise.resolve(); });
  assert.equal(runs.length, 2, "the person can try again");
  assertNoDomNode(document.querySelector('[role="dialog"] .notice'), "the old error clears while it runs again");
  await act(async () => { cancelButton().click(); await tick(); });
  assert.equal(outcome.value, false);
  assert.equal(runs[1]!.signal.aborted, true, "cancelling while it runs aborts the action");
  await act(async () => { runs[1]!.resolve(); await tick(); });
  assert.equal(outcome.value, false, "an action that finishes after Cancel does not confirm");
  await cleanup();
});

test("a caller can keep Cancel unavailable while its confirm action runs", async () => {
  const { runs, outcome, confirmButton, cancelButton, cleanup } = await renderPendingConfirmation({ cancelWhileRunning: false });
  assert.equal(cancelButton().disabled, false, "Cancel is available until the action starts");
  await act(async () => { confirmButton()!.click(); await Promise.resolve(); });
  assert.equal(cancelButton().disabled, true);
  await act(async () => {
    domWindow.document.activeElement?.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
  });
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1, "Escape does not close it either");
  assert.equal(runs[0]!.signal.aborted, false);
  await act(async () => { runs[0]!.resolve(); await tick(); });
  assert.equal(outcome.value, true);
  await cleanup();
});

test("a nested confirmation owns Escape without closing its parent modal", async () => {
  function NestedHarness() {
    const feedback = useFeedback();
    const [open, setOpen] = useState(true);
    return open ? (
      <Modal title="Parent" onClose={() => setOpen(false)}>
        <button onClick={() => void feedback.confirm({ title: "Child", message: "Nested confirmation", confirmLabel: "Confirm Child" })}>Confirm action</button>
      </Modal>
    ) : <output>parent closed</output>;
  }
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<FeedbackProvider><NestedHarness /></FeedbackProvider>); });
  await act(async () => { document.querySelector<HTMLButtonElement>('.modal-body button')!.click(); });
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 2);
  await act(async () => {
    domWindow.document.activeElement?.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
  });
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
  assert.equal(document.querySelector('[role="dialog"] h2')?.textContent, "Parent");
  await act(async () => { root.unmount(); });
  container.remove();
});

test("provider teardown fails active and queued confirmations closed", async () => {
  let result: boolean[] | undefined;
  function PendingHarness() {
    const feedback = useFeedback();
    return <button onClick={() => {
      void Promise.all([
        feedback.confirm({ title: "Active", message: "One", confirmLabel: "Active Action" }),
        feedback.confirm({ title: "Queued", message: "Two", confirmLabel: "Queued Action" }),
      ]).then((value) => { result = value; });
    }}>Open two</button>;
  }
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<FeedbackProvider><PendingHarness /></FeedbackProvider>); });
  await act(async () => { container.querySelector("button")!.click(); });
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
  await act(async () => { root.unmount(); await tick(); });
  assert.deepEqual(result, [false, false]);
  container.remove();
});

test("a dismissed in-flight undo still reports failure, while teardown suppresses stale completion", async () => {
  let rejectUndo: ((cause: Error) => void) | undefined;
  function DeferredUndoHarness() {
    const feedback = useFeedback();
    return <button onClick={() => feedback.showUndo("Session archived.", () => new Promise<void>((_resolve, reject) => { rejectUndo = reject; }))}>Archive</button>;
  }
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<FeedbackProvider><DeferredUndoHarness /></FeedbackProvider>); });
  await act(async () => { container.querySelector("button")!.click(); });
  await act(async () => { container.querySelector<HTMLButtonElement>('.toast .btn')!.click(); });
  await act(async () => { container.querySelector<HTMLButtonElement>('.toast .icon-btn')!.click(); });
  assertNoDomNode(container.querySelector('.toast'));
  await act(async () => { rejectUndo?.(new Error("runner offline")); await tick(); });
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /Undo failed: runner offline.*Retry Undo/);

  await act(async () => { container.querySelector<HTMLButtonElement>('.toast .icon-btn')!.click(); });
  await act(async () => { container.querySelector("button")!.click(); });
  await act(async () => { container.querySelector<HTMLButtonElement>('.toast .btn')!.click(); });
  await act(async () => { root.unmount(); });
  rejectUndo?.(new Error("late failure"));
  await tick();
  assert.equal(container.textContent, "");
  container.remove();
});

test("dismissing the focused toast does not leave the rest of the stack paused", async () => {
  const originalNow = Date.now;
  let now = 2_000_000;
  const timers: Array<{ id: number; at: number; run: () => void }> = [];
  let nextId = 1;
  const realSet = domWindow.setTimeout;
  const realClear = domWindow.clearTimeout;
  Date.now = () => now;
  domWindow.setTimeout = ((run: () => void, delay = 0) => {
    const id = nextId++;
    timers.push({ id, at: now + delay, run });
    return id;
  }) as never;
  domWindow.clearTimeout = ((id: number) => {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index >= 0) timers.splice(index, 1);
  }) as never;
  const advance = async (ms: number) => {
    now += ms;
    for (const timer of [...timers].filter((candidate) => candidate.at <= now)) {
      timers.splice(timers.indexOf(timer), 1);
      await act(async () => { timer.run(); });
    }
  };
  const { container, root } = await renderHarness();
  try {
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="info"]')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="info"]')!.click(); });
    assert.equal(container.querySelectorAll(".toast").length, 2);
    // A keyboard user focuses the newest toast's close button, which pauses the stack, and presses
    // it. The button is removed while focused, so the region never receives a blur.
    const close = container.querySelector<HTMLButtonElement>('.toast-region > .toast [aria-label="Dismiss Notification"]')!;
    await act(async () => { close.focus(); });
    await act(async () => { close.click(); });
    assert.equal(container.querySelectorAll(".toast").length, 1);
    await advance(5_000);
    assert.equal(container.querySelectorAll(".toast").length, 0, "the remaining info toast still dismisses itself");
  } finally {
    Date.now = originalNow;
    domWindow.setTimeout = realSet;
    domWindow.clearTimeout = realClear;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
