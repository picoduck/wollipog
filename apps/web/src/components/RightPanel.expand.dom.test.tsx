import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView } from "@wollipog/protocol";
import { RightPanel, useRightPanelState, type RightPanelState } from "./RightPanel.js";
import { loadBrowserStorageValue, saveBrowserStorageValue } from "../instance-storage.js";
import { clearPanelScratch } from "../right-panel-scratch.js";
import type { GitStatus } from "./useGitStatus.js";
import { StoreProvider } from "../store.js";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime } from "../ui-transport.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

/**
 * Expand Panel (#2845): the side panel fills the session's content area in place of the chat
 * column, Restore Panel and Escape bring the docked panel back, and the drag ceiling is the room
 * §15.2's 480px rule leaves.
 */

const connection: UiConnectionRuntime = {
  instanceId: "right-panel-expand-test", runtimeKey: "right-panel-expand-test",
  createSocket: () => ({ readyState: UI_SOCKET_OPEN, onopen: null, onmessage: null,
    onclose: null, onerror: null, send() {}, close() {} }),
  close() {},
};

/** No control plane knows this fixture's session; reject rather than reach the network (#911). */
const client = {
  ...api,
  childSessions: () => Promise.reject(new ApiError("This fixture has no durable child-session registry.", 404)),
} as ApiClient;

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
let phoneViewport = false;
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  writable: true,
  value: (query: string) => ({
    get matches() {
      return query === "(max-width: 760px)" ? phoneViewport : false;
    },
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }),
});
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  localStorage: domWindow.localStorage,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  ResizeObserver: domWindow.ResizeObserver,
  React,
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

beforeEach(() => {
  domWindow.localStorage.clear();
  clearPanelScratch();
  phoneViewport = false;
});

after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  domWindow.close();
});

const session = {
  id: "session-1",
  runnerId: "runner-1",
  driver: "claude-code",
  status: "running",
  adopted: false,
  eventEpoch: 1,
} as SessionView;

const git: GitStatus = {
  status: null,
  observation: 0,
  observedAt: null,
  settled: false,
  busy: false,
  error: null,
  errorCode: null,
  refresh: async () => {},
  refreshStatusOnly: async () => {},
  install: () => {},
  mutationRevision: 0,
};

function PanelHarness({ onState }: { onState: (state: RightPanelState) => void }) {
  const state = useRightPanelState();
  onState(state);
  return (
    <>
      <button type="button" id="opener">Side Panel</button>
      <ApiProvider client={client}><StoreProvider connection={connection}><RightPanel
        state={state}
        session={session}
        runnerOnline
        runnerProtocolVersion={null}
        git={git}
        items={[]}
        onOpenSourceLocation={() => {}}
        onClearSourceLocation={() => {}}
        onOpenTerminal={() => {}}
        onInsertSideChatDraft={() => {}}
      /></StoreProvider></ApiProvider>
    </>
  );
}

/**
 * Mounts the panel in a row of `rowWidth` (the row the chat column and the panel share is the
 * panel's parent here). A 1440px window less the 64px rail is 1376px.
 */
async function mountPanel(rowWidth = 1376) {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  container.getBoundingClientRect = () => ({
    width: rowWidth, height: 600, top: 0, left: 0, right: rowWidth, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
  }) as DOMRect;
  let root = createRoot(container);
  let state!: RightPanelState;
  await act(async () => root.render(<PanelHarness onState={(next) => { state = next; }} />));
  return {
    container,
    get state() { return state; },
    aside: () => container.querySelector<HTMLElement>("#right-panel"),
    button: (name: string) => container.querySelector<HTMLButtonElement>(`.rpanel-head [aria-label="${name}"]`),
    async remount() {
      await act(async () => root.unmount());
      root = createRoot(container);
      await act(async () => root.render(<PanelHarness onState={(next) => { state = next; }} />));
    },
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function isFocused(element: Element | null) {
  return (domWindow.document.activeElement as unknown as Element | null) === element;
}

async function pressEscape(target: Element) {
  const event = new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => { target.dispatchEvent(event as unknown as Event); });
  return event;
}

test("Expand Panel fills the row in place of the chat, and Restore Panel brings the docked panel back at its width (#2845)", async () => {
  const panel = await mountPanel();
  try {
    await act(async () => panel.state.show("review"));
    assert.equal(panel.aside()?.dataset.presentation, "docked");
    assert.equal(panel.aside()?.style.width, "400px");
    const expand = panel.button("Expand Panel")!;
    assert.ok(expand, "a docked panel offers Expand Panel");
    assert.match(expand.className, /\bicon-btn\b/u);
    assert.equal(expand.title, "Expand Panel");
    assert.equal(expand.textContent, "", "icon-only");
    assert.ok(expand.querySelector("svg"));

    expand.focus();
    await act(async () => expand.click());
    assert.equal(panel.state.expanded, true);
    assert.equal(panel.aside()?.dataset.presentation, "expanded");
    assert.equal(panel.aside()?.style.width, "", "the stylesheet sizes an expanded panel to the row");
    assertNoDomNode(panel.container.querySelector(".rpanel-resizer"), "no resize handle while expanded");
    assertNoDomNode(panel.container.querySelector(".rpanel-scrim"), "no scrim while expanded");
    assertNoDomNode(panel.button("Expand Panel"));
    const restore = panel.button("Restore Panel")!;
    assert.equal(restore.title, "Restore Panel");
    assert.ok(isFocused(restore), "the same control keeps focus as it becomes Restore Panel");
    assert.equal(loadBrowserStorageValue("wollipog.rightpanel.expanded"), "1");

    await act(async () => restore.click());
    assert.equal(panel.state.expanded, false);
    assert.equal(panel.aside()?.dataset.presentation, "docked");
    assert.equal(panel.aside()?.style.width, "400px", "back at the width it had");
    assert.ok(panel.container.querySelector(".rpanel-resizer"), "the handle returns");
    assert.ok(isFocused(panel.button("Expand Panel")));
    assert.equal(loadBrowserStorageValue("wollipog.rightpanel.expanded"), "0");
  } finally {
    await panel.dispose();
  }
});

test("Escape restores an expanded panel before it closes it, after the menu or tool layer above it (#2845)", async () => {
  const panel = await mountPanel();
  try {
    await act(async () => panel.state.show("decisions"));
    await act(async () => panel.state.setExpanded(true));
    const switcher = panel.container.querySelector<HTMLButtonElement>(".rpanel-switcher")!;

    // An open menu takes Escape first.
    await act(async () => switcher.click());
    const menu = domWindow.document.querySelector('[role="menu"][aria-label="Switch Tool"]')!;
    assert.ok(menu);
    await pressEscape(domWindow.document.activeElement as unknown as Element);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assertNoDomNode(domWindow.document.querySelector('[aria-label="Switch Tool"]'), "the menu closes");
    assert.equal(panel.aside()?.dataset.presentation, "expanded", "and the panel stays expanded");

    // A layer the tool draws on its body handles Escape and calls preventDefault.
    const body = panel.container.querySelector<HTMLElement>(".rpanel-body")!;
    const takeEscape = (event: Event) => event.preventDefault();
    body.addEventListener("keydown", takeEscape, { capture: true });
    await pressEscape(body);
    body.removeEventListener("keydown", takeEscape, { capture: true });
    assert.equal(panel.aside()?.dataset.presentation, "expanded", "a tool layer keeps the panel expanded");

    const restored = await pressEscape(switcher);
    assert.equal(restored.defaultPrevented, true, "Escape is consumed by the restore");
    assert.equal(panel.state.open, true, "Escape restores first");
    assert.equal(panel.aside()?.dataset.presentation, "docked");
    assert.equal(panel.aside()?.style.width, "400px");

    await pressEscape(panel.container.querySelector(".rpanel-switcher")!);
    assert.equal(panel.state.open, false, "then closes");
    assert.equal(panel.state.expanded, false);
  } finally {
    await panel.dispose();
  }
});

test("Requests restores an expanded panel on Escape from outside it, then closes it (#2845)", async () => {
  const panel = await mountPanel();
  try {
    await act(async () => panel.state.show("requests"));
    await act(async () => panel.state.setExpanded(true));
    const opener = panel.container.querySelector<HTMLButtonElement>("#opener")!;
    await pressEscape(opener);
    assert.equal(panel.state.open, true);
    assert.equal(panel.aside()?.dataset.presentation, "docked");
    await pressEscape(opener);
    assert.equal(panel.state.open, false);
  } finally {
    await panel.dispose();
  }
});

test("the expanded state outlives closing the panel, switching tools and a reload (#2845)", async () => {
  const panel = await mountPanel();
  try {
    await act(async () => panel.state.show("review"));
    await act(async () => panel.button("Expand Panel")!.click());
    await act(async () => panel.button("Close Panel")!.click());
    assert.equal(panel.state.open, false);
    assert.equal(panel.state.expanded, true, "closing keeps it");
    assert.equal(loadBrowserStorageValue("wollipog.rightpanel.expanded"), "1");

    await act(async () => panel.state.toggle());
    assert.equal(panel.aside()?.dataset.presentation, "expanded", "the next open is expanded again");
    // Files last: a reload never reopens Agents, whatever was stored.
    for (const mode of ["subagents", "decisions", "launcher", "files"] as const) {
      await act(async () => panel.state.setMode(mode));
      assert.equal(panel.aside()?.dataset.presentation, "expanded", mode);
      assert.ok(panel.button("Restore Panel"), `${mode}: Restore Panel`);
    }

    await panel.remount();
    assert.equal(panel.state.expanded, true, "a reload restores it");
    assert.equal(panel.aside()?.dataset.presentation, "expanded");
  } finally {
    await panel.dispose();
  }
});

test("a phone has no Expand or Restore, and a stored Expanded state leaves its sheet alone (#2845)", async () => {
  saveBrowserStorageValue("wollipog.rightpanel.expanded", "1");
  phoneViewport = true;
  const panel = await mountPanel(390);
  try {
    await act(async () => panel.state.show("review"));
    assertNoDomNode(panel.button("Expand Panel"));
    assertNoDomNode(panel.button("Restore Panel"));
    assert.notEqual(panel.aside()?.dataset.presentation, "expanded");
    // Escape on a phone closes the sheet; the preference survives for the desktop.
    await pressEscape(panel.container.querySelector(".rpanel-switcher")!);
    assert.equal(panel.state.open, false);
    assert.equal(panel.state.expanded, true);
  } finally {
    await panel.dispose();
  }
});

test("in the overlay presentation, Expand fills the row with no scrim and Restore returns to the overlay (#2845)", async () => {
  // An 834px window less the 64px rail leaves the chat under 480px beside even a 320px panel.
  const panel = await mountPanel(834 - 64);
  try {
    await act(async () => panel.state.show("files"));
    assert.equal(panel.aside()?.dataset.presentation, "overlay");
    assert.ok(panel.container.querySelector(".rpanel-scrim"));
    await act(async () => panel.button("Expand Panel")!.click());
    assert.equal(panel.aside()?.dataset.presentation, "expanded");
    assertNoDomNode(panel.container.querySelector(".rpanel-scrim"), "the scrim is hidden");
    assertNoDomNode(panel.container.querySelector(".rpanel-resizer"));
    await act(async () => panel.button("Restore Panel")!.click());
    assert.equal(panel.aside()?.dataset.presentation, "overlay");
    assert.ok(panel.container.querySelector(".rpanel-scrim"), "the scrim returns");
  } finally {
    await panel.dispose();
  }
});

test("the separator's range ends where the chat column keeps 480px and the handle 10px, within 320–640px (#2845)", async () => {
  for (const [label, row, max] of [
    ["1280px with the rail", 1280 - 64, 640],
    ["1100px with the labelled rail", 1100 - 208, 1100 - 208 - 480 - 10],
    ["940px with the rail", 940 - 64, 940 - 64 - 480 - 10],
  ] as const) {
    saveBrowserStorageValue("wollipog.rightpanel.width", "640");
    const panel = await mountPanel(row);
    try {
      await act(async () => panel.state.show("review"));
      const handle = panel.container.querySelector<HTMLElement>(".rpanel-resizer")!;
      assert.equal(handle.getAttribute("aria-valuemax"), String(max), label);
      assert.equal(handle.getAttribute("aria-valuenow"), String(max), `${label}: a wider stored width renders clamped`);
      assert.equal(panel.state.width, 640, `${label}: and stays stored as it was`);
      assert.equal(panel.aside()?.dataset.presentation, "docked", `${label}: docked, not overlaid`);
    } finally {
      await panel.dispose();
    }
  }
});

test("focus left in the chat column moves to the switcher when the panel expands over it (#2845)", async () => {
  const panel = await mountPanel();
  try {
    // The opener sits in the row the panel shares with the chat column, as the composer does.
    const inRow = panel.container.querySelector<HTMLButtonElement>("#opener")!;
    await act(async () => panel.state.show("review"));
    inRow.focus();
    await act(async () => panel.state.setExpanded(true));
    assert.ok(isFocused(panel.container.querySelector(".rpanel-switcher")), "expanding moves focus into the panel");

    // Reopening an expanded panel from the hidden chat (the Side Panel chord in the composer) does too.
    await act(async () => panel.state.close());
    inRow.focus();
    await act(async () => panel.state.toggle());
    assert.equal(panel.aside()?.dataset.presentation, "expanded");
    assert.ok(isFocused(panel.container.querySelector(".rpanel-switcher")), "opening expanded moves focus into the panel");

    // Focus outside the row (the session bar's toggle) stays where it is.
    await act(async () => panel.state.close());
    const outside = domWindow.document.createElement("button");
    domWindow.document.body.append(outside);
    outside.focus();
    await act(async () => panel.state.toggle());
    assert.ok(isFocused(outside as unknown as Element), "focus outside the chat column is left alone");
    outside.remove();
  } finally {
    await panel.dispose();
  }
});
