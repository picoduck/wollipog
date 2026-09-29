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

type ToastAction = { label: string; run: () => Promise<void> };

/** Replace the clipboard for one test; returns what was written and a restore. */
function fakeClipboard(writeText: (text: string) => Promise<void>) {
  const written: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(domWindow.navigator, "clipboard");
  Object.defineProperty(domWindow.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { await writeText(text); written.push(text); } },
  });
  return {
    written,
    restore: () => {
      if (previous) Object.defineProperty(domWindow.navigator, "clipboard", previous);
      else delete (domWindow.navigator as unknown as Record<string, unknown>).clipboard;
    },
  };
}

/** The native text goes to the console, never the screen. */
function captureWarnings() {
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  return { warnings, restore: () => { console.warn = original; } };
}

test("a link the browser refuses shows the URL and Copy Link, and keeps the native error off the screen", async () => {
  const h = harness();
  h.rejectWith = "The system browser could not open this link: No browser is configured";
  const console_ = captureWarnings();
  const clipboard = fakeClipboard(async () => undefined);
  const { unmount } = await mount(h);
  const url = "https://example.com/docs?page=2#install";
  const link = anchor(url);
  activate(link);
  await act(async () => { await Promise.resolve(); });

  try {
    assert.equal(h.calls.length, 1);
    assert.equal(h.toasts.length, 1);
    const [toast] = h.toasts;
    assert.equal(toast!.message, "Couldn't open the link in your browser.");
    assert.equal(toast!.options.tone, "error");
    assert.equal(toast!.options.durationMs, undefined, "an error persists until dismissed (#1802)");
    assert.equal(toast!.options.detail, url);
    assert.equal(toast!.options.detailStyle, "mono");
    assert.doesNotMatch(JSON.stringify(toast), /No browser is configured/, "the native text never reaches the toast");
    assert.match(String(console_.warnings[0]?.[1]), /No browser is configured/);
    const action = toast!.options.action as ToastAction;
    assert.equal(action.label, "Copy Link", "there is no Retry");

    await act(async () => { await action.run(); });
    assert.deepEqual(clipboard.written, [url], "Copy Link copies the exact URL");
    assert.equal(h.toasts.at(-1)!.message, "Link copied.");
  } finally {
    console_.restore();
    clipboard.restore();
    link.remove();
    await unmount();
  }
});

test("a link the policy blocks is a warning with the URL and Copy Link, and no Retry", async () => {
  const h = harness();
  h.rejectWith = `${EXTERNAL_URL_POLICY_ERROR_PREFIX}Wollipog can open only HTTP and HTTPS links in your system browser; file links are blocked.`;
  const console_ = captureWarnings();
  const { unmount } = await mount(h);
  const url = "file:///tmp/report.txt";
  const link = anchor(url);
  activate(link);
  await act(async () => { await Promise.resolve(); });

  try {
    assert.equal(h.calls.length, 1, "the native trust boundary still makes the policy decision");
    assert.equal(h.toasts.length, 1);
    const [toast] = h.toasts;
    assert.equal(toast!.message, "Wollipog only opens web links in your browser.");
    assert.equal(toast!.options.tone, "warning");
    assert.equal(toast!.options.detail, url);
    assert.equal(toast!.options.detailStyle, "mono");
    assert.equal((toast!.options.action as ToastAction).label, "Copy Link");
    assert.doesNotMatch(JSON.stringify(toast), /file links are blocked/);
    assert.match(String(console_.warnings[0]?.[1]), /file links are blocked/);
  } finally {
    console_.restore();
    link.remove();
    await unmount();
  }
});

test("a copy the clipboard refuses leaves the URL on screen to select, without a Retry", async () => {
  const h = harness();
  h.rejectWith = "The system browser could not open this link: refused";
  const console_ = captureWarnings();
  const clipboard = fakeClipboard(async () => { throw new Error("NotAllowedError: denied"); });
  const execCommand = Object.getOwnPropertyDescriptor(domWindow.document, "execCommand");
  Object.defineProperty(domWindow.document, "execCommand", { configurable: true, value: () => false });
  const { unmount } = await mount(h);
  const url = "https://example.com/docs";
  const link = anchor(url);
  activate(link);
  await act(async () => { await Promise.resolve(); });

  try {
    await act(async () => { await (h.toasts[0]!.options.action as ToastAction).run(); });
    const last = h.toasts.at(-1)!;
    assert.equal(last.message, "Couldn't copy the link. Select it and copy it instead.");
    assert.equal(last.options.detail, url);
    assert.equal(last.options.action, undefined);
    assert.doesNotMatch(JSON.stringify(last), /NotAllowedError/);
  } finally {
    if (execCommand) Object.defineProperty(domWindow.document, "execCommand", execCommand);
    else delete (domWindow.document as unknown as Record<string, unknown>).execCommand;
    console_.restore();
    clipboard.restore();
    link.remove();
    await unmount();
  }
});
