import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { ThemeProvider, useTheme } from "./ThemeProvider.js";
import { DENSITY_STORAGE_KEY, SCHEME_STORAGE_KEY, THEME_STORAGE_KEY } from "../theme.js";

const domWindow = new Window({ url: "http://localhost/" });
let systemDark = false;
let changeListener: ((event: MediaQueryListEvent) => void) | undefined;
const media = {
  get matches() { return systemDark; },
  media: "(prefers-color-scheme: dark)",
  onchange: null,
  addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => { changeListener = listener; },
  removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
    if (changeListener === listener) changeListener = undefined;
  },
  addListener: () => undefined,
  removeListener: () => undefined,
  dispatchEvent: () => true,
} as MediaQueryList;
Object.defineProperty(domWindow, "matchMedia", { configurable: true, value: () => media });

for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  Event: domWindow.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function Harness() {
  const theme = useTheme();
  return (
    <div>
      <output>{`${theme.preference}:${theme.resolved}`}</output>
      <button onClick={() => theme.setPreference("dark")}>Dark</button>
      <button onClick={() => theme.setPreference("system")}>System</button>
    </div>
  );
}

test("theme provider persists explicit choices and follows system changes live", async () => {
  domWindow.localStorage.setItem(THEME_STORAGE_KEY, "system");
  domWindow.document.head.innerHTML = '<meta name="theme-color" content="#000000">';
  systemDark = false;
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);

  await act(async () => { root.render(<ThemeProvider><Harness /></ThemeProvider>); });
  assert.equal(container.querySelector("output")?.textContent, "system:light");
  assert.equal(domWindow.document.documentElement.dataset.theme, "light");

  await act(async () => { container.querySelectorAll("button")[0]!.click(); });
  assert.equal(container.querySelector("output")?.textContent, "dark:dark");
  assert.equal(domWindow.localStorage.getItem(THEME_STORAGE_KEY), "dark");

  await act(async () => { container.querySelectorAll("button")[1]!.click(); });
  systemDark = true;
  await act(async () => { changeListener?.({ matches: true } as MediaQueryListEvent); });
  assert.equal(container.querySelector("output")?.textContent, "system:dark");
  assert.equal(domWindow.document.documentElement.dataset.theme, "dark");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("a child measuring in its first layout effect already sees the stored palette, with no head bootstrap", async () => {
  // A page without index.html's bootstrap: nothing on the document yet. Settings measures its section
  // list in a layout effect, which runs before the provider's own; styles resolved then must be the
  // real palette, or every transitioned colour animates from the default one (#2158 regression).
  const root = domWindow.document.documentElement;
  delete root.dataset.theme;
  delete root.dataset.scheme;
  delete root.dataset.density;
  domWindow.localStorage.setItem(THEME_STORAGE_KEY, "light");
  domWindow.localStorage.setItem(SCHEME_STORAGE_KEY, "dracula");
  domWindow.localStorage.setItem(DENSITY_STORAGE_KEY, "comfortable");
  const seen: Array<Array<string | undefined>> = [];
  function Measuring() {
    useLayoutEffect(() => { seen.push([root.dataset.theme, root.dataset.scheme, root.dataset.density]); }, []);
    return null;
  }
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const reactRoot = createRoot(container);
  try {
    await act(async () => { reactRoot.render(<ThemeProvider><Measuring /></ThemeProvider>); });
    assert.deepEqual(seen, [["light", "dracula", "comfortable"]]);
  } finally {
    await act(async () => { reactRoot.unmount(); });
    container.remove();
    for (const key of [THEME_STORAGE_KEY, SCHEME_STORAGE_KEY, DENSITY_STORAGE_KEY]) domWindow.localStorage.removeItem(key);
  }
});
