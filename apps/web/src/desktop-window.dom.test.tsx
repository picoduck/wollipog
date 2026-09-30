import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  hasOverlayTitleBar,
  installDesktopWindowChrome,
  nativeWindowTheme,
  useNativeWindowTheme,
  useWindowTitle,
  windowDragRegion,
  windowTitle,
  type DesktopWindow,
} from "./desktop-window.js";
import { DetailBar, PageHeader } from "./components/PageHeader.js";
import { RailDragStrip } from "./components/Rail.js";
import type { ResolvedTheme, ThemePreference } from "./theme.js";
import { assertNoDomNode } from "./dom-test-assertions.js";

const domWindow = new Window({ url: "http://localhost/" });
const globals = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const prior = Object.fromEntries(Object.keys(globals).map((name) => [name, (globalThis as Record<string, unknown>)[name]]));

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

/** Tauri's own `isTauri()` reads this global, which its webview sets before any page script. */
function runInTauriOn(platform: string) {
  Object.defineProperty(globalThis, "isTauri", { configurable: true, writable: true, value: true });
  Object.defineProperty(domWindow.navigator, "platform", { configurable: true, get: () => platform });
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)["isTauri"];
  Object.defineProperty(domWindow.navigator, "platform", { configurable: true, get: () => "" });
  domWindow.document.title = "";
});

function fakeWindow(options: { tauri?: boolean; platform?: string } = {}) {
  const calls: Array<[string, unknown]> = [];
  const desktop: DesktopWindow = {
    isTauri: () => options.tauri ?? true,
    platform: () => options.platform ?? "MacIntel",
    setTheme: async (theme) => { calls.push(["setTheme", theme]); },
    setTitle: async (title) => { calls.push(["setTitle", title]); },
  };
  return { desktop, calls };
}

async function mount(node: React.ReactNode) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    rerender: (next: React.ReactNode) => act(async () => root.render(next)),
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("only the macOS desktop app runs under an overlay title bar", () => {
  assert.equal(hasOverlayTitleBar(fakeWindow({ platform: "MacIntel" }).desktop), true);
  assert.equal(hasOverlayTitleBar(fakeWindow({ platform: "Win32" }).desktop), false);
  assert.equal(hasOverlayTitleBar(fakeWindow({ platform: "Linux x86_64" }).desktop), false);
  assert.equal(hasOverlayTitleBar(fakeWindow({ tauri: false, platform: "MacIntel" }).desktop), false,
    "Safari on a Mac keeps its own title bar");
});

test("the document is marked for the traffic lights before the first paint, and only on macOS", () => {
  const root = domWindow.document.createElement("html") as unknown as HTMLElement;
  installDesktopWindowChrome(root, fakeWindow({ platform: "MacIntel" }).desktop);
  assert.equal(root.classList.contains("macos-title-bar"), true);
  installDesktopWindowChrome(root, fakeWindow({ platform: "Win32" }).desktop);
  assert.equal(root.classList.contains("macos-title-bar"), false);
  installDesktopWindowChrome(root, fakeWindow({ tauri: false }).desktop);
  assert.equal(root.classList.contains("macos-title-bar"), false);
});

test("a bar drags the window from anything that is not a control, on macOS only", () => {
  assert.deepEqual(windowDragRegion(fakeWindow({ platform: "MacIntel" }).desktop), { "data-tauri-drag-region": "deep" });
  assert.deepEqual(windowDragRegion(fakeWindow({ platform: "Win32" }).desktop), {},
    "Windows and Linux keep their native title bar to drag");
  assert.deepEqual(windowDragRegion(fakeWindow({ tauri: false }).desktop), {});
});

test("the page header, the detail bar and the rail strip are the macOS drag regions; their controls are not", async () => {
  runInTauriOn("MacIntel");
  const view = await mount(
    <>
      <PageHeader title="Agent Skills" description="Skills." primary={{ label: "New Skill", onClick: () => {} }} />
      <DetailBar title="Docs Overhaul" backLabel="Back to Sessions" onBack={() => {}} primary={{ label: "Open", onClick: () => {} }} />
      <RailDragStrip />
    </>,
  );
  try {
    const header = view.container.querySelector(".page-header")!;
    const bar = view.container.querySelector(".detail-bar")!;
    assert.equal(header.getAttribute("data-tauri-drag-region"), "deep");
    assert.equal(bar.getAttribute("data-tauri-drag-region"), "deep");
    // Tauri's handler lets a native control stop the drag only when the control carries no region
    // of its own, so a button that did would move the window instead of activating.
    for (const control of view.container.querySelectorAll("button")) {
      assert.equal(control.getAttribute("data-tauri-drag-region"), null, control.textContent ?? "");
    }
    // The title is focusable only programmatically, which Tauri counts as a place to drag from.
    assert.equal(header.querySelector("h1")!.getAttribute("tabindex"), "-1");
    const strip = view.container.querySelector(".rail-drag-strip")!;
    assert.equal(strip.getAttribute("data-tauri-drag-region"), "", "the strip itself, which has nothing in it");
    assert.equal(strip.getAttribute("aria-hidden"), "true");
  } finally {
    await view.unmount();
  }
});

test("in a browser and on Windows and Linux the bars carry no drag region", async () => {
  for (const platform of [null, "Win32", "Linux x86_64"]) {
    if (platform) runInTauriOn(platform);
    const view = await mount(
      <>
        <PageHeader title="Agent Skills" />
        <DetailBar title="Docs Overhaul" backLabel="Back to Sessions" onBack={() => {}} />
      </>,
    );
    try {
      assertNoDomNode(view.container.querySelector("[data-tauri-drag-region='deep']"), String(platform));
    } finally {
      await view.unmount();
    }
  }
});

test("a System preference leaves the native window following the operating system", () => {
  const cases: Array<[ThemePreference, ResolvedTheme, ResolvedTheme | null]> = [
    ["dark", "dark", "dark"],
    ["light", "light", "light"],
    ["system", "dark", null],
    ["system", "light", null],
  ];
  for (const [preference, resolved, expected] of cases) {
    assert.equal(nativeWindowTheme(preference, resolved), expected, `${preference} → ${resolved}`);
  }
});

function ThemeProbe({ preference, resolved, desktop }: { preference: ThemePreference; resolved: ResolvedTheme; desktop: DesktopWindow }) {
  useNativeWindowTheme(preference, resolved, desktop);
  return null;
}

test("switching the theme in Settings switches the native window's, without a restart", async () => {
  const { desktop, calls } = fakeWindow({ platform: "Win32" });
  const view = await mount(<ThemeProbe preference="dark" resolved="dark" desktop={desktop} />);
  try {
    await view.rerender(<ThemeProbe preference="light" resolved="light" desktop={desktop} />);
    await view.rerender(<ThemeProbe preference="system" resolved="dark" desktop={desktop} />);
    // The system switching the app from dark to light asks for nothing new: the window follows the
    // system by itself.
    await view.rerender(<ThemeProbe preference="system" resolved="light" desktop={desktop} />);
    assert.deepEqual(calls, [["setTheme", "dark"], ["setTheme", "light"], ["setTheme", null]]);
  } finally {
    await view.unmount();
  }
});

test("a browser has no native window theme to set, and a refused request is not an error", async () => {
  const browser = fakeWindow({ tauri: false });
  const view = await mount(<ThemeProbe preference="dark" resolved="dark" desktop={browser.desktop} />);
  await view.unmount();
  assert.deepEqual(browser.calls, []);

  // An older shell without the permission rejects the command; the page has changed regardless.
  const refusing: DesktopWindow = { ...fakeWindow().desktop, setTheme: () => Promise.reject(new Error("not allowed")) };
  const refused = await mount(<ThemeProbe preference="light" resolved="light" desktop={refusing} />);
  await refused.unmount();
});

test("the window title reads \"<Page> – Wollipog\"", () => {
  assert.equal(windowTitle("Agent Skills"), "Agent Skills – Wollipog");
  assert.equal(windowTitle("  Docs Overhaul  "), "Docs Overhaul – Wollipog");
  assert.equal(windowTitle(""), "Wollipog");
  assert.equal(windowTitle(undefined), "Wollipog");
});

function TitleProbe({ page, desktop }: { page: string; desktop: DesktopWindow }) {
  useWindowTitle(page, desktop);
  return null;
}

test("the document and the desktop window take the page's title and follow navigation", async () => {
  const { desktop, calls } = fakeWindow({ platform: "Win32" });
  const view = await mount(<TitleProbe page="Agent Skills" desktop={desktop} />);
  try {
    assert.equal(domWindow.document.title, "Agent Skills – Wollipog");
    await view.rerender(<TitleProbe page="Docs Overhaul Bake-Off" desktop={desktop} />);
    assert.equal(domWindow.document.title, "Docs Overhaul Bake-Off – Wollipog");
    assert.deepEqual(calls, [["setTitle", "Agent Skills – Wollipog"], ["setTitle", "Docs Overhaul Bake-Off – Wollipog"]]);
  } finally {
    await view.unmount();
  }

  const browser = fakeWindow({ tauri: false });
  const tab = await mount(<TitleProbe page="Usage and Cost" desktop={browser.desktop} />);
  assert.equal(domWindow.document.title, "Usage and Cost – Wollipog", "a browser tab reads the same title");
  assert.deepEqual(browser.calls, []);
  await tab.unmount();
});

test("the macOS window has no title bar of its own, and the traffic lights sit inside the 64px rail", () => {
  const railWidth = 64;
  for (const config of ["tauri.conf.json", "tauri.e2e.conf.json"]) {
    const parsed = JSON.parse(readFileSync(new URL(`../../desktop/src-tauri/${config}`, import.meta.url), "utf8")) as {
      app: { windows: Array<Record<string, unknown>> };
    };
    const [main] = parsed.app.windows;
    assert.equal(main!["titleBarStyle"], "Overlay", config);
    assert.equal(main!["hiddenTitle"], true, config);
    assert.equal(main!["minWidth"], 940, config);
    assert.equal(main!["minHeight"], 600, config);
    const { x, y } = main!["trafficLightPosition"] as { x: number; y: number };
    // AppKit's three 14pt buttons, 20pt apart: the last ends 54pt after the first begins. They stay
    // clear of the rail's 1px right hairline, and inside the 40px strip above the instance tile.
    assert.ok(x > 0 && x + 54 <= railWidth - 1, `${config}: x ${x}`);
    assert.ok(y > 0 && y + 16 <= 40, `${config}: y ${y}`);
  }
});

test("the desktop app is granted exactly the window permissions it uses", () => {
  const capability = JSON.parse(readFileSync(new URL("../../desktop/src-tauri/capabilities/default.json", import.meta.url), "utf8")) as {
    windows: string[];
    permissions: string[];
  };
  assert.deepEqual(capability.windows, ["main"], "they act only on the app's own window");
  assert.deepEqual(capability.permissions.filter((permission) => permission.startsWith("core:window:")), [
    // Dragging from `data-tauri-drag-region`, the theme and the title (#1979).
    "core:window:allow-start-dragging",
    "core:window:allow-set-theme",
    "core:window:allow-set-title",
  ]);
});

test("the rail keeps the traffic lights' strip clear in the macOS app, and nowhere else", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  assert.match(css, /--title-bar-h: 40px;/);
  assert.match(css, /\.rail-drag-strip \{ display: none; \}/, "the strip is hidden unless the class asks for it");
  assert.match(css, /:root\.macos-title-bar \.app-rail,\s*:root\.macos-title-bar \.instance-recovery-nav \{[^}]*padding-top: var\(--title-bar-h\);/);
  assert.match(css, /:root\.macos-title-bar \.rail-drag-strip \{[^}]*position: absolute;[^}]*height: var\(--title-bar-h\);/);
});
