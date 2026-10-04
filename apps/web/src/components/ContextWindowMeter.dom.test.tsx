import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView } from "@wollipog/protocol";
import type { ContextWindowCapacity } from "../context-window-capacity.js";
import { ContextWindowMeter } from "./ContextWindowMeter.js";

const domWindow = new Window();
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const CAPACITY: ContextWindowCapacity = { known: true, capacity: 200_000, source: "served", served: 200_000, advertised: null };
const UNKNOWN: ContextWindowCapacity = { known: false, capacity: null, source: null, served: null, advertised: null };

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "s1",
    driver: "claude-code",
    tokensIn: 184_000,
    tokensOut: 21_000,
    costUsd: 1234.56,
    contextTokensUsed: 72_000,
    contextWindow: 200_000,
    ...overrides,
  } as SessionView;
}

async function render(node: React.ReactNode) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => { root.render(node); });
  return {
    container,
    async cleanup() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

test("the ring is neutral below 75%, warning from 75% and danger from 90%, and its bar follows", async () => {
  for (const [used, tone] of [
    [149_999, null],
    [150_000, "t-warning"],
    [179_999, "t-warning"],
    [180_000, "t-danger"],
  ] as const) {
    const view = await render(<ContextWindowMeter session={session({ contextTokensUsed: used })} resolution={CAPACITY} placement="bar" />);
    try {
      const control = view.container.querySelector<HTMLElement>(".context-control")!;
      for (const candidate of ["t-warning", "t-danger"]) {
        assert.equal(control.classList.contains(candidate), candidate === tone, `${used} tokens: ${candidate}`);
      }
      await act(async () => { view.container.querySelector<HTMLButtonElement>("button")!.click(); });
      const meter = view.container.querySelector<HTMLElement>('.context-popover [role="progressbar"]')!;
      assert.equal(meter.className, tone ? `meter ${tone}` : "meter", `${used} tokens: the popover's bar`);
    } finally {
      await view.cleanup();
    }
  }
});

test("in the composer bar the ring is a ghost ComposerButton with a 14px ring and the percentage", async () => {
  const view = await render(<ContextWindowMeter session={session()} resolution={CAPACITY} placement="bar" />);
  try {
    const button = view.container.querySelector<HTMLButtonElement>("button")!;
    assert.equal(button.className, "btn ghost composer-btn cbar-usage");
    assert.equal(button.hasAttribute("data-composer-button"), true);
    assert.equal(button.getAttribute("aria-label"), "Context Window 36% Used");
    assert.equal(button.querySelector("svg")!.getAttribute("width"), "14");
    assert.equal(button.textContent, "36%");
  } finally {
    await view.cleanup();
  }
});

test("before any usage the bar shows no ring, while the preview header keeps its 0% ring", async () => {
  const empty = session({ tokensIn: 0, tokensOut: 0, costUsd: 0, contextTokensUsed: undefined });
  const bar = await render(<ContextWindowMeter session={empty} resolution={CAPACITY} placement="bar" />);
  try {
    assert.equal(bar.container.innerHTML, "");
  } finally {
    await bar.cleanup();
  }
  const header = await render(<ContextWindowMeter session={empty} resolution={CAPACITY} />);
  try {
    assert.equal(header.container.querySelector("button")!.getAttribute("aria-label"), "Context Window 0.0% Used");
  } finally {
    await header.cleanup();
  }
});
