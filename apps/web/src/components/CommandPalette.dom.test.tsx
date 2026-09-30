import assert from "node:assert/strict";
import { test } from "node:test";
import { fireDomEvent } from "./test-dom-events.js";
import React, { act, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView, UiSnapshotMessage } from "@wollipog/protocol";
import type { ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { View, ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { getRailPreferences, resetRailPreferencesForTest, setRailViewHidden } from "../rail-preferences.js";
import { RECENT_SESSIONS_KEY } from "../recent-sessions.js";
import { saveInstanceStorageValue } from "../instance-storage.js";
import { takeArchiveSearch } from "../archive-search-handoff.js";
import { CommandPalette, useSearchShortcut } from "./CommandPalette.js";
import { AppBarSearchProvider, DetailBar, PageHeader } from "./PageHeader.js";
import { Rail } from "./Rail.js";
import { useIsMobile } from "./useIsMobile.js";

/**
 * The command palette in the DOM (#1978): each trigger gets focus back when the palette closes,
 * and the sections, the searching row, the short-query hint and the no-results sentence render as
 * the issue specifies. The section model itself is palette.test.ts.
 */

const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
const { cleanup } = installDomTestCleanup(domWindow, {
  reset: () => {
    domWindow.localStorage.clear();
    resetRailPreferencesForTest();
  },
});
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  KeyboardEvent: domWindow.KeyboardEvent,
  Event: domWindow.Event,
  Element: domWindow.Element,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: UiSnapshotMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

function session(id: string, title: string, over: Partial<SessionView> = {}): SessionView {
  return {
    id, runnerId: "runner-1", workspaceId: "w", workspaceName: "repo", agentId: "claude", agentName: "Claude Code",
    title, status: "idle", column: "review", archived: false, createdAt: 1, updatedAt: 1, pendingApproval: null,
    driver: "claude-code", ...over,
  } as unknown as SessionView;
}

const SESSIONS = [
  session("s-login", "Fix the login bug", { updatedAt: 3 }),
  session("s-docs", "Write the docs", { updatedAt: 2 }),
  session("s-other", "Other work", { updatedAt: 1 }),
];

interface SearchCall { query: string; resolve: (results: { sessionId: string; snippet: string; title: string }[]) => void }

let sequence = 0;

async function mount(options: { view?: View; appBarSearchOnPhoneOnly?: boolean } = {}) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  sequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `palette-${sequence}`,
    runtimeKey: `palette-${sequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  const navigation: ViewNavigation = { current: () => options.view ?? { name: "inbox" }, push() {}, listen: () => () => {} };
  const searches: SearchCall[] = [];
  const client = {
    listAllSessions: async () => ({ sessions: SESSIONS }),
    search: (query: string) => new Promise((resolve) => {
      searches.push({ query, resolve: (results) => resolve({ results }) });
    }),
  } as unknown as ApiClient;
  let currentView: View | null = null;
  function ViewProbe() {
    currentView = useStoreSelector((state) => state.view);
    return null;
  }
  function Harness() {
    const [open, setOpen] = useState(false);
    const openPalette = useCallback(() => setOpen(true), []);
    const toggle = useCallback(() => setOpen((value) => !value), []);
    useSearchShortcut(toggle);
    // As in App: the app bar's Search exists only at 760px and below.
    const isMobile = useIsMobile();
    const appBarSearch = options.appBarSearchOnPhoneOnly && !isMobile ? undefined : openPalette;
    return (
      <>
        <Rail
          view={{ name: "inbox" }}
          blockedCount={0}
          stalledCount={0}
          onlineConnections={0}
          onNavigate={() => {}}
          onSearch={openPalette}
        />
        <AppBarSearchProvider onSearch={appBarSearch}>
          <div className="page-app-bar"><PageHeader title="Projects" /></div>
          <div className="entity-app-bar"><DetailBar title="A Pod" backLabel="Back to Pods" onBack={() => {}} /></div>
        </AppBarSearchProvider>
        <input aria-label="Elsewhere" />
        <ViewProbe />
        {open && <CommandPalette onClose={() => setOpen(false)} />}
      </>
    );
  }
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}>
          <Harness />
        </StoreProvider>
      </ApiProvider>,
    );
  });
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
      runners: [], boxes: [], projects: [], sessions: SESSIONS, runs: [], pods: [],
    } as unknown as UiSnapshotMessage);
  });
  cleanup(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const doc = domWindow.document as unknown as Document;
  return {
    doc,
    searches,
    view: () => currentView,
    palette: () => doc.querySelector<HTMLElement>('[role="dialog"][aria-label="Search"]'),
    input: () => doc.querySelector<HTMLInputElement>(".palette-input")!,
    sections: () => [...doc.querySelectorAll<HTMLElement>('.palette [role="group"]')].map((group) => [
      doc.getElementById(group.getAttribute("aria-labelledby")!)!.textContent,
      [...group.querySelectorAll('[role="option"] .palette-label')].map((label) => label.textContent),
    ]),
    type: async (value: string) => {
      const input = doc.querySelector<HTMLInputElement>(".palette-input")!;
      await act(async () => { fireDomEvent.change(input, { target: { value } }); });
    },
    key: async (target: Element, key: string, init: { ctrlKey?: boolean; shiftKey?: boolean } = {}) => {
      await act(async () => {
        target.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }) as never);
      });
    },
  };
}

/** Wait out the palette's restore timer (a zero-delay timeout after it unmounts). */
async function settle(ms = 0) {
  // On the window's own timer queue, so it runs after the palette's zero-delay restore timer.
  await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, ms)); });
}

test("closing the palette returns focus to whichever trigger opened it", async () => {
  const ui = await mount();
  const triggers: Array<[string, () => HTMLElement]> = [
    ["the rail's Search item", () => ui.doc.querySelector<HTMLElement>('.app-rail [aria-label="Search"]')!],
    ["a destination's app bar Search icon", () => ui.doc.querySelector<HTMLElement>('.page-app-bar [aria-label="Search"]')!],
    ["an entity page's app bar Search icon", () => ui.doc.querySelector<HTMLElement>('.entity-app-bar [aria-label="Search"]')!],
  ];
  for (const [name, trigger] of triggers) {
    await act(async () => { trigger().click(); });
    assert.ok(ui.palette(), `${name} opens the palette`);
    assert.equal(ui.doc.activeElement, ui.input(), "the search field takes focus");
    await ui.key(ui.input(), "Escape");
    assertNoDomNode(ui.palette(), "Escape closes it");
    await settle();
    assert.equal(ui.doc.activeElement, trigger(), `focus is back on ${name}`);
  }

  // Ctrl+K from wherever focus is, and Ctrl+K again to close.
  const elsewhere = ui.doc.querySelector<HTMLElement>('input[aria-label="Elsewhere"]')!;
  await act(async () => { elsewhere.focus(); });
  await ui.key(elsewhere, "k", { ctrlKey: true });
  assert.ok(ui.palette(), "Ctrl+K opens the palette");
  await ui.key(ui.input(), "k", { ctrlKey: true });
  assertNoDomNode(ui.palette(), "Ctrl+K closes it again");
  await settle();
  assert.equal(ui.doc.activeElement, elsewhere, "focus is back where Ctrl+K was pressed");
});

test("an empty query shows Recent, Go To and Actions; arrows move across sections", async () => {
  saveInstanceStorageValue(RECENT_SESSIONS_KEY, JSON.stringify(["s-other", "s-login"]));
  setRailViewHidden("usage", true);
  const ui = await mount();
  await ui.key(ui.doc.body, "k", { ctrlKey: true });
  const [recent, goTo, actions] = ui.sections();
  assert.deepEqual(recent, ["Recent", ["Other work", "Fix the login bug"]]);
  assert.equal(goTo![0], "Go To");
  assert.deepEqual((goTo![1] as string[]).slice(0, 3), ["Sessions", "Automations", "Projects"]);
  assert.ok((goTo![1] as string[]).includes("Appearance"), "Settings sections are named by themselves");
  assert.ok(!(goTo![1] as string[]).includes("Usage and Cost"), "a hidden destination is not listed");
  assert.deepEqual(actions, ["Actions", ["Switch to Board View", "Show Navigation Labels"]]);
  const appearance = [...ui.doc.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((option) => option.querySelector(".palette-label")?.textContent === "Appearance")!;
  assert.equal(appearance.querySelector(".palette-detail")?.textContent, "Settings");
  const sessions = [...ui.doc.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((option) => option.querySelector(".palette-label")?.textContent === "Sessions")!;
  assert.equal(sessions.querySelector("kbd")?.textContent, "1", "a destination shows its digit");
  assert.equal(ui.doc.querySelectorAll(".palette-kind").length, 0);

  // The active row walks from Recent into Go To with one listbox's aria-activedescendant.
  const active = () => ui.doc.getElementById(ui.input().getAttribute("aria-activedescendant")!)!;
  assert.equal(active().querySelector(".palette-label")?.textContent, "Other work");
  await ui.key(ui.input(), "ArrowDown");
  await ui.key(ui.input(), "ArrowDown");
  assert.equal(active().querySelector(".palette-label")?.textContent, "Sessions");
  assert.equal(active().getAttribute("aria-selected"), "true");
  assert.equal(ui.doc.querySelectorAll('[role="listbox"]').length, 1, "one listbox holds every section");
});

test("Show Navigation Labels turns the labelled rail on through the one preference writer", async () => {
  const ui = await mount();
  assert.equal(getRailPreferences().labels, false);
  await ui.key(ui.doc.body, "k", { ctrlKey: true });
  await ui.type("navigation labels");
  assert.deepEqual(ui.sections(), [["Actions", ["Show Navigation Labels"]]]);
  await ui.key(ui.input(), "Enter");
  assertNoDomNode(ui.palette());
  assert.equal(getRailPreferences().labels, true);
  await ui.key(ui.doc.body, "k", { ctrlKey: true });
  await ui.type("navigation labels");
  assert.deepEqual(ui.sections(), [["Actions", ["Hide Navigation Labels"]]], "the action names the state it switches to");
});

test("transcript search: a hint under three characters, a searching row, and earlier hits kept until replaced", async () => {
  const ui = await mount();
  await ui.key(ui.doc.body, "k", { ctrlKey: true });
  await ui.type("lo");
  assert.match(ui.doc.querySelector('.palette [role="status"]')!.textContent!, /Type 3 or more characters to search transcripts\./);
  assert.deepEqual(ui.sections(), [["Sessions", ["Fix the login bug"]]]);

  await ui.type("login");
  assert.match(ui.doc.querySelector('.palette [role="status"]')!.textContent!, /Searching transcripts…/);
  await settle(250);
  assert.equal(ui.searches.at(-1)?.query, "login");
  await act(async () => {
    ui.searches.at(-1)!.resolve([
      { sessionId: "s-login", title: "Fix the login bug", snippet: "the ⟪login⟫ form" },
      { sessionId: "s-docs", title: "Write the docs", snippet: "…t document the ⟪login⟫ flow" },
    ]);
  });
  assert.deepEqual(ui.sections(), [["Sessions", ["Fix the login bug"]], ["In Transcripts", ["Write the docs"]]]);
  assert.equal(ui.doc.querySelector(".palette-snippet")?.textContent, "the login form",
    "the title match carries its transcript hit as a third line instead of a second row");
  assert.equal(ui.doc.querySelectorAll(".palette-snippet")[1]?.textContent, "…document the login flow",
    "a snippet starts on a word");
  assert.doesNotMatch(ui.doc.querySelector('.palette [role="status"]')!.textContent!, /Searching/);

  await ui.type("login form");
  assert.match(ui.doc.querySelector('.palette [role="status"]')!.textContent!, /Searching transcripts…/);
  assert.deepEqual(ui.sections(), [["In Transcripts", ["Fix the login bug", "Write the docs"]]],
    "the earlier hits stay until new ones arrive, rather than clearing on every keystroke");
  await settle(250);
  await act(async () => {
    ui.searches.at(-1)!.resolve([{ sessionId: "s-other", title: "Other work", snippet: "the ⟪login⟫ ⟪form⟫" }]);
  });
  assert.deepEqual(ui.sections(), [["In Transcripts", ["Other work"]]], "and are replaced when they do");
});

test("no results: the sentence, Clear Search and Search Archived Sessions", async () => {
  const ui = await mount();
  await ui.key(ui.doc.body, "k", { ctrlKey: true });
  await ui.type("zzzz");
  await settle(250);
  await act(async () => { ui.searches.at(-1)!.resolve([]); });
  const empty = ui.doc.querySelector<HTMLElement>(".palette-empty")!;
  assert.equal(empty.querySelector("p")?.textContent, "No sessions, transcripts or pages match “zzzz”.");
  const [clear, archive] = [...empty.querySelectorAll<HTMLButtonElement>("button")];
  assert.equal(clear?.textContent, "Clear Search");
  assert.equal(archive?.textContent, "Search Archived Sessions");
  await act(async () => { clear!.click(); });
  assert.equal(ui.input().value, "");
  assert.equal(ui.doc.activeElement, ui.input());

  await ui.type("zzzz");
  await settle(250);
  await act(async () => { ui.searches.at(-1)!.resolve([]); });
  await act(async () => { ui.doc.querySelectorAll<HTMLButtonElement>(".palette-empty button")[1]!.click(); });
  assertNoDomNode(ui.palette());
  assert.deepEqual(ui.view(), { name: "archived" });
  assert.equal(takeArchiveSearch(), "zzzz", "Archived Sessions opens searching for the same words");
});

test("at 760px and below: Cancel closes, and the labelled rail is not offered", async () => {
  await act(async () => { domWindow.happyDOM.setViewport({ width: 390, height: 844 }); });
  try {
    const ui = await mount();
    await act(async () => { ui.doc.querySelector<HTMLElement>('.page-app-bar [aria-label="Search"]')!.click(); });
    const actions = ui.sections().find(([label]) => label === "Actions");
    assert.deepEqual(actions, ["Actions", ["Switch to Board View"]]);
    const sessions = [...ui.doc.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.querySelector(".palette-label")?.textContent === "Sessions")!;
    assertNoDomNode(sessions.querySelector("kbd"), "a phone has no digit shortcuts to show");
    const cancel = [...ui.doc.querySelectorAll<HTMLButtonElement>(".palette button")].find((button) => button.textContent === "Cancel")!;
    await act(async () => { cancel.click(); });
    assertNoDomNode(ui.palette());
  } finally {
    await act(async () => { domWindow.happyDOM.setViewport({ width: 1440, height: 900 }); });
  }
});

test("crossing 760px with Cancel focused keeps focus in the palette, so Escape still closes it", async () => {
  await act(async () => { domWindow.happyDOM.setViewport({ width: 390, height: 844 }); });
  try {
    const ui = await mount({ appBarSearchOnPhoneOnly: true });
    await act(async () => { ui.doc.querySelector<HTMLElement>('.page-app-bar [aria-label="Search"]')!.click(); });
    const cancel = [...ui.doc.querySelectorAll<HTMLButtonElement>(".palette button")].find((button) => button.textContent === "Cancel")!;
    await act(async () => { cancel.focus(); });
    await act(async () => { domWindow.happyDOM.setViewport({ width: 1440, height: 900 }); });
    assert.ok(ui.doc.activeElement === ui.input(), `Cancel went with the phone layout, so focus moves to the field (found ${ui.doc.activeElement?.tagName})`);
    await ui.key(ui.input(), "Escape");
    assertNoDomNode(ui.palette(), "Escape still reaches the palette");
  } finally {
    await act(async () => { domWindow.happyDOM.setViewport({ width: 1440, height: 900 }); });
  }
});
