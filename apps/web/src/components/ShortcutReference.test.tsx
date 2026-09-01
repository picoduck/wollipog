import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShortcutReference } from "./ShortcutReference.js";
import { resetRailPreferencesForTest, setRailViewHidden } from "../rail-preferences.js";

Object.defineProperty(globalThis, "React", { configurable: true, writable: true, value: React });

test("shortcut reference exposes the Sessions List group and terminal exit binding", () => {
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
  assert.match(html, /id="shortcut-sessions-list"/);
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

test("navigation digits derive from the visible rail order and hidden destinations say so", () => {
  resetRailPreferencesForTest();
  try {
    setRailViewHidden("automations", true);
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
    assert.match(html, /<dt>Automations<\/dt><dd>Hidden in Settings → Appearance/,
      "a hidden destination explains itself instead of advertising a digit");
    assert.match(html, /<dt>Automations<\/dt>[^]*?<kbd>—<\/kbd>/,
      "and shows no keycap");
    assert.match(html, /<dt>Multi-Agent<\/dt>[^]*?<kbd>2<\/kbd>/,
      "the survivor inherits the freed digit");
  } finally {
    resetRailPreferencesForTest();
  }
});
