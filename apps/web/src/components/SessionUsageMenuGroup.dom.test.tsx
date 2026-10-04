import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionUsageResponse, SessionView, UsageAmount } from "@wollipog/protocol";
import type { ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ContextWindowCapacity } from "../context-window-capacity.js";
import { ModelEffortMenuChoices, ModelSettingsPopover } from "./ComposerControls.js";
import { SessionUsageMenuGroup } from "./SessionUsageMenuGroup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window({ url: "http://localhost/" });
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
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
after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

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

function amount(overrides: Partial<UsageAmount> = {}): UsageAmount {
  return {
    inputTokens: 184_000,
    outputTokens: 21_000,
    costUsd: 1234.56,
    uncachedInputTokens: 184_000,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    processedTokens: 205_000,
    cacheSavingsUsd: 0,
    costSource: "modelPriced",
    unpricedRecords: 0,
    ...overrides,
  };
}

const USAGE: SessionUsageResponse = {
  sessionId: "s1",
  totals: amount(),
  byModel: [
    { model: "gpt-5.5-codex", ...amount({ inputTokens: 160_000, outputTokens: 18_000, costUsd: 1200, processedTokens: 178_000 }) },
    { model: "gpt-5.5-codex-mini", ...amount({ inputTokens: 24_000, outputTokens: 3_000, costUsd: 34.56, processedTokens: 27_000 }) },
  ],
  pricing: { status: "fresh", source: "https://example.test/prices.json", fetchedAt: 1, knownModels: 10 },
};

const client = { sessionUsage: async () => USAGE } as unknown as ApiClient;

async function render(node: React.ReactNode) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => { root.render(<ApiProvider client={client}>{node}</ApiProvider>); });
  return {
    container,
    async rerender(next: React.ReactNode) {
      await act(async () => { root.render(<ApiProvider client={client}>{next}</ApiProvider>); });
    },
    async cleanup() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

/** The name a row's aria-labelledby gives it, and the description its aria-describedby does, without
 * the aria-hidden text a screen reader skips. */
function rowName(row: Element): { name: string; description: string } {
  const spoken = (element: Element | null) => {
    if (!element) return "";
    const copy = element.cloneNode(true) as Element;
    copy.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
    return copy.textContent ?? "";
  };
  const text = (ids: string | null) => (ids ?? "").split(" ").filter(Boolean)
    .map((id) => spoken(domWindow.document.getElementById(id) as Element | null)).join(" ");
  return { name: text(row.getAttribute("aria-labelledby")), description: text(row.getAttribute("aria-describedby")) };
}

function modelSettings(view: SessionView, usage = true) {
  return (
    <ModelSettingsPopover label="GPT" ariaLabel="Model Settings: GPT">
      {(close) => (
        <ModelEffortMenuChoices
          models={[{ id: "gpt", displayName: "GPT" }]}
          modelVal="gpt"
          modelEfforts={["low", "high"]}
          effortVal="low"
          sessionUsage={usage ? <SessionUsageMenuGroup session={view} resolution={CAPACITY} /> : null}
          close={close}
          apply={() => undefined}
        />
      )}
    </ModelSettingsPopover>
  );
}

const active = () => domWindow.document.activeElement as unknown as HTMLElement;
const press = (key: string, shiftKey = false) => act(async () => {
  active().dispatchEvent(new domWindow.KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }) as never);
  // Focus returns to the Model Settings trigger on the next task.
  await new Promise((resolve) => domWindow.setTimeout(resolve, 0));
});
const dialog = (): HTMLElement | null =>
  domWindow.document.querySelector('[role="dialog"][aria-label="Model Settings"]') as unknown as HTMLElement | null;
const title = () => dialog()?.querySelector(".menu-head-title")?.textContent;
const row = (name: string) => [...(dialog()?.querySelectorAll("[data-model-settings-detail]") ?? [])]
  .find((candidate) => rowName(candidate).name === name) as HTMLButtonElement | undefined;

test("the Session Usage group lists Context Window, then Session Cost, each a row named by its label", async () => {
  const view = await render(<SessionUsageMenuGroup session={session({ contextTokensUsed: 186_000 })} resolution={CAPACITY} />);
  try {
    const group = view.container.querySelector<HTMLElement>('[role="group"][aria-label="Session Usage"]')!;
    const rows = [...group.querySelectorAll("button")];
    assert.deepEqual(rows.map((candidate) => rowName(candidate)), [
      { name: "Context Window", description: "93%186K of 200K" },
      { name: "Session Cost", description: "$1,234.56" },
    ]);
    const context = rows[0]!.querySelector(".session-usage-group-value")!;
    assert.ok(context.classList.contains("t-danger"), "the group's ring takes the same tone");
    assert.ok(group.nextElementSibling?.getAttribute("role") === "separator", "a hairline separates it from the model choices");
  } finally {
    await view.cleanup();
  }
});

test("the Session Usage group names an unpriced cost and drops an unknown window", async () => {
  const view = await render(<SessionUsageMenuGroup session={session({ costUsd: 0, costSource: "unpriced" })} resolution={UNKNOWN} />);
  try {
    const rows = [...view.container.querySelectorAll("button")];
    assert.deepEqual(rows.map((candidate) => rowName(candidate)), [{ name: "Session Cost", description: "Cost Unavailable" }]);
    const value = rows[0]!.querySelector(".session-usage-group-value")!;
    assert.ok(value.classList.contains("is-unpriced"));
    assert.equal(value.querySelector('[aria-hidden="true"]')!.textContent, "$—");
  } finally {
    await view.cleanup();
  }
});

test("a session without usage yet renders neither the group nor its separator", async () => {
  const view = await render(<SessionUsageMenuGroup session={session({ tokensIn: 0, tokensOut: 0, costUsd: 0, contextTokensUsed: undefined })} resolution={UNKNOWN} />);
  try {
    assert.equal(view.container.innerHTML, "");
  } finally {
    await view.cleanup();
  }
});

test("Session Cost opens the breakdown in Model Settings' place, and Escape closes one layer at a time", async () => {
  const view = await render(modelSettings(session({ driver: "codex-app-server" })));
  try {
    const trigger = view.container.querySelector<HTMLButtonElement>(".model-chip")!;
    await act(async () => { trigger.click(); });
    assert.equal(title(), "Model Settings");
    await act(async () => { row("Session Cost")!.click(); });

    const breakdown = dialog()!.querySelector<HTMLElement>('[role="group"][aria-label="Session Usage"]')!;
    assert.equal(title(), "Session Cost", "the title row names the breakdown");
    assert.ok(active() === dialog()!.querySelector('[aria-label="Back to Model Settings"]'), "focus moves to Back");
    assertNoDomNode(dialog()!.querySelector('[role="radiogroup"]'));
    assert.match(breakdown.textContent ?? "", /By Model/);
    assert.deepEqual([...breakdown.querySelectorAll(".session-usage-model-name")].map((name) => name.textContent),
      ["gpt-5.5-codex", "gpt-5.5-codex-mini"]);
    assert.ok(breakdown.querySelector('a[href="https://example.test/prices.json"]')?.textContent === "Estimated API Costs");
    const about = breakdown.querySelector<HTMLButtonElement>('[aria-label="About Codex App Server Usage"]');
    assert.ok(about, "a Codex App Server session keeps its usage note");

    // Tab reaches the note's button and the pricing link, and stays inside.
    const stops: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      await press("Tab");
      stops.push(active().getAttribute("aria-label") ?? active().textContent ?? "");
    }
    assert.deepEqual(stops, ["Close Model Settings", "About Codex App Server Usage", "Estimated API Costs", "Back to Model Settings"]);

    // The first Escape returns to the choices with focus on the row, not past Model Settings.
    let leaked = 0;
    const count = (event: KeyboardEvent) => { if (event.key === "Escape") leaked += 1; };
    domWindow.document.addEventListener("keydown", count as never);
    try {
      await press("Escape");
      assert.ok(dialog(), "Model Settings stays open");
      assert.equal(title(), "Model Settings");
      assert.ok(active() === row("Session Cost"), "focus returns to the Session Cost row");
      assert.ok(dialog()!.querySelector('[role="radiogroup"]'), "the choices are back");
      await press("Escape");
      assertNoDomNode(dialog());
      assert.ok(active() === trigger, "the second Escape closes Model Settings onto its trigger");
      assert.equal(leaked, 0, "neither press reached the document");
    } finally {
      domWindow.document.removeEventListener("keydown", count as never);
    }

    // A reopened popover starts on its choices.
    await act(async () => { trigger.click(); });
    assert.equal(title(), "Model Settings");
    assert.ok(row("Session Cost"));
  } finally {
    await view.cleanup();
  }
});

test("Escape still closes only the breakdown when live usage removes its focused link", async () => {
  const view = await render(modelSettings(session()));
  // The shell's own Escape (App.tsx) closes the open menu by its backdrop when the key reaches the window.
  let shellEscapes = 0;
  const shell = (event: KeyboardEvent) => { if (event.key === "Escape") shellEscapes += 1; };
  domWindow.addEventListener("keydown", shell as never);
  try {
    await act(async () => { view.container.querySelector<HTMLButtonElement>(".model-chip")!.click(); });
    await act(async () => { row("Session Cost")!.click(); });
    const link = dialog()!.querySelector<HTMLAnchorElement>("a.link")!;
    await act(async () => { link.focus(); });
    assert.ok(active() === link);
    // The runner's counters overtake the fetched ledger, which is rejected with its pricing link.
    await view.rerender(modelSettings(session({ tokensIn: 400_000 })));
    assertNoDomNode(dialog()!.querySelector("a.link"));
    assert.ok(active() === domWindow.document.body as unknown as HTMLElement, "focus fell to the document");

    await press("Escape");
    assert.ok(dialog(), "Model Settings stays open");
    assert.equal(title(), "Model Settings");
    assert.ok(active() === row("Session Cost"), "focus returns to the Session Cost row");
    assert.equal(shellEscapes, 0, "the press never reached the shell");
  } finally {
    domWindow.removeEventListener("keydown", shell as never);
    await view.cleanup();
  }
});

test("Context Window opens its breakdown too, and Back returns to its row", async () => {
  const view = await render(modelSettings(session()));
  try {
    await act(async () => { view.container.querySelector<HTMLButtonElement>(".model-chip")!.click(); });
    await act(async () => { row("Context Window")!.click(); });
    assert.equal(title(), "Context Window");
    const breakdown = dialog()!.querySelector<HTMLElement>('[role="group"][aria-label="Context Window"]')!;
    assert.match(breakdown.textContent ?? "", /Capacity200K · Provider Reported/);
    assert.match(breakdown.textContent ?? "", /Remaining128k/);
    assertNoDomNode(breakdown.querySelector('[aria-label="About Codex App Server Usage"]'));
    await act(async () => { dialog()!.querySelector<HTMLButtonElement>('[aria-label="Back to Model Settings"]')!.click(); });
    assert.equal(title(), "Model Settings");
    assert.ok(active() === row("Context Window"));
  } finally {
    await view.cleanup();
  }
});

test("a breakdown whose group goes away returns Model Settings to its choices", async () => {
  const view = await render(modelSettings(session()));
  try {
    await act(async () => { view.container.querySelector<HTMLButtonElement>(".model-chip")!.click(); });
    await act(async () => { row("Session Cost")!.click(); });
    assert.equal(title(), "Session Cost");
    // The composer widened: the bar seats the triggers again and the group leaves Model Settings.
    await view.rerender(modelSettings(session(), false));
    assert.equal(title(), "Model Settings");
    assert.ok(dialog()!.querySelector('[role="radiogroup"]'));
    assert.ok(dialog()!.contains(active()), "focus stays inside Model Settings");
  } finally {
    await view.cleanup();
  }
});
