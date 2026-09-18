import assert from "node:assert/strict";
import test from "node:test";
import React, { StrictMode, act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView } from "@wollipog/protocol";
import { useCommandPaletteFocus } from "./CommandPalette.js";
import { EventTimeline } from "./EventTimeline.js";
import { SessionApprovalRegion } from "./SessionApproval.js";
import { handleMenuKeyDown, useAccessibleMenu } from "./interactions.js";
import { Select } from "./ui/ChoiceControls.js";
import { clearQuestionDrafts } from "../question-response.js";
import { setQuestionResponseStyle } from "../question-response-style.js";
import { api } from "../api.js";
import { ApiProvider } from "../api-context.js";

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
 * Drive the deferred trigger-focus restore by hand.
 *
 * The restore runs on a zero-delay timer, so whether it lands before or after the next interaction
 * is a race that a test can only lose intermittently — which is exactly the flake #1307 reported.
 * Capturing the callback instead of scheduling it makes the interleaving the assertion rather than
 * the weather.
 */
function captureDeferredFocusRestore(): { run: () => void } {
  const timers = domWindow as unknown as {
    setTimeout: (handler: () => void, delay?: number) => unknown;
  };
  const scheduled: Array<() => void> = [];
  const original = timers.setTimeout;
  timers.setTimeout = (handler, delay) => {
    if (delay !== 0) return original.call(domWindow, handler, delay);
    scheduled.push(handler);
    return 0;
  };
  return {
    run: () => {
      timers.setTimeout = original;
      for (const handler of scheduled.splice(0)) handler();
    },
  };
}

async function openFirstAndCommit(container: HTMLDivElement) {
  const first = container.querySelector<HTMLButtonElement>('[aria-label="First: Alpha"]')!;
  await act(async () => { first.click(); });
  const deferred = captureDeferredFocusRestore();
  const beta = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((option) => option.textContent === "Beta")!;
  await act(async () => { beta.click(); });
  assert.equal(container.querySelector('[role="listbox"][aria-label="First"]'), null,
    "committing an option closes the list it was chosen from");
  return { first, deferred };
}

test("a deferred trigger restore yields to a control that took focus while the panel closed", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<TwoSelectHarness />); });
  const { deferred } = await openFirstAndCommit(container);

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
  await act(async () => { deferred.run(); });
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
  const { first, deferred } = await openFirstAndCommit(container);

  await act(async () => { deferred.run(); });
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
      <SessionApprovalRegion
        session={session}
        runnerOnline={runnerOnline}
        fallbackFocusRef={fallbackRef}
        questionInTimeline={requestId !== null}
      />
      <EventTimeline items={items} questionContext={{
        sessionId: session.id,
        pendingQuestion: session.pendingApproval?.kind === "question" ? {
          requestId: session.pendingApproval.requestId,
          questions: session.pendingApproval.questions ?? [],
        } : null,
        questionInTimeline: requestId !== null,
        runnerOnline,
      }} />
      <textarea ref={fallbackRef} aria-label="Composer" />
    </>
  );
}

function QuestionPresentationHarness({ hydrated }: { hydrated: boolean }) {
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const session = approvalSession("ask-a");
  const questions = session.pendingApproval?.kind === "question" ? session.pendingApproval.questions ?? [] : [];
  const [inlineRequestId, setInlineRequestId] = React.useState<string | null>(null);
  const questionInTimeline = inlineRequestId === "ask-a";
  const handlePendingQuestionAvailabilityChange = React.useCallback((requestId: string, available: boolean) => {
    setInlineRequestId((current) => available
      ? current === requestId ? current : requestId
      : current === requestId ? null : current);
  }, []);
  return (
    <>
      <SessionApprovalRegion
        session={session}
        runnerOnline
        fallbackFocusRef={fallbackRef}
        questionInTimeline={questionInTimeline}
      />
      {hydrated && (
        <EventTimeline
          items={[{ kind: "question", id: 1, requestId: "ask-a", questions }]}
          questionContext={{
            sessionId: session.id,
            pendingQuestion: { requestId: "ask-a", questions },
            questionInTimeline,
            onPendingQuestionAvailabilityChange: handlePendingQuestionAvailabilityChange,
            runnerOnline: true,
          }}
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
      <SessionApprovalRegion
        session={authenticationSession()}
        runnerOnline
        fallbackFocusRef={{ current: null }}
      />,
    );
  });
  const card = container.querySelector<HTMLElement>('[aria-label="Authentication Required — Claude Code"]');
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

test("restored authentication recovery card uses its visible title as the accessible name", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const title = "Authentication Restored — Retained Messages Waiting";
  await act(async () => {
    root.render(
      <SessionApprovalRegion
        session={authenticationSession(title)}
        runnerOnline
        fallbackFocusRef={{ current: null }}
      />,
    );
  });
  const card = container.querySelector<HTMLElement>(`[aria-label="${title}"]`);
  assert.ok(card);
  assert.match(card.textContent ?? "", new RegExp(title));
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
          <SessionApprovalRegion session={session} runnerOnline={false} fallbackFocusRef={{ current: null }} />
        </ApiProvider>,
      );
    });
    const approve = [...container.querySelectorAll<HTMLButtonElement>(".approval-actions button")]
      .find((button) => button.textContent?.includes("Approve"))!;
    assert.equal(approve.disabled, true);
    assert.equal(container.querySelector<HTMLAnchorElement>('[href="https://evidence.example/after.png"]')?.textContent,
      "Open Evidence: desktop-after");
    const reviewed = container.querySelector<HTMLInputElement>('.approval-evidence input[type="checkbox"]')!;
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
      <SessionApprovalRegion
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
  container.querySelector<HTMLElement>('[role="radio"]')!.focus();

  await act(async () => { root.render(<ApprovalHarness requestId="ask-b" />); });
  assert.equal(container.querySelector('[role="status"]'), liveRegion, "the live region remains mounted across row replacement");
  assert.equal(liveRegion?.textContent, "Agent request updated");
  assert.equal(domWindow.document.activeElement?.textContent?.replace(/\s+/g, " ").trim(), "Dismiss D");

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

test("question focus and draft survive transcript hydration without exposing a second live form", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<QuestionPresentationHarness hydrated={false} />); });
  const response = container.querySelector<HTMLElement>('[role="radio"]')!;
  await act(async () => { response.click(); });
  response.focus();
  await act(async () => { root.render(<QuestionPresentationHarness hydrated={false} />); });
  assert.equal(domWindow.document.activeElement?.closest("[data-session-request-id]")?.getAttribute("data-session-request-id"), "ask-a");

  await act(async () => { root.render(<QuestionPresentationHarness hydrated />); });
  assert.equal(domWindow.document.activeElement?.closest("[data-session-request-id]")?.getAttribute("data-session-request-id"), "ask-a");
  assert.equal(domWindow.document.activeElement?.getAttribute("role"), "radio",
    "the same response control, not Dismiss, keeps focus after the presentation moves");
  assert.equal(container.querySelector<HTMLElement>('[role="radio"]')?.getAttribute("aria-checked"), "true");
  assert.equal(container.querySelectorAll('[aria-label="Agent Questions"]').length, 1);
  assert.equal(container.querySelectorAll('[role="radio"]').length, 2);
  assert.equal(container.querySelector(".tl-question"), null,
    "the live inline form replaces the hydrated historical card");
  await act(async () => { root.render(<QuestionPresentationHarness hydrated={false} />); });
  assert.equal(container.querySelectorAll('[aria-label="Agent Questions"]').length, 1,
    "unmounting the inline timeline restores the reachable fallback");
  assert.equal(container.querySelector(".tl-question"), null);
  await act(async () => { root.unmount(); });
  clearQuestionDrafts("session-1", "ask-a");
  container.remove();
});

test("duplicate unresolved request rows expose only the latest question as interactive", async () => {
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
          questionContext={{
            sessionId: session.id,
            pendingQuestion: { requestId: "ask-a", questions },
            questionInTimeline: true,
            runnerOnline: true,
          }}
        />,
      );
    });
    assert.equal(container.querySelectorAll('[aria-label="Agent Questions"]').length, 1);
    assert.equal(container.querySelectorAll(".tl-question").length, 1,
      "the earlier duplicate remains a historical card");
    assert.equal(container.querySelector('[role="listitem"]:last-child [aria-label="Agent Questions"]') != null, true,
      "the latest duplicate owns the live form");
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
  container.querySelector<HTMLElement>("[role=\"radio\"]")!.focus();

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
  container.querySelector<HTMLElement>("[role=\"radio\"]")!.focus();

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

test("going offline preserves focus on an approval control that remains enabled", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(<OfflineApprovalHarness requestId="ask-a" withContext runnerOnline />);
  });
  const details = container.querySelector<HTMLButtonElement>("button[aria-expanded]");
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
