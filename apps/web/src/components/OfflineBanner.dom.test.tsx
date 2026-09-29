import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { useConnectionLostFor } from "../connection-lost.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { StoreProvider, useStoreActions, useStoreSelector } from "../store.js";
import type { UiConnectionRuntime, UiSocket } from "../ui-transport.js";
import { OfflineBanner } from "./OfflineBanner.js";

/**
 * docs/design-system.md §12.5: the offline banner offers Retry Now, which brings the store's pending
 * retry forward, and shows developer hints only in a development build. The banner is rendered the
 * way the Shell renders it, against the real StoreProvider and its socket lifecycle.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

// happy-dom binds its timers to Node's at import, so `node:test` mock timers never reach them. The
// window's timeout pair is replaced instead: the store's retry timer and the banner's 2s hold fire
// only when a test advances this clock.
const pendingTimeouts = new Map<number, { at: number; run: () => void }>();
let clockNow = 0;
let nextTimeoutId = 1;
Object.assign(domWindow, {
  setTimeout: (callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    const id = nextTimeoutId++;
    pendingTimeouts.set(id, { at: clockNow + Math.max(0, Number(delay) || 0), run: () => callback(...args) });
    return id;
  },
  clearTimeout: (id: number) => { pendingTimeouts.delete(id); },
});

async function advance(ms: number) {
  const until = clockNow + ms;
  for (;;) {
    const [next] = [...pendingTimeouts]
      .filter(([, timeout]) => timeout.at <= until)
      .sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId);
    if (!next) break;
    const [id, timeout] = next;
    pendingTimeouts.delete(id);
    clockNow = timeout.at;
    await act(async () => { timeout.run(); });
  }
  clockNow = until;
}

class FakeSocket implements UiSocket {
  readonly readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
}

const SNAPSHOT = JSON.stringify({ type: "snapshot", runners: [], runs: [], pods: [], sessions: [] });
const ORIGIN = "http://127.0.0.1:4317";

/** The Shell's wiring: the banner after 2s of disconnection, Retry Now bound to the store. */
function ShellBanner({ developmentBuild }: { developmentBuild: boolean }) {
  const conn = useStoreSelector((state) => state.conn);
  const { reconnectNow } = useStoreActions();
  const offlineHeld = useConnectionLostFor(conn, 2000);
  return offlineHeld
    ? <OfflineBanner connecting={conn === "connecting"} onRetryNow={reconnectNow} developmentBuild={developmentBuild} controlPlaneOrigin={ORIGIN} />
    : null;
}

async function mount({ developmentBuild = false } = {}) {
  pendingTimeouts.clear();
  clockNow = 0;
  const sockets: FakeSocket[] = [];
  const connection: UiConnectionRuntime = {
    instanceId: "offline-banner",
    runtimeKey: `offline-banner:${nextTimeoutId}`,
    createSocket() {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    close() {},
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<StoreProvider connection={connection}><ShellBanner developmentBuild={developmentBuild} /></StoreProvider>);
  });
  const latest = () => sockets.at(-1)!;
  const view = {
    sockets,
    banner: () => container.querySelector<HTMLElement>(".notice.page-banner"),
    button: () => container.querySelector<HTMLButtonElement>(".notice-actions button"),
    async online() { await act(async () => { latest().onmessage?.({ data: SNAPSHOT }); }); },
    async fail() { await act(async () => { latest().onclose?.({ code: 1006 }); }); },
    async click() { await act(async () => { view.button()!.click(); }); },
    /** Online, then lost long enough for the banner to appear, with the next retry pending. */
    async goOffline() {
      await view.online();
      await view.fail();
      await advance(1500);
      await view.fail();
      await advance(600);
      assert.ok(view.banner(), "the banner is up after 2.1s of disconnection");
    },
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
  return view;
}

test("Retry Now starts exactly one attempt immediately and cancels the pending retry", async () => {
  const view = await mount();
  try {
    await view.goOffline();
    const before = view.sockets.length;
    assert.equal(view.button()!.textContent, "Retry Now");
    await view.click();
    assert.equal(view.sockets.length, before + 1, "one attempt starts at once, without waiting for the timer");
    await advance(5000);
    assert.equal(view.sockets.length, before + 1, "the cancelled retry timer never opens a second socket");
  } finally {
    await view.dispose();
  }
});

test("Retry Now shows a busy state, and a second click starts no second attempt", async () => {
  const view = await mount();
  try {
    await view.goOffline();
    const before = view.sockets.length;
    await view.click();
    const button = view.button()!;
    assert.equal(button.textContent, "Retrying…");
    assert.equal(button.getAttribute("aria-busy"), "true");
    assert.equal(button.getAttribute("aria-disabled"), "true");
    await view.click();
    assert.equal(view.sockets.length, before + 1, "clicking twice starts one attempt");
    // The attempt fails: the button is offered again and the normal 1.5s retry resumes.
    await view.fail();
    assert.equal(view.button()!.textContent, "Retry Now");
    assert.equal(view.button()!.getAttribute("aria-busy"), null);
    assert.equal(view.button()!.getAttribute("aria-disabled"), null);
    await advance(1500);
    assert.equal(view.sockets.length, before + 2, "the store's own retry cadence is unchanged");
  } finally {
    await view.dispose();
  }
});

test("Retry Now is not offered while the store's own attempt is opening", async () => {
  const view = await mount();
  try {
    await view.goOffline();
    await advance(1500); // The pending retry fires: a connection is opening.
    const before = view.sockets.length;
    const button = view.button()!;
    assert.equal(button.getAttribute("aria-disabled"), "true");
    assert.equal(button.textContent, "Retry Now", "an automatic attempt does not relabel the live region");
    await view.click();
    assert.equal(view.sockets.length, before, "no attempt starts while one is opening");
  } finally {
    await view.dispose();
  }
});

test("the store's reconnectNow does nothing while connecting or online", async () => {
  let actions: ReturnType<typeof useStoreActions> | null = null;
  function Capture() {
    actions = useStoreActions();
    return null;
  }
  const sockets: FakeSocket[] = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  pendingTimeouts.clear();
  await act(async () => {
    root.render(
      <StoreProvider connection={{ instanceId: "reconnect", runtimeKey: "reconnect:1", createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }, close() {} }}><Capture /></StoreProvider>,
    );
  });
  try {
    assert.equal(actions!.reconnectNow(), false, "the first attempt is still opening");
    await act(async () => { sockets[0]!.onmessage?.({ data: SNAPSHOT }); });
    assert.equal(actions!.reconnectNow(), false, "online");
    assert.equal(sockets.length, 1);
    await act(async () => { sockets[0]!.onclose?.({ code: 1006 }); });
    let started = false;
    await act(async () => { started = actions!.reconnectNow(); });
    assert.equal(started, true, "offline with a pending retry");
    assert.equal(sockets.length, 2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the banner appears only after 2s of disconnection and clears when back online", async () => {
  const view = await mount();
  try {
    await view.online();
    await view.fail();
    await advance(1500);
    assertNoDomNode(view.banner(), "a blip shorter than 2s shows nothing");
    await view.fail();
    await advance(600);
    assert.ok(view.banner(), "disconnection across the store's retry counts from the first loss");
    await view.click();
    await view.online();
    assertNoDomNode(view.banner());
  } finally {
    await view.dispose();
  }
});

test("a development build shows the address and the pnpm dev hint behind Show Details", async () => {
  const view = await mount({ developmentBuild: true });
  try {
    await view.goOffline();
    const banner = view.banner()!;
    const details = banner.querySelector("details.notice-details")!;
    assert.equal(details.querySelector("summary")!.textContent, "Show Details");
    assert.match(details.textContent!, new RegExp(ORIGIN.replaceAll(".", "\\.")));
    assert.match(details.textContent!, /pnpm dev/);
    assert.ok(banner.textContent!.startsWith("Can't reach Wollipog on this machine. Reconnecting…"));
  } finally {
    await view.dispose();
  }
});

test("any other build shows neither the address nor pnpm dev anywhere in the banner", async () => {
  const view = await mount({ developmentBuild: false });
  try {
    await view.goOffline();
    const banner = view.banner()!;
    assertNoDomNode(banner.querySelector("details"), "no Show Details");
    assert.doesNotMatch(banner.textContent!, /pnpm dev/);
    assert.doesNotMatch(banner.textContent!, /127\.0\.0\.1|4317/);
    assert.equal(banner.textContent, "Can't reach Wollipog on this machine. Reconnecting…Retry Now");
  } finally {
    await view.dispose();
  }
});
