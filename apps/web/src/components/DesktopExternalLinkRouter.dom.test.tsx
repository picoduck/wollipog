import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { DesktopExternalLinkRouter, EXTERNAL_URL_POLICY_ERROR_PREFIX, externalHref, type ExternalLinkDesktop } from "./DesktopExternalLinkRouter.js";
import { FeedbackContext } from "./FeedbackProvider.js";

const domWindow = new Window({ url: "http://localhost:5173/sessions/active" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  location: domWindow.location,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLAnchorElement: domWindow.HTMLAnchorElement,
  MouseEvent: domWindow.MouseEvent,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

interface Harness {
  calls: Array<{ command: string; args: { url: string } }>;
  toasts: Array<{ message: string; options: Record<string, unknown> }>;
  rejectWith?: unknown;
  desktop: ExternalLinkDesktop;
}

function harness(isTauri = true): Harness {
  const state: Harness = {
    calls: [],
    toasts: [],
    desktop: {
      isTauri: () => isTauri,
      invoke: async (command, args) => {
        state.calls.push({ command, args });
        if (state.rejectWith != null) throw state.rejectWith;
      },
    },
  };
  return state;
}

async function mount(h: Harness) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const feedback = {
    confirm: async () => false,
    showToast: (message: string, options: Record<string, unknown> = {}) => {
      h.toasts.push({ message, options });
      return h.toasts.length;
    },
    showUndo: () => -1,
    dismissToast: () => undefined,
  };
  await act(async () => {
    root.render(
      <FeedbackContext.Provider value={feedback as never}>
        <DesktopExternalLinkRouter desktop={h.desktop} />
      </FeedbackContext.Provider>,
    );
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function anchor(href: string): HTMLAnchorElement {
  const element = domWindow.document.createElement("a") as unknown as HTMLAnchorElement;
  element.setAttribute("href", href);
  element.textContent = "Open";
  domWindow.document.body.append(element as never);
  return element;
}

function activate(element: HTMLAnchorElement, options: MouseEventInit = {}): MouseEvent {
  const event = new domWindow.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...options,
  } as never) as unknown as MouseEvent;
  element.dispatchEvent(event);
  return event;
}

test("externalHref preserves external and blocked URLs exactly while ignoring app navigation", () => {
  const cases: Array<[string, string | null]> = [
    ["https://example.com/a%2Fb?q=x%20y#fragment", "https://example.com/a%2Fb?q=x%20y#fragment"],
    ["HTTP://example.com/Case", "HTTP://example.com/Case"],
    ["//docs.example.com/guide", "https://docs.example.com/guide"],
    ["//localhost:5173/internal", null],
    ["mailto:person@example.com", "mailto:person@example.com"],
    ["file:///tmp/report.txt", "file:///tmp/report.txt"],
    ["wollipog://session/123", "wollipog://session/123"],
    ["/settings/network", null],
    ["#finding-4", null],
  ];
  for (const [href, expected] of cases) {
    const element = domWindow.document.createElement("a") as unknown as HTMLAnchorElement;
    element.setAttribute("href", href);
    assert.equal(externalHref(element, domWindow.location as unknown as Location), expected, href);
  }

  const protocolRelative = domWindow.document.createElement("a") as unknown as HTMLAnchorElement;
  protocolRelative.setAttribute("href", "//docs.example.com/guide");
  const tauriLocation = { href: "tauri://localhost/", origin: "null", protocol: "tauri:" } as Location;
  assert.equal(externalHref(protocolRelative, tauriLocation), "https://docs.example.com/guide");
});

test("pointer, Ctrl+click, and keyboard-generated clicks each reach the mocked opener exactly once", async () => {
  const h = harness();
  const { unmount } = await mount(h);
  const url = "https://github.com/picoduck/wollipog/issues/10?source=desktop#acceptance";
  const link = anchor(url);

  for (const options of [
    { detail: 1 },
    { detail: 1, ctrlKey: true },
    { detail: 0 },
  ]) {
    const before = h.calls.length;
    const event = activate(link, options);
    await act(async () => Promise.resolve());
    assert.equal(event.defaultPrevented, true);
    assert.equal(h.calls.length, before + 1, "one activation must issue exactly one native call");
    assert.deepEqual(h.calls.at(-1), { command: "open_external_url", args: { url } });
  }

  link.remove();
  await unmount();
});

test("download anchors remain owned by the WebView", async () => {
  const h = harness();
  const { unmount } = await mount(h);
  const link = anchor("blob:http://tauri.localhost/download-id");
  link.setAttribute("download", "transcript.json");
  const event = activate(link);
  await act(async () => Promise.resolve());

  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(h.calls, []);

  link.remove();
  await unmount();
});

test("internal links and browser builds retain ordinary navigation behavior", async () => {
  for (const isTauri of [true, false]) {
    const h = harness(isTauri);
    const { unmount } = await mount(h);
    const link = anchor(isTauri ? "/settings/network" : "https://example.com/docs");
    const event = activate(link);
    await act(async () => Promise.resolve());
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(h.calls, []);
    link.remove();
    await unmount();
  }
});

test("native opener failures become persistent actionable errors", async () => {
  const h = harness();
  h.rejectWith = "No browser is configured";
  const { unmount } = await mount(h);
  const link = anchor("https://example.com/docs");
  activate(link);
  await act(async () => { await Promise.resolve(); });

  assert.equal(h.calls.length, 1);
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0]!.message, /Could not open link: No browser is configured/);
  assert.equal(h.toasts[0]!.options.tone, "error");
  assert.equal(h.toasts[0]!.options.durationMs, 0);
  assert.equal((h.toasts[0]!.options.action as { label: string; busyLabel: string }).label, "Retry");
  assert.equal((h.toasts[0]!.options.action as { label: string; busyLabel: string }).busyLabel, "Retrying…");

  link.remove();
  await unmount();
});

test("native policy rejections are transient and never offer a futile retry", async () => {
  const h = harness();
  h.rejectWith = `${EXTERNAL_URL_POLICY_ERROR_PREFIX}Wollipog can open only HTTP and HTTPS links.`;
  const { unmount } = await mount(h);
  const link = anchor("mailto:person@example.com");
  activate(link);
  await act(async () => { await Promise.resolve(); });

  assert.equal(h.calls.length, 1, "the native trust boundary still makes the policy decision");
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0]!.message, "Wollipog can open only HTTP and HTTPS links.");
  assert.equal(h.toasts[0]!.options.tone, "error");
  assert.equal(h.toasts[0]!.options.durationMs, undefined);
  assert.equal(h.toasts[0]!.options.action, undefined);

  link.remove();
  await unmount();
});
