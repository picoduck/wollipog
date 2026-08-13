import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { ShortcutHint } from "./ShortcutHint.js";

const domWindow = new Window({ url: "http://localhost/session" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

test("static and interactive reader hints share one boxed ShortcutHint structure", async () => {
  const clicks: string[] = [];
  const pointerDowns: string[] = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<>
      <ShortcutHint label="Page Up" shortcut="Shift+Space" />
      <ShortcutHint
        label="Reply"
        shortcut="R"
        ariaLabel="Reply"
        onClick={() => clicks.push("reply")}
      />
      <ShortcutHint
        label="Hold"
        shortcut="H"
        ariaLabel="Hold Position"
        onMouseDown={() => pointerDowns.push("hold")}
      />
    </>));
    const hints = [...container.querySelectorAll<HTMLElement>(".shortcut-hint")];
    assert.equal(hints.length, 3);
    assert.deepEqual(hints.map((hint) => hint.dataset.shortcutHint), ["Shift+Space", "R", "H"]);
    assert.equal(hints[0]!.querySelector("kbd")?.getAttribute("aria-hidden"), null,
      "informational keycaps remain in their accessible description");
    const reply = container.querySelector<HTMLButtonElement>('button[data-shortcut-hint="R"]');
    assert.ok(reply);
    assert.equal(reply.getAttribute("aria-label"), "Reply");
    assert.equal(reply.querySelector("kbd")?.getAttribute("aria-hidden"), "true",
      "the button name is not duplicated by its supplemental keycap");
    reply.click();
    assert.deepEqual(clicks, ["reply"]);
    const hold = container.querySelector<HTMLButtonElement>('button[data-shortcut-hint="H"]');
    assert.ok(hold);
    assert.equal(hold.getAttribute("aria-label"), "Hold Position");
    hold.dispatchEvent(new domWindow.MouseEvent("mousedown", { bubbles: true }) as never);
    assert.deepEqual(pointerDowns, ["hold"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
