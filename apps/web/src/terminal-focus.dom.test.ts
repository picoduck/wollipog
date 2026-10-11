import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { Window } from "happy-dom";
import {
  installTerminalExitBoundary,
  loadTerminalHost,
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

/** A host's code, loaded on demand, that arrives when the test releases it. */
function slowHost() {
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => { release = resolve; });
  return { load: loadTerminalHost(() => arrived.then(() => "host")), release };
}

test("a move's focus request lasts a second from when the destination's code arrives (#2869)", async () => {
  mock.timers.enable({ apis: ["Date"], now: 10_000 });
  try {
    // The move asks for focus, then its destination's code takes 1.5s to arrive.
    requestTerminalFocus("session-a");
    const host = slowHost();
    const loading = host.load();
    mock.timers.tick(1_500);
    host.release();
    await loading;
    mock.timers.tick(500);
    assert.equal(takeTerminalFocusRequest("session-a"), true, "the request outlives the load");

    // Without a load in between, a request still expires after its second.
    requestTerminalFocus("session-a");
    mock.timers.tick(1_500);
    assert.equal(takeTerminalFocusRequest("session-a"), false);
  } finally {
    mock.timers.reset();
  }
});

test("code that starts loading long after a request leaves that request to expire (#2869)", async () => {
  mock.timers.enable({ apis: ["Date"], now: 50_000 });
  try {
    requestTerminalFocus("session-a");
    mock.timers.tick(5_000);
    const host = slowHost();
    const loading = host.load();
    host.release();
    await loading;
    assert.equal(takeTerminalFocusRequest("session-a"), false, "an earlier move's request is not revived");
  } finally {
    mock.timers.reset();
  }
});
