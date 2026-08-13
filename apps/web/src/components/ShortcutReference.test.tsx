import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShortcutReference } from "./ShortcutReference.js";

Object.defineProperty(globalThis, "React", { configurable: true, writable: true, value: React });

test("shortcut reference exposes the Inbox group and terminal exit binding", () => {
  const html = renderToStaticMarkup(
    <ShortcutReference
      onClose={() => undefined}
      sessionOpen
      terminalSupported
      filesSupported
      conversationSteeringSupported
      turnInterruptionSupported
    />,
  );
  assert.match(html, /id="shortcut-inbox"/);
  assert.match(html, />Next Session</);
  assert.match(html, />Previous Split</);
  assert.match(html, />Mark Unread</);
  assert.match(html, />Shift\+Space</);
  assert.match(html, />Exit Terminal Focus</);
  assert.match(html, />Ctrl\+Esc</);
  assert.match(html, />Stop Turn</);
  assert.match(html, />Shift\+Esc</);
  assert.match(html, />Steer Active Turn</);
  assert.match(html, />Ctrl\+Enter</);
});

test("shortcut reference marks steering unavailable for an older runner", () => {
  const html = renderToStaticMarkup(
    <ShortcutReference
      onClose={() => undefined}
      sessionOpen
      terminalSupported
      filesSupported
      conversationSteeringSupported={false}
      turnInterruptionSupported
    />,
  );
  assert.match(html, /Steer Active Turn/);
  assert.match(html, /Unavailable until this runner supports conversation steering/);
});
