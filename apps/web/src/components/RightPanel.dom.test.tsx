import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { DescendantRequestView, SessionView } from "@wollipog/protocol";
import { sessionRequestPanelKey } from "./SessionRequestPanel.js";
import type { TimelineItem } from "../timeline.js";
import {
  PanelActionSlotContext,
  PanelHeaderActions,
  panelReturnFocusTarget,
  RightPanel,
  useRightPanelState,
  type RightPanelState,
} from "./RightPanel.js";
import type { GovernanceDecision } from "../governance.js";
import { saveBrowserStorageValue } from "../instance-storage.js";
import { clearPanelScratch } from "../right-panel-scratch.js";
import type { GitStatus } from "./useGitStatus.js";
import { StoreProvider } from "../store.js";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime } from "../ui-transport.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const connection: UiConnectionRuntime = {
  instanceId: "right-panel-test", runtimeKey: "right-panel-test",
  createSocket: () => ({ readyState: UI_SOCKET_OPEN, onopen: null, onmessage: null,
    onclose: null, onerror: null, send() {}, close() {} }),
  close() {},
};

/**
 * The panel asks for a durable child-session registry as soon as it mounts. Left unstubbed, that
 * request goes to the real control-plane origin over the network and settles whenever the socket
 * says so — routinely after the test that mounted the panel has ended and `after` has restored
 * `window`, where React's own `resolveUpdatePriority` reads `window.event` and throws into a
 * promise nothing is waiting on (#911).
 *
 * Rejecting is what this fixture has always exercised, unknowingly: no control plane it reaches
 * knows `session-1`, so the roster these tests assert on is the one projected from `items`.
 */
const client = {
  ...api,
  childSessions: () => Promise.reject(new ApiError("This fixture has no durable child-session registry.", 404)),
} as ApiClient;

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
/** The viewport the panel reads through useIsMobile and useIsCoarsePointer; a desktop by default. */
let phoneViewport = false;
let coarsePointer = false;
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  writable: true,
  value: (query: string) => ({
    get matches() {
      if (query === "(max-width: 760px)") return phoneViewport;
      return query === "(pointer: coarse)" ? coarsePointer : false;
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
  // Panel scratch survives unmount on purpose (#1202); these cases share one session id.
  clearPanelScratch();
});

after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  domWindow.close();
});

const liveSession = {
  id: "session-1",
  runnerId: "runner-1",
  driver: "claude-code",
  status: "running",
  adopted: false,
  eventEpoch: 2,
} as SessionView;

const agentItems: TimelineItem[] = [
  { kind: "tool_call", id: 1, toolCallId: "agent", title: "Audit Agent", text: "", toolKind: "agent", status: "in_progress", startedAt: 10 },
  { kind: "agent_message", id: 2, text: "working", parentToolUseId: "agent", createdAt: 20 },
];

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

const governanceDecision: GovernanceDecision = {
  auditId: "audit-1",
  requestId: "req-1",
  outcome: "allowed",
  actor: { kind: "policy", policyId: "allow-read" },
  policyId: "allow-read",
  detail: "The matched policy allowed this tool.",
  timestamp: 1_700_000_000_000,
};

function PanelHarness({
  initialSession = liveSession,
  initialRunnerOnline = true,
  decisionHistory,
  decisionHistoryHasMore,
  descendantRequests,
  descendantRequestStatus,
  selectedRequestKey,
  git: harnessGit = git,
  onState,
}: {
  initialSession?: SessionView;
  initialRunnerOnline?: boolean;
  decisionHistory?: readonly GovernanceDecision[];
  decisionHistoryHasMore?: boolean;
  descendantRequests?: readonly DescendantRequestView[];
  descendantRequestStatus?: "idle" | "loading" | "ready" | "unavailable";
  selectedRequestKey?: string | null;
  git?: GitStatus;
  onState: (state: RightPanelState) => void;
}) {
  const state = useRightPanelState();
  const [session, setSession] = useState(initialSession);
  const [runnerOnline, setRunnerOnline] = useState(initialRunnerOnline);
  onState(state);
  return (
    <>
      <button type="button" id="open-agent" onClick={() => state.showSubagent(session.id, session.eventEpoch ?? 0, "agent")}>Open Agent</button>
      <button
        type="button"
        id="switch-generation"
        onClick={() => {
          state.showSubagent(session.id, session.eventEpoch ?? 0, "agent");
          setSession({ ...session, id: "session-2", eventEpoch: (session.eventEpoch ?? 0) + 1 });
        }}
      >
        Switch Generation
      </button>
      <button type="button" id="recorded" onClick={() => {
        setRunnerOnline(false);
        setSession((current) => ({ ...current, adopted: true, status: "completed" }));
      }}>Recorded</button>
      <button type="button" id="adopted-live" onClick={() => {
        setSession((current) => ({ ...current, adopted: true, status: "running" }));
        setRunnerOnline(true);
      }}>Adopted Live</button>
      <ApiProvider client={client}><StoreProvider connection={connection}><RightPanel
        state={state}
        session={session}
        runnerOnline={runnerOnline}
        runnerProtocolVersion={null}
        git={harnessGit}
        items={agentItems}
        decisionHistory={decisionHistory}
        decisionHistoryHasMore={decisionHistoryHasMore}
        descendantRequests={descendantRequests}
        descendantRequestStatus={descendantRequestStatus}
        selectedRequestKey={selectedRequestKey}
        onLoadOlderDecisions={() => {}}
        onOpenSourceLocation={() => {}}
        onClearSourceLocation={() => {}}
        onOpenTerminal={() => {}}
        onInsertSideChatDraft={() => {}}
      /></StoreProvider></ApiProvider>
    </>
  );
}

test("panel close falls back to the session composer when virtualization removes its trigger", () => {
  const surface = domWindow.document.createElement("section") as unknown as HTMLElement;
  surface.dataset.sessionSurfaceId = "focus-session";
  const composer = domWindow.document.createElement("textarea") as unknown as HTMLElement;
  composer.className = "composer-input";
  surface.append(composer);
  domWindow.document.body.append(surface as never);
  const detachedTrigger = domWindow.document.createElement("button") as unknown as HTMLElement;
  try {
    assert.equal(panelReturnFocusTarget(detachedTrigger, "focus-session", domWindow.document as unknown as ParentNode), composer);
    // A phone falls back to the conversation instead, so no software keyboard comes up (#2843).
    const reader = domWindow.document.createElement("div") as unknown as HTMLElement;
    reader.className = "detail-scroll";
    surface.append(reader);
    assert.equal(panelReturnFocusTarget(detachedTrigger, "focus-session", domWindow.document as unknown as ParentNode, true), reader);
    surface.append(detachedTrigger);
    assert.equal(panelReturnFocusTarget(detachedTrigger, "focus-session", domWindow.document as unknown as ParentNode), detachedTrigger);
    assert.equal(panelReturnFocusTarget(detachedTrigger, "focus-session", domWindow.document as unknown as ParentNode, true), detachedTrigger,
      "an opener still on screen takes focus back on a phone too");
  } finally {
    surface.remove();
  }
});

test("RightPanel consumes a transcript focus request in shared state and does not replay it after remount", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  let state!: RightPanelState;
  try {
    await act(async () => root.render(<PanelHarness onState={(next) => { state = next; }} />));
    await act(async () => container.querySelector<HTMLButtonElement>("#open-agent")!.click());
    const detail = container.querySelector<HTMLElement>(".subagent-detail")!;
    assert.equal(domWindow.document.activeElement, detail);
    assert.equal(state.subagentTarget?.subagentId, "agent");
    assert.equal(state.subagentTarget?.focusRequest, undefined, "the mounted panel acknowledges shared focus intent");

    await act(async () => state.close());
    const sentinel = container.querySelector<HTMLButtonElement>("#open-agent")!;
    sentinel.focus();
    await act(async () => state.show("subagents"));
    assert.equal(domWindow.document.activeElement, sentinel, "reopening cannot replay a consumed request");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("RightPanel drops unmounted-generation focus intent and renders honest offline/recorded lifecycle copy", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  let state!: RightPanelState;
  try {
    await act(async () => root.render(<PanelHarness initialRunnerOnline={false} onState={(next) => { state = next; }} />));
    await act(async () => container.querySelector<HTMLButtonElement>("#switch-generation")!.click());
    assert.equal(state.subagentTarget?.sessionId, "session-1");
    assert.equal(state.subagentTarget?.focusRequest, undefined,
      "a request is consumed when its session generation is not the mounted panel");
    assertNoDomNode(container.querySelector(".subagent-detail"),
      "a stale target does not select a different session's worker");
    await act(async () => {
      const history = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Worker Filter"] button')]
        .find((button) => button.textContent?.startsWith("History"))!;
      history.click();
    });
    await act(async () => container.querySelector<HTMLButtonElement>(".agents-list button")!.click());
    assert.match(container.querySelector(".subagent-detail-meta")?.textContent ?? "", /Recorded Activity/,
      "offline active state is explicitly recorded rather than current");

    await act(async () => container.querySelector<HTMLButtonElement>("#recorded")!.click());
    assert.match(container.querySelector(".subagent-detail-meta")?.textContent ?? "", /Interrupted · Recorded Activity/,
      "recorded state preserves the observed nonterminal tool lifecycle without claiming reachability");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("an adopted session that is online and running reports Current Activity", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => root.render(<PanelHarness onState={() => {}} />));
    await act(async () => container.querySelector<HTMLButtonElement>("#open-agent")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>("#adopted-live")!.click());
    const detail = container.querySelector(".subagent-detail-meta")?.textContent ?? "";
    assert.match(detail, /Running .* Current Activity/);
    assert.doesNotMatch(container.querySelector(".subagents-panel")?.textContent ?? "", /Recorded/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

async function mountPanel(element: React.ReactElement) {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("Decision History renders only its list, empty state, and paging control", async () => {
  // Every state the mode can reach must be free of the placeholder hint that used to trail the
  // panel body for any mode outside a hard-coded allow list (#1201).
  for (const [name, props] of [
    ["populated", { decisionHistory: [governanceDecision], decisionHistoryHasMore: false }],
    ["empty page with more available", { decisionHistory: [], decisionHistoryHasMore: true }],
    ["empty", { decisionHistory: [], decisionHistoryHasMore: false }],
  ] as const) {
    let state!: RightPanelState;
    const panel = await mountPanel(<PanelHarness {...props} onState={(next) => { state = next; }} />);
    try {
      await act(async () => state.show("decisions"));
      assert.equal(panel.container.querySelector(".rpanel-switcher-name")?.textContent, "Decision History");
      const body = panel.container.querySelector(".rpanel-body")!;
      assert.doesNotMatch(body.textContent ?? "", /Coming soon/, `${name} must not render a placeholder hint`);
      if (name === "populated") {
        assert.match(body.textContent ?? "", /AllowedTool Requestby Policy/);
        assertNoDomNode(body.querySelector(".decision-history-more"), "no paging control without more pages");
      } else if (name === "empty page with more available") {
        assert.match(body.textContent ?? "", /No decisions are loaded yet\./);
        assert.equal(body.querySelector(".decision-history-more")?.textContent, "Load Older Decisions");
      } else {
        assert.match(body.textContent ?? "", /No Decisions Yet/);
        assert.match(body.textContent ?? "", /Decisions you and your approval policies make in this session appear here\./);
        assertNoDomNode(body.querySelector(".decision-history-more"));
      }
    } finally {
      await panel.dispose();
    }
  }
});

test("the Decision History launcher row is enabled with no decisions and opens the empty state (#2213)", async () => {
  let state!: RightPanelState;
  const panel = await mountPanel(<PanelHarness decisionHistory={[]} onState={(next) => { state = next; }} />);
  try {
    await act(async () => state.show("launcher"));
    const row = [...panel.container.querySelectorAll<HTMLButtonElement>(".rp-launcher .rp-row")]
      .find((candidate) => candidate.textContent === "Decision History");
    assert.ok(row, "the launcher lists Decision History");
    assert.equal(row.disabled, false);
    assert.equal(row.getAttribute("aria-disabled"), null);
    await act(async () => row.click());
    assert.equal(state.mode, "decisions");
    assert.match(panel.container.querySelector(".rpanel-body")?.textContent ?? "", /No Decisions Yet/);
    assert.doesNotMatch(panel.container.textContent ?? "", /Governance History/);
  } finally {
    await panel.dispose();
  }
});

test("the Requests launcher row is enabled with nothing pending and opens Nothing Waiting (#2206)", async () => {
  let state!: RightPanelState;
  const panel = await mountPanel(<PanelHarness onState={(next) => { state = next; }} />);
  try {
    await act(async () => state.show("launcher"));
    const row = [...panel.container.querySelectorAll<HTMLButtonElement>(".rp-launcher .rp-row")]
      .find((candidate) => candidate.textContent === "Requests");
    assert.ok(row, "the launcher lists Requests");
    assert.equal(row.disabled, false);
    assert.equal(row.getAttribute("aria-disabled"), null);
    assert.equal(row.getAttribute("title"), null, "no tooltip stands in for a reason");
    await act(async () => row.click());
    assert.equal(state.mode, "requests");
    const body = panel.container.querySelector(".rpanel-body")!;
    assert.equal(body.querySelector(".state-title")?.textContent, "Nothing Waiting");
    const history = [...body.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Decision History");
    assert.ok(history, "the empty state links to Decision History (#2213)");
    await act(async () => history.click());
    assert.equal(state.mode, "decisions");
  } finally {
    await panel.dispose();
  }
});

test("the panel head's back control leaves only while a request's detail is shown (#2206)", async () => {
  const child: DescendantRequestView = {
    sessionId: "child-1",
    sessionTitle: "Child Session 1",
    runnerId: "runner-1",
    runnerOnline: true,
    eventEpoch: 1,
    createdAt: Date.now(),
    responseOwner: "human",
    occurrenceId: "occurrence-1",
    request: {
      requestId: "question-1",
      occurrenceId: "occurrence-1",
      kind: "question",
      title: "Question",
      options: [],
      questions: [{ id: "target", question: "Choose a target", options: [{ label: "Staging" }] }],
    },
  };
  const key = sessionRequestPanelKey(child.sessionId, child.occurrenceId);
  for (const [name, props, detailShown] of [
    ["the open request's detail", { descendantRequests: [child], descendantRequestStatus: "ready" }, true],
    // Polling failed with the request open: the panel shows its unavailable state, not the detail.
    ["unavailable with the request still selected", { descendantRequests: [], descendantRequestStatus: "unavailable" }, false],
    ["loading with the request still selected", { descendantRequests: [], descendantRequestStatus: "loading" }, false],
  ] as const) {
    let state!: RightPanelState;
    const panel = await mountPanel(<PanelHarness {...props} selectedRequestKey={key} onState={(next) => { state = next; }} />);
    try {
      await act(async () => state.show("requests"));
      // The header never has a back control (#2843): Session Tools is the switcher's first item.
      const head = panel.container.querySelector(".rpanel-head")!;
      assert.deepEqual([...head.querySelectorAll("button")].map((button) => button.getAttribute("aria-label") ?? button.textContent),
        ["Requests", "Close Panel"], name);
      assert.equal(panel.container.querySelector(".request-panel-back") !== null, detailShown,
        `${name}: a request's detail keeps its own All Requests in the body`);
    } finally {
      await panel.dispose();
    }
  }
});

test("the close button is an icon named Close Panel in every mode, Requests included (#2206)", async () => {
  let state!: RightPanelState;
  const panel = await mountPanel(<PanelHarness onState={(next) => { state = next; }} />);
  try {
    for (const mode of ["launcher", "requests", "decisions", "subagents"] as const) {
      await act(async () => state.show(mode));
      const close = panel.container.querySelector<HTMLButtonElement>('[aria-label="Close Panel"]')!;
      assert.equal(close.getAttribute("aria-label"), "Close Panel", mode);
      assert.match(close.className, /\bicon-btn\b/u, mode);
      assert.equal(close.textContent, "", `${mode}: no "Close" or × text`);
      assert.ok(close.querySelector("svg"), `${mode}: an icon`);
    }
  } finally {
    await panel.dispose();
  }
});

test("every mode overlays the chat with a scrim where docking would leave it under 480px, and docks otherwise (#2725)", async () => {
  let state!: RightPanelState;
  const panel = await mountPanel(<PanelHarness onState={(next) => { state = next; }} />);
  // The row the chat column and the panel share is the panel's parent here.
  let rowWidth = 700;
  panel.container.getBoundingClientRect = () => ({
    width: rowWidth, height: 600, top: 0, left: 0, right: rowWidth, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
  }) as DOMRect;
  const aside = () => panel.container.querySelector<HTMLElement>("#right-panel");
  const opener = panel.container.querySelector<HTMLButtonElement>("#recorded")!;
  const nextFrame = () => act(async () => {
    await new Promise((resolve) => domWindow.requestAnimationFrame(() => resolve(undefined)));
  });
  try {
    const storedWidth = state.width;
    for (const mode of ["launcher", "requests", "review", "files", "decisions", "subagents", "background"] as const) {
      await act(async () => state.show(mode));
      assert.equal(aside()?.dataset.presentation, "overlay", mode);
      assert.ok(panel.container.querySelector(".rpanel-scrim"), `${mode}: a scrim covers the chat column`);
      assertNoDomNode(panel.container.querySelector(".rpanel-resizer"), `${mode}: no resize handle while overlaid`);
    }
    assert.equal(state.width, storedWidth, "overlaying leaves the stored width alone");

    // A press on the scrim closes the panel and returns focus as Close Panel does.
    for (const close of [
      () => panel.container.querySelector<HTMLElement>('[aria-label="Close Panel"]')!.click(),
      () => panel.container.querySelector<HTMLElement>(".rpanel-scrim")!.click(),
    ]) {
      await act(async () => { state.close(); });
      opener.focus();
      await act(async () => state.show("files"));
      await act(async () => close());
      await nextFrame();
      assert.equal(state.open, false);
      assert.ok((domWindow.document.activeElement as unknown as Element | null) === (opener as unknown as Element),
        "focus returns to the opener");
    }

    rowWidth = 1200;
    await act(async () => state.show("review"));
    assert.equal(aside()?.dataset.presentation, "docked");
    assertNoDomNode(panel.container.querySelector(".rpanel-scrim"), "a docked panel draws no scrim");
    assert.ok(panel.container.querySelector(".rpanel-resizer"), "and keeps its handle");
  } finally {
    await panel.dispose();
  }
});

test("keyboard resizing into an overlay moves focus from the removed handle to Close Panel (#2725)", async () => {
  let state!: RightPanelState;
  const panel = await mountPanel(<PanelHarness onState={(next) => { state = next; }} />);
  try {
    await act(async () => { state.setWidth(() => 380); });
    // 380px panel + 10px handle + 480px chat: one step wider and the chat would have 464px.
    const rowWidth = 380 + 10 + 480;
    panel.container.getBoundingClientRect = () => ({
      width: rowWidth, height: 600, top: 0, left: 0, right: rowWidth, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
    }) as DOMRect;
    await act(async () => state.show("files"));
    const handle = panel.container.querySelector<HTMLElement>(".rpanel-resizer")!;
    assert.equal(panel.container.querySelector<HTMLElement>("#right-panel")?.dataset.presentation, "docked");
    handle.focus();
    await act(async () => {
      handle.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }) as unknown as Event);
    });
    assert.equal(panel.container.querySelector<HTMLElement>("#right-panel")?.dataset.presentation, "overlay");
    assertNoDomNode(panel.container.querySelector(".rpanel-resizer"));
    assert.ok((domWindow.document.activeElement as unknown as Element | null) ===
      (panel.container.querySelector('[aria-label="Close Panel"]') as unknown as Element), "focus moves to Close Panel");
  } finally {
    await panel.dispose();
  }
});

test("a handle focused when the panel closed does not pull focus into a later overlay (#2725)", async () => {
  let state!: RightPanelState;
  const panel = await mountPanel(<PanelHarness onState={(next) => { state = next; }} />);
  let rowWidth = 1200;
  panel.container.getBoundingClientRect = () => ({
    width: rowWidth, height: 600, top: 0, left: 0, right: rowWidth, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
  }) as DOMRect;
  const opener = panel.container.querySelector<HTMLButtonElement>("#recorded")!;
  try {
    await act(async () => state.show("requests"));
    panel.container.querySelector<HTMLElement>(".rpanel-resizer")!.focus();
    // Closing removes the focused handle with the rest of the panel.
    await act(async () => { state.close(); });
    opener.focus();
    rowWidth = 700;
    await act(async () => state.show("files"));
    assert.equal(panel.container.querySelector<HTMLElement>("#right-panel")?.dataset.presentation, "overlay");
    assert.ok((domWindow.document.activeElement as unknown as Element | null) === (opener as unknown as Element),
      "focus stays on the control that opened the panel");
  } finally {
    await panel.dispose();
  }
});

test("a persisted terminal mode restores the launcher instead of an empty panel", async () => {
  // Older builds reserved a "terminal" panel mode that nothing could open; the value can still
  // sit in localStorage, and restoring it must land on the launcher (#1201).
  saveBrowserStorageValue("wollipog.rightpanel.mode", "terminal");
  saveBrowserStorageValue("wollipog.rightpanel.open", "1");
  let state!: RightPanelState;
  const panel = await mountPanel(<PanelHarness onState={(next) => { state = next; }} />);
  try {
    assert.equal(state.mode, "launcher");
    assert.equal(panel.container.querySelector(".rp-launcher") != null, true, "the launcher list is restored");
    assertNoDomNode(panel.container.querySelector(".rpanel-body"), "no mode body renders for a retired mode");
    assert.doesNotMatch(panel.container.querySelector(".rpanel")?.textContent ?? "", /Coming soon/);
    assert.equal(panel.container.querySelector(".rpanel-switcher-name")?.textContent, "Session Tools");
  } finally {
    await panel.dispose();
  }
});

test("every launcher row carries a distinct icon", async () => {
  // Review used the terminal prompt glyph and Background Work duplicated Terminal's (#1205).
  let state!: RightPanelState;
  const panel = await mountPanel(<PanelHarness onState={(next) => { state = next; }} />);
  try {
    await act(async () => state.show("launcher"));
    const rows = [...panel.container.querySelectorAll<HTMLElement>(".rp-launcher .rp-row")];
    assert.ok(rows.length >= 9, `expected every launcher destination, saw ${rows.length}`);
    const glyphs = rows.map((row) => {
      const label = row.querySelector("span:nth-of-type(2)")?.textContent ?? "";
      const svg = row.querySelector(".rp-row-icon svg");
      assert.ok(svg, `${label} must render an icon`);
      return [label, svg!.innerHTML] as const;
    });
    const byGlyph = new Map<string, string[]>();
    for (const [label, glyph] of glyphs) byGlyph.set(glyph, [...(byGlyph.get(glyph) ?? []), label]);
    const duplicates = [...byGlyph.values()].filter((labels) => labels.length > 1);
    assert.deepEqual(duplicates, [], "two launcher rows must never share a glyph");
  } finally {
    await panel.dispose();
  }
});

const keydown = (target: Element, key: string, init: { ctrlKey?: boolean } = {}) => act(async () => {
  target.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }) as unknown as Event);
});

test("the header is one bar with the tool switcher as its title and one Close, and nothing reads Panel (#2843)", async () => {
  let state!: RightPanelState;
  const panel = await mountPanel(<PanelHarness onState={(next) => { state = next; }} />);
  try {
    for (const [mode, name] of [["launcher", "Session Tools"], ["review", "Review"], ["requests", "Requests"],
      ["decisions", "Decision History"], ["subagents", "Agents"]] as const) {
      await act(async () => state.show(mode));
      const aside = panel.container.querySelector<HTMLElement>("#right-panel")!;
      assert.equal(aside.getAttribute("aria-label"), "Side Panel", `${mode}: the landmark is the Side Panel`);
      const head = aside.querySelector(".rpanel-head")!;
      const switcher = head.querySelector<HTMLButtonElement>(".rpanel-title > .rpanel-switcher")!;
      assert.equal(switcher.textContent, name, mode);
      assert.equal(switcher.getAttribute("aria-haspopup"), "menu");
      assert.ok(switcher.querySelector(".rpanel-switcher-icon svg"), `${mode}: the tool's icon`);
      // Switcher, the (empty) action slot, then Close Panel; no back control in any tool.
      assert.deepEqual([...head.children].map((child) => child.className || child.getAttribute("aria-label")),
        ["rpanel-title", "rpanel-actions", "icon-btn"], mode);
      assert.equal(head.querySelectorAll('[aria-label="Close Panel"]').length, 1, `${mode}: one Close`);
      for (const element of aside.querySelectorAll("*")) {
        assert.notEqual(element.textContent?.trim(), "Panel", `${mode}: no element reads "Panel"`);
      }
    }
  } finally {
    await panel.dispose();
  }
});

test("Review's header says no branch or change count (#2843)", async () => {
  let state!: RightPanelState;
  const statusGit: GitStatus = { ...git, status: { branch: "main", files: [{ path: "a.ts" }, { path: "b.ts" }] } as unknown as GitStatus["status"] };
  const panel = await mountPanel(<PanelHarness git={statusGit} onState={(next) => { state = next; }} />);
  try {
    await act(async () => state.show("review"));
    const head = panel.container.querySelector(".rpanel-head")!;
    assert.equal(head.textContent, "Review");
    assert.doesNotMatch(head.textContent ?? "", /main|Change/);
  } finally {
    await panel.dispose();
  }
});

test("the tool switcher lists Session Tools, then Code, Work and Decisions, the current tool checked (#2843)", async () => {
  let state!: RightPanelState;
  const panel = await mountPanel(<PanelHarness onState={(next) => { state = next; }} />);
  try {
    await act(async () => state.show("decisions"));
    const switcher = panel.container.querySelector<HTMLButtonElement>(".rpanel-switcher")!;
    await act(async () => switcher.click());
    const menu = (domWindow.document.querySelector('[role="menu"][aria-label="Switch Tool"]') as unknown as HTMLElement);
    assert.ok(menu, "the switcher opens a menu");
    assert.equal(switcher.getAttribute("aria-expanded"), "true");
    const top = [...menu.children].filter((child) => child.matches('[role="group"], .menu-item'));
    assert.deepEqual(top.map((child) => child.getAttribute("aria-label") ?? child.querySelector(".menu-text")?.textContent),
      ["Session Tools", "Code", "Work", "Decisions"], "Session Tools first, then the three groups in order");
    assert.deepEqual([...menu.querySelectorAll(".menu-label")].map((label) => label.textContent), ["Code", "Work", "Decisions"],
      "Title Case group labels");
    const names = (group: string) => [...menu.querySelectorAll(`[role="group"][aria-label="${group}"] .menu-item .menu-text`)]
      .map((text) => text.textContent);
    assert.deepEqual(names("Code"), ["Review", "Files", "Browser", "Terminal"]);
    // Campaign Status is listed only for campaign sessions.
    assert.deepEqual(names("Work"), ["Agents", "Side Chat", "Background Work"]);
    assert.deepEqual(names("Decisions"), ["Requests", "Decision History"]);
    const item = (name: string) => [...menu.querySelectorAll<HTMLButtonElement>(".menu-item")]
      .find((candidate) => candidate.querySelector(".menu-text")?.textContent === name)!;
    assert.equal(item("Decision History").getAttribute("aria-checked"), "true", "the current tool is checked");
    assert.equal(item("Review").getAttribute("aria-checked"), "false");
    assert.equal(item("Review").getAttribute("role"), "menuitemradio");
    assert.equal(item("Terminal").getAttribute("role"), "menuitem", "Terminal opens the dock, so it is never checked");
    assert.ok((domWindow.document.activeElement as unknown as Element | null) === (item("Decision History") as unknown as Element),
      "opening lands on the current tool");
    // Keycaps on a fine pointer.
    assert.ok(item("Review").querySelector("kbd"), "Review shows its chord");

    // This runner predates session files: Files is unavailable, focusable, and says why.
    const files = item("Files");
    assert.equal(files.getAttribute("aria-disabled"), "true");
    assert.equal(files.disabled, false, "an unavailable tool stays focusable");
    const reasonId = files.getAttribute("aria-describedby")!;
    assert.match(domWindow.document.getElementById(reasonId)?.textContent ?? "", /session file browsing/);
    await keydown(menu, "ArrowDown");
    await keydown(menu, "ArrowDown");
    assert.ok((domWindow.document.activeElement as unknown as Element | null) !== (item("Decision History") as unknown as Element));
    await act(async () => files.click());
    assert.equal(state.mode, "decisions", "choosing an unavailable tool does nothing");
    assert.ok(domWindow.document.querySelector('[aria-label="Switch Tool"]'), "and leaves the menu open");

    await act(async () => item("Agents").click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(state.mode, "subagents", "choosing a tool shows it");
    assertNoDomNode(domWindow.document.querySelector('[aria-label="Switch Tool"]'), "and closes the menu");
    assert.equal(panel.container.querySelector(".rpanel-switcher")?.textContent, "Agents");

    // Session Tools is the switcher's first item: the way back to the list.
    await act(async () => panel.container.querySelector<HTMLButtonElement>(".rpanel-switcher")!.click());
    const reopened = (domWindow.document.querySelector('[role="menu"][aria-label="Switch Tool"]') as unknown as HTMLElement);
    await act(async () => reopened.querySelector<HTMLButtonElement>(".menu-item")!.click());
    assert.equal(state.mode, "launcher");
  } finally {
    await panel.dispose();
  }
});

test("on a coarse pointer the switcher shows no keycaps (#2843)", async () => {
  coarsePointer = true;
  let state!: RightPanelState;
  const panel = await mountPanel(<PanelHarness onState={(next) => { state = next; }} />);
  try {
    await act(async () => state.show("review"));
    await act(async () => panel.container.querySelector<HTMLButtonElement>(".rpanel-switcher")!.click());
    const menu = domWindow.document.querySelector('[aria-label="Switch Tool"]')!;
    assert.equal(menu.querySelectorAll("kbd").length, 0);
  } finally {
    coarsePointer = false;
    await panel.dispose();
  }
});

test("Escape closes the panel from any tool while focus is inside it (#2843, #1260)", async () => {
  let state!: RightPanelState;
  const panel = await mountPanel(<PanelHarness decisionHistory={[governanceDecision]} onState={(next) => { state = next; }} />);
  try {
    for (const mode of ["files", "browser", "subagents", "decisions", "review", "launcher"] as const) {
      await act(async () => state.show(mode));
      const aside = panel.container.querySelector("#right-panel")!;
      const target = aside.querySelector<HTMLElement>(".rpanel-body button:not([disabled]), .rpanel-body input, .rp-launcher button") ??
        aside.querySelector<HTMLElement>(".rpanel-switcher")!;
      target.focus();
      await keydown(target, "Escape");
      assert.equal(state.open, false, `${mode}: Escape closes the panel`);
    }
  } finally {
    await panel.dispose();
  }
});

test("Escape closes an open switcher menu first and leaves the panel open (#2843)", async () => {
  let state!: RightPanelState;
  const panel = await mountPanel(<PanelHarness onState={(next) => { state = next; }} />);
  try {
    await act(async () => state.show("browser"));
    const switcher = panel.container.querySelector<HTMLButtonElement>(".rpanel-switcher")!;
    await act(async () => switcher.click());
    const item = (domWindow.document.querySelector('[aria-label="Switch Tool"] [aria-checked="true"]') as unknown as HTMLElement);
    await keydown(item, "Escape");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assertNoDomNode(domWindow.document.querySelector('[aria-label="Switch Tool"]'), "the menu closes");
    assert.equal(state.open, true, "the panel stays open");
    assert.ok((domWindow.document.activeElement as unknown as Element | null) === (switcher as unknown as Element),
      "focus returns to the switcher");
    // The next Escape closes the panel.
    await keydown(switcher, "Escape");
    assert.equal(state.open, false);
  } finally {
    await panel.dispose();
  }
});

test("Escape inside a terminal goes to the shell, and a handled Escape leaves the panel open (#2843)", async () => {
  let state!: RightPanelState;
  const panel = await mountPanel(<PanelHarness onState={(next) => { state = next; }} />);
  try {
    await act(async () => state.show("browser"));
    const body = panel.container.querySelector(".rpanel-body")!;
    const terminal = domWindow.document.createElement("div");
    terminal.className = "xterm";
    const input = domWindow.document.createElement("textarea");
    terminal.append(input);
    body.append(terminal as never);
    (input as unknown as HTMLElement).focus();
    await keydown(input as unknown as Element, "Escape");
    assert.equal(state.open, true, "the terminal keeps Escape");
    terminal.remove();

    // A layer inside a tool that takes Escape marks it handled, and the panel yields to it.
    const switcher = panel.container.querySelector<HTMLButtonElement>(".rpanel-switcher")!;
    const consume = (event: Event) => event.preventDefault();
    switcher.addEventListener("keydown", consume);
    await keydown(switcher, "Escape");
    switcher.removeEventListener("keydown", consume);
    assert.equal(state.open, true, "a handled Escape does not close the panel");
    // A modified Escape (Ctrl+Esc leaves a terminal) never closes it.
    await keydown(switcher, "Escape", { ctrlKey: true });
    assert.equal(state.open, true);
  } finally {
    await panel.dispose();
  }
});

test("a tool's PanelHeaderActions render in the header's action slot, and nowhere outside the panel (#2843)", async () => {
  const head = domWindow.document.createElement("div");
  domWindow.document.body.append(head as never);
  const slot = await mountPanel(
    <PanelActionSlotContext.Provider value={head as unknown as HTMLElement}>
      <p>Body</p>
      <PanelHeaderActions>
        <button type="button" className="icon-btn" aria-label="Refresh">R</button>
      </PanelHeaderActions>
    </PanelActionSlotContext.Provider>,
  );
  const outside = await mountPanel(
    <PanelHeaderActions><button type="button" aria-label="Stray">S</button></PanelHeaderActions>,
  );
  try {
    assert.equal(head.querySelector('[aria-label="Refresh"]')?.textContent, "R", "the action is portalled into the slot");
    assertNoDomNode(slot.container.querySelector('[aria-label="Refresh"]'), "and not left in the body");
    assert.equal(outside.container.innerHTML, "", "outside the panel it renders nothing");
  } finally {
    await slot.dispose();
    await outside.dispose();
    head.remove();
  }
});

test("on a phone the panel's bar leads with Back to Session, has no Close, and Back returns to the conversation (#2843)", async () => {
  phoneViewport = true;
  const surface = domWindow.document.createElement("section") as unknown as HTMLElement;
  surface.dataset.sessionSurfaceId = liveSession.id;
  const reader = domWindow.document.createElement("div") as unknown as HTMLElement;
  reader.className = "detail-scroll";
  reader.tabIndex = -1;
  const composer = domWindow.document.createElement("textarea") as unknown as HTMLElement;
  composer.className = "composer-input";
  surface.append(reader, composer);
  domWindow.document.body.append(surface as never);
  let state!: RightPanelState;
  const panel = await mountPanel(<PanelHarness onState={(next) => { state = next; }} />);
  try {
    // The phone's toggle is in the session app bar, which the open panel replaces: no opener is left.
    (domWindow.document.activeElement as unknown as HTMLElement | null)?.blur();
    await act(async () => state.show("decisions"));
    const head = panel.container.querySelector(".rpanel-head")!;
    const buttons = [...head.querySelectorAll("button")].map((button) => button.getAttribute("aria-label") ?? button.textContent);
    assert.deepEqual(buttons, ["Back to Session", "Decision History"], "Back, then the switcher; no Close");
    assert.ok((domWindow.document.activeElement as unknown as Element | null) ===
      (head.querySelector(".rpanel-switcher") as unknown as Element), "focus moves into the sheet's bar");
    await act(async () => head.querySelector<HTMLButtonElement>('[aria-label="Back to Session"]')!.click());
    await act(async () => {
      await new Promise((resolve) => domWindow.requestAnimationFrame(() => resolve(undefined)));
    });
    assert.equal(state.open, false, "Back closes the panel");
    assert.ok((domWindow.document.activeElement as unknown as Element | null) === (reader as unknown as Element),
      "focus lands in the conversation, not the composer");
  } finally {
    phoneViewport = false;
    await panel.dispose();
    surface.remove();
  }
});

test("crossing the phone breakpoint with the panel open keeps focus on the panel's switcher (#2843)", async () => {
  let state!: RightPanelState;
  const panel = await mountPanel(<PanelHarness onState={(next) => { state = next; }} />);
  const resize = () => act(async () => { domWindow.dispatchEvent(new domWindow.Event("resize")); });
  const focused = () => domWindow.document.activeElement as unknown as Element | null;
  try {
    await act(async () => state.show("decisions"));
    const close = panel.container.querySelector('[aria-label="Close Panel"]') as unknown as HTMLElement;
    close.focus();
    phoneViewport = true;
    await resize();
    assertNoDomNode(panel.container.querySelector('[aria-label="Close Panel"]'), "a phone's bar has no Close");
    assert.ok(focused() === (panel.container.querySelector(".rpanel-switcher") as unknown as Element),
      "focus that fell with Close Panel lands on the switcher");

    (panel.container.querySelector('[aria-label="Back to Session"]') as unknown as HTMLElement).focus();
    phoneViewport = false;
    await resize();
    assert.ok(focused() === (panel.container.querySelector(".rpanel-switcher") as unknown as Element),
      "and focus that fell with Back to Session does too");

    // Focus somewhere else that survives the crossing stays where it is.
    const outside = panel.container.querySelector("#recorded") as unknown as HTMLElement;
    outside.focus();
    phoneViewport = true;
    await resize();
    assert.ok(focused() === (outside as unknown as Element));
  } finally {
    phoneViewport = false;
    await panel.dispose();
  }
});
