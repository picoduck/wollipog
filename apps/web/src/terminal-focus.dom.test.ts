import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import {
  cancelTerminalFocusRequest,
  installTerminalExitBoundary,
  requestTerminalFocus,
  takeTerminalFocusRequest,
} from "./terminal-focus.js";

test("Ctrl+Escape exits before xterm capture while plain Escape remains terminal-owned", () => {
  const domWindow = new Window();
  const document = domWindow.document as unknown as Document;
  const terminal = domWindow.document.createElement("div");
  terminal.className = "xterm";
  const textarea = domWindow.document.createElement("textarea");
  terminal.append(textarea);
  const main = domWindow.document.createElement("div");
  main.className = "main-body";
  const reading = domWindow.document.createElement("div");
  reading.className = "detail-scroll";
  reading.tabIndex = 0;
  main.append(reading);
  domWindow.document.body.append(terminal, main);
  textarea.focus();

  let terminalKeys = 0;
  textarea.addEventListener("keydown", (event) => {
    terminalKeys += 1;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  const cleanup = installTerminalExitBoundary(domWindow as unknown as Window, document);

  textarea.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(terminalKeys, 1);
  assert.equal(domWindow.document.activeElement, textarea);

  textarea.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", ctrlKey: true, bubbles: true }));
  assert.equal(terminalKeys, 1, "the window capture boundary runs before xterm's capture handler");
  assert.equal(domWindow.document.activeElement, reading);
  cleanup();
});

test("Ctrl+Escape lands on an expanded side panel's switcher, since the panel hides the transcript (#2845)", () => {
  const domWindow = new Window();
  const document = domWindow.document as unknown as Document;
  const terminal = domWindow.document.createElement("div");
  terminal.className = "xterm";
  const textarea = domWindow.document.createElement("textarea");
  terminal.append(textarea);
  const main = domWindow.document.createElement("div");
  main.className = "main-body";
  const reading = domWindow.document.createElement("div");
  reading.className = "detail-scroll";
  reading.tabIndex = 0;
  const panel = domWindow.document.createElement("aside");
  panel.id = "right-panel";
  panel.dataset.presentation = "expanded";
  const switcher = domWindow.document.createElement("button");
  switcher.className = "rpanel-switcher";
  panel.append(switcher);
  main.append(reading, panel);
  domWindow.document.body.append(terminal, main);
  textarea.focus();
  const cleanup = installTerminalExitBoundary(domWindow as unknown as Window, document);

  textarea.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", ctrlKey: true, bubbles: true }));
  assert.ok(domWindow.document.activeElement === switcher, "focus lands on the switcher");

  // Docked again, the transcript takes it as before.
  panel.dataset.presentation = "docked";
  textarea.focus();
  textarea.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", ctrlKey: true, bubbles: true }));
  assert.ok(domWindow.document.activeElement === reading, "focus lands on the transcript");
  cleanup();
});

/** What a host of `place` mounting for the session does with a move's request: whether it moves focus. */
const focuses = (sessionId: string, place: "dock" | "panel") => takeTerminalFocusRequest(sessionId, place)?.() ?? false;

test("a move's focus request waits for its destination's host however long it takes to mount (#2869)", async () => {
  requestTerminalFocus("session-a", "panel");
  // The destination's code, or the session view around it, is slow to arrive.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(focuses("session-b", "panel"), false, "another session's host does not take it");
  assert.equal(focuses("session-a", "panel"), true, "the destination's host takes it");
  assert.equal(focuses("session-a", "panel"), false, "once");
});

test("the other place's host mounting instead ends the move without focus (#2869)", () => {
  requestTerminalFocus("session-a", "panel");
  assert.equal(focuses("session-a", "dock"), false, "the dock is not the move's destination");
  assert.equal(focuses("session-a", "panel"), false, "and the move is over");
});

test("a move abandoned before its destination mounts, or a session left, drops the request (#2869)", () => {
  // The panel closed (or the dock hid) before the terminal mounted there.
  requestTerminalFocus("session-a", "panel");
  cancelTerminalFocusRequest("session-a", "dock");
  assert.equal(focuses("session-a", "panel"), true, "closing the other place leaves it");
  requestTerminalFocus("session-a", "panel");
  cancelTerminalFocusRequest("session-a", "panel");
  assert.equal(focuses("session-a", "panel"), false, "closing its destination drops it");

  // Leaving the session drops it, whatever its destination; leaving another session does not.
  requestTerminalFocus("session-a", "dock");
  cancelTerminalFocusRequest("session-b");
  cancelTerminalFocusRequest("session-a");
  assert.equal(focuses("session-a", "dock"), false);
});

test("typing or clicking before the destination mounts takes focus back from the move (#2869)", async () => {
  const domWindow = new Window();
  const prior = (globalThis as Record<string, unknown>).window;
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: domWindow });
  const nextTask = () => new Promise((resolve) => domWindow.setTimeout(resolve, 0));
  try {
    // The key that chose the move is still being dispatched when the request is made: it does not count.
    requestTerminalFocus("session-a", "panel");
    domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Enter" }));
    await nextTask();
    assert.equal(focuses("session-a", "panel"), true, "the choosing key leaves the request");

    requestTerminalFocus("session-a", "panel");
    await nextTask();
    domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "d" }));
    assert.equal(focuses("session-a", "panel"), false, "a later key ends it");

    requestTerminalFocus("session-a", "panel");
    await nextTask();
    domWindow.dispatchEvent(new domWindow.PointerEvent("pointerdown"));
    assert.equal(focuses("session-a", "panel"), false, "a later click ends it");

    // A request that ended stops watching, so input never ends the next one early.
    requestTerminalFocus("session-a", "panel");
    await nextTask();
    assert.equal(focuses("session-a", "panel"), true);
    requestTerminalFocus("session-a", "dock");
    domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "d" }));
    assert.equal(focuses("session-a", "dock"), true, "the taken request's watch is gone");
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: prior });
    domWindow.close();
  }
});

test("typing or clicking between the destination mounting and its focus frame keeps focus where it is (#2869)", async () => {
  const domWindow = new Window();
  const prior = (globalThis as Record<string, unknown>).window;
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: domWindow });
  const nextTask = () => new Promise((resolve) => domWindow.setTimeout(resolve, 0));
  try {
    requestTerminalFocus("session-a", "panel");
    await nextTask();
    // The destination mounted and its focus waits for the next frame; the person types first.
    const claim = takeTerminalFocusRequest("session-a", "panel");
    assert.ok(claim, "the destination's host claims the request");
    domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "d" }));
    assert.equal(claim!(), false, "the frame finds the move ended and leaves focus alone");

    requestTerminalFocus("session-a", "panel");
    await nextTask();
    const untouched = takeTerminalFocusRequest("session-a", "panel");
    assert.equal(untouched!(), true, "with no input in between, focus moves");
    assert.equal(untouched!(), false, "once");
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: prior });
    domWindow.close();
  }
});
