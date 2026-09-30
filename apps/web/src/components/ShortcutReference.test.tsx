import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShortcutReference, shortcutReferenceColumns } from "./ShortcutReference.js";
import { resetRailPreferencesForTest, setRailViewHidden } from "../rail-preferences.js";
import { GLOBAL_VIEW_ITEMS } from "../navigation.js";
import { SHORTCUTS, shortcutBindingDisplay, shortcutReferenceGroups, type ShortcutScope } from "../shortcuts.js";

Object.defineProperty(globalThis, "React", { configurable: true, writable: true, value: React });

function render({
  scope = "Global",
  sessionOpen = true,
  conversationSteeringSupported = true,
}: { scope?: ShortcutScope; sessionOpen?: boolean; conversationSteeringSupported?: boolean } = {}) {
  return renderToStaticMarkup(
    <ShortcutReference
      onClose={() => undefined}
      scope={scope}
      sessionOpen={sessionOpen}
      terminalSupported
      filesSupported
      conversationSteeringSupported={conversationSteeringSupported}
      turnInterruptionSupported
    />,
  );
}

/** The group headings in document order, and whether each is marked Current Page. */
function headings(html: string): string[] {
  return [...html.matchAll(/<h3 id="shortcut-[^"]+">([^<]+)(<span class="shortcut-current">Current Page<\/span>)?<\/h3>/g)]
    .map((match) => `${match[1]}${match[2] ? " (Current Page)" : ""}`);
}

test("the reference is a large dialog of one-line rows: a label and a keycap, no scope tag or description", () => {
  const html = render();
  assert.match(html, /class="modal lg"/);
  assert.match(html, /<p id="[^"]+" class="modal-desc">Shortcuts pause while a terminal has focus\.<\/p>/);
  assert.match(html, /<input[^>]*type="search"[^>]*aria-label="Filter Shortcuts"/);
  assert.doesNotMatch(html, /shortcut-intro|shortcut-scope|shortcut-footnote/);
  for (const scope of ["Global", "Sessions List", "Session Reading"]) {
    assert.doesNotMatch(html, new RegExp(`>${scope}</span>`), `no ${scope} scope tag`);
  }
  assert.doesNotMatch(html, /Open a session to use this binding|Search sessions, transcripts, and views/);
  // Every row is a label and a keycap, with nothing between them unless the row is unavailable.
  const rows = [...html.matchAll(/<div class="shortcut-row">(.*?)<\/div>/g)].map((match) => match[1]!);
  assert.ok(rows.length > 40);
  for (const row of rows) assert.match(row, /^<dt>[^<]+<\/dt><dd class="shortcut-keys"><kbd>[^<]+<\/kbd><\/dd>$/);
  assert.match(html, /<dt>Exit Terminal Focus<\/dt><dd class="shortcut-keys"><kbd>Ctrl\+Esc<\/kbd>/);
  assert.match(html, /<dt>Page Up<\/dt><dd class="shortcut-keys"><kbd>Shift\+Space<\/kbd>/);
  // A close-only dialog has one secondary Done button and the rail-order note beside it.
  assert.match(html, /<div class="modal-foot"><p class="shortcut-reference-note">Digits follow your rail order\. Change it in Settings, Appearance\.<\/p><button type="button" class="btn">Done<\/button><\/div>/);
});

test("the current page's group comes first and is marked Current Page", () => {
  assert.deepEqual(headings(render({ scope: "Global", sessionOpen: false })).sort(),
    ["Actions", "Help", "Navigation", "Session", "Session Reading", "Sessions List"]);
  assert.equal(headings(render({ scope: "Session Reading" }))[0], "Session Reading (Current Page)");
  assert.equal(headings(render({ scope: "Session" }))[0], "Session (Current Page)");
  assert.equal(headings(render({ scope: "Sessions List", sessionOpen: false }))[0], "Sessions List (Current Page)");
  assert.equal(render({ scope: "Session" }).match(/Current Page/g)?.length, 1);
});

test("without a session each Session group says so once and dims its rows", () => {
  const html = render({ sessionOpen: false });
  assert.equal(html.match(/Open a session to use these\./g)?.length, 2);
  for (const id of ["shortcut-session", "shortcut-session-reading"]) {
    assert.match(html, new RegExp(`<section class="shortcut-group" aria-labelledby="${id}" aria-describedby="${id}-note">`));
    const section = html.slice(html.indexOf(`aria-labelledby="${id}"`));
    const list = section.slice(0, section.indexOf("</dl>"));
    assert.doesNotMatch(list, /<div class="shortcut-row">/, `every ${id} row is dimmed`);
    assert.match(list, /<div class="shortcut-row is-unavailable"><dt>/);
  }
  assert.doesNotMatch(render({ sessionOpen: true }), /Open a session to use these/);
});

test("a row-specific reason stays on its row", () => {
  const html = render({ scope: "Session", conversationSteeringSupported: false });
  assert.match(html, /<div class="shortcut-row is-unavailable"><dt>Steer Active Turn<\/dt><dd class="shortcut-reason" title="Not supported by this runner">Not supported by this runner<\/dd><dd class="shortcut-keys"><kbd>Ctrl\+Enter<\/kbd>/);
});

test("navigation digits derive from the visible rail order and hidden destinations say so", () => {
  resetRailPreferencesForTest();
  try {
    setRailViewHidden("automations", true);
    const html = render();
    assert.match(html, /<dt>Automations<\/dt><dd class="shortcut-reason" title="Hidden in Settings → Appearance">Hidden in Settings → Appearance<\/dd><dd class="shortcut-keys"><kbd>—<\/kbd>/,
      "a hidden destination explains itself instead of advertising a digit");
    assert.match(html, /<dt>Projects<\/dt><dd class="shortcut-keys"><kbd>2<\/kbd>/, "the survivor inherits the freed digit");
    // The Navigation group labels each destination with its one name, in the rail's order.
    const navigation = html.slice(html.indexOf('id="shortcut-navigation"'), html.indexOf("Toggle List / Board"));
    assert.deepEqual([...navigation.matchAll(/<dt>([^<]+)<\/dt>/g)].map((match) => match[1]).slice(1),
      GLOBAL_VIEW_ITEMS.map((item) => item.name));
  } finally {
    resetRailPreferencesForTest();
  }
});

test("the columns start with the first two groups and hold every group once", () => {
  const keys = (definition: (typeof SHORTCUTS)[number]) => shortcutBindingDisplay(definition.binding, false);
  for (const scope of ["Global", "Sessions List", "Session Reading", "Session"] as const) {
    const sessionOpen = scope === "Session Reading" || scope === "Session";
    const groups = shortcutReferenceGroups({ scope, availability: { sessionOpen, terminalSupported: true, filesSupported: true }, keys });
    const [left, right] = shortcutReferenceColumns(groups);
    assert.equal(left[0], groups[0], scope);
    assert.equal(right[0], groups[1], scope);
    assert.deepEqual([...left, ...right].map((group) => group.group).sort(), groups.map((group) => group.group).sort());
    const rows = (column: typeof left) => column.reduce((sum, group) => sum + group.rows.length, 0);
    // Balanced to within the largest group, so the reference stays under two screens.
    assert.ok(Math.abs(rows(left) - rows(right)) <= Math.max(...groups.map((group) => group.rows.length)), scope);
  }
});
