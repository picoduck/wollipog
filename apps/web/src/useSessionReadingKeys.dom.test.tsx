import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  SESSION_READING_LINE_PX,
  SESSION_READING_PAGE_FRACTION,
  useSessionReadingKeys,
  type SessionReadingKeyActions,
} from "./useSessionReadingKeys.js";
import { focusComposerAtEnd } from "./composer-focus.js";
import { VIRTUAL_VIEWPORT_INTENT_EVENT } from "./viewport-intent.js";

const domWindow = new Window({ url: "http://localhost/sessions/~reading" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

type ScrollCall = { kind: "by" | "to"; top: number };

function Harness({
  actions,
  sessionId,
  composerAvailable = true,
  onTranscriptKeyDown,
}: {
  actions: SessionReadingKeyActions;
  sessionId: string;
  composerAvailable?: boolean;
  onTranscriptKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useSessionReadingKeys({ enabled: true, sessionId, scrollRef, composerAvailable, actions });
  return (
    <div>
      <div data-focus-zone="detail">
        <div className="detail-scroll" ref={scrollRef} tabIndex={0} onKeyDown={onTranscriptKeyDown}>
          Transcript
          <button type="button">Transcript Control</button>
        </div>
        <textarea aria-label="Composer" />
        <button type="button">Approval Action</button>
      </div>
      <div className="xterm"><textarea aria-label="Terminal" /></div>
      <nav data-focus-zone="rail"><button type="button">Inbox</button></nav>
    </div>
  );
}

function dispatchKey(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new domWindow.KeyboardEvent(
    "keydown",
    { key, bubbles: true, cancelable: true, ...init } as never,
  );
  domWindow.document.activeElement?.dispatchEvent(event);
  return event as unknown as KeyboardEvent;
}

function setupActions() {
  const calls: Array<keyof SessionReadingKeyActions> = [];
  const action = (name: keyof SessionReadingKeyActions) => () => calls.push(name);
  const actions: SessionReadingKeyActions = {
    nextSession: action("nextSession"),
    previousSession: action("previousSession"),
    approve: action("approve"),
    deny: action("deny"),
    archive: action("archive"),
    snooze: action("snooze"),
    reply: action("reply"),
    pauseFollow: action("pauseFollow"),
    resumeFollow: action("resumeFollow"),
  };
  return {
    calls,
    actions,
  };
}

async function renderHarness(onTranscriptKeyDown?: React.KeyboardEventHandler<HTMLDivElement>) {
  const { calls, actions } = setupActions();
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => { root.render(<Harness actions={actions} sessionId="one" onTranscriptKeyDown={onTranscriptKeyDown} />); });
  const scroll = container.querySelector<HTMLElement>(".detail-scroll")!;
  const scrollCalls: ScrollCall[] = [];
  Object.defineProperties(scroll, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: 1_000 },
    scrollBy: {
      configurable: true,
      value: ({ top }: ScrollToOptions) => scrollCalls.push({ kind: "by", top: top ?? 0 }),
    },
    scrollTo: {
      configurable: true,
      value: ({ top }: ScrollToOptions) => scrollCalls.push({ kind: "to", top: top ?? 0 }),
    },
  });
  scroll.focus();
  return { root, container, scroll, scrollCalls, calls, actions };
}

test("Session Reading scroll keys use fixed line, page, start, and latest semantics", async () => {
  const fixture = await renderHarness();
  const scrollCountAtIntent: number[] = [];
  fixture.scroll.addEventListener(VIRTUAL_VIEWPORT_INTENT_EVENT, () => {
    scrollCountAtIntent.push(fixture.scrollCalls.length);
  });

  dispatchKey("j");
  dispatchKey("k");
  dispatchKey(" ");
  dispatchKey(" ", { shiftKey: true });
  dispatchKey("g");
  assert.equal(fixture.scrollCalls.length, 4, "a stray g has no visible effect");
  dispatchKey("g");
  dispatchKey("G", { shiftKey: true });
  dispatchKey("End");

  assert.deepEqual(fixture.scrollCalls, [
    { kind: "by", top: SESSION_READING_LINE_PX },
    { kind: "by", top: -SESSION_READING_LINE_PX },
    { kind: "by", top: 200 * SESSION_READING_PAGE_FRACTION },
    { kind: "by", top: -200 * SESSION_READING_PAGE_FRACTION },
    { kind: "to", top: 0 },
    { kind: "to", top: 1_000 },
    { kind: "to", top: 1_000 },
  ]);
  assert.deepEqual(scrollCountAtIntent, [0, 1, 2, 3, 4, 5, 6],
    "every Session Reading scroll publishes viewport ownership first");
  assert.deepEqual(fixture.calls, ["pauseFollow", "pauseFollow", "pauseFollow", "resumeFollow", "resumeFollow"]);

  await act(async () => { fixture.root.unmount(); });
  fixture.container.remove();
});

test("expanded latest keys are owned once at capture before the transcript bridge", async () => {
  let bubbleCalls = 0;
  const fixture = await renderHarness((event) => {
    if (event.defaultPrevented) return;
    if (event.key !== "End" && !(event.key === "G" && event.shiftKey)) return;
    bubbleCalls += 1;
    event.preventDefault();
  });

  dispatchKey("End");
  dispatchKey("G", { shiftKey: true });

  assert.deepEqual(fixture.calls, ["resumeFollow", "resumeFollow"], "each capture action runs exactly once");
  assert.equal(bubbleCalls, 0, "the transcript bridge observes defaultPrevented and does not handle again");
  await act(async () => { fixture.root.unmount(); });
  fixture.container.remove();
});

test("Session Reading dispatches contextual triage and session hopping bindings", async () => {
  const fixture = await renderHarness();

  dispatchKey("j", { ctrlKey: true });
  const previous = dispatchKey("k", { ctrlKey: true });
  dispatchKey("a");
  dispatchKey("d");
  dispatchKey("e");
  dispatchKey("r");

  assert.equal(previous.defaultPrevented, true, "contextual Ctrl+K shadows global search");
  assert.deepEqual(fixture.calls, ["nextSession", "previousSession", "approve", "deny", "archive", "reply"]);

  await act(async () => { fixture.root.unmount(); });
  fixture.container.remove();
});

test("R returns an existing composer draft with the caret at the end", async () => {
  const fixture = await renderHarness();
  const composer = fixture.container.querySelector<HTMLTextAreaElement>('[aria-label="Composer"]')!;
  composer.value = "first line\npartial reply";
  Object.defineProperty(composer, "scrollHeight", { configurable: true, value: 320 });
  composer.focus();
  composer.setSelectionRange(0, 0);
  fixture.scroll.focus(); // The Escape ladder leaves the composer for the reader.
  fixture.actions.reply = () => {
    focusComposerAtEnd(composer);
  };

  dispatchKey("r");
  assert.equal(domWindow.document.activeElement, composer);
  assert.equal(composer.selectionStart, composer.value.length);
  assert.equal(composer.selectionEnd, composer.value.length);
  assert.equal(composer.scrollTop, composer.scrollHeight);

  composer.setRangeText(" continued", composer.selectionStart, composer.selectionEnd, "end");
  assert.equal(composer.value, "first line\npartial reply continued");

  await act(async () => { fixture.root.unmount(); });
  fixture.container.remove();
});

test("Tab remains native across the reader, transcript controls, and composer", async () => {
  const fixture = await renderHarness();
  const composer = fixture.container.querySelector<HTMLTextAreaElement>('[aria-label="Composer"]')!;
  composer.className = "composer-input";

  const toComposer = dispatchKey("Tab");
  assert.equal(toComposer.defaultPrevented, false);
  assert.deepEqual(fixture.calls, []);

  fixture.container.querySelector<HTMLButtonElement>(".detail-scroll button")!.focus();
  const nestedTab = dispatchKey("Tab");
  assert.equal(nestedTab.defaultPrevented, false, "an explicitly focused transcript control keeps native Tab behavior");
  assert.deepEqual(fixture.calls, []);

  composer.focus();
  const toReader = dispatchKey("Tab", { shiftKey: true });
  assert.equal(toReader.defaultPrevented, false);
  assert.equal(domWindow.document.activeElement, composer);

  await act(async () => { fixture.root.unmount(); });
  fixture.container.remove();
});

test("Tab remains native when the session composer is unavailable", async () => {
  const { calls, actions } = setupActions();
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Harness actions={actions} sessionId="offline" composerAvailable={false} />);
  });
  const scroll = container.querySelector<HTMLElement>(".detail-scroll")!;
  scroll.focus();

  const tab = dispatchKey("Tab");
  assert.equal(tab.defaultPrevented, false);
  assert.deepEqual(calls, []);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("typing, native controls, layers, focus zones, and xterm keep their key ownership", async () => {
  const fixture = await renderHarness();
  const composer = fixture.container.querySelector<HTMLTextAreaElement>('[aria-label="Composer"]')!;
  composer.focus();
  dispatchKey("a");
  dispatchKey("j", { ctrlKey: true });
  assert.deepEqual(fixture.calls, ["nextSession"], "typing blocks bare keys but preserves modifier navigation");

  fixture.container.querySelector<HTMLButtonElement>("[data-focus-zone=detail] button")!.focus();
  for (const key of ["a", "j", " "]) dispatchKey(key);
  fixture.container.querySelector<HTMLTextAreaElement>('[aria-label="Terminal"]')!.focus();
  dispatchKey("j", { ctrlKey: true });
  fixture.container.querySelector<HTMLButtonElement>("[data-focus-zone=rail] button")!.focus();
  dispatchKey("e");

  fixture.scroll.focus();
  const modal = domWindow.document.createElement("div");
  modal.setAttribute("aria-modal", "true");
  domWindow.document.body.append(modal);
  dispatchKey("d");
  modal.remove();
  assert.deepEqual(fixture.calls, ["nextSession"]);

  await act(async () => { fixture.root.unmount(); });
  fixture.container.remove();
});

test("composition, repeat, mismatch, and session changes reset the gg sequence", async () => {
  const fixture = await renderHarness();

  dispatchKey("g");
  dispatchKey("g", { isComposing: true });
  dispatchKey("g");
  assert.equal(fixture.scrollCalls.length, 0);
  dispatchKey("g");
  assert.deepEqual(fixture.scrollCalls, [{ kind: "to", top: 0 }]);

  fixture.scrollCalls.length = 0;
  dispatchKey("g");
  dispatchKey("g", { repeat: true });
  dispatchKey("g");
  assert.equal(fixture.scrollCalls.length, 0);
  dispatchKey("g");
  assert.deepEqual(fixture.scrollCalls, [{ kind: "to", top: 0 }]);

  fixture.scrollCalls.length = 0;
  dispatchKey("g");
  dispatchKey("j");
  assert.deepEqual(fixture.scrollCalls, [{ kind: "by", top: SESSION_READING_LINE_PX }]);

  fixture.scrollCalls.length = 0;
  dispatchKey("g");
  await act(async () => {
    fixture.root.render(<Harness actions={fixture.actions} sessionId="two" />);
  });
  const nextScroll = fixture.container.querySelector<HTMLElement>(".detail-scroll")!;
  Object.defineProperty(nextScroll, "scrollTo", {
    configurable: true,
    value: ({ top }: ScrollToOptions) => fixture.scrollCalls.push({ kind: "to", top: top ?? 0 }),
  });
  nextScroll.focus();
  dispatchKey("g");
  assert.equal(fixture.scrollCalls.length, 0, "the first g after a session change starts a fresh sequence");

  await act(async () => { fixture.root.unmount(); });
  fixture.container.remove();
});
