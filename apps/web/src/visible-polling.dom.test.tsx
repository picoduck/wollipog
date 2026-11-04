import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "./api.js";
import { ApiProvider } from "./api-context.js";
import { StoreProvider } from "./store.js";
import type { UiConnectionRuntime } from "./ui-transport.js";
import { installDomTestCleanup } from "./dom-test-cleanup.js";
import { AutomationsView } from "./components/AutomationsView.js";
import { OutboundEventSubscriptions } from "./components/OutboundEventSubscriptions.js";
import { SideChatPanel } from "./components/SideChatPanel.js";
import { useDescendantRequestPolling } from "./components/SessionDetail.js";
import { withScopedClockOverrides } from "./components/test-clock-overrides.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  localStorage: domWindow.localStorage, HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node, Event: domWindow.Event, ResizeObserver: domWindow.ResizeObserver,
  React, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const connection: UiConnectionRuntime = {
  instanceId: "visible-polling", runtimeKey: "visible-polling",
  createSocket: () => ({ readyState: 0, onopen: null, onmessage: null, onclose: null,
    onerror: null, send() {}, close() {} }),
  close() {},
};
const parent = { id: "parent", title: "Parent", status: "idle", driver: "claude-code" } as SessionView;
const child = { ...parent, id: "child", title: "Side Chat", eventEpoch: 0 };
function Descendants() {
  const poll = useDescendantRequestPolling({ sessionId: parent.id, enabled: true, available: true });
  return <output>{poll.status}</output>;
}

for (const surface of ["automations", "outbound"] as const) {
test(`${surface} refreshes immediately after Strict Mode cleans up a pending initial effect`, async () => {
  let calls = 0;
  const client: ApiClient = {
    ...api,
    automations: async () => { if (surface === "automations") calls += 1; return { automations: [] }; },
    workflowDefinitions: async () => [],
    outboundEventSubscriptions: async () => { if (surface === "outbound") calls += 1; return []; },
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<React.StrictMode><ApiProvider client={client}>
        <StoreProvider connection={connection}>{surface === "automations" ? <AutomationsView />
          : <OutboundEventSubscriptions projects={[]} automations={[]} />}</StoreProvider>
      </ApiProvider></React.StrictMode>);
    });
    assert.equal(calls, 2, "the remounted effect serializes a replacement initial refresh");
    assert.doesNotMatch(container.textContent ?? "", /Loading automations|Loading outbound events/,
      "the view completes its initial load without waiting for a five-second interval");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
}

for (const surface of ["automations", "outbound", "side-chat", "descendants"] as const) {
  test(`${surface} polling pauses when hidden, refreshes on return, and coalesces slow polls`, async () => {
    let visible = false;
    Object.defineProperty(domWindow.document, "visibilityState", {
      configurable: true, get: () => visible ? "visible" : "hidden",
    });
    const intervals = new Map<number, () => void>();
    let nextId = 1;
    let calls = 0;
    let release: (() => void) | undefined;
    let hold = false;
    const count = async () => {
      calls += 1;
      if (hold) await new Promise<void>((resolve) => { release = resolve; });
    };
    const client: ApiClient = {
      ...api,
      automations: async () => { await count(); return { automations: [] }; },
      workflowDefinitions: async () => [],
      outboundEventSubscriptions: async () => { if (surface === "outbound") await count(); return []; },
      sideChat: async () => { await count(); return { sideChat: { parentSessionId: parent.id, session: child, createdAt: 1 } }; },
      getSessionEventPage: async () => ({ events: [], eventEpoch: 0, nextAfter: 0, cacheComplete: true }),
      descendantRequests: async () => { await count(); return { requests: [], blockedChildren: [] }; },
    };
    const node = surface === "automations" ? <AutomationsView />
      : surface === "outbound" ? <OutboundEventSubscriptions projects={[]} automations={[]} />
        : surface === "side-chat" ? <SideChatPanel session={parent} runnerOnline onInsertDraft={() => {}} />
          : <Descendants />;
    const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
    domWindow.document.body.append(container as never);
    const root = createRoot(container);
    const changeVisibility = async (next: boolean) => {
      visible = next;
      await act(async () => { domWindow.document.dispatchEvent(new domWindow.Event("visibilitychange")); });
    };
    try {
      await withScopedClockOverrides(domWindow, {
        setInterval: (callback: () => void) => { const id = nextId++; intervals.set(id, callback); return id; },
        clearInterval: (id: number) => { intervals.delete(id); },
      }, async () => {
        await act(async () => {
          root.render(<ApiProvider client={client}><StoreProvider connection={connection}>{node}</StoreProvider></ApiProvider>);
        });
        assert.equal(calls, surface === "side-chat" ? 1 : 0,
          "mounting hidden does not start recurring reads (side chat still loads its relationship)");
        await changeVisibility(true);
        assert.ok(calls > 0, "the first visible refresh runs");
        const initial = calls;
        await changeVisibility(false);
        await act(async () => { for (const poll of intervals.values()) poll(); });
        assert.equal(calls, initial, "hidden intervals do no work");
        hold = true;
        await changeVisibility(true);
        assert.equal(calls, initial + 1, "becoming visible refreshes without waiting for an interval");
        await act(async () => { for (const poll of intervals.values()) poll(); });
        await changeVisibility(false);
        await changeVisibility(true);
        assert.equal(calls, initial + 1, "intervals and visibility events cannot overlap a slow request");
        await act(async () => { release?.(); });
        hold = false;
        await act(async () => { for (const poll of intervals.values()) poll(); });
        assert.equal(calls, initial + 2, "settled work permits the next interval");
        await act(async () => { root.unmount(); });
        assert.equal(intervals.size, 0, "unmount clears every recurring poll");
        const atUnmount = calls;
        await changeVisibility(false);
        await changeVisibility(true);
        assert.equal(calls, atUnmount, "unmount removes visibility listeners");
      });
    } finally {
      release?.();
      await act(async () => { root.unmount(); });
      container.remove();
      Reflect.deleteProperty(domWindow.document, "visibilityState");
    }
  });
}
