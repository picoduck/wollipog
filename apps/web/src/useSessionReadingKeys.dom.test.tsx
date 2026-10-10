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
import { matchesShortcut } from "./shortcuts.js";
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
      <div className="chat-reading" data-focus-zone="main">
        <div className="detail-scroll" ref={scrollRef} tabIndex={0} onKeyDown={onTranscriptKeyDown}>
          Transcript
          <button type="button">Transcript Control</button>
        </div>
        <textarea aria-label="Composer" role="combobox" aria-expanded={false} />
        <button type="button">Approval Action</button>
        <div role="listbox" aria-label="Worktree" tabIndex={-1} />
        <input role="combobox" aria-label="Filter Worktrees" aria-expanded />
        <div role="separator" aria-label="Resize Shell Panel" tabIndex={0} />
        <input className="shell-input" aria-label="Pipe Shell" />
        <section className="request-card question-card" aria-label="Agent Questions">
          <div role="heading" aria-level={3} tabIndex={-1}>Which target?</div>
        </section>
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
    fork: action("fork"),
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
  const intentDirections: Array<string | undefined> = [];
  fixture.scroll.addEventListener(VIRTUAL_VIEWPORT_INTENT_EVENT, (event) => {
    scrollCountAtIntent.push(fixture.scrollCalls.length);
    intentDirections.push((event as CustomEvent<{ direction?: string }>).detail?.direction);
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
  // The harness reader sits at scrollTop 0, so Session Start claims upward from the head itself.
  assert.deepEqual(intentDirections, ["down", "up", "down", "up", "up", "down", "down"],
    "each claim names the direction of the scroll it precedes, with start at the head still upward");
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

  const next = dispatchKey("ArrowDown", { altKey: true });
  const previous = dispatchKey("ArrowUp", { altKey: true });
  dispatchKey("a");
  dispatchKey("d");
  dispatchKey("e");
  dispatchKey("h");
  const fork = dispatchKey("f");
  dispatchKey("F", { shiftKey: true });
  dispatchKey("r");

  assert.equal(next.defaultPrevented, true);
  assert.equal(previous.defaultPrevented, true);
  assert.equal(fork.defaultPrevented, true);
  assert.deepEqual(fixture.calls, ["nextSession", "previousSession", "approve", "deny", "archive", "snooze", "fork", "reply"],
    "Shift+F is not Fork");

  await act(async () => { fixture.root.unmount(); });
  fixture.container.remove();
});

test("Ctrl+K reaches the global Search listener while Session Reading owns the transcript", async () => {
  const fixture = await renderHarness();
  // The palette's bubble listener in App: it ignores a key someone already handled.
  const searches: Array<{ defaultPrevented: boolean }> = [];
  const onSearch = (event: KeyboardEvent) => {
    if (matchesShortcut(event, "search")) searches.push({ defaultPrevented: event.defaultPrevented });
  };
  domWindow.addEventListener("keydown", onSearch as never);

  dispatchKey("k", { ctrlKey: true });
  fixture.container.querySelector<HTMLTextAreaElement>('[aria-label="Composer"]')!.focus();
  dispatchKey("k", { ctrlKey: true });
  const terminal = fixture.container.querySelector<HTMLTextAreaElement>('[aria-label="Terminal"]')!;
  terminal.focus();
  const inTerminal = dispatchKey("k", { ctrlKey: true });

  assert.deepEqual(searches, [{ defaultPrevented: false }, { defaultPrevented: false }, { defaultPrevented: false }],
    "Session Reading leaves Ctrl+K unhandled from the transcript, the composer and the terminal");
  assert.equal(inTerminal.defaultPrevented, false, "the terminal still receives its own Ctrl+K");
  assert.deepEqual(fixture.calls, []);

  domWindow.removeEventListener("keydown", onSearch as never);
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
  dispatchKey("f");
  dispatchKey("ArrowDown", { altKey: true });
  assert.deepEqual(fixture.calls, ["nextSession"], "typing blocks bare keys but preserves modifier navigation");

  fixture.container.querySelector<HTMLButtonElement>("[data-focus-zone=main] button")!.focus();
  for (const key of ["a", "f", "j", " "]) dispatchKey(key);
  // An open picker, a filter combobox and a resize grip move their own value with Alt+arrows, and
  // the pipe-mode shell input keeps its own ↑/↓ history like any terminal.
  for (const label of ["Worktree", "Filter Worktrees", "Resize Shell Panel", "Pipe Shell"]) {
    fixture.container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.focus();
    const picked = dispatchKey("ArrowDown", { altKey: true });
    assert.equal(picked.defaultPrevented, false, label);
    dispatchKey("a");
  }
  fixture.container.querySelector<HTMLTextAreaElement>('[aria-label="Terminal"]')!.focus();
  dispatchKey("ArrowDown", { altKey: true });
  dispatchKey("f");
  fixture.container.querySelector<HTMLButtonElement>("[data-focus-zone=rail] button")!.focus();
  dispatchKey("e");

  fixture.scroll.focus();
  const modal = domWindow.document.createElement("div");
  modal.setAttribute("aria-modal", "true");
  domWindow.document.body.append(modal);
  dispatchKey("d");
  dispatchKey("f");
  modal.remove();
  // An open menu (More Actions, with the reader still focused) owns its keys too.
  const menu = domWindow.document.createElement("div");
  menu.setAttribute("role", "menu");
  domWindow.document.body.append(menu);
  dispatchKey("f");
  menu.remove();
  assert.deepEqual(fixture.calls, ["nextSession"]);

  await act(async () => { fixture.root.unmount(); });
  fixture.container.remove();
});

test("a question card owns its keys while focus is on its heading, leaving R to Reply (#2196)", async () => {
  const fixture = await renderHarness();
  // The heading is a focusable div, not a native control, so only the card's ownership keeps D on
  // its question rather than the session's top request.
  fixture.container.querySelector<HTMLElement>(".question-card [role=heading]")!.focus();
  for (const key of ["d", "a", "e", "s", "j", "1"]) {
    assert.equal(dispatchKey(key).defaultPrevented, false, key);
  }
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.scrollCalls, []);
  // R is the card's way into Answer Mode in Composer Response, after Back or Next focused the heading.
  assert.equal(dispatchKey("r").defaultPrevented, true);
  assert.deepEqual(fixture.calls, ["reply"]);

  await act(async () => { fixture.root.unmount(); });
  fixture.container.remove();
});

test("an expanded workflow decision owns focus without moving the hidden transcript (#2874)", async () => {
  const fixture = await renderHarness();
  const request = fixture.container.querySelector<HTMLElement>(".question-card")!;
  request.classList.remove("question-card");
  request.setAttribute("data-decision-expanded", "");
  request.querySelector<HTMLElement>("[role=heading]")!.focus();
  for (const key of ["j", "k", "PageDown", "PageUp", "End", "g", "g", "a", "d"]) {
    assert.equal(dispatchKey(key).defaultPrevented, false, key);
  }
  assert.deepEqual(fixture.scrollCalls, []);
  assert.deepEqual(fixture.calls, []);
  // Text clicks can focus the surrounding notice slot or the page body rather than the card.
  const column = fixture.container.querySelector<HTMLElement>(".chat-reading")!;
  column.tabIndex = -1;
  for (const target of [column, domWindow.document.body as unknown as HTMLElement]) {
    target.tabIndex = -1;
    target.focus();
    for (const key of ["j", "k", "PageDown", "PageUp", "End", "g", "g"]) {
      assert.equal(dispatchKey(key).defaultPrevented, false, key);
    }
  }
  assert.deepEqual(fixture.scrollCalls, []);
  assert.deepEqual(fixture.calls, []);
  request.querySelector<HTMLElement>("[role=heading]")!.focus();
  request.removeAttribute("data-decision-expanded");
  assert.equal(dispatchKey("j").defaultPrevented, true);
  assert.deepEqual(fixture.scrollCalls, [{ kind: "by", top: SESSION_READING_LINE_PX }]);
  await act(async () => fixture.root.unmount());
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
