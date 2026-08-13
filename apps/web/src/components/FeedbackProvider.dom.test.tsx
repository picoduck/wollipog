import assert from "node:assert/strict";
import test from "node:test";
import React, { act, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { FeedbackProvider, useFeedback } from "./FeedbackProvider.js";
import { Modal } from "./common.js";

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
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

const tick = () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0));

function Harness() {
  const feedback = useFeedback();
  const [result, setResult] = useState("idle");
  const [undoCount, setUndoCount] = useState(0);
  const [actionCount, setActionCount] = useState(0);
  const [confirmedCount, setConfirmedCount] = useState(0);
  return (
    <>
      <button data-testid="ask" onClick={async () => {
        const answer = await feedback.confirm({ title: "Delete item?", message: "This cannot be undone.", confirmLabel: "Delete", tone: "danger" });
        if (answer) setConfirmedCount((count) => count + 1);
        setResult(String(answer));
      }}>Ask</button>
      <button data-testid="queue" onClick={async () => {
        const first = feedback.confirm({ title: "First", message: "First request" });
        const second = feedback.confirm({ title: "Second", message: "Second request" });
        setResult((await Promise.all([first, second])).join(","));
      }}>Queue</button>
      <button data-testid="chain" onClick={async () => {
        const first = await feedback.confirm({ title: "First", message: "First request" });
        const second = first ? await feedback.confirm({ title: "Second", message: "Second request" }) : false;
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
      <button data-testid="double-action" onClick={() => feedback.showToast("Run once.", { action: { label: "Run", run: () => { setActionCount((count) => count + 1); } } })}>Double action</button>
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
  assert.equal(container.querySelector('[role="dialog"] h2')?.textContent, "Delete item?");
  assert.equal((domWindow.document.activeElement as unknown as HTMLElement | null)?.textContent, "Cancel");

  await act(async () => {
    domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape" }));
    await tick();
  });
  assert.equal(container.querySelector('[data-testid="result"]')?.textContent, "false");
  assert.equal(domWindow.document.activeElement, ask);

  await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="queue"]')!.click(); });
  assert.equal(container.querySelector('[role="dialog"] h2')?.textContent, "First");
  await act(async () => {
    container.querySelector<HTMLButtonElement>('.modal-foot .primary')!.click();
    await tick();
  });
  assert.equal(container.querySelector('[role="dialog"] h2')?.textContent, "Second");
  await act(async () => {
    container.querySelector<HTMLButtonElement>('.modal-foot .btn')!.click();
    await tick();
  });
  assert.equal(container.querySelector('[data-testid="result"]')?.textContent, "true,false");
  assert.equal(container.querySelectorAll('[role="dialog"]').length, 0);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("a sequential confirmation keeps focus trapped and restores the original invoker", async () => {
  const { container, root } = await renderHarness();
  const chain = container.querySelector<HTMLButtonElement>('[data-testid="chain"]')!;
  chain.focus();
  await act(async () => { chain.click(); });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('.modal-foot .primary')!.click();
    await tick();
  });
  assert.equal(container.querySelector('[role="dialog"] h2')?.textContent, "Second");
  assert.equal((domWindow.document.activeElement as unknown as HTMLElement | null)?.textContent, "Cancel");
  await act(async () => { container.querySelector<HTMLButtonElement>('.modal-foot .btn')!.click(); await tick(); });
  assert.equal(domWindow.document.activeElement, chain);
  await act(async () => { root.unmount(); });
  container.remove();
});

test("same-frame duplicate activation cannot queue or execute one confirmation twice", async () => {
  const { container, root } = await renderHarness();
  const ask = container.querySelector<HTMLButtonElement>('[data-testid="ask"]')!;
  await act(async () => { ask.click(); ask.click(); await tick(); });
  assert.equal(container.querySelectorAll('[role="dialog"]').length, 1);
  await act(async () => { container.querySelector<HTMLButtonElement>('.modal-foot .danger')!.click(); await tick(); });
  assert.equal(container.querySelectorAll('[role="dialog"]').length, 0);
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
  assert.equal(container.querySelector('.toast'), null);

  await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="broken-undo"]')!.click(); });
  await act(async () => { container.querySelector<HTMLButtonElement>('.toast .btn')!.click(); });
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /Undo failed: runner offline.*Retry undo/);

  await act(async () => { container.querySelector<HTMLButtonElement>('.toast .icon-btn')!.click(); });
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="broken-recovery"]')!.click(); });
  await act(async () => { container.querySelector<HTMLButtonElement>('.toast .btn')!.click(); });
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /Restore sessions failed: runner offline.*Retry/);
  assert.doesNotMatch(container.querySelector('[role="alert"]')?.textContent ?? "", /Retry undo/);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("transient toast bursts preserve a bounded persistent recovery action", async () => {
  const { container, root } = await renderHarness();
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="toast-burst"]')!.click(); });
  const toasts = [...container.querySelectorAll<HTMLElement>('.toast')];
  assert.equal(toasts.length, 4);
  assert.match(toasts.map((toast) => toast.textContent).join("\n"), /Persistent recovery.*Restore sessions/);
  assert.doesNotMatch(toasts.map((toast) => toast.textContent).join("\n"), /Transient 1/);
  assert.match(toasts.map((toast) => toast.textContent).join("\n"), /Transient 4/);
  await act(async () => { root.unmount(); });
  container.remove();
});

test("persistent recovery overflow keeps the newest action visible and queues older actions", async () => {
  const { container, root } = await renderHarness();
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="persistent-burst"]')!.click(); });
  let toasts = [...container.querySelectorAll<HTMLElement>('.toast')];
  assert.equal(toasts.length, 4);
  assert.match(toasts.map((toast) => toast.textContent).join("\n"), /Persistent 5.*Recover 5/);
  assert.doesNotMatch(toasts.map((toast) => toast.textContent).join("\n"), /Persistent 1/);

  const newest = toasts.find((toast) => toast.textContent?.includes("Persistent 5"))!;
  await act(async () => { newest.querySelector<HTMLButtonElement>('.icon-btn')!.click(); });
  toasts = [...container.querySelectorAll<HTMLElement>('.toast')];
  assert.equal(toasts.length, 4);
  assert.match(toasts.map((toast) => toast.textContent).join("\n"), /Persistent 1.*Recover 1/);
  await act(async () => { root.unmount(); });
  container.remove();
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

test("a nested confirmation owns Escape without closing its parent modal", async () => {
  function NestedHarness() {
    const feedback = useFeedback();
    const [open, setOpen] = useState(true);
    return open ? (
      <Modal title="Parent" onClose={() => setOpen(false)}>
        <button onClick={() => void feedback.confirm({ title: "Child", message: "Nested confirmation" })}>Confirm action</button>
      </Modal>
    ) : <output>parent closed</output>;
  }
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<FeedbackProvider><NestedHarness /></FeedbackProvider>); });
  await act(async () => { container.querySelector<HTMLButtonElement>('.modal-body button')!.click(); });
  assert.equal(container.querySelectorAll('[role="dialog"]').length, 2);
  await act(async () => {
    domWindow.document.activeElement?.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
  });
  assert.equal(container.querySelectorAll('[role="dialog"]').length, 1);
  assert.equal(container.querySelector('[role="dialog"] h2')?.textContent, "Parent");
  await act(async () => { root.unmount(); });
  container.remove();
});

test("provider teardown fails active and queued confirmations closed", async () => {
  let result: boolean[] | undefined;
  function PendingHarness() {
    const feedback = useFeedback();
    return <button onClick={() => {
      void Promise.all([
        feedback.confirm({ title: "Active", message: "One" }),
        feedback.confirm({ title: "Queued", message: "Two" }),
      ]).then((value) => { result = value; });
    }}>Open two</button>;
  }
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<FeedbackProvider><PendingHarness /></FeedbackProvider>); });
  await act(async () => { container.querySelector("button")!.click(); });
  assert.equal(container.querySelectorAll('[role="dialog"]').length, 1);
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
  assert.equal(container.querySelector('.toast'), null);
  await act(async () => { rejectUndo?.(new Error("runner offline")); await tick(); });
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /Undo failed: runner offline.*Retry undo/);

  await act(async () => { container.querySelector<HTMLButtonElement>('.toast .icon-btn')!.click(); });
  await act(async () => { container.querySelector("button")!.click(); });
  await act(async () => { container.querySelector<HTMLButtonElement>('.toast .btn')!.click(); });
  await act(async () => { root.unmount(); });
  rejectUndo?.(new Error("late failure"));
  await tick();
  assert.equal(container.textContent, "");
  container.remove();
});
