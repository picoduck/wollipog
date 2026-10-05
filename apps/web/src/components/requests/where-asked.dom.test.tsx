import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { AgentQuestion, PendingApproval, SessionView } from "@wollipog/protocol";
import { api } from "../../api.js";
import { ApiProvider } from "../../api-context.js";
import { installDomTestCleanup } from "../../dom-test-cleanup.js";
import type { TimelineItem } from "../../timeline.js";
import { QUESTION_CARD_COPY } from "./QuestionStep.js";
import { RequestDock, type DockWhereAsked } from "./RequestDock.js";
import { revealDockedRequest } from "./request-reveal.js";
import { useQuestionWhereAsked } from "./where-asked.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  FocusEvent: domWindow.FocusEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const questions: AgentQuestion[] = [{
  id: "target",
  header: "Target",
  question: "Which environment should I deploy to?",
  options: [{ label: "Staging" }, { label: "Production" }],
}];
const questionItem: TimelineItem = { kind: "question", id: 40, requestId: "ask-1", questions };
const earlier: TimelineItem[] = [{ kind: "user_message", id: 41, text: "Later message" }];

type History = { hasOlder: boolean; loadingOlder: boolean; complete: boolean };
type Hook = ReturnType<typeof useQuestionWhereAsked>;

function HookFixture({ items, history, loadOlder, pending = ["ask-1"], following = false, onReveal, expose }: {
  items: readonly TimelineItem[];
  history: History;
  loadOlder: () => boolean;
  pending?: readonly string[];
  following?: boolean;
  onReveal: (eventId: number) => void;
  expose: (hook: Hook) => void;
}) {
  const readerRef = useRef<HTMLDivElement>(null);
  expose(useQuestionWhereAsked({
    items, history, loadOlder, pendingRequestIds: pending, reveal: onReveal, readerRef, following, resetKey: "session:0",
  }));
  return <div ref={readerRef} data-testid="reader" tabIndex={0} />;
}

async function mountHook() {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const reveals: number[] = [];
  let loads = 0;
  let loadStarts = true;
  let hook!: Hook;
  const render = (props: { items: readonly TimelineItem[]; history: History; pending?: readonly string[]; following?: boolean }) =>
    act(async () => root.render(
      <HookFixture
        {...props}
        loadOlder={() => {
          loads += 1;
          return loadStarts;
        }}
        onReveal={(eventId) => reveals.push(eventId)}
        expose={(next) => { hook = next; }}
      />,
    ));
  return {
    container,
    render,
    reveals,
    get loads() { return loads; },
    refuseLoads() { loadStarts = false; },
    get hook() { return hook; },
    reader: () => container.querySelector<HTMLElement>("[data-testid=reader]")!,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const loaded: History = { hasOlder: false, loadingOlder: false, complete: true };
const partial: History = { hasOlder: true, loadingOlder: false, complete: true };

test("Show Where Asked reveals a loaded marker and selects it until the reader scrolls", async () => {
  const view = await mountHook();
  try {
    await view.render({ items: [questionItem, ...earlier], history: loaded });
    assert.equal(view.hook.whereAsked.unavailableReason("ask-1"), null);
    await act(async () => view.hook.whereAsked.show("ask-1"));
    assert.deepEqual(view.reveals, [40]);
    assert.equal(view.hook.selectedRequestId, "ask-1");
    assert.equal(view.loads, 0);

    // A key that does not scroll keeps it; the reader's own scroll ends it.
    await act(async () => view.reader().dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "a" }) as unknown as Event));
    assert.equal(view.hook.selectedRequestId, "ask-1");
    await act(async () => view.reader().dispatchEvent(new domWindow.Event("wheel") as unknown as Event));
    assert.equal(view.hook.selectedRequestId, null);

    await act(async () => view.hook.whereAsked.show("ask-1"));
    await act(async () => view.reader().dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "PageDown" }) as unknown as Event));
    assert.equal(view.hook.selectedRequestId, null);

    // Back at the live tail there is nothing to mark.
    await act(async () => view.hook.whereAsked.show("ask-1"));
    await view.render({ items: [questionItem, ...earlier], history: loaded, following: true });
    assert.equal(view.hook.selectedRequestId, null);
  } finally {
    await view.cleanup();
  }
});

test("a marker older than the loaded history is loaded back to, one page at a time, then revealed", async () => {
  const view = await mountHook();
  try {
    await view.render({ items: earlier, history: partial });
    assert.equal(view.hook.whereAsked.unavailableReason("ask-1"), null, "an earlier page may still hold it");
    await act(async () => view.hook.whereAsked.show("ask-1"));
    assert.equal(view.loads, 1);
    assert.equal(view.hook.whereAsked.loadingRequestId, "ask-1");

    // While the page loads nothing else is asked for.
    await view.render({ items: earlier, history: { ...partial, loadingOlder: true } });
    assert.equal(view.loads, 1);
    // A page without it asks for the next.
    await view.render({ items: [{ kind: "agent_message", id: 39, text: "Older" }, ...earlier], history: partial });
    assert.equal(view.loads, 2);
    await view.render({ items: earlier, history: { ...partial, loadingOlder: true } });
    await view.render({ items: [questionItem, ...earlier], history: partial });
    assert.equal(view.loads, 2);
    assert.deepEqual(view.reveals, [40]);
    assert.equal(view.hook.selectedRequestId, "ask-1");
    assert.equal(view.hook.whereAsked.loadingRequestId, null);
  } finally {
    await view.cleanup();
  }
});

test("a marker that can't be found disables Show Where Asked with its reason", async () => {
  const view = await mountHook();
  try {
    // Every page loaded and the marker is not among them.
    await view.render({ items: earlier, history: loaded });
    assert.equal(view.hook.whereAsked.unavailableReason("ask-1"), QUESTION_CARD_COPY.whereAskedNotLoaded);

    // The history runs out while loading back.
    await view.render({ items: earlier, history: { ...partial, complete: false } });
    assert.equal(view.hook.whereAsked.unavailableReason("ask-1"), null);
    await act(async () => view.hook.whereAsked.show("ask-1"));
    await view.render({ items: earlier, history: { hasOlder: false, loadingOlder: false, complete: false } });
    assert.equal(view.hook.whereAsked.loadingRequestId, null);
    assert.equal(view.hook.whereAsked.unavailableReason("ask-1"), QUESTION_CARD_COPY.whereAskedNotLoaded);
    assert.deepEqual(view.reveals, []);

    // An earlier page that can't be loaded.
    await view.render({ items: earlier, history: partial });
    view.refuseLoads();
    await act(async () => view.hook.whereAsked.show("ask-1"));
    assert.equal(view.hook.whereAsked.unavailableReason("ask-1"), QUESTION_CARD_COPY.whereAskedNotLoaded);
    assert.equal(view.hook.whereAsked.loadingRequestId, null);
  } finally {
    await view.cleanup();
  }
});

test("a question answered while its place loads stops the search", async () => {
  const view = await mountHook();
  try {
    await view.render({ items: earlier, history: partial });
    await act(async () => view.hook.whereAsked.show("ask-1"));
    await view.render({ items: earlier, history: { ...partial, loadingOlder: true } });
    await view.render({ items: earlier, history: partial, pending: [] });
    assert.equal(view.hook.whereAsked.loadingRequestId, null);
    assert.equal(view.loads, 1);
    assert.equal(view.hook.whereAsked.unavailableReason("ask-1"), null);
  } finally {
    await view.cleanup();
  }
});

const session = { id: "session-dock", runnerId: "runner-1", title: "Session", status: "input_required" } as SessionView;
const questionRequest: PendingApproval = { requestId: "ask-1", kind: "question", title: "Which environment?", options: [], questions };

async function mountDock(whereAsked: DockWhereAsked, keyboardOpen = false) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(
    <ApiProvider client={api}>
      <RequestDock session={session} requests={[questionRequest]} runnerOnline owner="Claude Code"
        keyboardOpen={keyboardOpen} whereAsked={whereAsked} />
    </ApiProvider>,
  ));
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("the docked question card has Show Where Asked, and says why when it can't be used", async () => {
  const shown: string[] = [];
  const view = await mountDock({ show: (id) => shown.push(id), unavailableReason: () => null, loadingRequestId: null });
  try {
    const card = view.container.querySelector<HTMLElement>(".request-dock .question-card")!;
    assert.ok(card, "the question is on the dock");
    const button = card.querySelector<HTMLButtonElement>(".request-card-head .question-where-asked")!;
    assert.equal(button.getAttribute("aria-label"), "Show Where Asked");
    assert.equal(button.disabled, false);
    await act(async () => button.click());
    assert.deepEqual(shown, ["ask-1"]);
  } finally {
    await view.cleanup();
  }

  const unavailable = await mountDock({ show: () => {}, unavailableReason: () => QUESTION_CARD_COPY.whereAskedNotLoaded, loadingRequestId: null });
  try {
    const button = unavailable.container.querySelector<HTMLButtonElement>(".question-where-asked")!;
    assert.equal(button.disabled, true);
    const reason = unavailable.container.querySelector(`#${button.getAttribute("aria-describedby")}`);
    assert.equal(reason?.textContent, "This question's place in the transcript isn't loaded.");
    assert.equal(reason?.closest(".request-card-reasons") != null, true, "a visible foot-note");
  } finally {
    await unavailable.cleanup();
  }
});

test("the dock brings a question up by focusing its heading, and marks the card while the keyboard is open", async () => {
  const view = await mountDock({ show: () => {}, unavailableReason: () => null, loadingRequestId: null }, true);
  try {
    assert.equal(view.container.querySelector(".question-card")?.hasAttribute("data-keyboard-open"), true);
    await act(async () => { assert.equal(revealDockedRequest(session.id, "ask-1"), true); });
    const heading = domWindow.document.activeElement as unknown as HTMLElement;
    assert.equal(heading.getAttribute("role"), "heading");
    assert.equal(heading.textContent, "Which environment should I deploy to?");
  } finally {
    await view.cleanup();
  }
});
