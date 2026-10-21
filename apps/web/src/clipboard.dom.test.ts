import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Window } from "happy-dom";
import { writeClipboardText } from "./clipboard.js";
import { assertNoDomNode } from "./dom-test-assertions.js";

/**
 * A copy reports only while it is current (#3582): a write that settles after `current()` turns
 * false resolves `null`, whether the Clipboard API accepted it or refused it, so every caller that
 * returns early on `null` shows no toast and moves no focus.
 */

const domWindow = new Window({ url: "http://localhost/" });
const globals = { window: domWindow, document: domWindow.document, navigator: domWindow.navigator };
const prior = Object.fromEntries(Object.keys(globals).map((name) => [name, (globalThis as Record<string, unknown>)[name]]));

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

after(async () => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  await domWindow.happyDOM.abort();
});

/** A Clipboard API whose single write stays pending until the test settles it. */
function deferredClipboard() {
  const original = Object.getOwnPropertyDescriptor(domWindow.navigator, "clipboard");
  let settle: { resolve: () => void; reject: (cause: Error) => void } | undefined;
  const written: string[] = [];
  Object.defineProperty(domWindow.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => new Promise<void>((resolve, reject) => {
        written.push(text);
        settle = { resolve, reject };
      }),
    },
  });
  return {
    written,
    succeed: () => settle!.resolve(),
    refuse: () => settle!.reject(new Error("NotAllowedError")),
    restore: () => {
      if (original) Object.defineProperty(domWindow.navigator, "clipboard", original);
      else delete (domWindow.navigator as unknown as { clipboard?: unknown }).clipboard;
    },
  };
}

/** Counts fallback copies, which select a hidden field and so move focus. */
function stubExecCommand(result: boolean) {
  // happy-dom's Document type has no execCommand; the helper reaches it through the global document.
  const target = domWindow.document as unknown as { execCommand?: (command: string) => boolean };
  const original = target.execCommand;
  const commands: string[] = [];
  target.execCommand = (command: string) => {
    commands.push(command);
    return result;
  };
  return { commands, restore: () => { target.execCommand = original; } };
}

describe("writeClipboardText", () => {
  test("a write that succeeds while the copy is current resolves true", async () => {
    const clipboard = deferredClipboard();
    try {
      const copy = writeClipboardText("abc", () => true);
      clipboard.succeed();
      assert.equal(await copy, true);
      assert.deepEqual(clipboard.written, ["abc"]);
    } finally {
      clipboard.restore();
    }
  });

  test("a write that succeeds after the copy stopped being current resolves null", async () => {
    const clipboard = deferredClipboard();
    try {
      let current = true;
      const copy = writeClipboardText("abc", () => current);
      current = false;
      clipboard.succeed();
      assert.equal(await copy, null);
      assert.deepEqual(clipboard.written, ["abc"], "the write itself still happened");
    } finally {
      clipboard.restore();
    }
  });

  test("a refused write falls back while the copy is current and reports the fallback's result", async () => {
    const clipboard = deferredClipboard();
    const exec = stubExecCommand(true);
    try {
      const copy = writeClipboardText("abc", () => true);
      clipboard.refuse();
      assert.equal(await copy, true);
      assert.deepEqual(exec.commands, ["copy"]);
      assertNoDomNode(domWindow.document.querySelector("textarea"), "the hidden field is removed");
    } finally {
      exec.restore();
      clipboard.restore();
    }
  });

  test("a refused write after the copy stopped being current resolves null without the fallback", async () => {
    const clipboard = deferredClipboard();
    const exec = stubExecCommand(true);
    try {
      let current = true;
      const copy = writeClipboardText("abc", () => current);
      current = false;
      clipboard.refuse();
      assert.equal(await copy, null);
      assert.deepEqual(exec.commands, [], "no fallback selection takes focus");
    } finally {
      exec.restore();
      clipboard.restore();
    }
  });
});
