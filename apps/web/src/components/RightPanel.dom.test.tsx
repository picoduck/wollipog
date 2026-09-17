import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView } from "@wollipog/protocol";
import type { TimelineItem } from "../timeline.js";
import { panelReturnFocusTarget, RightPanel, useRightPanelState, type RightPanelState } from "./RightPanel.js";
import type { GovernanceDecision } from "../governance.js";
import { saveBrowserStorageValue } from "../instance-storage.js";
import type { GitStatus } from "./useGitStatus.js";
import { StoreProvider } from "../store.js";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime } from "../ui-transport.js";
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
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  localStorage: domWindow.localStorage,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
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

beforeEach(() => domWindow.localStorage.clear());

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
  decidedBy: "You · device-1",
  label: "Allowed by Policy",
  detail: "The matched policy allowed this tool.",
  tone: "allowed",
  timestamp: 1_700_000_000_000,
};

function PanelHarness({
  initialSession = liveSession,
  initialRunnerOnline = true,
  governanceDecisions,
  governanceHasMore,
  onState,
}: {
  initialSession?: SessionView;
  initialRunnerOnline?: boolean;
  governanceDecisions?: readonly GovernanceDecision[];
  governanceHasMore?: boolean;
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
        git={git}
        items={agentItems}
        governanceDecisions={governanceDecisions}
        governanceHasMore={governanceHasMore}
        onLoadOlderGovernance={() => {}}
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
    surface.append(detachedTrigger);
    assert.equal(panelReturnFocusTarget(detachedTrigger, "focus-session", domWindow.document as unknown as ParentNode), detachedTrigger);
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
    assert.equal(container.querySelector(".subagent-detail"), null,
      "a stale target does not select a different session's worker");
    await act(async () => {
      const history = [...container.querySelectorAll<HTMLButtonElement>(".agents-filters button")]
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

test("Governance History renders only its list, empty state, and paging control", async () => {
  // Every state the mode can reach must be free of the placeholder hint that used to trail the
  // panel body for any mode outside a hard-coded allow list (#1201).
  for (const [name, props] of [
    ["populated", { governanceDecisions: [governanceDecision], governanceHasMore: false }],
    ["empty page with more available", { governanceDecisions: [], governanceHasMore: true }],
    ["empty", { governanceDecisions: [], governanceHasMore: false }],
  ] as const) {
    let state!: RightPanelState;
    const panel = await mountPanel(<PanelHarness {...props} onState={(next) => { state = next; }} />);
    try {
      await act(async () => state.show("governance"));
      const body = panel.container.querySelector(".rp-body")!;
      assert.doesNotMatch(body.textContent ?? "", /Coming soon/, `${name} must not render a placeholder hint`);
      if (name === "populated") {
        assert.match(body.textContent ?? "", /Allowed by Policy/);
        assert.equal(body.querySelector(".governance-history-more"), null, "no paging control without more pages");
      } else if (name === "empty page with more available") {
        assert.match(body.textContent ?? "", /No governance decisions are visible in this page yet\./);
        assert.equal(body.querySelector(".governance-history-more")?.textContent, "Load Older Decisions");
      } else {
        assert.match(body.textContent ?? "", /No governance decisions have been recorded for this session\./);
        assert.equal(body.querySelector(".governance-history-more"), null);
      }
    } finally {
      await panel.dispose();
    }
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
    assert.equal(panel.container.querySelector(".rp-body"), null, "no mode body renders for a retired mode");
    assert.doesNotMatch(panel.container.querySelector(".right-panel")?.textContent ?? "", /Coming soon/);
    assert.equal(panel.container.querySelector(".rp-title")?.textContent, "Panel");
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
