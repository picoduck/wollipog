/**
 * #2202: while its session is not loaded, the Session page has one heading and a next step. On
 * desktop the bar keeps only Back and the state carries the page's `h1`; Not Found offers Back to
 * Sessions and Search Sessions; a load error offers Retry with the raw error behind Show Details; and
 * Loading is transcript skeleton rows after 300ms, with no sentence.
 */

import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, SessionView } from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { routedSessionPlaceholder } from "../detail-placeholder.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { SearchPaletteContext } from "./search-palette-context.js";
import { SessionDetail } from "./SessionDetail.js";
import { SESSION_PLACEHOLDER_SKELETON_DELAY_MS, SessionPlaceholder } from "./SessionPlaceholder.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  FocusEvent: domWindow.FocusEvent,
  MutationObserver: domWindow.MutationObserver,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: ControlPlaneToUi) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

async function flush(delay = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    await Promise.resolve();
  });
}

const SESSION_ID = "missing-session";

const snapshotSessions: SessionView[] = [];

async function mount(lookup: (id: string) => Promise<{ session: SessionView }>, lateStrictMount = false) {
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "placeholder", runtimeKey: "placeholder:1", createSocket: () => socket, close() {},
  };
  const navigation: ViewNavigation = {
    current: () => ({ name: "session", id: SESSION_ID }), push() {}, listen: () => () => {},
  };
  const lookups: string[] = [];
  const client = {
    ...api,
    session: (id: string) => {
      lookups.push(id);
      return lookup(id);
    },
    getSessionEventPage: () => new Promise<never>(() => {}),
    getSessionEventTailPage: () => new Promise<never>(() => {}),
  } as unknown as ApiClient;
  const rightPanel = {
    open: false, mode: "launcher" as const, width: 360, dragging: false, subagentTarget: null,
    toggle() {}, openMode() {}, show() {}, setMode() {}, setWidth() {}, expanded: false, setExpanded() {}, setDragging() {},
    close() {}, selectSubagent() {}, showSubagent() {}, consumeSubagentFocusRequest() {},
  };
  let backs = 0;
  let searches = 0;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  let showDetail = !lateStrictMount;
  const render = () => root.render(
    <ApiProvider client={client}>
      <FeedbackContext.Provider value={{ confirm: async () => true, showToast: () => 0, showUndo: () => 0, dismissToast: () => {} } as never}>
        <SearchPaletteContext.Provider value={() => { searches += 1; }}>
          <StoreProvider connection={connection} navigation={navigation}>
            {showDetail && <React.StrictMode><SessionDetail sessionId={SESSION_ID} mode="expanded" rightPanel={rightPanel}
              onBack={() => { backs += 1; }}
              onOpenTerminal={() => {}} composerDraftLoader={async () => null} /></React.StrictMode>}
          </StoreProvider>
        </SearchPaletteContext.Provider>
      </FeedbackContext.Provider>
    </ApiProvider>,
  );
  await act(async () => render());
  await act(async () => socket.push({
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners: [], boxes: [], projects: [], sessions: snapshotSessions, runs: [], pods: [],
  }));
  await flush();
  if (lateStrictMount) {
    showDetail = true;
    await act(async () => render());
    await flush();
  }
  const button = (name: string) => [...container.querySelectorAll("button")]
    .find((candidate) => candidate.textContent === name) as HTMLButtonElement | undefined;
  return {
    container,
    lookups,
    button,
    backs: () => backs,
    searches: () => searches,
    headings: () => [...container.querySelectorAll("h1")] as HTMLElement[],
    unmount: async () => {
      await flush(1);
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function session(): SessionView {
  return {
    id: SESSION_ID, runnerId: "runner-1", workspaceId: null, workspaceName: null, projectId: null,
    agentId: "codex", agentName: "Codex", title: "Archived Fixture", status: "stopped",
    column: "review", runId: null, useWorktree: false, worktreePath: null,
    archived: true, createdAt: 1, updatedAt: 1, lastEventAt: null, messageCount: 0,
    eventEpoch: 0, preview: null, pendingApproval: null, driver: "codex-app-server",
    model: null, effort: null, permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
  } as SessionView;
}

test("a Session mounted after connection readiness restarts its cancelled StrictMode lookup", async () => {
  const fixture = await mount(async () => { throw new ApiError("Not Found", 404); }, true);
  try {
    assert.equal(fixture.headings()[0]?.textContent, "Session Not Found");
    assert.deepEqual(fixture.lookups, [SESSION_ID, SESSION_ID], "the cancelled setup cannot suppress the live lookup");
  } finally {
    await fixture.unmount();
  }
});

test("a cancelled lookup's late success cannot replace the live missing-session result", async () => {
  let resolveCancelled!: (value: { session: SessionView }) => void;
  const cancelled = new Promise<{ session: SessionView }>((resolve) => { resolveCancelled = resolve; });
  let attempt = 0;
  const fixture = await mount(() => ++attempt === 1 ? cancelled : Promise.reject(new ApiError("Not Found", 404)), true);
  try {
    assert.equal(fixture.headings()[0]?.textContent, "Session Not Found");
    await act(async () => resolveCancelled({ session: session() }));
    await flush();
    assert.equal(fixture.headings()[0]?.textContent, "Session Not Found", "cancelled success never enters the store");
    assert.deepEqual(fixture.lookups, [SESSION_ID, SESSION_ID]);
  } finally {
    await fixture.unmount();
  }
});

test("a settled archived lookup keeps its dedup key and ignores the cancelled setup's late error", async () => {
  let rejectCancelled!: (cause: Error) => void;
  const cancelled = new Promise<{ session: SessionView }>((_resolve, reject) => { rejectCancelled = reject; });
  let attempt = 0;
  const fixture = await mount(() => ++attempt === 1 ? cancelled : Promise.resolve({ session: session() }), true);
  try {
    assertNoDomNode(fixture.container.querySelector("[data-placeholder]"), "the live lookup loads the archived session");
    assert.deepEqual(fixture.lookups, [SESSION_ID, SESSION_ID], "loading the row must not refetch the settled key");
    await act(async () => rejectCancelled(new ApiError("Not Found", 404)));
    await flush();
    assertNoDomNode(fixture.container.querySelector("[data-placeholder]"), "cancelled error cannot remove the loaded session");
    assert.deepEqual(fixture.lookups, [SESSION_ID, SESSION_ID]);
  } finally {
    await fixture.unmount();
  }
});

test("Not Found has exactly one h1, the page title, and offers Back to Sessions and Search Sessions", async () => {
  const fixture = await mount(async () => { throw new ApiError("Not Found", 404); });
  try {
    const headings = fixture.headings();
    assert.equal(headings.length, 1, "one page heading: the bar keeps only Back");
    assert.equal(headings[0]!.id, "page-title");
    assert.equal(headings[0]!.textContent, "Session Not Found");
    assert.equal(headings[0]!.getAttribute("tabindex"), "-1", "the focus-rescue anchor is focusable from script");
    assert.ok(fixture.container.querySelector(".session-bar .detail-bar-back"), "the bar keeps Back");
    assert.match(fixture.container.textContent ?? "", /It may have been deleted, or you may not have access\./u);

    await act(async () => fixture.button("Back to Sessions")!.click());
    assert.equal(fixture.backs(), 1);
    await act(async () => fixture.button("Search Sessions")!.click());
    assert.equal(fixture.searches(), 1);
  } finally {
    await fixture.unmount();
  }
});

test("a load error offers Retry, which reissues the lookup, and shows the raw error only behind Show Details", async () => {
  let attempt = 0;
  const fixture = await mount(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("HTTP 502: upstream connect error");
    return { session: session() };
  });
  try {
    const heading = fixture.headings();
    assert.equal(heading.length, 1);
    assert.equal(heading[0]!.id, "page-title");
    assert.equal(heading[0]!.textContent, "Couldn't Load Session");
    assert.doesNotMatch(fixture.container.textContent ?? "", /upstream connect error/u, "the raw error waits behind Show Details");

    await act(async () => fixture.button("Show Details")!.click());
    assert.match(fixture.container.textContent ?? "", /HTTP 502: upstream connect error/u);

    const retry = fixture.button("Retry")!;
    await act(async () => {
      retry.focus();
      retry.click();
    });
    await flush();
    assert.deepEqual(fixture.lookups, [SESSION_ID, SESSION_ID], "Retry reissues the lookup");
    assertNoDomNode(fixture.container.querySelector("[data-placeholder]"), "the retried lookup loads the session");
  } finally {
    await fixture.unmount();
  }
});

test("Retry moves focus to the page title rather than <body> while the lookup runs", async () => {
  let attempt = 0;
  const fixture = await mount(() => {
    attempt += 1;
    return attempt === 1 ? Promise.reject(new Error("HTTP 500")) : new Promise<never>(() => {});
  });
  try {
    const retry = fixture.button("Retry")!;
    await act(async () => {
      retry.focus();
      retry.click();
    });
    await flush();
    const title = fixture.container.querySelector("#page-title");
    assert.equal(title?.textContent, "Loading Session…");
    assert.ok(domWindow.document.activeElement === (title as never), "focus lands on the page title");
  } finally {
    await fixture.unmount();
  }
});

test("Loading is skeleton rows after 300ms, with a hidden page title and no sentence", async () => {
  const fixture = await mount(() => new Promise<never>(() => {}));
  try {
    const heading = fixture.headings();
    assert.equal(heading.length, 1);
    assert.equal(heading[0]!.textContent, "Loading Session…");
    assert.ok(heading[0]!.classList.contains("sr-only"));
    assertNoDomNode(fixture.container.querySelector(".transcript-skeleton"), "nothing new before 300ms");
    await flush(SESSION_PLACEHOLDER_SKELETON_DELAY_MS + 50);
    assert.ok(fixture.container.querySelector(".transcript-skeleton"));
    assertNoDomNode(fixture.container.querySelector(".state-body"), "no sentence");
    assert.doesNotMatch(fixture.container.textContent ?? "", /control[ -]plane/iu);
  } finally {
    await fixture.unmount();
  }
});

test("leaving Back during Loading is the person's choice, so the skeleton does not pull focus to the title", async () => {
  const fixture = await mount(() => new Promise<never>(() => {}));
  try {
    const back = fixture.container.querySelector(".session-bar .detail-bar-back") as HTMLButtonElement;
    await act(async () => back.focus());
    await act(async () => back.blur());
    assert.ok(domWindow.document.activeElement === (domWindow.document.body as never));
    await flush(SESSION_PLACEHOLDER_SKELETON_DELAY_MS + 50);
    assert.ok(fixture.container.querySelector(".transcript-skeleton"), "the skeleton has appeared");
    assert.ok(domWindow.document.activeElement === (domWindow.document.body as never), "focus stays where the person left it");
  } finally {
    await fixture.unmount();
  }
});

async function renderPlaceholder(element: React.ReactElement) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("on a phone the state leaves its title to the top bar, and keeps the next step", async () => {
  const notFound = routedSessionPlaceholder(SESSION_ID, { sessionId: SESSION_ID, complete: true, error: null }, "online");
  const fixture = await renderPlaceholder(
    <SessionPlaceholder sessionId={SESSION_ID} placeholder={notFound} preview={false} isMobile
      onBack={() => {}} onRetry={() => {}} />,
  );
  try {
    assertNoDomNode(fixture.container.querySelector("h1"), "the phone top bar holds the page heading");
    assertNoDomNode(fixture.container.querySelector(".state-title"), "the title is not repeated");
    assertNoDomNode(fixture.container.querySelector(".session-bar"));
    assert.match(fixture.container.textContent ?? "", /It may have been deleted, or you may not have access\./u);
    assert.ok([...fixture.container.querySelectorAll("button")].some((button) => button.textContent === "Back to Sessions"));
  } finally {
    await fixture.unmount();
  }
});

test("a preview pane keeps a plain title and no Back, since it is already on Sessions", async () => {
  const notFound = routedSessionPlaceholder(SESSION_ID, { sessionId: SESSION_ID, complete: true, error: null }, "online");
  const fixture = await renderPlaceholder(
    <SessionPlaceholder sessionId={SESSION_ID} placeholder={notFound} preview isMobile={false}
      onBack={() => {}} onRetry={() => {}} />,
  );
  try {
    assertNoDomNode(fixture.container.querySelector("h1"));
    assert.equal(fixture.container.querySelector(".state-title")?.textContent, "Session Not Found");
    assert.equal([...fixture.container.querySelectorAll("button")].some((button) => button.textContent === "Back to Sessions"), false);
  } finally {
    await fixture.unmount();
  }
});
