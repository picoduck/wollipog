import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "postcss";
import { NavRow, SegmentedRow, SelectRow, SwitchRow } from "./SettingsRows.js";
import { resetSelectPreviewRegistry } from "./ChoiceControls.js";
import { AppearancePanel } from "../SettingsView.js";
import { ThemeProvider, useTheme } from "../ThemeProvider.js";
import {
  COLOR_SCHEMES,
  DENSITY_OPTIONS,
  SCHEME_STORAGE_KEY,
  THEME_OPTIONS,
  type ColorScheme,
  type Density,
  type ThemePreference,
} from "../../theme.js";

/** WCAG 2.1 relative luminance and contrast ratio, on hex colours. */
function luminance(hex: string): number {
  const parts = hex.replace("#", "").match(/../g)!.map((pair) => Number.parseInt(pair, 16) / 255);
  const [r, g, b] = parts.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const domWindow = new Window();

/**
 * The constructors as well as the document.
 *
 * `window` and `document` alone were enough while every assertion read markup. The keyboard tests
 * below are not that: `handleRovingChoiceKeyDown` guards on `event.target instanceof HTMLElement`,
 * so with the host's HTMLElement still installed globally every arrow key was silently ignored and
 * a roving test would have passed against a control that never moved.
 */
/**
 * Storage as a LEDGER, because "the preview never reaches storage" is a claim about writes.
 *
 * A real store can only be inspected for its final state, and a preview written and then overwritten
 * by the committed value leaves that state correct — the tab is right and every later tab is wrong.
 * Every `setItem` is recorded instead, so the assertion is about what was written rather than about
 * what happened to survive.
 */
const storageWrites: [string, string][] = [];
const storedValues = new Map<string, string>();
const fakeStorage = {
  getItem: (key: string) => storedValues.get(key) ?? null,
  setItem: (key: string, value: string) => { storageWrites.push([key, value]); storedValues.set(key, value); },
  removeItem: (key: string) => { storedValues.delete(key); },
  clear: () => { storedValues.clear(); },
};

const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  localStorage: fakeStorage,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  // The picker schedules its focus move on a frame, so without these the listbox throws on open
  // rather than failing an assertion — a missing global reads as a broken component.
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const prior = Object.fromEntries(
  Object.keys(globals).map((name) => [name, (globalThis as Record<string, unknown>)[name]]),
);

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});
after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

async function render(node: React.ReactNode) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => { root.render(node as React.ReactElement); });
  return {
    container,
    cleanup: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

/**
 * The defect this file exists to prevent, verified in the running desktop app: an OFF switch, an
 * UNSELECTED radio, and a plain navigation row rendered pixel-identically — bold title, dim
 * description, and nothing else. There was no way to tell what kind of control you were looking at,
 * or what state it was in, without activating it.
 */
const THEMES_FIXTURE = [
  { value: "system", label: "System", description: "Follow this device's appearance" },
  { value: "light", label: "Light", description: "Always use the light palette" },
  { value: "dark", label: "Dark", description: "Always use the dark palette" },
];

const SCHEMES_FIXTURE = [
  { value: "wollipog", label: "Wollipog", description: "The logo's teal and orange on slate", swatch: swatchNode() },
  { value: "github", label: "GitHub", description: "Primer's canvas and blue", swatch: swatchNode() },
  { value: "dracula", label: "Dracula", description: "Purple and pink on charcoal", swatch: swatchNode() },
];

function swatchNode() {
  return <span className="ui-swatch" aria-hidden="true"><span className="ui-swatch-dot" /></span>;
}

test("the row kinds are distinguishable in their inert state", async () => {
  const { container, cleanup } = await render(
    <>
      <SegmentedRow title="Theme" options={THEMES_FIXTURE} value="system" onChange={() => undefined} />
      <SelectRow title="Colour Scheme" options={SCHEMES_FIXTURE} value="wollipog" onChange={() => undefined} />
      <SwitchRow title="Desktop Alerts" description="Approvals and finished turns" checked={false} onClick={() => undefined} />
      <NavRow title="Keyboard Shortcuts" description="Reference" onClick={() => undefined} />
    </>,
  );
  try {
    const [segmented, select, sw, nav] = [...container.querySelectorAll(".ui-row")];

    // Each carries an affordance naming its kind, in every state — including the two that used to
    // be a column of rows whose unselected members showed an empty ring and nothing else.
    assert.ok(segmented!.querySelector(".ui-seg"), "a segmented row shows its group of pills");
    assert.equal(segmented!.querySelectorAll('[role="radio"]').length, 3,
      "and every alternative is on screen, which is the point of a segmented row");
    assert.ok(select!.querySelector(".ui-select-trigger"), "a picker row shows a trigger");
    assert.ok(select!.querySelector(".ui-select-caret"), "with a caret saying it opens something");
    assert.ok(sw!.querySelector(".ui-switch"), "an off switch still shows a track");
    assert.ok(nav!.querySelector(".ui-row-chevron"), "a navigation row shows a chevron");

    // And they are not each other.
    assert.equal(segmented!.querySelector(".ui-switch"), null);
    assert.equal(segmented!.querySelector(".ui-select-trigger"), null);
    assert.equal(select!.querySelector(".ui-seg"), null);
    assert.equal(sw!.querySelector(".ui-seg"), null);
    assert.equal(nav!.querySelector(".ui-seg"), null);
    assert.equal(nav!.querySelector(".ui-switch"), null);

    // The roles remain honest. A row that CONTAINS a control is not itself one: giving the row a
    // role would announce a radiogroup wrapping a radiogroup, and make the label a second target.
    assert.equal(segmented!.getAttribute("role"), null);
    assert.equal(segmented!.querySelector(".ui-seg")!.getAttribute("role"), "radiogroup");
    assert.equal(segmented!.querySelector(".ui-seg")!.getAttribute("aria-label"), "Theme");
    assert.equal(select!.querySelector(".ui-select-trigger")!.getAttribute("aria-haspopup"), "listbox");
    assert.equal(select!.querySelector(".ui-select-trigger")!.getAttribute("aria-expanded"), "false");
    assert.equal(sw!.getAttribute("role"), "switch");
    assert.equal(sw!.getAttribute("aria-checked"), "false");
    assert.equal(nav!.getAttribute("role"), null, "a navigation row is a plain button, not a fake control");
    assert.equal(nav!.getAttribute("aria-checked"), null);

    // The old markup signalled state only through a text glyph in a shared gutter.
    assert.equal(container.textContent?.includes("✓"), false, "state must not be conveyed by a glyph");
  } finally {
    await cleanup();
  }
});

test("a settings panel is one row per setting, not one row per option", async () => {
  // The defect this change exists to remove: Theme, Colour Scheme and Density were three groups of
  // full-width rows carrying one option each — ten rows and three headings for three settings.
  const { container, cleanup } = await render(
    <AppearancePanel
      options={THEME_OPTIONS}
      value="system"
      onChange={() => undefined}
      schemes={COLOR_SCHEMES}
      scheme="wollipog"
      onSchemeChange={() => undefined}
      onSchemePreview={() => undefined}
      resolvedTheme="dark"
      densities={DENSITY_OPTIONS}
      density="compact"
      onDensityChange={() => undefined}
    />,
  );
  try {
    const rows = [...container.querySelectorAll(".ui-row")];
    assert.equal(rows.length, 3, "Appearance is three settings, so it is three rows");
    assert.deepEqual(rows.map((row) => row.querySelector(".ui-row-title")?.textContent),
      ["Theme", "Colour Scheme", "Density"]);
    assert.ok(rows.every((row) => row.querySelector(":scope > .ui-row-choice-control")),
      "all three controls occupy the same trailing alignment slot");
    assert.equal(container.querySelectorAll(".settings-group").length, 1,
      "and one group, since a heading per single-row setting restates the row beneath it");

    // The swatches are real colours from the map, hidden from assistive technology because the
    // option's own label already carries the name.
    const dots = [...container.querySelectorAll(".ui-swatch-dot")];
    assert.equal(dots.length, 3, "the closed trigger shows the selected scheme's three colours");
    assert.equal(container.querySelector(".ui-swatch")!.getAttribute("aria-hidden"), "true");
    // Wollipog dark, read from SCHEME_SWATCHES rather than asserted as a literal here — which hex
    // is correct is `colour-schemes.test.ts`'s question, and it asks the stylesheet.
    assert.ok(dots.every((dot) => /background/.test(dot.getAttribute("style") ?? "")),
      "each dot must actually paint a colour");
  } finally {
    await cleanup();
  }
});

test("the scheme list requests readable content dimensions while preserving trigger alignment", async () => {
  const priorWidth = domWindow.innerWidth;
  const priorHeight = domWindow.innerHeight;
  Object.defineProperty(domWindow, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(domWindow, "innerHeight", { configurable: true, value: 720 });
  const { container, cleanup } = await render(
    <AppearancePanel
      options={THEME_OPTIONS}
      value="system"
      onChange={() => undefined}
      schemes={COLOR_SCHEMES}
      scheme="wollipog"
      onSchemeChange={() => undefined}
      onSchemePreview={() => undefined}
      resolvedTheme="dark"
      densities={DENSITY_OPTIONS}
      density="compact"
      onDensityChange={() => undefined}
    />,
  );
  try {
    const trigger = container.querySelector(".ui-select-trigger") as unknown as HTMLButtonElement;
    trigger.getBoundingClientRect = () => ({
      top: 180,
      right: 820,
      bottom: 216,
      left: 600,
      width: 220,
      height: 36,
      x: 600,
      y: 180,
      toJSON: () => ({}),
    });
    await act(async () => { trigger.click(); });
    const list = container.querySelector<HTMLElement>('[role="listbox"][aria-label="Colour Scheme"]');
    assert.ok(list);
    assert.equal(list.querySelectorAll('[role="option"]').length, 5);
    assert.equal(list.style.left, "600px", "the open list keeps the trigger's start edge");
    assert.equal(list.style.width, "400px", "described schemes get a content-aware width");
    assert.equal(list.style.maxHeight, "298px", "five two-line options fit without a 280px cap");
  } finally {
    await cleanup();
    Object.defineProperty(domWindow, "innerWidth", { configurable: true, value: priorWidth });
    Object.defineProperty(domWindow, "innerHeight", { configurable: true, value: priorHeight });
  }
});

test("an explicit menu width never makes the list narrower than its trigger", async () => {
  const { container, cleanup } = await render(
    <SelectRow
      title="Colour Scheme"
      options={SCHEMES_FIXTURE}
      value="wollipog"
      onChange={() => undefined}
      menuWidth={180}
    />,
  );
  try {
    const trigger = container.querySelector(".ui-select-trigger") as unknown as HTMLButtonElement;
    trigger.getBoundingClientRect = () => ({
      top: 180,
      right: 820,
      bottom: 216,
      left: 600,
      width: 220,
      height: 36,
      x: 600,
      y: 180,
      toJSON: () => ({}),
    });
    await act(async () => { trigger.click(); });
    const list = container.querySelector<HTMLElement>('[role="listbox"]');
    assert.ok(list);
    assert.equal(list.style.width, "220px");
  } finally {
    await cleanup();
  }
});

test("checked state is exposed structurally, not just by colour", async () => {
  const { container, cleanup } = await render(
    <>
      <SegmentedRow title="Density" options={THEMES_FIXTURE} value="light" onChange={() => undefined} />
      <SwitchRow title="Push Notifications" checked onClick={() => undefined} />
    </>,
  );
  try {
    const pills = [...container.querySelectorAll('[role="radio"]')];
    assert.deepEqual(pills.map((pill) => pill.getAttribute("aria-checked")), ["false", "true", "false"],
      "exactly one option is checked, and the others say so rather than saying nothing");
    // The CSS keys its fill off the class and the state off the attribute, so both have to be there.
    assert.ok(pills[1]!.className.includes("is-selected"));
    const sw = container.querySelector(".ui-row-switch")!;
    assert.equal(sw.getAttribute("aria-checked"), "true");
    assert.ok(sw.className.includes("ui-row-switch"));
  } finally {
    await cleanup();
  }
});

test("a segmented row is one tab stop, and the arrows move the selection inside it", async () => {
  // The roving contract, exercised rather than read off the markup: the group is a single stop and
  // the arrows both MOVE and SELECT. Ten stacked radios cost ten tabs to pass; this costs one.
  const chosen: string[] = [];
  const { container, cleanup } = await render(
    <SegmentedRow title="Theme" options={THEMES_FIXTURE} value="system" onChange={(value) => chosen.push(value)} />,
  );
  try {
    const pills = [...container.querySelectorAll('[role="radio"]')] as unknown as HTMLElement[];
    assert.deepEqual(pills.map((pill) => pill.getAttribute("tabindex")), ["0", "-1", "-1"],
      "the selected option carries the group's only tab stop");

    pills[0]!.focus();
    await act(async () => {
      pills[0]!.dispatchEvent(
        new domWindow.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }) as never,
      );
    });
    assert.deepEqual(chosen, ["light"], "an arrow selects the option it moves to");
  } finally {
    await cleanup();
  }
});

test("a segmented row explains the option that is actually selected", async () => {
  // A pill cannot carry "Follow this device's appearance", and dropping every description would
  // leave a row that states its value twice and explains nothing.
  const { container, cleanup } = await render(
    <SegmentedRow title="Theme" options={THEMES_FIXTURE} value="dark" onChange={() => undefined} />,
  );
  try {
    assert.equal(container.querySelector(".ui-row-desc")?.textContent, "Always use the dark palette",
      "the row's description tracks the choice rather than describing the setting in general");
  } finally {
    await cleanup();
  }
});

/**
 * The picker's preview, which is the one thing here that can leave the WHOLE APP in a state nobody
 * asked for.
 *
 * Browsing the colour-scheme list repaints the entire window, so every way out of the list has to
 * put the committed palette back: Enter commits and stops previewing, Escape commits nothing and
 * stops previewing, and unmounting mid-browse — closing Settings with the list open — stops
 * previewing too. A missed path is not a glitch; it is an app that is permanently the wrong colour
 * with no control still open to explain why.
 */
function SchemeHarness({ preview, commits }: { preview: (value: string | null) => void; commits: string[] }) {
  const [value, setValue] = React.useState("wollipog");
  return (
    <SelectRow
      title="Colour Scheme"
      options={SCHEMES_FIXTURE}
      value={value}
      onChange={(next) => { commits.push(next); setValue(next); }}
      onPreview={preview}
    />
  );
}

async function openList(container: HTMLElement) {
  const trigger = container.querySelector(".ui-select-trigger") as unknown as HTMLButtonElement;
  await act(async () => { trigger.click(); });
  const list = container.ownerDocument.querySelector('[role="listbox"]');
  assert.ok(list, "the trigger must open a listbox");
  return list!;
}

const key = async (target: Element, name: string, init: Record<string, unknown> = {}) => {
  await act(async () => {
    target.dispatchEvent(
      new domWindow.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }) as never,
    );
  });
};

test("browsing the picker previews, and choosing an option commits it", async () => {
  const seen: (string | null)[] = [];
  const commits: string[] = [];
  const { container, cleanup } = await render(<SchemeHarness preview={(v) => seen.push(v)} commits={commits} />);
  try {
    const list = await openList(container);
    assert.equal(list.querySelectorAll('[role="option"]').length, 3);
    // Opening highlights the CURRENT value, so the first preview is a no-op repaint rather than a
    // jump to whatever happens to be first in the list.
    assert.deepEqual(seen, ["wollipog"]);

    await key(list, "ArrowDown");
    assert.deepEqual(seen, ["wollipog", "github"], "moving the highlight previews the option under it");

    await key(list, "Enter");
    assert.deepEqual(commits, ["github"], "Enter commits the highlighted option");
    assert.equal(seen.at(-1), null, "and the preview stops, so the committed value is what renders");
    assert.equal(container.ownerDocument.querySelector('[role="listbox"]'), null, "committing closes the list");
  } finally {
    await cleanup();
  }
});

test("Escape closes the picker without committing, and puts the palette back", async () => {
  const seen: (string | null)[] = [];
  const commits: string[] = [];
  const { container, cleanup } = await render(<SchemeHarness preview={(v) => seen.push(v)} commits={commits} />);
  try {
    const list = await openList(container);
    await key(list, "ArrowDown");
    await key(list, "ArrowDown");
    assert.deepEqual(seen, ["wollipog", "github", "dracula"]);

    await key(list, "Escape");
    assert.deepEqual(commits, [], "Escape is a cancellation, so nothing may be chosen");
    assert.equal(seen.at(-1), null, "and the preview must be withdrawn, or the app keeps the palette");
    assert.equal(container.ownerDocument.querySelector('[role="listbox"]'), null);
    // The trigger still says what it always said, which is the visible half of "nothing happened".
    assert.match(container.querySelector(".ui-select-trigger")!.getAttribute("aria-label") ?? "",
      /Colour Scheme: Wollipog/);
  } finally {
    await cleanup();
  }
});

test("a picker unmounted mid-browse withdraws its preview", async () => {
  // Closing Settings with the list open never re-renders this component with a closed list, so the
  // effect that clears on close cannot see it. Without the unmount path the previewed palette
  // outlives the picker entirely.
  const seen: (string | null)[] = [];
  const { container, cleanup } = await render(<SchemeHarness preview={(v) => seen.push(v)} commits={[]} />);
  const list = await openList(container);
  await key(list, "ArrowDown");
  assert.equal(seen.at(-1), "github");
  await cleanup();
  assert.equal(seen.at(-1), null, "unmounting is a dismissal like any other");
});

test("Space commits the highlighted option, and so does a click on it", async () => {
  // Enter was the only commit path with a test, and the three are separate branches: Space is
  // handled beside Enter in the list's key handler, and a click goes through the option's own
  // handler. A commit path that closed without committing would look identical to a cancellation.
  resetSelectPreviewRegistry();
  const seen: (string | null)[] = [];
  const commits: string[] = [];
  const { container, cleanup } = await render(<SchemeHarness preview={(v) => seen.push(v)} commits={commits} />);
  try {
    const list = await openList(container);
    await key(list, "ArrowDown");
    await key(list, " ");
    assert.deepEqual(commits, ["github"], "Space commits, as the listbox contract says it does");
    assert.equal(seen.at(-1), null, "and the preview stops with it");
    assert.equal(container.ownerDocument.querySelector('[role="listbox"]'), null);

    const reopened = await openList(container);
    const options = [...reopened.querySelectorAll('[role="option"]')] as unknown as HTMLButtonElement[];
    await act(async () => { options[2]!.click(); });
    assert.deepEqual(commits, ["github", "dracula"], "a click commits the option it lands on");
    assert.equal(seen.at(-1), null);
    assert.equal(container.ownerDocument.querySelector('[role="listbox"]'), null);
  } finally {
    await cleanup();
  }
});

test("a pointer outside the list, and a second click on the trigger, both end the browse", async () => {
  // Two dismissals that commit nothing. Neither goes through the list's key handler, so each is its
  // own way of leaving a previewed palette applied with no control still open to explain it.
  resetSelectPreviewRegistry();
  const seen: (string | null)[] = [];
  const commits: string[] = [];
  const { container, cleanup } = await render(<SchemeHarness preview={(v) => seen.push(v)} commits={commits} />);
  try {
    const list = await openList(container);
    await key(list, "ArrowDown");
    assert.equal(seen.at(-1), "github");
    await act(async () => {
      domWindow.document.body.dispatchEvent(new domWindow.Event("pointerdown", { bubbles: true }) as never);
    });
    assert.equal(container.ownerDocument.querySelector('[role="listbox"]'), null, "an outside pointer closes it");
    assert.equal(seen.at(-1), null);
    assert.deepEqual(commits, [], "clicking away is not a choice");

    const reopened = await openList(container);
    await key(reopened, "ArrowDown");
    assert.equal(seen.at(-1), "github");
    const trigger = container.querySelector(".ui-select-trigger") as unknown as HTMLButtonElement;
    await act(async () => { trigger.click(); });
    assert.equal(container.ownerDocument.querySelector('[role="listbox"]'), null, "the trigger toggles it shut");
    assert.equal(seen.at(-1), null);
    assert.deepEqual(commits, []);
  } finally {
    await cleanup();
  }
});

/**
 * The palette the DOCUMENT is showing, which is the only thing that matters about a preview.
 *
 * The callback assertions above prove the picker publishes; they cannot prove anyone applies it, or
 * that applying it stops at the document. This mounts the real provider under the real panel, so
 * `data-scheme` and the storage ledger answer both questions.
 */
function ThemedAppearance({ seen }: { seen: (string | null)[] }) {
  const theme = useTheme();
  return (
    <AppearancePanel
      options={THEME_OPTIONS}
      value={theme.preference}
      onChange={(value) => theme.setPreference(value as ThemePreference)}
      schemes={COLOR_SCHEMES}
      scheme={theme.scheme}
      onSchemeChange={(value) => theme.setScheme(value as ColorScheme)}
      onSchemePreview={(value) => {
        seen.push(value);
        theme.setPreviewScheme(value === null ? null : (value as ColorScheme));
      }}
      resolvedTheme={theme.resolved}
      densities={DENSITY_OPTIONS}
      density={theme.density}
      onDensityChange={(value) => theme.setDensity(value as Density)}
    />
  );
}

/** Wollipog is the ABSENCE of the attribute — it is the plain `[data-theme]` block. */
const applied = () => domWindow.document.documentElement.dataset.scheme ?? "wollipog";
const schemeWrites = () => storageWrites.filter(([name]) => name === SCHEME_STORAGE_KEY).map(([, value]) => value);

async function renderThemed(seen: (string | null)[]) {
  resetSelectPreviewRegistry();
  storageWrites.length = 0;
  storedValues.clear();
  return render(<ThemeProvider><ThemedAppearance seen={seen} /></ThemeProvider>);
}

test("a preview repaints the document, never reaches storage, and the commit is what survives", async () => {
  const seen: (string | null)[] = [];
  const { container, cleanup } = await renderThemed(seen);
  try {
    assert.equal(applied(), "wollipog");

    const list = await openList(container);
    await key(list, "ArrowDown");
    assert.equal(applied(), "github", "browsing has to repaint the app, or the swatches are the whole preview");
    assert.deepEqual(schemeWrites(), ["wollipog"],
      "a previewed palette written to storage makes scrolling a list a series of decisions");

    await key(list, "Escape");
    assert.equal(applied(), "wollipog", "and a cancellation puts the committed palette back");

    // preview → COMMIT → clear, which is the interleaving that ends on a different scheme than it
    // started: the withdrawal of the preview must not take the new choice with it.
    const second = await openList(container);
    await key(second, "ArrowDown");
    await key(second, "ArrowDown");
    assert.equal(applied(), "one-dark");
    await key(second, "Enter");
    assert.equal(applied(), "one-dark", "the committed scheme is what the document ends on");
    assert.deepEqual(schemeWrites(), ["wollipog", "one-dark"]);

    // And a later cancellation returns to the NEW committed scheme rather than the original one.
    const third = await openList(container);
    await key(third, "ArrowDown");
    assert.equal(applied(), "dracula");
    await key(third, "Escape");
    assert.equal(applied(), "one-dark");
    assert.deepEqual(schemeWrites(), ["wollipog", "one-dark"], "no browsed palette may ever be persisted");
  } finally {
    await cleanup();
  }
});

/**
 * Leaving the CONTROL without leaving a decision behind.
 *
 * Each of these was open at the point the review found it. Shift+Tab from the list lands on the
 * picker's own trigger, which is inside the Select's root, so the focus-move dismisser correctly
 * decides nothing left the control — and the list stayed open with a palette applied that nobody
 * chose. Alt+Tab produces no focus move anywhere in the document at all. Both leave the whole app
 * the wrong colour, with the control that would explain it no longer on screen.
 */
for (const [name, leave] of [
  ["Tab forward out of the list", async (list: Element) => { await key(list, "Tab"); }],
  ["Shift+Tab back to the trigger", async (list: Element) => { await key(list, "Tab", { shiftKey: true }); }],
  ["the window losing focus", async () => {
    await act(async () => { domWindow.dispatchEvent(new domWindow.Event("blur") as never); });
  }],
] as const) {
  test(`${name} ends the preview and restores the committed palette`, async () => {
    const seen: (string | null)[] = [];
    const { container, cleanup } = await renderThemed(seen);
    try {
      const list = await openList(container);
      await key(list, "ArrowDown");
      assert.equal(applied(), "github");

      await leave(list);
      assert.equal(container.ownerDocument.querySelector('[role="listbox"]'), null, "the list has to close");
      assert.equal(seen.at(-1), null, "and withdraw its preview");
      assert.equal(applied(), "wollipog", "so the document is the palette the user actually chose");
      assert.deepEqual(schemeWrites(), ["wollipog"], "leaving is not choosing");
    } finally {
      await cleanup();
    }
  });
}

/**
 * Two pickers, one document.
 *
 * A preview is a single `data-scheme`, so two mounted Selects share one channel whether or not they
 * agree. With each of them clearing it unconditionally, the second one closing published `null` over
 * the first one's live preview and the first never republished — its own highlight had not moved —
 * so the app sat on the committed palette while an open list said otherwise. Ordinary pointer use
 * dismisses the first list on the way to the second; keyboard and assistive-technology activation
 * do not, and neither does anything programmatic, which is what these clicks are.
 */
function TwoPickers({ showFirst, showSecond, first, second, commits }: {
  showFirst: boolean;
  showSecond: boolean;
  first: (value: string | null) => void;
  second: (value: string | null) => void;
  commits: string[];
}) {
  return (
    <>
      {showFirst && (
        <SelectRow title="Colour Scheme" options={SCHEMES_FIXTURE} value="wollipog"
          onChange={() => undefined} onPreview={first} />
      )}
      {showSecond && (
        <SelectRow title="Accent Colour" options={SCHEMES_FIXTURE} value="wollipog"
          onChange={(value) => commits.push(value)} onPreview={second} />
      )}
    </>
  );
}

/**
 * Both pickers mounted, a handle on each — and on the ONE screen they share.
 *
 * `channel` is every publication either of them made, in order, which is the only record that
 * answers "what colour is the app". The per-picker arrays say who spoke; the channel says what the
 * document was left showing, and every two-picker defect is a case where those disagree.
 *
 * Focus is held still for the duration, because focus is what USUALLY keeps this from happening:
 * opening a list focuses its panel, and every other open list treats that as a dismissal, so in
 * ordinary use only one picker is ever browsing. That guarantee lives in the dismisser, several
 * hundred lines from the preview channel and answerable to its own requirements — a picker that
 * previews on hover, or one inside something that swallows focus events, and it is gone while the
 * channel's rules are unchanged. These tests hold the channel to its own contract instead. Without
 * this the second list closes the first on the way in, and every assertion below about "the picker
 * underneath" passes against a picker that is no longer there.
 */
function twoPickers() {
  resetSelectPreviewRegistry();
  const elementPrototype = domWindow.HTMLElement.prototype as unknown as { focus: () => void };
  const realFocus = elementPrototype.focus;
  elementPrototype.focus = () => undefined;
  const first: (string | null)[] = [];
  const second: (string | null)[] = [];
  const channel: (string | null)[] = [];
  const commits: string[] = [];
  const record = (own: (string | null)[]) => (value: string | null) => { own.push(value); channel.push(value); };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const show = async (showFirst: boolean, showSecond = true) => {
    await act(async () => {
      root.render(
        <TwoPickers showFirst={showFirst} showSecond={showSecond}
          first={record(first)} second={record(second)} commits={commits} />,
      );
    });
  };
  const openPicker = async (index: number) => {
    const triggers = [...container.querySelectorAll(".ui-select-trigger")] as unknown as HTMLButtonElement[];
    await act(async () => { triggers[index]!.click(); });
    return [...container.querySelectorAll('[role="listbox"]')].at(index === 0 ? 0 : -1)!;
  };
  return {
    first,
    second,
    channel,
    commits,
    show,
    openPicker,
    /** Whatever list is still open, by node rather than by the handle a re-render may have replaced. */
    openList: () => container.querySelector('[role="listbox"]'),
    /** How many are open at once, since "the other one is still browsing" is half of every claim here. */
    lists: () => [...container.querySelectorAll('[role="listbox"]')],
    cleanup: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
      elementPrototype.focus = realFocus;
      resetSelectPreviewRegistry();
    },
  };
}

test("a picker that is not the one on screen withdraws nothing when it goes", async () => {
  const { first, second, commits, show, openPicker, openList, cleanup } = twoPickers();
  try {
    await show(true);
    const listA = await openPicker(0);
    await key(listA, "ArrowDown");
    assert.deepEqual(first, ["wollipog", "github"]);

    // The second picker takes the slot: the document shows one palette, so the newest publisher is
    // by definition the one the user is looking at.
    const listB = await openPicker(1);
    await key(listB, "ArrowDown");
    assert.deepEqual(second, ["wollipog", "github"]);

    // Unmounting the first — closing the screen it lives on — is the dismissal that cannot be seen
    // coming, and it must not blank a preview belonging to something still on screen.
    await show(false);
    assert.deepEqual(first, ["wollipog", "github"], "an unmounting non-owner may not publish null");
    assert.deepEqual(second, ["wollipog", "github"], "so the live preview survives it");

    // The owner leaving is what ends it, whichever way it leaves — here by committing.
    const stillOpen = openList();
    assert.ok(stillOpen, "unmounting the other picker must not have closed this one");
    await key(stillOpen, "Enter");
    assert.deepEqual(commits, ["github"]);
    assert.equal(second.at(-1), null, "the owner's own departure is the one that puts the palette back");
    assert.deepEqual(first, ["wollipog", "github"], "and the picker that left quietly stayed quiet");
  } finally {
    await cleanup();
  }
});

test("a picker that lost the slot can take it back", async () => {
  const { first, second, show, openPicker, cleanup } = twoPickers();
  try {
    await show(true);
    const listA = await openPicker(0);
    await key(listA, "ArrowDown");
    const listB = await openPicker(1);
    await key(listB, "ArrowDown");
    assert.deepEqual(second, ["wollipog", "github"]);

    // The first picker cancels while the second owns the slot. Nothing is published, or this is the
    // defect exactly: the app snaps back to the committed palette with an open list still
    // highlighting something else, and that list never republishes because its highlight has not
    // moved — one picker's Escape becomes another picker's cancellation.
    await key(listA, "Escape");
    assert.deepEqual(first, ["wollipog", "github"], "a non-owner's cancellation is not the owner's");
    assert.deepEqual(second, ["wollipog", "github"], "so the preview on screen is left alone");

    // And the skipped publication still moved the first picker's own state, so it can publish
    // again: a picker that silently declined to clear must not be left believing it already has.
    const reopened = await openPicker(0);
    await key(reopened, "ArrowDown");
    assert.deepEqual(first, ["wollipog", "github", "wollipog", "github"],
      "declining to publish is not the same as having published");
  } finally {
    await cleanup();
  }
});

/**
 * The picker UNDERNEATH, which a single owner slot had nothing to remember.
 *
 * Round one stopped a covered picker's dismissal from blanking the screen. This is the same wrong
 * screen reached from the other side: the picker on top leaves, and the one still open — still
 * highlighting GitHub, its own highlight never having moved, so its effect will never fire again —
 * is owed the document. With a slot there was nothing to uncover, so the app snapped back to the
 * committed palette while an open list said otherwise: exactly the state these tests exist to
 * prevent, one departure later.
 */
for (const [name, expectedCommits, leave] of [
  ["closing", [], async (list: Element) => { await key(list, "Escape"); }],
  ["committing", ["dracula"], async (list: Element) => { await key(list, "Enter"); }],
] as const) {
  test(`the picker underneath gets the screen back when the one on top leaves by ${name}`, async () => {
    const { first, second, channel, commits, show, openPicker, lists, cleanup } = twoPickers();
    try {
      await show(true);
      const listA = await openPicker(0);
      await key(listA, "ArrowDown");
      const listB = await openPicker(1);
      await key(listB, "ArrowDown");
      await key(listB, "ArrowDown");
      assert.deepEqual(second, ["wollipog", "github", "dracula"]);
      assert.equal(channel.at(-1), "dracula", "the newest publisher is the one the document shows");
      assert.equal(lists().length, 2, "and both lists are open, or this test proves nothing");

      await leave(listB);
      assert.deepEqual(commits, expectedCommits);
      assert.equal(lists().length, 1, "the older list is still open — which is why it is owed the screen");
      assert.equal(channel.at(-1), "github",
        "it is still browsing GitHub, so GitHub is what the document has to go back to");
      assert.deepEqual(first, ["wollipog", "github", "github"],
        "told again by the channel, since nothing about that picker changed for it to notice");
      assert.deepEqual(second, ["wollipog", "github", "dracula"],
        "and the picker that left says nothing more: its preview is replaced, not merely cancelled");
    } finally {
      await cleanup();
    }
  });
}

test("the picker underneath gets the screen back when the one on top unmounts", async () => {
  // The departure that cannot be seen coming — closing the screen the top picker lives on. It never
  // renders with a closed list, so its teardown is the only notice the channel gets, and a teardown
  // that publishes a bare `null` leaves the app the committed colour with a list still open on
  // something else.
  const { first, second, channel, show, openPicker, lists, cleanup } = twoPickers();
  try {
    await show(true);
    const listA = await openPicker(0);
    await key(listA, "ArrowDown");
    const listB = await openPicker(1);
    await key(listB, "ArrowDown");
    await key(listB, "ArrowDown");
    assert.equal(channel.at(-1), "dracula");
    assert.equal(lists().length, 2);

    await show(true, false);
    assert.equal(lists().length, 1, "unmounting one picker must not close the other");
    assert.equal(channel.at(-1), "github", "the surviving browse is what the document goes back to");
    assert.deepEqual(first, ["wollipog", "github", "github"]);
    assert.deepEqual(second, ["wollipog", "github", "dracula"]);
  } finally {
    await cleanup();
  }
});

test("a picker whose preview callback is taken away still gives the palette back", async () => {
  /*
   * `onPreview` is optional, so a parent may stop passing it while the list is open — a permission
   * lost, a panel switching modes. The preview is on screen either way, and the only function that
   * can take it back is the one that put it there: withdrawing through the CURRENT prop published
   * nothing, because there was no current prop, and left the picker's entry live forever. The next
   * picker's dismissal would then uncover a callback belonging to a tree that no longer exists.
   */
  resetSelectPreviewRegistry();
  const seen: (string | null)[] = [];
  const later: (string | null)[] = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const show = async (withPreview: boolean) => {
    await act(async () => {
      root.render(
        <SelectRow title="Colour Scheme" options={SCHEMES_FIXTURE} value="wollipog" onChange={() => undefined}
          onPreview={withPreview ? (value) => seen.push(value) : undefined} />,
      );
    });
  };
  try {
    await show(true);
    const list = await openList(container);
    await key(list, "ArrowDown");
    assert.deepEqual(seen, ["wollipog", "github"]);

    await show(false);
    assert.deepEqual(seen, ["wollipog", "github"], "losing the prop is not itself a dismissal");

    await act(async () => { root.unmount(); });
    assert.equal(seen.at(-1), null, "the callback that made the publication is the one that takes it back");

    // And the dead entry is off the stack: a fresh picker's dismissal must end in `null` rather than
    // uncovering the palette of a picker that is no longer on screen.
    const fresh = await render(
      <SelectRow title="Accent Colour" options={SCHEMES_FIXTURE} value="wollipog" onChange={() => undefined}
        onPreview={(value) => later.push(value)} />,
    );
    try {
      const freshList = await openList(fresh.container);
      await key(freshList, "ArrowDown");
      await key(freshList, "Escape");
      assert.deepEqual(later, ["wollipog", "github", null], "nothing was left underneath it");
      assert.deepEqual(seen, ["wollipog", "github", null], "and the departed picker was not spoken for");
    } finally {
      await fresh.cleanup();
    }
  } finally {
    container.remove();
    resetSelectPreviewRegistry();
  }
});

test("a picker with nothing to preview stays out of the channel entirely", async () => {
  // Almost every Select in the app previews nothing — a project, an agent, a range. One that took
  // the shared slot it never writes to would leave the picker that DOES preview unable to withdraw,
  // which is a palette nobody chose applied for the rest of the session.
  resetSelectPreviewRegistry();
  const seen: (string | null)[] = [];
  const { container, cleanup } = await render(
    <>
      <SelectRow title="Colour Scheme" options={SCHEMES_FIXTURE} value="wollipog"
        onChange={() => undefined} onPreview={(value) => seen.push(value)} />
      <SelectRow title="Accent Colour" options={SCHEMES_FIXTURE} value="wollipog" onChange={() => undefined} />
    </>,
  );
  try {
    const triggers = [...container.querySelectorAll(".ui-select-trigger")] as unknown as HTMLButtonElement[];
    const lists = () => [...container.querySelectorAll('[role="listbox"]')];
    await act(async () => { triggers[0]!.click(); });
    await key(lists()[0]!, "ArrowDown");
    assert.deepEqual(seen, ["wollipog", "github"]);

    await act(async () => { triggers[1]!.click(); });
    await key(lists().at(-1)!, "ArrowDown");
    await key(lists()[0]!, "Escape");
    assert.equal(seen.at(-1), null, "the previewing picker must still be able to put the palette back");
  } finally {
    await cleanup();
  }
});

test("each option's sentence is attached to the control it describes", async () => {
  /*
   * The row this replaced put every option's description inside the focused radio, so "Follow this
   * device's appearance" was announced with System. Pills cannot render one and the picker's trigger
   * names only its setting and value, so both sentences became siblings nothing pointed at: focus
   * reached "System, selected, radio" and arrowing to Light silently changed text no control
   * referenced. Resolved through the document here, because an id that resolves to nothing is
   * exactly as silent as no id at all.
   */
  const { container, cleanup } = await render(
    <AppearancePanel
      options={THEME_OPTIONS}
      value="system"
      onChange={() => undefined}
      schemes={COLOR_SCHEMES}
      scheme="wollipog"
      onSchemeChange={() => undefined}
      onSchemePreview={() => undefined}
      resolvedTheme="dark"
      densities={DENSITY_OPTIONS}
      density="compact"
      onDensityChange={() => undefined}
    />,
  );
  try {
    const describedBy = (element: Element) => (element.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => domWindow.document.getElementById(id)?.textContent ?? null)
      .join(" ");

    for (const [label, expected] of [["Theme", THEME_OPTIONS], ["Density", DENSITY_OPTIONS]] as const) {
      const group = container.querySelector(`[role="radiogroup"][aria-label="${label}"]`)!;
      const radios = [...group.querySelectorAll('[role="radio"]')];
      assert.deepEqual(radios.map(describedBy), expected.map((option) => option.description),
        `each ${label} option must carry its own sentence, not the selected one's`);
    }

    const trigger = container.querySelector(".ui-select-trigger")!;
    assert.equal(describedBy(trigger), "Applies to both the light and the dark theme.",
      "the picker's helper text has to reach someone who tabbed straight to the trigger");

    // The visible sentence for a segmented row is the SELECTED option's, and the pill already
    // carries it: exposed in both places it is announced twice.
    const rows = [...container.querySelectorAll(".ui-row")];
    assert.equal(rows[0]!.querySelector(".ui-row-desc")!.getAttribute("aria-hidden"), "true");
    assert.equal(rows[1]!.querySelector(".ui-row-desc")!.getAttribute("aria-hidden"), null,
      "the picker's own description is not duplicated anywhere, so it stays in the tree");
  } finally {
    await cleanup();
  }
});

test("a disabled segmented row says who took it away", async () => {
  // §11.3: an unavailable setting stays on screen and explains itself. A row-level disable is every
  // option at once, so the reason belongs to the group — five identical tooltips would be the same
  // sentence read five times, and a `title` cannot be reached by touch at all.
  const { container, cleanup } = await render(
    <SegmentedRow title="Theme" options={THEMES_FIXTURE} value="system" disabled
      disabledReason="Managed by your workspace administrator." onChange={() => undefined} />,
  );
  try {
    const group = container.querySelector('[role="radiogroup"]')!;
    const radios = [...group.querySelectorAll('[role="radio"]')];
    assert.deepEqual(radios.map((radio) => radio.getAttribute("aria-disabled")), ["true", "true", "true"],
      "every option is unavailable, not merely the selected one");
    const reasonId = group.getAttribute("aria-describedby");
    assert.ok(reasonId, "the reason has to be associated with the group, not merely rendered near it");
    assert.equal(domWindow.document.getElementById(reasonId!)?.textContent,
      "Managed by your workspace administrator.");
    assert.equal(container.querySelector(".ui-seg-reason")?.textContent,
      "Managed by your workspace administrator.", "and it is rendered, not hidden in a title");
  } finally {
    await cleanup();
  }
});

test("the picker's trigger names the setting AND its current value", async () => {
  // `aria-label` naming only the setting was the defect the primitive already fixed: the control
  // read as "Colour Scheme" whether it said Dracula or nothing at all. A row whose closed state
  // does not state its value can only be opened, not read.
  const { container, cleanup } = await render(
    <SelectRow title="Colour Scheme" options={SCHEMES_FIXTURE} value="dracula" onChange={() => undefined} />,
  );
  try {
    const trigger = container.querySelector(".ui-select-trigger")!;
    assert.equal(trigger.getAttribute("aria-label"), "Colour Scheme: Dracula");
    assert.equal(container.querySelector(".ui-select-value")?.textContent, "Dracula");
    assert.ok(trigger.querySelector(".ui-swatch"), "and shows the palette it is naming");
  } finally {
    await cleanup();
  }
});

test("a disabled row reports itself as disabled rather than merely looking faded", async () => {
  const clicks: string[] = [];
  const { container, cleanup } = await render(
    <SwitchRow title="Tailnet" checked={false} disabled onClick={() => clicks.push("toggled")} />,
  );
  try {
    const row = container.querySelector(".ui-row") as unknown as HTMLButtonElement;
    assert.equal(row.disabled, true);
    await act(async () => { row.click(); });
    assert.deepEqual(clicks, [], "a disabled row must not fire its action");
  } finally {
    await cleanup();
  }
});

/**
 * The DOM assertions above prove the affordance ELEMENTS exist. They cannot prove those elements
 * are visible: a CSS cleanup could delete every ring, track, knob and chevron rule and leave the
 * classed spans behind, and every assertion here would still pass while the three rows regressed
 * to the pixel-identical presentation this file exists to prevent.
 *
 * This repo has no browser or visual-baseline harness, so the stylesheet is read directly and the
 * geometry each class must carry is asserted. That is weaker than a rendered pixel — it cannot
 * catch a later override — but it does bind the classes to real, non-zero size.
 */
const sheet = readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8");

function ruleOf(selector: string): Map<string, string> {
  const declared = new Map<string, string>();
  parse(sheet).walkRules((rule) => {
    if (!rule.selectors.some((candidate) => candidate.trim() === selector)) return;
    for (const node of rule.nodes ?? []) {
      if (node.type === "decl") declared.set(node.prop, node.value.trim());
    }
  });
  assert.ok(declared.size > 0, `${selector} must exist in the stylesheet`);
  return declared;
}

const positive = (value: string | undefined) =>
  value !== undefined && /^[\d.]+px$/.test(value) && Number.parseFloat(value) > 0;

/**
 * Nothing in the rule may make it invisible.
 *
 * Geometry alone is not visibility: `opacity: 0`, `visibility: hidden` and `display: none` all
 * leave width and height intact, so a size assertion passes while the control is gone.
 */
function assertVisible(rule: Map<string, string>, label: string) {
  assert.notEqual(rule.get("display"), "none", `${label} must not be display:none`);
  assert.notEqual(rule.get("visibility"), "hidden", `${label} must not be visibility:hidden`);
  const opacity = rule.get("opacity");
  assert.ok(opacity === undefined || Number.parseFloat(opacity) > 0, `${label} must not be transparent`);
}

/** A ::before/::after with no `content` is never generated at all, whatever else it declares. */
function assertGenerated(rule: Map<string, string>, label: string) {
  const content = rule.get("content");
  assert.ok(content !== undefined && content !== "none", `${label} needs content to exist at all`);
}

test("each affordance has real geometry in the stylesheet, not just a class name", () => {
  // The group's own border is what makes the unselected pills read as pills rather than as bare
  // words: their own border is transparent, so deleting this leaves a segmented control that looks
  // like a row of text until one of them happens to be selected.
  const group = ruleOf(".ui-seg");
  assert.match(group.get("border") ?? "", /solid/, "the pill group needs a visible boundary");
  assertVisible(group, "the pill group");

  const pill = ruleOf(".ui-seg-option");
  assertVisible(pill, "an unselected pill");
  assert.ok(/\d/.test(pill.get("padding") ?? ""), "a pill needs real padding or it is just its label");

  // Selection is a FILL plus a border, not colour alone on the text.
  const selectedPill = ruleOf(".ui-seg-option.is-selected");
  assert.match(selectedPill.get("background") ?? "", /var\(--accent\)/, "the selected pill must be filled");
  assert.match(selectedPill.get("border-color") ?? "", /var\(--accent\)/, "and outlined");

  // The picker's resting state has to look like something you can open.
  const trigger = ruleOf(".ui-select-trigger");
  assert.match(trigger.get("border") ?? "", /solid/, "the trigger needs a visible boundary");
  assertVisible(trigger, "the picker trigger");

  const swatch = ruleOf(".ui-swatch-dot");
  assert.ok(positive(swatch.get("width")) && positive(swatch.get("height")), "a swatch dot needs size");
  assertVisible(swatch, "the swatch dot");
  // Bound to the CONTRAST-TESTED token, and not optional: a swatch shows a colour that may BE the
  // surface behind it — Wollipog light's ground on a near-white panel — so without the outline the
  // dot is a gap in the row rather than a colour.
  assert.match(swatch.get("border") ?? "", /solid/, "and a visible border");
  assert.match(swatch.get("border") ?? "", /var\(--control-outline\)/,
    "the dot must use the token whose contrast is asserted below");

  const track = ruleOf(".ui-switch");
  assert.ok(positive(track.get("width")) && positive(track.get("height")));
  assert.match(track.get("border") ?? "", /solid/);
  assertVisible(track, "the switch track");
  assert.match(track.get("border") ?? "", /var\(--control-outline\)/,
    "the track must use the token whose contrast is asserted below");

  const knob = ruleOf(".ui-switch::after");
  assert.ok(positive(knob.get("width")) && positive(knob.get("height")));
  assertGenerated(knob, "the switch knob");
  assertVisible(knob, "the switch knob");

  // Checked state must move the knob a real distance, not merely recolour it — colour alone is not
  // an accessible state indicator.
  const checkedKnob = ruleOf('.ui-row-switch[aria-checked="true"] .ui-switch::after');
  const shift = /translateX\((-?[\d.]+)px\)/.exec(checkedKnob.get("transform") ?? "");
  assert.ok(shift && Math.abs(Number.parseFloat(shift[1]!)) >= 8,
    "the knob must visibly travel when the switch is on");

});

test("Appearance controls share one fixed trailing column and fill it", () => {
  assert.match(ruleOf(".ui-row-choice").get("grid-template-columns") ?? "", /220px/,
    "the value-column edge must not depend on each row's content width");
  assert.equal(ruleOf(".ui-row-choice-control").get("width"), "100%");
  assert.equal(ruleOf(".ui-row-choice-control > .ui-seg").get("width"), "100%");
  assert.equal(ruleOf(".ui-row-picker").get("width"), "100%");
});

test("control outlines meet the 3:1 non-text contrast bar in every palette", () => {
  // These boundaries CARRY state — an empty ring, an off track — so they are not decoration.
  // --border-strong managed 1.74:1 on the Settings modal, which is why --control-outline exists.
  //
  // Per BLOCK rather than per theme. §6.5 added four alternative schemes, so there are ten of these
  // now, and pairing them by index against a flat list of surfaces would have compared one
  // scheme's outline with another's background — a comparison that means nothing and can pass.
  const blocks: { selector: string; tokens: Map<string, string> }[] = [];
  parse(sheet).walkRules((rule) => {
    if (!/^:root(\[[^\]]+\])*$/.test(rule.selector.split(",")[0]!.trim())) return;
    const tokens = new Map<string, string>();
    rule.walkDecls((decl) => { if (decl.prop.startsWith("--")) tokens.set(decl.prop, decl.value.trim()); });
    if (tokens.has("--control-outline")) blocks.push({ selector: rule.selector, tokens });
  });
  // Two base themes plus a pair per alternative scheme; a block that declared no outline would
  // inherit one from a different palette and go unchecked.
  assert.ok(blocks.length >= 2, "every palette block has to declare its own control outline");

  for (const { selector, tokens } of blocks) {
    const outline = tokens.get("--control-outline")!;
    for (const [label, name] of [["modal", "--bg-elev-2"], ["track", "--bg-elev-3"]] as const) {
      const behind = tokens.get(name);
      assert.ok(behind, `${selector} declares an outline but not ${name} to measure it against`);
      const ratio = contrast(outline, behind!);
      assert.ok(ratio >= 3,
        `--control-outline is ${ratio.toFixed(2)}:1 on the ${label} in ${selector}; 3:1 required`);
    }
  }
});

/**
 * A toggle mid-request must keep announcing its last CONFIRMED value. Push Notifications rendered
 * checked={state === "on"} through a transitional "busy" state, so switching off moved the control
 * to off — and exposed aria-checked="false" — before the subscription was actually unregistered,
 * while notifications could still be delivered.
 */
test("a busy switch keeps its confirmed value and says it is working", async () => {
  const clicks: string[] = [];
  const { container, cleanup } = await render(
    <SwitchRow title="Push Notifications" checked busy onClick={() => clicks.push("toggled")} />,
  );
  try {
    const row = container.querySelector(".ui-row") as unknown as HTMLButtonElement;
    assert.equal(row.getAttribute("aria-checked"), "true",
      "the confirmed value must survive the pending request, not flip early");
    assert.equal(row.getAttribute("aria-busy"), "true", "and the transition must be announced");
    assert.equal(row.disabled, true, "a second toggle mid-request would race the first");
    await act(async () => { row.click(); });
    assert.deepEqual(clicks, []);
  } finally {
    await cleanup();
  }
});

test("a settled switch carries no busy state", async () => {
  const { container, cleanup } = await render(<SwitchRow title="Tailnet" checked={false} onClick={() => undefined} />);
  try {
    const row = container.querySelector(".ui-row") as unknown as HTMLButtonElement;
    assert.equal(row.getAttribute("aria-busy"), null, "aria-busy must not be present when idle");
    assert.equal(row.disabled, false);
  } finally {
    await cleanup();
  }
});

/**
 * The chevron, as RENDERED by NavRow.
 *
 * Reading ChevronRightIcon's source instead let the icon be dropped from the row entirely: the DOM
 * test still found the .ui-row-chevron span, and the source test still found geometry in a function
 * nobody called any more. Assert the row actually paints one.
 */
test("a navigation row renders a chevron with real geometry", async () => {
  const { container, cleanup } = await render(<NavRow title="Keyboard Shortcuts" onClick={() => undefined} />);
  try {
    const slot = container.querySelector(".ui-row-chevron");
    assert.ok(slot, "the chevron slot must exist");
    const svg = slot!.querySelector("svg");
    assert.ok(svg, "and must contain a rendered SVG, not just an empty span");

    for (const attribute of ["width", "height"]) {
      assert.ok(Number.parseFloat(svg!.getAttribute(attribute) ?? "0") > 0,
        `the chevron needs a positive ${attribute}`);
    }

    const drawn = [...svg!.querySelectorAll("path, polyline, line")]
      .map((node) => (node.getAttribute("d") ?? node.getAttribute("points") ?? "").trim())
      .filter(Boolean);
    assert.ok(drawn.length > 0, "the chevron must draw something");
    // "" or "M0 0" keeps the attribute while rendering nothing.
    for (const geometry of drawn) {
      assert.ok(geometry.length > 4 && /\d/.test(geometry), `chevron geometry "${geometry}" is empty`);
    }
  } finally {
    await cleanup();
  }
});


/**
 * Closing Settings unmounts the row, so this has to exercise the OWNER of the confirmed value, not
 * a standalone SwitchRow handed `checked busy` on every mount — that renders the right pixels while
 * proving nothing about ref lifetime, which is the bug.
 *
 * PushOwner mirrors usePushSetting's contract: it is mounted by the shell, outlives the modal, and
 * holds the last confirmed value across a pending toggle. The row mounts conditionally beneath it.
 */
function PushOwner({ open, state }: { open: boolean; state: "on" | "off" | "busy" }) {
  const confirmed = React.useRef(false);
  if (state === "on" || state === "off") confirmed.current = state === "on";
  return open
    ? <SwitchRow title="Push Notifications" checked={confirmed.current} busy={state === "busy"} onClick={() => undefined} />
    : null;
}

test("a switch remounted mid-request still reports its confirmed value", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const show = async (open: boolean, state: "on" | "off" | "busy") => {
    await act(async () => { root.render(<PushOwner open={open} state={state} />); });
  };
  const row = () => container.querySelector(".ui-row") as unknown as HTMLButtonElement | null;

  try {
    await show(true, "on");                        // confirmed on
    assert.equal(row()!.getAttribute("aria-checked"), "true");

    await show(true, "busy");                      // disable starts
    assert.equal(row()!.getAttribute("aria-checked"), "true", "must not flip before the server confirms");

    await show(false, "busy");                     // Settings closes mid-request
    assert.equal(row(), null);

    await show(true, "busy");                      // and reopens before it resolves
    assert.equal(row()!.getAttribute("aria-checked"), "true",
      "a ref living inside the row would have re-initialised from \"busy\" and reported off here");
    assert.equal(row()!.getAttribute("aria-busy"), "true");
    assert.equal(row()!.disabled, true);

    await show(true, "off");                       // request resolves
    assert.equal(row()!.getAttribute("aria-checked"), "false");
    assert.equal(row()!.getAttribute("aria-busy"), null);
    assert.equal(row()!.disabled, false);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
