import assert from "node:assert/strict";
import test from "node:test";
import React, { StrictMode, act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { prioritizedPendingRequests, type SessionView } from "@wollipog/protocol";
import { useCommandPaletteFocus } from "./CommandPalette.js";
import { EventTimeline } from "./EventTimeline.js";
import { SessionApprovalRegion } from "./SessionApproval.js";
import { RequestDock, dockRequests } from "./requests/RequestDock.js";
import { handleMenuKeyDown, useAccessibleMenu, useDismissiblePopover } from "./interactions.js";
import { Select } from "./ui/ChoiceControls.js";
import { clearQuestionDrafts } from "../question-response.js";
import { setQuestionResponseStyle } from "../question-response-style.js";
import { api } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { withScopedClockOverrides } from "./test-clock-overrides.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window({ url: "http://localhost/" });
(globalThis as typeof globalThis & { React: typeof React }).React = React;
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  KeyboardEvent: domWindow.KeyboardEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
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
  assertNoDomNode(container.querySelector('[role="menu"]'));
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
  assertNoDomNode(container.querySelector('[data-testid="collection-menu"]'));
  assert.equal(domWindow.document.activeElement, trigger);
  await act(async () => { root.unmount(); });
  container.remove();
});

function FormPopoverHarness({ fieldFirst }: { fieldFirst: boolean }) {
  const [open, setOpen] = useState(false);
  const popover = useDismissiblePopover(open, setOpen, "test-popover");
  return (
    <>
      <button ref={popover.triggerRef} data-testid="popover-trigger" onClick={popover.toggle}>Options</button>
      {open && (
        <div ref={popover.panelRef} id={popover.panelId} role="dialog" aria-label="Options" tabIndex={-1}
          onKeyDown={popover.onPanelKeyDown}>
          <button disabled>Unavailable</button>
          {!fieldFirst && <button>Action</button>}
          <input aria-label="Threshold" />
        </div>
      )}
    </>
  );
}

/** Opens the harness under a stubbed pointer and reports what took focus. */
async function openFormPopover(fieldFirst: boolean, coarse: boolean) {
  const matchMedia = domWindow.matchMedia;
  domWindow.matchMedia = ((query: string) => ({
    ...matchMedia.call(domWindow, query),
    matches: query === "(pointer: coarse)" ? coarse : false,
  })) as typeof matchMedia;
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<FormPopoverHarness fieldFirst={fieldFirst} />); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="popover-trigger"]')!.click(); });
    const active = domWindow.document.activeElement;
    return active?.getAttribute("role") === "dialog" ? "panel" : active?.getAttribute("aria-label") ?? active?.textContent;
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    domWindow.matchMedia = matchMedia;
  }
}

test("a form popover opens onto its panel, not a field, on a coarse pointer", async () => {
  // A fine pointer keeps the first enabled control, field or not.
  assert.equal(await openFormPopover(true, false), "Threshold");
  // A coarse pointer never focuses a field on open (#1904): the software keyboard would cover it.
  assert.equal(await openFormPopover(true, true), "panel");
  // A button first is unaffected by the pointer.
  assert.equal(await openFormPopover(false, true), "Action");
});

const CHOICES = [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }] as const;

function TwoSelectHarness() {
  const [first, setFirst] = useState<"a" | "b">("a");
  const [second, setSecond] = useState<"a" | "b">("a");
  return (
    <>
      <Select label="First" options={CHOICES} value={first} onChange={setFirst} />
      <Select label="Second" options={CHOICES} value={second} onChange={setSecond} />
    </>
  );
}

/**
 * Run `body` with zero-delay timers captured instead of scheduled, and hand back a function that
 * fires what it caught.
 *
 * The trigger-focus restore runs on a zero-delay timer, so whether it lands before or after the
 * next interaction is a race a test can only lose intermittently — which is the flake #1307
 * reported. Capturing the callback makes the interleaving the assertion rather than the weather.
 *
 * The override is installed for the duration of `body` and removed in a `finally`, never left for a
 * later caller to unwind. `tick()` above is itself a zero-delay timer, so an override that outlived
 * a thrown assertion would leave every subsequent test in this shared process awaiting a promise
 * that can no longer settle: one failure became a hung file, cancelled at the test timeout.
 */
async function withCapturedZeroDelayTimers(body: () => Promise<void>): Promise<() => void> {
  const timers = domWindow as unknown as {
    setTimeout: (handler: () => void, delay?: number) => unknown;
  };
  const scheduled: Array<() => void> = [];
  const original = timers.setTimeout;
  await withScopedClockOverrides(domWindow, { setTimeout: (handler: () => void, delay?: number) => {
    if (delay !== 0) return original.call(domWindow, handler, delay);
    scheduled.push(handler);
    return 0;
  } }, body);
  return () => { for (const handler of scheduled.splice(0)) handler(); };
}

async function openFirstAndCommit(container: HTMLDivElement) {
  const first = container.querySelector<HTMLButtonElement>('[aria-label="First: Alpha"]')!;
  await act(async () => { first.click(); });
  const beta = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((option) => option.textContent === "Beta")!;
  const restore = await withCapturedZeroDelayTimers(async () => {
    await act(async () => { beta.click(); });
  });
  assertNoDomNode(container.querySelector('[role="listbox"][aria-label="First"]'),
    "committing an option closes the list it was chosen from");
  return { first, restore };
}

test("a deferred trigger restore yields to a control that took focus while the panel closed", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<TwoSelectHarness />); });
  const { restore } = await openFirstAndCommit(container);

  const second = container.querySelector<HTMLButtonElement>('[aria-label="Second: Alpha"]')!;
  await act(async () => {
    second.dispatchEvent(
      new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event,
    );
  });
  assert.ok(container.querySelector('[role="listbox"][aria-label="Second"]'), "ArrowDown opens the second list");

  // The first Select's restore now fires with the second list already open. Pulling focus back to
  // the first trigger would read to the second Select's outside-focus dismisser as a click-away,
  // closing a list the user had just opened — issue #1307's intermittent failure.
  await act(async () => { restore(); });
  assert.ok(container.querySelector('[role="listbox"][aria-label="Second"]'),
    "the late restore does not dismiss the list that took focus after it was scheduled");
  assert.equal(second.getAttribute("aria-expanded"), "true");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("a deferred trigger restore still returns focus when nothing else claimed it", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<TwoSelectHarness />); });
  const { first, restore } = await openFirstAndCommit(container);

  await act(async () => { restore(); });
  assert.equal(domWindow.document.activeElement, first,
    "closing a list with nowhere else for focus to go puts it back on the trigger");

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

test("closing the palette after its opener was removed hands focus to the page title (#1978)", async () => {
  // The phone app bar's Search unmounts when the window widens past 760px while the palette is open.
  const happyTitle = domWindow.document.createElement("h1");
  const happyInvoker = domWindow.document.createElement("button");
  const happyContainer = domWindow.document.createElement("div");
  happyTitle.id = "page-title";
  happyTitle.tabIndex = -1;
  domWindow.document.body.append(happyTitle, happyInvoker, happyContainer);
  const invoker = happyInvoker as unknown as HTMLButtonElement;
  const container = happyContainer as unknown as HTMLDivElement;
  invoker.focus();
  const root = createRoot(container);
  await act(async () => {
    root.render(<StrictFocusHarness returnTo={invoker} />);
    await tick();
  });
  invoker.remove();
  await act(async () => {
    root.unmount();
    await tick();
  });
  assert.ok(domWindow.document.activeElement === happyTitle, "focus is on the page title, not <body>");
  happyTitle.remove();
  container.remove();
});

test("a palette reopened at once keeps focus; the closed one's restore does not take it back (#1978)", async () => {
  const happyInvoker = domWindow.document.createElement("button");
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyInvoker, happyContainer);
  const invoker = happyInvoker as unknown as HTMLButtonElement;
  const container = happyContainer as unknown as HTMLDivElement;
  invoker.focus();
  const root = createRoot(container);
  const palette = (key: string) => (
    <div role="dialog" aria-modal="true" key={key}><StrictFocusHarness returnTo={invoker} /></div>
  );
  await act(async () => {
    root.render(palette("first"));
    await tick();
  });
  // Close and reopen in one commit, before the first palette's zero-delay restore has run.
  await act(async () => { root.render(palette("second")); });
  await act(async () => { await tick(); });
  assert.equal(domWindow.document.activeElement?.getAttribute("aria-label"), "Palette input",
    "focus stays in the open palette, where Escape can reach it");
  await act(async () => { root.unmount(); });
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
  const session = approvalSession(requestId);
  const question = (id: string) => [{
    id: "choice",
    question: `Choose for ${id}`,
    multiSelect: false,
    options: [{ label: "A" }, { label: "B" }],
  }];
  const items = requestId === "ask-a"
    ? [{ kind: "question" as const, id: 1, requestId: "ask-a", questions: question("ask-a") }]
    : [
        { kind: "question" as const, id: 1, requestId: "ask-a", questions: question("ask-a"), answered: false, resolutionReason: "replaced" as const },
        { kind: "question" as const, id: 2, requestId: "ask-b", questions: question("ask-b"),
          ...(requestId === "ask-b" ? {} : { answered: false, resolutionReason: "dismissed" as const }) },
      ];
  return (
    <>
      <DockedRegion session={session} runnerOnline={runnerOnline} fallbackFocusRef={fallbackRef} />
      <EventTimeline items={items} questionContext={{ pendingRequestIds: requestId ? [requestId] : [] }} />
      <textarea ref={fallbackRef} aria-label="Composer" />
    </>
  );
}

function QuestionPresentationHarness({ hydrated }: { hydrated: boolean }) {
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const session = approvalSession("ask-a");
  const questions = session.pendingApproval?.kind === "question" ? session.pendingApproval.questions ?? [] : [];
  return (
    <>
      <DockedRegion session={session} runnerOnline fallbackFocusRef={fallbackRef} />
      {hydrated && (
        <EventTimeline
          items={[{ kind: "question", id: 1, requestId: "ask-a", questions }]}
          questionContext={{ pendingRequestIds: ["ask-a"] }}
        />
      )}
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

/** The session's own requests as SessionDetail shows them: the approval region's focus coordinator,
 * and every request, questions included, on the dock (#2179, #2205). */
function DockedRegion({ session, runnerOnline, fallbackFocusRef, alternateFallbackFocusRef }: {
  session: SessionView;
  runnerOnline: boolean;
  fallbackFocusRef: React.RefObject<HTMLElement | null>;
  alternateFallbackFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const requests = dockRequests(prioritizedPendingRequests(session.pendingApproval));
  return (
    <>
      <SessionApprovalRegion
        session={session}
        runnerOnline={runnerOnline}
        fallbackFocusRef={fallbackFocusRef}
        alternateFallbackFocusRef={alternateFallbackFocusRef}
      />
      {requests.length > 0 && <RequestDock session={session} requests={requests} runnerOnline={runnerOnline} />}
    </>
  );
}

function authenticationSession(title = "Authentication Required — Claude Code"): SessionView {
  return {
    id: "session-1",
    runnerId: "runner-1",
    title: "Session",
    status: "input_required",
    pendingApproval: {
      kind: "authentication",
      requestId: "provider-auth:test",
      title,
      options: [],
      context: { toolName: "Claude Code", input: "Run `claude` in this exact context." },
    },
  } as unknown as SessionView;
}

test("provider authentication card uses its visible title as the accessible name", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <DockedRegion
        session={authenticationSession()}
        runnerOnline
        fallbackFocusRef={{ current: null }}
      />,
    );
  });
  const card = container.querySelector<HTMLElement>(".request-card")!;
  assert.ok(card);
  assert.equal(domWindow.document.getElementById(card.getAttribute("aria-labelledby")!)?.textContent,
    "Authentication Required — Claude Code");
  assert.match(card.querySelector(".code-well")?.textContent ?? "", /Run `claude` in this exact context\./);
  assert.deepEqual(
    [...card.querySelectorAll<HTMLButtonElement>(".request-card-foot button")].map((button) => button.textContent?.trim()),
    [],
    "terminal login guidance shows its context but no fake provider approval action",
  );
  await act(async () => { root.unmount(); });
  container.remove();
});

test("restored authentication recovery card uses its visible title as the accessible name", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const title = "Authentication Restored — Retained Messages Waiting";
  await act(async () => {
    root.render(
      <DockedRegion
        session={authenticationSession(title)}
        runnerOnline
        fallbackFocusRef={{ current: null }}
      />,
    );
  });
  const card = container.querySelector<HTMLElement>(".request-card")!;
  assert.ok(card);
  assert.equal(domWindow.document.getElementById(card.getAttribute("aria-labelledby")!)?.textContent, title);
  await act(async () => { root.unmount(); });
  container.remove();
});

test("UI evidence approval requires an explicit review acknowledgement and sends exact evidence ids", async () => {
  const evidence = { evidenceId: "desktop-after", uri: "https://evidence.example/after.png", sha256: "a".repeat(64) };
  const session = {
    id: "session-evidence",
    runnerId: "runner-1",
    title: "Evidence Review",
    status: "input_required",
    pendingApproval: {
      kind: "workflow_decision",
      requestId: "workflow-evidence",
      occurrenceId: "workflow-evidence",
      title: "UI Evidence Approval Required",
      options: [
        { optionId: "approve", name: "Approve", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
      workflowDecision: {
        requestId: "evidence-request",
        occurrenceId: "workflow-evidence",
        sessionId: "session-evidence",
        controllingSessionId: "session-parent",
        category: "ui_evidence_approval",
        resourceKey: "pr-1094-ui",
        resourceSnapshot: { category: "ui_evidence_approval", evidence: [evidence] },
        resourceDigest: "b".repeat(64),
        policyRevision: 1,
        authority: "human",
        status: "pending",
        createdAt: 1,
      },
    },
  } as SessionView;
  const requests: unknown[] = [];
  const client = {
    ...api,
    approve: async (_id: string, body: unknown) => {
      requests.push(body);
      return { ...session, status: "running", pendingApproval: null } as SessionView;
    },
  };
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <ApiProvider client={client}>
          <DockedRegion session={session} runnerOnline={false} fallbackFocusRef={{ current: null }} />
        </ApiProvider>,
      );
    });
    const approve = [...container.querySelectorAll<HTMLButtonElement>(".request-card-foot button")]
      .find((button) => button.textContent?.includes("Approve"))!;
    assert.equal(approve.disabled, true);
    const link = container.querySelector<HTMLAnchorElement>('[href="https://evidence.example/after.png"]')!;
    assert.equal(link.textContent, "Open Link");
    const reviewed = container.querySelector<HTMLInputElement>('.ev-tile input[type="checkbox"]')!;
    assert.equal(reviewed.disabled, true, "a link-only item is reviewable once its link was opened");
    await act(async () => { link.click(); });
    await act(async () => { reviewed.click(); });
    assert.equal(approve.disabled, false);
    await act(async () => { approve.click(); await tick(); });
    assert.deepEqual(requests, [{
      requestId: "workflow-evidence", optionId: "approve", evidenceReviewed: ["desktop-after"],
    }]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("the inline evidence card blocks an artifact it cannot show instead of linking to its URI", async () => {
  const evidence = [
    { evidenceId: "vector", uri: "https://evidence.example/vector.svg", sha256: "a".repeat(64),
      artifactId: "art_svg", mediaType: "image/svg+xml" },
    { evidenceId: "legacy", uri: "https://evidence.example/legacy.png", sha256: "c".repeat(64) },
  ];
  const session = {
    id: "session-evidence-unrenderable",
    runnerId: "runner-1",
    title: "Evidence Review",
    status: "input_required",
    pendingApproval: {
      kind: "workflow_decision",
      requestId: "workflow-evidence-unrenderable",
      occurrenceId: "workflow-evidence-unrenderable",
      title: "UI Evidence Approval Required",
      options: [
        { optionId: "approve", name: "Approve", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
      workflowDecision: {
        requestId: "evidence-request",
        occurrenceId: "workflow-evidence-unrenderable",
        sessionId: "session-evidence-unrenderable",
        controllingSessionId: "session-parent",
        category: "ui_evidence_approval",
        resourceKey: "pr-1790-ui",
        resourceSnapshot: { category: "ui_evidence_approval", evidence },
        resourceDigest: "b".repeat(64),
        policyRevision: 1,
        authority: "human",
        status: "pending",
        createdAt: 1,
      },
    },
  } as SessionView;
  const requests: unknown[] = [];
  const client = {
    ...api,
    approve: async (_id: string, body: unknown) => {
      requests.push(body);
      return { ...session, status: "running", pendingApproval: null } as SessionView;
    },
  };
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <ApiProvider client={client}>
          <DockedRegion session={session} runnerOnline={false} fallbackFocusRef={{ current: null }} />
        </ApiProvider>,
      );
    });
    const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>(".request-card-foot button")]
      .find((candidate) => candidate.textContent?.includes(name))!;
    assertNoDomNode(container.querySelector('[href="https://evidence.example/vector.svg"]'));
    const legacy = container.querySelector<HTMLAnchorElement>('[href="https://evidence.example/legacy.png"]');
    assert.ok(legacy, "URI-only evidence keeps its link");
    assert.equal(container.querySelector('.ev-media[data-status="unsupported"]')?.textContent,
      "Can't Showimage/svg+xml can't be shown here.");
    const checkbox = (name: string) =>
      container.querySelector<HTMLInputElement>(`input[aria-label="Mark ${name} as Reviewed"]`);
    assertNoDomNode(checkbox("Screenshot"), "the SVG has no Reviewed mark");
    await act(async () => { legacy.click(); });
    await act(async () => { checkbox("Link")!.click(); });
    assert.equal(button("Approve").disabled, true);
    await act(async () => { button("Deny").click(); await tick(); });
    assert.deepEqual(requests, [{ requestId: "workflow-evidence-unrenderable", optionId: "deny" }]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

function OfflineApprovalHarness({
  requestId,
  withContext,
  runnerOnline = false,
}: {
  requestId: string;
  withContext: boolean;
  runnerOnline?: boolean;
}) {
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  return (
    <>
      <DockedRegion
        session={offlinePolicySession(requestId, withContext)}
        runnerOnline={runnerOnline}
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
  const liveRegion = container.querySelector('[role="status"]');
  container.querySelector<HTMLElement>('input[type="radio"]')!.focus();

  await act(async () => { root.render(<ApprovalHarness requestId="ask-b" />); });
  assert.equal(container.querySelector('[role="status"]'), liveRegion, "the live region remains mounted across row replacement");
  assert.equal(liveRegion?.textContent, "Agent request updated");
  // A new question is read before it is answered (#2196): focus lands on its heading, never Dismiss.
  assert.equal(domWindow.document.activeElement?.getAttribute("role"), "heading");
  assert.equal(domWindow.document.activeElement?.textContent?.trim(), "Choose for ask-b");

  await act(async () => { root.render(<ApprovalHarness requestId={null} />); });
  assert.equal(domWindow.document.activeElement?.getAttribute("aria-label"), "Composer");
  await act(async () => { root.unmount(); });
  container.remove();
});

test("Composer Response replacement falls back instead of focusing Dismiss", async () => {
  setQuestionResponseStyle("composer", domWindow as never);
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<ApprovalHarness requestId="ask-a" />); });
    container.querySelector<HTMLButtonElement>('[data-session-request-control="dismiss"]')!.focus();

    await act(async () => { root.render(<ApprovalHarness requestId="ask-b" />); });
    assert.equal(domWindow.document.activeElement?.getAttribute("aria-label"), "Composer");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    setQuestionResponseStyle("interactive", domWindow as never);
  }
});

test("a pending question keeps one form on the dock, with its focus and draft, as its transcript marker hydrates", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<QuestionPresentationHarness hydrated={false} />); });
  const response = container.querySelector<HTMLInputElement>('input[type="radio"]')!;
  await act(async () => { response.click(); });
  response.focus();
  await act(async () => { root.render(<QuestionPresentationHarness hydrated={false} />); });
  assert.equal(domWindow.document.activeElement?.closest("[data-session-request-id]")?.getAttribute("data-session-request-id"), "ask-a");

  await act(async () => { root.render(<QuestionPresentationHarness hydrated />); });
  assert.equal(domWindow.document.activeElement?.closest("[data-session-request-id]")?.getAttribute("data-session-request-id"), "ask-a");
  assert.equal(domWindow.document.activeElement?.getAttribute("type"), "radio",
    "the same response control keeps focus as the transcript arrives");
  assert.equal(domWindow.document.activeElement?.getAttribute("data-session-request-control"), "question:choice:option:0");
  assert.equal(container.querySelector<HTMLInputElement>('input[type="radio"]')?.checked, true);
  assert.equal(container.querySelectorAll('[aria-label="Agent Questions"]').length, 1);
  assert.equal(container.querySelectorAll('input[type="radio"]').length, 3, "A, B and Something Else");
  assert.equal(container.querySelector(".request-dock [aria-label='Agent Questions']") != null, true, "the form is on the dock");
  assert.equal(container.querySelector(".ask-marker")?.textContent, "QuestionChoose for ask-a",
    "the transcript row is the question's marker");
  assertNoDomNode(container.querySelector(".tl-question"));
  await act(async () => { root.render(<QuestionPresentationHarness hydrated={false} />); });
  assert.equal(container.querySelectorAll('[aria-label="Agent Questions"]').length, 1,
    "the dock keeps the form without the transcript");
  await act(async () => { root.unmount(); });
  clearQuestionDrafts("session-1", "ask-a");
  container.remove();
});

test("a pending question's transcript rows are markers, never a second form", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const session = approvalSession("ask-a");
  const questions = session.pendingApproval?.kind === "question" ? session.pendingApproval.questions ?? [] : [];
  try {
    await act(async () => {
      root.render(
        <EventTimeline
          items={[
            { kind: "question", id: 1, requestId: "ask-a", questions },
            { kind: "question", id: 2, requestId: "ask-a", questions },
          ]}
          questionContext={{ pendingRequestIds: ["ask-a"] }}
        />,
      );
    });
    assert.equal(container.querySelectorAll('[aria-label="Agent Questions"]').length, 0);
    assert.equal(container.querySelectorAll(".ask-marker").length, 2);
    assert.equal(container.querySelectorAll(".tl-question").length, 0);
  } finally {
    await act(async () => root.unmount());
    clearQuestionDrafts("session-1", "ask-a");
    container.remove();
  }
});

test("offline question replacement falls back instead of targeting a disabled radio", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<ApprovalHarness requestId="ask-a" />); });
  container.querySelector<HTMLElement>('input[type="radio"]')!.focus();

  await act(async () => { root.render(<ApprovalHarness requestId="ask-b" runnerOnline={false} />); });
  assert.equal(domWindow.document.activeElement?.getAttribute("aria-label"), "Composer");
  await act(async () => { root.unmount(); });
  container.remove();
});

test("taking a pending question offline moves owned focus to the composer", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<ApprovalHarness requestId="ask-a" />); });
  container.querySelector<HTMLElement>('input[type="radio"]')!.focus();

  await act(async () => { root.render(<ApprovalHarness requestId="ask-a" runnerOnline={false} />); });
  assert.equal(domWindow.document.activeElement?.getAttribute("aria-label"), "Composer");
  await act(async () => { root.unmount(); });
  container.remove();
});

function UnownedOfflineHarness({ runnerOnline }: { runnerOnline: boolean }) {
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  return (
    <>
      <SessionApprovalRegion
        session={approvalSession(null)}
        runnerOnline={runnerOnline}
        fallbackFocusRef={fallbackRef}
      />
      <button type="button" disabled={!runnerOnline}>Unrelated Action</button>
      <textarea ref={fallbackRef} aria-label="Composer" />
    </>
  );
}

test("an offline transition does not move unrelated disabled focus into the composer", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<UnownedOfflineHarness runnerOnline />); });
  container.querySelector<HTMLButtonElement>("button")!.focus();

  await act(async () => { root.render(<UnownedOfflineHarness runnerOnline={false} />); });
  assert.notEqual(domWindow.document.activeElement?.getAttribute("aria-label"), "Composer");
  await act(async () => { root.unmount(); });
  container.remove();
});

test("approval replacement does not reclaim focus after a null-target blur", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<ApprovalHarness requestId="ask-a" />); });
  const choice = container.querySelector<HTMLElement>('input[type="radio"]')!;
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
      <DockedRegion
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
  container.querySelector<HTMLButtonElement>('button[aria-label="Copy Request Details"]')!.focus();
  await act(async () => { root.render(<DisabledFallbackHarness requestId={null} />); });
  assert.equal(domWindow.document.activeElement?.getAttribute("aria-label"), "Transcript");
  await act(async () => { root.unmount(); });
  container.remove();
});

test("offline approval replacement lands on the new request's heading when it has no enabled action", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<OfflineApprovalHarness requestId="ask-a" withContext />); });
  container.querySelector<HTMLButtonElement>('button[aria-label="Copy Request Details"]')!.focus();
  await act(async () => { root.render(<OfflineApprovalHarness requestId="ask-b" withContext={false} />); });
  // The new card's disabled Allow is never focused; its heading is, and the reason is visible below.
  assert.equal(domWindow.document.activeElement?.textContent, "Approval ask-b");
  assert.equal(domWindow.document.activeElement?.tagName, "H3");
  assert.match(container.querySelector(".request-card-reasons")?.textContent ?? "", /until the runner reconnects/);
  await act(async () => { root.unmount(); });
  container.remove();
});

test("going offline preserves focus on an approval control that remains enabled", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(<OfflineApprovalHarness requestId="ask-a" withContext runnerOnline />);
  });
  const details = container.querySelector<HTMLButtonElement>('button[aria-label="Copy Request Details"]');
  assert.ok(details);
  details.focus();

  await act(async () => {
    root.render(<OfflineApprovalHarness requestId="ask-a" withContext />);
  });
  assert.equal(domWindow.document.activeElement, details);
  assert.equal(details.disabled, false);
  await act(async () => { root.unmount(); });
  container.remove();
});
