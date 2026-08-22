import assert from "node:assert/strict";
import test from "node:test";
import React, { StrictMode, act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView } from "@wollipog/protocol";
import { useCommandPaletteFocus } from "./CommandPalette.js";
import { SessionApprovalRegion } from "./SessionApproval.js";
import { handleMenuKeyDown, useAccessibleMenu } from "./interactions.js";

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

function MenuHarness() {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "test-menu");
  return (
    <>
      <button ref={menu.triggerRef} data-testid="trigger" onClick={menu.toggle} onKeyDown={menu.onTriggerKeyDown}>
        Actions
      </button>
      {open && (
        <div ref={menu.menuRef} id={menu.menuId} role="menu" onKeyDown={menu.onMenuKeyDown}>
          <button role="menuitem" disabled>Disabled</button>
          <button role="menuitemradio" aria-checked="true" data-menu-label="Second"><span aria-hidden="true">✓</span>Second</button>
          <button role="menuitem">Third</button>
        </div>
      )}
    </>
  );
}

test("accessible menus focus selected enabled items, navigate, and restore their trigger", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<MenuHarness />); });
  const trigger = container.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
  await act(async () => { trigger.click(); });
  assert.equal(domWindow.document.activeElement?.textContent, "✓Second");

  await act(async () => {
    domWindow.document.activeElement?.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  assert.equal(domWindow.document.activeElement?.textContent, "Third");

  await act(async () => {
    domWindow.document.activeElement?.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "s", bubbles: true }));
  });
  assert.equal(domWindow.document.activeElement?.textContent, "✓Second");
  await act(async () => {
    domWindow.document.activeElement?.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  assert.equal(domWindow.document.activeElement?.textContent, "Third");

  await act(async () => {
    domWindow.document.activeElement?.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
  });
  assert.equal(container.querySelector('[role="menu"]'), null);
  assert.equal(domWindow.document.activeElement, trigger);
  await act(async () => { root.unmount(); });
  container.remove();
});

function CollectionMenuHarness() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) domWindow.setTimeout(() => triggerRef.current?.focus(), 0);
  };
  return (
    <>
      <button ref={triggerRef} data-testid="collection-trigger" onClick={() => setOpen(true)}>Rows</button>
      {open && (
        <div role="menu" data-testid="collection-menu" onKeyDown={(event) => handleMenuKeyDown(event, close)}>
          <button role="menuitem" autoFocus>First</button>
          <button role="menuitem" disabled>Disabled</button>
          <button role="menuitem">Last</button>
        </div>
      )}
    </>
  );
}

test("collection-owned menus skip disabled rows and restore on Escape", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<CollectionMenuHarness />); });
  const trigger = container.querySelector<HTMLButtonElement>('[data-testid="collection-trigger"]')!;
  await act(async () => { trigger.click(); });
  assert.equal(domWindow.document.activeElement?.textContent, "First");
  await act(async () => {
    domWindow.document.activeElement?.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  assert.equal(domWindow.document.activeElement?.textContent, "Last");
  await act(async () => {
    domWindow.document.activeElement?.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
  });
  assert.equal(container.querySelector('[data-testid="collection-menu"]'), null);
  assert.equal(domWindow.document.activeElement, trigger);
  await act(async () => { root.unmount(); });
  container.remove();
});

function StrictFocusHarness({ returnTo }: { returnTo: HTMLElement }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement>(returnTo);
  useCommandPaletteFocus(inputRef, returnFocusRef);
  return <input ref={inputRef} aria-label="Palette input" />;
}

test("StrictMode simulated cleanup cannot move focus behind an open palette", async () => {
  const happyInvoker = domWindow.document.createElement("button");
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyInvoker, happyContainer);
  const invoker = happyInvoker as unknown as HTMLButtonElement;
  const container = happyContainer as unknown as HTMLDivElement;
  invoker.textContent = "Open palette";
  invoker.focus();
  const root = createRoot(container);
  await act(async () => {
    root.render(<StrictMode><StrictFocusHarness returnTo={invoker} /></StrictMode>);
    await tick();
  });
  assert.equal(domWindow.document.activeElement?.getAttribute("aria-label"), "Palette input");
  await act(async () => {
    root.unmount();
    await tick();
  });
  assert.equal(domWindow.document.activeElement, invoker);
  invoker.remove();
  container.remove();
});

function approvalSession(requestId: string | null): SessionView {
  return {
    id: "session-1",
    runnerId: "runner-1",
    title: "Session",
    status: requestId ? "input_required" : "idle",
    pendingApproval: requestId
      ? {
          kind: "question",
          requestId,
          title: "Question",
          options: [],
          questions: [{
            id: "choice",
            question: `Choose for ${requestId}`,
            multiSelect: false,
            options: [{ label: "A" }, { label: "B" }],
          }],
        }
      : null,
  } as SessionView;
}

function ApprovalHarness({ requestId, runnerOnline = true }: { requestId: string | null; runnerOnline?: boolean }) {
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  return (
    <>
      <SessionApprovalRegion session={approvalSession(requestId)} runnerOnline={runnerOnline} fallbackFocusRef={fallbackRef} />
      <textarea ref={fallbackRef} aria-label="Composer" />
    </>
  );
}

function offlinePolicySession(requestId: string, withContext: boolean): SessionView {
  return {
    id: "session-1",
    runnerId: "runner-1",
    title: "Session",
    status: "input_required",
    pendingApproval: {
      kind: "permission",
      requestId,
      title: `Approval ${requestId}`,
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      context: withContext ? { input: "npm test" } : undefined,
    },
  } as SessionView;
}

function authenticationSession(): SessionView {
  return {
    id: "session-1",
    runnerId: "runner-1",
    title: "Session",
    status: "input_required",
    pendingApproval: {
      kind: "authentication",
      requestId: "provider-auth:test",
      title: "Authentication Required — Claude Code",
      options: [],
      context: { toolName: "Claude Code", input: "Run `claude` in this exact context." },
    },
  } as unknown as SessionView;
}

test("provider authentication card uses the visible Authentication Required accessible name", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <SessionApprovalRegion
        session={authenticationSession()}
        runnerOnline
        fallbackFocusRef={{ current: null }}
      />,
    );
  });
  const card = container.querySelector<HTMLElement>('[aria-label="Authentication Required"]');
  assert.ok(card);
  assert.match(card.textContent ?? "", /Authentication Required — Claude Code/);
  assert.deepEqual(
    [...card.querySelectorAll<HTMLButtonElement>(".approval-actions button")].map((button) => button.textContent?.trim()),
    ["Hide Details"],
    "terminal login guidance offers context details but no fake provider approval action",
  );
  await act(async () => { root.unmount(); });
  container.remove();
});

function OfflineApprovalHarness({ requestId, withContext }: { requestId: string; withContext: boolean }) {
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  return (
    <>
      <SessionApprovalRegion
        session={offlinePolicySession(requestId, withContext)}
        runnerOnline={false}
        fallbackFocusRef={fallbackRef}
      />
      <textarea ref={fallbackRef} aria-label="Offline composer" />
    </>
  );
}

test("approval replacement and resolution preserve owned keyboard focus", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<ApprovalHarness requestId="ask-a" />); });
  container.querySelector<HTMLElement>('[role="radio"]')!.focus();

  await act(async () => { root.render(<ApprovalHarness requestId="ask-b" />); });
  assert.equal(domWindow.document.activeElement?.textContent?.replace(/\s+/g, " ").trim(), "Dismiss D");

  await act(async () => { root.render(<ApprovalHarness requestId={null} />); });
  assert.equal(domWindow.document.activeElement?.getAttribute("aria-label"), "Composer");
  await act(async () => { root.unmount(); });
  container.remove();
});

test("offline question replacement falls back instead of targeting a disabled radio", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<ApprovalHarness requestId="ask-a" />); });
  container.querySelector<HTMLElement>("[role=\"radio\"]")!.focus();

  await act(async () => { root.render(<ApprovalHarness requestId="ask-b" runnerOnline={false} />); });
  assert.equal(domWindow.document.activeElement?.getAttribute("aria-label"), "Composer");
  await act(async () => { root.unmount(); });
  container.remove();
});

test("approval replacement does not reclaim focus after a null-target blur", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<ApprovalHarness requestId="ask-a" />); });
  const choice = container.querySelector<HTMLElement>('[role="radio"]')!;
  choice.focus();
  await act(async () => { choice.blur(); });
  await act(async () => { root.render(<ApprovalHarness requestId="ask-b" />); });
  assert.notEqual(domWindow.document.activeElement?.textContent?.trim(), "Dismiss");
  await act(async () => { root.unmount(); });
  container.remove();
});

function DisabledFallbackHarness({ requestId }: { requestId: string | null }) {
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <SessionApprovalRegion
        session={requestId ? offlinePolicySession(requestId, true) : approvalSession(null)}
        runnerOnline={false}
        fallbackFocusRef={composerRef}
        alternateFallbackFocusRef={transcriptRef}
      />
      <div ref={transcriptRef} tabIndex={0} aria-label="Transcript" />
      <textarea ref={composerRef} disabled aria-label="Disabled composer" />
    </>
  );
}

test("approval resolution uses the transcript when the composer fallback is disabled", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<DisabledFallbackHarness requestId="ask-a" />); });
  container.querySelector<HTMLButtonElement>('button[aria-expanded]')!.focus();
  await act(async () => { root.render(<DisabledFallbackHarness requestId={null} />); });
  assert.equal(domWindow.document.activeElement?.getAttribute("aria-label"), "Transcript");
  await act(async () => { root.unmount(); });
  container.remove();
});

test("offline approval replacement falls back when the new request has no enabled action", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<OfflineApprovalHarness requestId="ask-a" withContext />); });
  container.querySelector<HTMLButtonElement>('button[aria-expanded]')!.focus();
  await act(async () => { root.render(<OfflineApprovalHarness requestId="ask-b" withContext={false} />); });
  assert.equal(domWindow.document.activeElement?.getAttribute("aria-label"), "Offline composer");
  await act(async () => { root.unmount(); });
  container.remove();
});
