import assert from "node:assert/strict";
import test from "node:test";
import React, { act, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { FeedbackProvider, useFeedback } from "./FeedbackProvider.js";
import { Modal } from "./common.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

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
      <button data-testid="pending-action" onClick={() => feedback.showToast("Opening link.", { action: { label: "Retry", busyLabel: "Retrying…", run: () => new Promise<void>((resolve) => { finishPendingAction = resolve; }) } })}>Pending Action</button>
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
  assert.equal((domWindow.document.activeElement as unknown as HTMLElement | null)?.textContent, "Cancel");
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

test("non-undo actions show their own busy label", async () => {
  const { container, root } = await renderHarness();
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="pending-action"]')!.click(); });
  const action = container.querySelector<HTMLButtonElement>(".toast .btn")!;
  await act(async () => { action.click(); await Promise.resolve(); });
  assert.equal(action.textContent, "Retrying…");
  await act(async () => { finishPendingAction?.(); await tick(); });
  assertNoDomNode(container.querySelector(".toast"));
  finishPendingAction = undefined;
  await act(async () => { root.unmount(); });
  container.remove();
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
