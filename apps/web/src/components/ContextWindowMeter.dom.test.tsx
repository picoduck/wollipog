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
    const view = await render(<ContextWindowMeter session={session({ contextTokensUsed: used })} resolution={CAPACITY} />);
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

test("the ring is a ghost ComposerButton with a 14px ring and the percentage", async () => {
  const view = await render(<ContextWindowMeter session={session()} resolution={CAPACITY} />);
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

test("before any usage the bar shows no ring", async () => {
  const empty = session({ tokensIn: 0, tokensOut: 0, costUsd: 0, contextTokensUsed: undefined });
  const bar = await render(<ContextWindowMeter session={empty} resolution={CAPACITY} />);
  try {
    assert.equal(bar.container.innerHTML, "");
  } finally {
    await bar.cleanup();
  }
});

/** Opens the meter's popover and returns it. */
async function openPopover(view: Awaited<ReturnType<typeof render>>) {
  await act(async () => { view.container.querySelector<HTMLButtonElement>("button")!.click(); });
  return view.container.querySelector<HTMLElement>(".context-popover")!;
}

function facts(list: Element | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const term of list?.querySelectorAll("dt") ?? []) out[term.textContent ?? ""] = term.nextElementSibling?.textContent ?? "";
  return out;
}

test("the popover states Used, Remaining and Window in one unit style, with the source as a sentence", async () => {
  const view = await render(<ContextWindowMeter session={session()} resolution={CAPACITY} />);
  try {
    const popover = await openPopover(view);
    assert.equal(popover.querySelector(".usage-popover-title")!.textContent, "Context Window");
    assert.equal(popover.querySelector(".usage-popover-figure")!.textContent, "36%");
    const list = popover.querySelector("dl.facts");
    assert.deepEqual([...list!.querySelectorAll("dt")].map((term) => term.textContent), ["Used", "Remaining", "Window"]);
    assert.deepEqual(facts(list), { Used: "72K", Remaining: "128K", Window: "200K" });
    assert.match(popover.textContent ?? "", /Window size reported by the provider\./);
    assert.doesNotMatch(popover.textContent ?? "", /Provider Reported|Capacity/);
    assert.match(popover.textContent ?? "", /Context compacts automatically when the window fills\./);
    assert.equal(popover.querySelectorAll(".notice").length, 0, "no notice below 75%");
  } finally {
    await view.cleanup();
  }
  const catalog = await render(<ContextWindowMeter session={session()} resolution={{ ...CAPACITY, source: "catalog", served: null }} />);
  try {
    assert.match((await openPopover(catalog)).textContent ?? "", /Window size from the model catalog\./);
  } finally {
    await catalog.cleanup();
  }
});

test("from 75% a warning notice and from 90% a danger notice, in the ring's tone", async () => {
  for (const [used, tone, text] of [
    [156_000, "t-warning", "Over three quarters full. Claude Code will compact the conversation soon."],
    [184_000, "t-danger", "Almost full. The next long reply will trigger compaction."],
  ] as const) {
    const view = await render(<ContextWindowMeter session={session({ contextTokensUsed: used })} resolution={CAPACITY} />);
    try {
      const popover = await openPopover(view);
      assert.ok(view.container.querySelector(".context-control")!.classList.contains(tone));
      const notices = [...popover.querySelectorAll<HTMLElement>(".notice")];
      assert.equal(notices.length, 1, `${used} tokens: one notice`);
      assert.ok(notices[0]!.classList.contains("compact"));
      assert.ok(notices[0]!.classList.contains(tone), `${used} tokens: the notice takes the ring's tone`);
      assert.equal(notices[0]!.querySelector(".notice-body")!.textContent, text);
      assert.doesNotMatch(popover.textContent ?? "", /compacts automatically/, "the notice replaces the quiet sentence");
    } finally {
      await view.cleanup();
    }
  }
  // An agent that does not compact on its own gets no compaction claim, at any level.
  const acp = await render(<ContextWindowMeter session={session({ driver: "acp", contextTokensUsed: 184_000 })} resolution={CAPACITY} />);
  try {
    const popover = await openPopover(acp);
    assert.equal(popover.querySelectorAll(".notice").length, 0);
    assert.match(popover.textContent ?? "", /Compaction is up to the agent\./);
  } finally {
    await acp.cleanup();
  }
});

test("a served window that differs from the advertised one is a compact warning notice", async () => {
  const resolution: ContextWindowCapacity = { known: true, capacity: 128_000, source: "served", served: 128_000, advertised: 200_000 };
  const view = await render(<ContextWindowMeter session={session({ contextTokensUsed: 46_000 })} resolution={resolution} />);
  try {
    const popover = await openPopover(view);
    const notice = popover.querySelector<HTMLElement>(".notice.compact.t-warning")!;
    assert.equal(notice.getAttribute("role"), "status");
    assert.equal(notice.querySelector(".notice-body")!.textContent,
      "The provider is serving a 128K context window, not the 200K the selected model advertises. The meter uses the served size.");
  } finally {
    await view.cleanup();
  }
});
