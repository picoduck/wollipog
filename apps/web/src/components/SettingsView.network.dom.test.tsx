import "./test-dom-events.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { TailnetAccessSetting } from "../tailnet-access.js";
import { NetworkPanel } from "./SettingsView.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window({ url: "http://localhost/settings/network" });
const previous = new Map<string, unknown>();
const globals = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, (globalThis as Record<string, unknown>)[name]);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

after(() => {
  for (const [name, value] of previous) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

function tailnet(overrides: Partial<TailnetAccessSetting> = {}): TailnetAccessSetting {
  return {
    status: { available: true, enabled: false, managed: true },
    loading: false,
    desktop: true,
    busy: false,
    error: null,
    toggle: () => undefined,
    ...overrides,
  };
}

async function render(setting: TailnetAccessSetting) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<NetworkPanel tailnet={setting} />));
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const sheet = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

test("a failed Tailnet change reads as an error, in a class the stylesheet colors as danger", async () => {
  // The row used `error-text`, which no rule matched once the old selector was retired, so the
  // failure rendered as ordinary helper text.
  const view = await render(tailnet({ error: "Tailscale refused the change." }));
  try {
    const message = view.container.querySelector(".ui-row-desc .danger-text");
    assert.equal(message?.textContent, "Tailscale refused the change.", "the error replaces the row description");
    assert.match(sheet, /\n\.danger-text\s*\{[^}]*color:\s*var\(--danger-text\);/);
  } finally {
    await view.unmount();
  }
});

test("without an error the description keeps its helper styling", async () => {
  const view = await render(tailnet());
  try {
    assertNoDomNode(view.container.querySelector(".danger-text"));
    assertNoDomNode(view.container.querySelector(".error-text"));
  } finally {
    await view.unmount();
  }
});
