import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { installTerminalExitBoundary } from "./terminal-focus.js";

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
