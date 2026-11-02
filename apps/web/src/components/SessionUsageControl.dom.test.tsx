import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { AgentModel, SessionUsageResponse, SessionView, UsageAmount, UsageCostSource } from "@wollipog/protocol";
import type { ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { SessionUsageControl } from "./SessionUsageControl.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

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

function amount(overrides: Partial<UsageAmount> = {}): UsageAmount {
  return {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    processedTokens: 0,
    cacheSavingsUsd: 0,
    costSource: "providerReported" as UsageCostSource,
    unpricedRecords: 0,
    ...overrides,
  };
}

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "s1",
    tokensIn: 25_000,
    tokensOut: 900,
    costUsd: 0.59,
    contextTokensUsed: 25_000,
    contextWindow: 258_000,
    ...overrides,
  } as SessionView;
}

/** `usage` answers every fetch, or a list answers them in turn (the last one repeating). */
async function mount(
  view: SessionView,
  usage: SessionUsageResponse | Error | null | ReadonlyArray<SessionUsageResponse | Error>,
  models?: AgentModel[],
) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  let fetches = 0;
  const client = {
    sessionUsage: async () => {
      const answers = Array.isArray(usage) ? usage : [usage];
      const answer = answers[Math.min(fetches, answers.length - 1)] as SessionUsageResponse | Error | null;
      fetches += 1;
      if (answer instanceof Error) throw answer;
      if (!answer) return new Promise<never>(() => {});
      return answer;
    },
  } as unknown as ApiClient;
  const node = (next: SessionView) => (
    <ApiProvider client={client}><SessionUsageControl session={next} models={models} /></ApiProvider>
  );
  await act(async () => { root.render(node(view)); });
  return {
    container,
    fetches: () => fetches,
    button: () => container.querySelector<HTMLButtonElement>(".cbar-usage"),
    popover: () => container.querySelector<HTMLElement>(".session-usage-popover"),
    async open() {
      await act(async () => { container.querySelector<HTMLButtonElement>(".cbar-usage")!.click(); });
    },
    async rerender(next: SessionView) {
      await act(async () => { root.render(node(next)); });
    },
    async cleanup() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

/** Reads a definition list as `{ term: value }` so assertions name the fact, not the DOM order. */
function facts(list: Element | null): Record<string, string> {
  const out: Record<string, string> = {};
  const terms = [...(list?.querySelectorAll("dt") ?? [])];
  const values = [...(list?.querySelectorAll("dd") ?? [])];
  terms.forEach((term, index) => { out[term.textContent ?? ""] = values[index]?.textContent ?? ""; });
  return out;
}

/** The Token Breakdown disclosure's facts. */
const breakdown = (popover: Element) => facts(popover.querySelector(".usage-disclosure dl"));

/** The table by model as rows of cell text, the Total row last. */
function table(popover: Element): string[][] {
  return [...popover.querySelectorAll(".usage-table tr")]
    .map((row) => [...row.children].map((cell) => cell.textContent ?? ""));
}

const notes = (popover: Element) => [...popover.querySelectorAll(".usage-popover-note")].map((note) => note.textContent);

test("a priced session shows only the cost, and opens Session Cost with the token breakdown closed", async () => {
  const view = await mount(session(), {
    sessionId: "s1",
    totals: amount({
      inputTokens: 40_000,
      uncachedInputTokens: 2_000,
      cachedInputTokens: 36_000,
      cacheCreationTokens: 2_000,
      outputTokens: 900,
      reasoningTokens: 300,
      processedTokens: 40_900,
      costUsd: 0.59,
      costSource: "providerReported",
    }),
    byModel: [],
  });

  const button = view.button()!;
  assert.equal(button.textContent, "$0.59");
  assert.equal(button.getAttribute("aria-label"), "Session Usage: $0.59");
  assert.equal(button.getAttribute("aria-expanded"), "false");
  // The trailing control shows no context figures at all — that is the ring's job (#781).
  assert.doesNotMatch(view.container.textContent ?? "", /context/i);
  assert.doesNotMatch(view.container.textContent ?? "", /258k/);

  await view.open();
  const popover = view.popover()!;
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(popover.getAttribute("aria-label"), "Session Cost");
  assert.equal(button.getAttribute("aria-controls"), popover.getAttribute("id"));
  assert.equal(popover.querySelector(".usage-popover-title")!.textContent, "Session Cost");
  assert.equal(popover.querySelector(".usage-popover-figure")!.textContent, "$0.59");
  // No ledger rows yet: the processed total stays in view in place of the table.
  assertNoDomNode(popover.querySelector(".usage-table"));
  assert.deepEqual(facts(popover.querySelector(".session-usage-popover > dl.facts")), { Tokens: "41K" });
  const disclosure = popover.querySelector<HTMLDetailsElement>("details.disclosure")!;
  assert.equal(disclosure.open, false, "Token Breakdown is closed by default");
  assert.match(disclosure.querySelector("summary")!.textContent ?? "", /^Token Breakdown$/);
  assert.deepEqual(breakdown(popover), { Input: "2K", Output: "900", "Cache Read": "36K", "Cache Write": "2K", Reasoning: "300" });
  assert.ok(notes(popover).includes("Cost as reported by the provider."));
  // Occupancy and capacity stay with the context meter; the usage panel never repeats them.
  assert.doesNotMatch(popover.textContent ?? "", /Capacity|Remaining|258K/);

  await view.cleanup();
});

test("Escape dismisses the popover and the control keeps its own accessible name", async () => {
  const view = await mount(session(), { sessionId: "s1", totals: amount(), byModel: [] });
  await view.open();
  assert.ok(view.popover());
  // The session view's own Escape handler skips a prevented key, so consuming it keeps one Escape
  // from also leaving the session (#1796).
  const escape = new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  let reachedView = false;
  const onViewKey = () => { reachedView = true; };
  domWindow.addEventListener("keydown", onViewKey);
  await act(async () => {
    view.button()!.dispatchEvent(escape as never);
  });
  domWindow.removeEventListener("keydown", onViewKey);
  assertNoDomNode(view.popover());
  assert.equal(view.button()!.getAttribute("aria-expanded"), "false");
  assert.equal(escape.defaultPrevented, true);
  assert.equal(reachedView, false, "a view-level Escape handler never sees the key that closed the popover");
  await view.cleanup();
});

test("a modal opened over the popover keeps the first Escape", async () => {
  const view = await mount(session(), { sessionId: "s1", totals: amount(), byModel: [] });
  await view.open();
  const modal = domWindow.document.createElement("div");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  domWindow.document.body.append(modal);
  const escape = new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => {
    modal.dispatchEvent(escape);
  });
  assert.ok(view.popover(), "the popover beneath the modal stays open");
  assert.equal(escape.defaultPrevented, false, "the modal's own Escape handling still sees the key");
  modal.remove();
  await act(async () => {
    view.button()!.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as never);
  });
  assertNoDomNode(view.popover());
  await view.cleanup();
});

test("a menu opened over the popover from the keyboard keeps the first Escape", async () => {
  const view = await mount(session(), { sessionId: "s1", totals: amount(), byModel: [] });
  await view.open();
  const menu = domWindow.document.createElement("div");
  menu.setAttribute("role", "menu");
  domWindow.document.body.append(menu);
  const escape = new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => {
    menu.dispatchEvent(escape);
  });
  assert.ok(view.popover(), "the popover beneath the menu stays open");
  assert.equal(escape.defaultPrevented, false);
  menu.remove();
  await view.cleanup();
});

test("a non-modal popup dialog opened over the popover keeps the first Escape", async () => {
  // The session header's hidden-status list is a `role="dialog"` popup without aria-modal.
  const view = await mount(session(), { sessionId: "s1", totals: amount(), byModel: [] });
  await view.open();
  const popup = domWindow.document.createElement("div");
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "Session Statuses");
  domWindow.document.body.append(popup);
  const escape = new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => {
    popup.dispatchEvent(escape);
  });
  assert.ok(view.popover());
  assert.equal(escape.defaultPrevented, false);
  popup.remove();
  await view.cleanup();
});

test("a field that focus has moved on to keeps its own Escape while the popover closes", async () => {
  const view = await mount(session(), { sessionId: "s1", totals: amount(), byModel: [] });
  await view.open();
  const field = domWindow.document.createElement("textarea");
  domWindow.document.body.append(field);
  field.focus();
  const escape = new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => {
    field.dispatchEvent(escape);
  });
  assertNoDomNode(view.popover());
  assert.equal(escape.defaultPrevented, false, "the composer's own Escape (closing its suggestions, blurring) still runs");
  assert.equal(domWindow.document.activeElement, field as never, "focus is not pulled back to the chip");
  field.remove();
  await view.cleanup();
});

test("an IME's composition Escape neither closes the popover nor is consumed", async () => {
  const view = await mount(session(), { sessionId: "s1", totals: amount(), byModel: [] });
  await view.open();
  const escape = new domWindow.KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true });
  await act(async () => {
    view.button()!.dispatchEvent(escape as never);
  });
  assert.ok(view.popover());
  assert.equal(escape.defaultPrevented, false);
  await view.cleanup();
});

test("Escape passes through once the open control has stopped rendering", async () => {
  // Usage that never arrives keeps the label on the session snapshot, so zeroing it unrenders the chip.
  const view = await mount(session(), null);
  await view.open();
  assert.ok(view.popover());
  await view.rerender(session({ tokensIn: 0, tokensOut: 0, costUsd: 0 }));
  assertNoDomNode(view.button());
  const escape = new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => {
    domWindow.document.body.dispatchEvent(escape);
  });
  assert.equal(escape.defaultPrevented, false, "no visible popover, so the session's own Escape still runs");
  await view.rerender(session());
  assertNoDomNode(view.popover(), "the stale open state was cleared rather than reappearing");
  await view.cleanup();
});

test("Escape from inside the popover returns focus to the cost chip", async () => {
  const view = await mount(session(), {
    sessionId: "s1",
    totals: amount({ processedTokens: 25_900, costUsd: 0.59, costSource: "modelPriced" }),
    byModel: [],
    pricing: { status: "fresh", source: "https://example.com/rates.json", fetchedAt: 1, knownModels: 1200 },
  });
  await view.open();
  const info = view.popover()!.querySelector<HTMLAnchorElement>("a.link")!;
  info.focus();
  assert.equal(domWindow.document.activeElement, info as never);
  await act(async () => {
    info.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as never);
  });
  assertNoDomNode(view.popover());
  assert.equal(domWindow.document.activeElement, view.button() as never);
  await view.cleanup();
});

test("an unpriced session shows its token count, the Unpriced badge and Unpriced cells, never $0.00", async () => {
  const view = await mount(session({ costUsd: 0, tokensIn: 184_000, tokensOut: 21_000 }), {
    sessionId: "s1",
    totals: amount({ inputTokens: 184_000, outputTokens: 21_000, processedTokens: 205_000, costSource: "unpriced", unpricedRecords: 4 }),
    byModel: [
      { model: "local-large", ...amount({ inputTokens: 160_000, outputTokens: 18_000, processedTokens: 178_000, costSource: "unpriced", unpricedRecords: 3 }) },
      { model: "local-small", ...amount({ inputTokens: 24_000, outputTokens: 3_000, processedTokens: 27_000, costSource: "unpriced", unpricedRecords: 1 }) },
    ],
  });

  const button = view.button()!;
  assert.equal(button.textContent, "205K Tokens");
  assert.equal(button.getAttribute("aria-label"), "Session Usage: 205K Tokens, Unpriced");
  assert.doesNotMatch(button.textContent ?? "", /\$/);

  await view.open();
  const popover = view.popover()!;
  const badge = popover.querySelector(".usage-popover-head .status")!;
  assert.equal(badge.textContent, "Unpriced");
  assert.ok(badge.classList.contains("t-neutral"));
  assertNoDomNode(popover.querySelector(".usage-popover-figure"));
  assert.ok(notes(popover).includes("No rate is known for these models, so the cost isn't estimated. Token counts are exact."));
  assert.deepEqual(table(popover), [
    ["Model", "Tokens", "Cost"],
    ["local-large", "178K", "Unpriced"],
    ["local-small", "27K", "Unpriced"],
    ["Total", "205K", "Unpriced"],
  ]);
  assert.doesNotMatch(popover.textContent ?? "", /\$0\.00|lower bound/);
  await view.cleanup();
});

test("two models are one table of two rows plus Total, by display name, with nothing uppercased or monospace", async () => {
  const models: AgentModel[] = [{ id: "opus", displayName: "Opus 5" }];
  const view = await mount(session({ costUsd: 1.37, tokensIn: 184_000, tokensOut: 21_000 }), {
    sessionId: "s1",
    totals: amount({ inputTokens: 184_000, uncachedInputTokens: 24_000, cachedInputTokens: 160_000, outputTokens: 21_000,
      processedTokens: 205_000, costUsd: 1.37, costSource: "modelPriced" }),
    byModel: [
      { model: "opus", ...amount({ processedTokens: 178_000, costUsd: 1.21, costSource: "modelPriced" }) },
      { model: "claude-haiku-4-5-20251001", ...amount({ processedTokens: 27_000, costUsd: 0.16, costSource: "modelPriced" }) },
    ],
    pricing: { status: "fresh", source: "https://example.com/rates.json", fetchedAt: 1, knownModels: 1200 },
  }, models);

  await view.open();
  const popover = view.popover()!;
  assert.equal(popover.querySelectorAll("table").length, 1);
  assert.equal(popover.querySelector("table")!.className, "table compact usage-table");
  assert.deepEqual(table(popover), [
    ["Model", "Tokens", "Cost"],
    ["Opus 5", "178K", "$1.21"],
    ["Haiku 4.5", "27K", "$0.16"],
    ["Total", "205K", "$1.37"],
  ]);
  // The catalog's display name, else `resolvedModelLabel`; the exact id is the tooltip.
  const names = [...popover.querySelectorAll("tbody th")];
  assert.deepEqual(names.map((name) => name.getAttribute("title")), ["opus", "claude-haiku-4-5-20251001"]);
  assert.deepEqual([...popover.querySelectorAll("thead th")].map((header) => header.getAttribute("scope")), ["col", "col", "col"]);
  assert.equal(popover.querySelector<HTMLDetailsElement>("details.disclosure")!.open, false);
  // §17.1: no text is set in capitals or a monospace face by a class that could carry it.
  for (const element of popover.querySelectorAll("*")) {
    assert.doesNotMatch(element.className.toString(), /mono|uppercase|session-usage-label|session-usage-model/, element.outerHTML);
  }
  assert.doesNotMatch(popover.textContent ?? "", /By Model|BY MODEL/);
  // The footer names the rates; the link carries the source rather than printing it.
  const foot = popover.querySelector(".usage-popover-foot")!;
  assert.equal(foot.querySelector(".usage-popover-note")!.textContent, "Estimated API cost at published rates.");
  const link = foot.querySelector("a")!;
  assert.equal(link.textContent, "published rates");
  assert.equal(link.getAttribute("href"), "https://example.com/rates.json");
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.getAttribute("rel"), "noreferrer");
  await view.cleanup();
});

test("a free session reports $0.00 once the ledger proves the provider priced it", async () => {
  const view = await mount(session({ costUsd: 0 }), {
    sessionId: "s1",
    totals: amount({ inputTokens: 25_000, outputTokens: 900, processedTokens: 25_900, costUsd: 0, costSource: "providerReported" }),
    byModel: [
      { model: "local-llama", ...amount({ inputTokens: 25_000, outputTokens: 900, processedTokens: 25_900, costSource: "providerReported" }) },
    ],
  });

  // Before the ledger loads, the strip cannot tell "free" from "nobody priced it", so it shows tokens.
  assert.equal(view.button()!.textContent, "26K Tokens");
  await view.open();
  const popover = view.popover()!;
  // Once provenance is known, zero is stated as the amount it is rather than as a missing price.
  assert.equal(view.button()!.textContent, "$0.00");
  assert.equal(view.button()!.getAttribute("aria-label"), "Session Usage: $0.00");
  assert.equal(popover.querySelector(".usage-popover-figure")!.textContent, "$0.00");
  assert.doesNotMatch(popover.textContent ?? "", /Unpriced/);
  assert.deepEqual(table(popover).slice(1), [["local-llama", "26K", "$0.00"], ["Total", "26K", "$0.00"]]);
  await view.cleanup();
});

test("a provider-reported free snapshot keeps a $0.00 figure while detail is pending", async () => {
  const view = await mount(session({ costUsd: 0, costSource: "providerReported" }), null);

  assert.equal(view.button()!.textContent, "$0.00");
  await view.open();
  assert.equal(view.popover()!.querySelector(".usage-popover-figure")!.textContent, "$0.00");
  assertNoDomNode(view.popover()!.querySelector(".usage-popover-head .status"));
  await view.cleanup();
});

test("a cost without token counts says so, with no table, no breakdown and no unknown model", async () => {
  const view = await mount(session({ tokensIn: 0, tokensOut: 0, costUsd: 0.42 }), {
    sessionId: "s1",
    totals: amount({ costUsd: 0.42, costSource: "providerReported" }),
    byModel: [{ model: "unknown", ...amount({ costUsd: 0.42, costSource: "providerReported" }) }],
  });
  assert.equal(view.button()!.textContent, "$0.42");
  await view.open();
  const popover = view.popover()!;
  assert.equal(popover.querySelector(".usage-popover-figure")!.textContent, "$0.42");
  assert.ok(notes(popover).includes("The provider reported this cost but no token counts, so there is no breakdown by model."));
  assertNoDomNode(popover.querySelector("table"));
  assertNoDomNode(popover.querySelector("details"));
  assertNoDomNode(popover.querySelector("dl"));
  assert.doesNotMatch(popover.textContent ?? "", /unknown/);
  await view.cleanup();
});

test("a failed breakdown is a compact danger notice whose Retry refetches once", async () => {
  const ledger: SessionUsageResponse = {
    sessionId: "s1",
    totals: amount({ inputTokens: 25_000, outputTokens: 900, processedTokens: 25_900, costUsd: 0.59, costSource: "providerReported" }),
    byModel: [{ model: "gpt-5.5-codex", ...amount({ processedTokens: 25_900, costUsd: 0.59, costSource: "providerReported" }) }],
  };
  const view = await mount(session(), [new Error("usage endpoint unavailable"), ledger]);
  await view.open();
  assert.equal(view.fetches(), 1);
  const popover = view.popover()!;
  const notice = popover.querySelector<HTMLElement>(".notice")!;
  assert.ok(notice.classList.contains("compact"));
  assert.ok(notice.classList.contains("t-danger"));
  assert.equal(notice.getAttribute("role"), "alert");
  assert.equal(notice.querySelector(".notice-body")!.textContent, "Couldn't load the breakdown by model.");
  // The raw message stays behind Show Details.
  assert.doesNotMatch(notice.textContent ?? "", /usage endpoint unavailable/);
  const toggle = [...notice.querySelectorAll("button")].find((button) => button.textContent === "Show Details")!;
  await act(async () => { toggle.click(); });
  assert.match(notice.textContent ?? "", /usage endpoint unavailable/);
  // The processed total stays visible beside the failure.
  assert.deepEqual(facts(popover.querySelector(".session-usage-popover > dl.facts")), { Tokens: "26K" });

  const retry = [...notice.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
  await act(async () => { retry.click(); });
  assert.equal(view.fetches(), 2, "Retry refetches once");
  assertNoDomNode(view.popover()!.querySelector(".notice"));
  assert.deepEqual(table(view.popover()!).slice(1), [["gpt-5.5-codex", "26K", "$0.59"], ["Total", "26K", "$0.59"]]);
  await view.cleanup();
});

test("a lagging ledger drives nothing in the panel, not just the token rows", async () => {
  // A previously provider-priced zero plus newer, not-yet-ledgered tokens: if any part of the
  // panel still read from this response, the session would claim to be free.
  const view = await mount(session({ tokensIn: 9_000, tokensOut: 1_000, costUsd: 0 }), {
    sessionId: "s1",
    totals: amount({ inputTokens: 100, outputTokens: 10, processedTokens: 110, costUsd: 0, costSource: "providerReported" }),
    byModel: [
      { model: "stale-model", ...amount({ inputTokens: 100, outputTokens: 10, processedTokens: 110, costSource: "providerReported" }) },
    ],
    pricing: { status: "fresh", source: "litellm", fetchedAt: 1, knownModels: 1200 },
  });

  assert.equal(view.button()!.textContent, "10K Tokens", "a stale priced zero must not be shown as $0.00");
  await view.open();
  const popover = view.popover()!;
  assert.deepEqual(breakdown(popover), { Input: "9K", Output: "1K" });
  assert.deepEqual(facts(popover.querySelector(".session-usage-popover > dl.facts")), { Tokens: "10K" });
  assert.equal(view.button()!.textContent, "10K Tokens");
  // The rest of the rejected response is rejected too, so nothing on screen disagrees.
  assert.equal(popover.querySelector(".usage-popover-head .status")!.textContent, "Unpriced");
  assertNoDomNode(popover.querySelector("table"));
  assert.doesNotMatch(popover.textContent ?? "", /stale-model|rate table|reported by the provider/);
  await view.cleanup();
});

test("running counters say whether their input includes cached tokens until the breakdown separates them", async () => {
  const lagging = {
    sessionId: "s1",
    totals: amount({ inputTokens: 100, outputTokens: 10, processedTokens: 110, costUsd: 0.01, costSource: "modelPriced" as const }),
    byModel: [],
  };
  for (const [driver, note] of [
    ["claude-code", "Until the breakdown loads, these totals leave out cached input."],
    ["codex-app-server", "Until the breakdown loads, Input includes cached tokens."],
  ] as const) {
    const view = await mount(session({ driver, tokensIn: 9_000, tokensOut: 1_000 }), lagging);
    await view.open();
    const disclosure = view.popover()!.querySelector(".usage-disclosure")!;
    assert.ok(notes(disclosure).includes(note), `${driver}: ${notes(disclosure).join(" | ")}`);
    await view.cleanup();
  }
  // A caught-up breakdown reports uncached Input for every driver, so it needs no note.
  const current = await mount(session({ driver: "claude-code", tokensIn: 100, tokensOut: 10 }), {
    ...lagging,
    totals: amount({ inputTokens: 100, uncachedInputTokens: 100, cachedInputTokens: 4_000, outputTokens: 10,
      processedTokens: 4_110, costUsd: 0.01, costSource: "modelPriced" }),
  });
  await current.open();
  assert.equal(notes(current.popover()!).some((text) => text?.startsWith("Until the breakdown loads")), false);
  await current.cleanup();
});

test("the Codex App Server note is one plain sentence inside Token Breakdown, not an overlay", async () => {
  const view = await mount(session({ driver: "codex-app-server" }), {
    sessionId: "s1",
    totals: amount({ inputTokens: 25_000, outputTokens: 900, processedTokens: 25_900, costUsd: 0.59 }),
    byModel: [],
  });
  await view.open();
  const popover = view.popover()!;
  assertNoDomNode(popover.querySelector('[aria-label="About Codex App Server Usage"]'));
  assertNoDomNode(popover.querySelector('[role="note"]'));
  assert.deepEqual(notes(popover.querySelector(".usage-disclosure")!), [
    "Codex App Server usage recorded before the machine's Wollipog update counts only the final response of each turn, so older figures are incomplete.",
  ]);
  assert.doesNotMatch(popover.textContent ?? "", /protocol|v\d/i);
  await view.cleanup();
});

test("cached and unavailable URL sources keep their provenance state", async () => {
  const source = "https://example.com/rates.json";
  const cached = await mount(session(), {
    sessionId: "s1",
    totals: amount({ inputTokens: 25_000, outputTokens: 900, processedTokens: 25_900, costUsd: 0.59, costSource: "modelPriced" }),
    byModel: [],
    pricing: { status: "cached", source, fetchedAt: 1, knownModels: 1200 },
  });
  await cached.open();
  const note = cached.popover()!.querySelector(".usage-popover-foot .usage-popover-note")!;
  assert.equal(note.textContent, "Estimated API cost at published rates. Cached rates.");
  assert.equal(note.querySelector("a")!.getAttribute("href"), source);
  await cached.cleanup();

  const unavailable = await mount(session(), {
    sessionId: "s1",
    totals: amount({ inputTokens: 25_000, outputTokens: 900, processedTokens: 25_900, costUsd: 0.59, costSource: "modelPriced" }),
    byModel: [],
    pricing: { status: "unavailable", source, fetchedAt: null, knownModels: 0 },
  });
  await unavailable.open();
  const plain = unavailable.popover()!.querySelector(".usage-popover-foot .usage-popover-note")!;
  assert.equal(plain.textContent, "No rate table is loaded, so cost is not estimated.");
  assertNoDomNode(plain.querySelector("a"));
  await unavailable.cleanup();
});

test("a mixed-model session names the unpriced model and states its cost as a lower bound", async () => {
  const view = await mount(session({ costUsd: 1.21 }), {
    sessionId: "s1",
    totals: amount({
      inputTokens: 184_000,
      uncachedInputTokens: 24_000,
      cachedInputTokens: 160_000,
      outputTokens: 21_000,
      processedTokens: 205_000,
      costUsd: 1.21,
      costSource: "unpriced",
      unpricedRecords: 3,
    }),
    byModel: [
      { model: "gpt-5.5-codex", ...amount({ processedTokens: 178_000, costUsd: 1.21, costSource: "providerReported" }) },
      { model: "gpt-5.5-codex-mini", ...amount({ processedTokens: 27_000, costSource: "unpriced", unpricedRecords: 3 }) },
    ],
    pricing: { status: "fresh", source: "litellm", fetchedAt: 1, knownModels: 1200 },
  });

  await view.open();
  const popover = view.popover()!;
  assert.deepEqual(table(popover).slice(1), [
    ["gpt-5.5-codex", "178K", "$1.21"],
    ["gpt-5.5-codex-mini", "27K", "Unpriced"],
    ["Total", "205K", "$1.21"],
  ]);
  assert.ok(notes(popover).includes("3 records could not be priced, so this cost is a lower bound."));
  await view.cleanup();
});

test("a session that has processed nothing renders no control", async () => {
  const view = await mount(session({ tokensIn: 0, tokensOut: 0, costUsd: 0 }), null);
  assertNoDomNode(view.button());
  await view.cleanup();
});

test("no production component renders the retired non-bar triggers or the old panel classes", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = new URL("./", import.meta.url);
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".tsx") && !name.includes(".test."))) {
    const source = readFileSync(new URL(file, dir), "utf8");
    assert.doesNotMatch(source, /session-cost-button|context-ring-button|session-usage-(?:label|model|info|facts|head|title|note)\b|context-popover-(?:facts|discrepancy|head|note)\b|ProtocolUsageInfo/,
      `${file} renders a retired usage class`);
  }
});
