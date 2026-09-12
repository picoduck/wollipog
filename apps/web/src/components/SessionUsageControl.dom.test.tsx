import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionUsageResponse, SessionView, UsageAmount, UsageCostSource } from "@wollipog/protocol";
import type { ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { SessionUsageControl } from "./SessionUsageControl.js";

const domWindow = new Window();
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
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

async function mount(view: SessionView, usage: SessionUsageResponse | Error | null) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const client = {
    sessionUsage: async () => {
      if (usage instanceof Error) throw usage;
      if (!usage) return new Promise<never>(() => {});
      return usage;
    },
  } as unknown as ApiClient;
  await act(async () => {
    root.render(<ApiProvider client={client}><SessionUsageControl session={view} /></ApiProvider>);
  });
  return {
    container,
    button: () => container.querySelector<HTMLButtonElement>(".session-cost-button"),
    popover: () => container.querySelector<HTMLElement>(".session-usage-popover"),
    async open() {
      await act(async () => { container.querySelector<HTMLButtonElement>(".session-cost-button")!.click(); });
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

test("a priced session shows only the cost, and opens Session Usage with cumulative tokens", async () => {
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
  assert.equal(popover.getAttribute("aria-label"), "Session Usage");
  assert.equal(button.getAttribute("aria-controls"), popover.getAttribute("id"));
  const rows = facts(popover.querySelector(".session-usage-facts"));
  assert.equal(rows["Input"], "2.0k");
  assert.equal(rows["Output"], "900");
  assert.equal(rows["Cache Read"], "36k");
  assert.equal(rows["Cache Write"], "2.0k");
  assert.equal(rows["Reasoning"], "300");
  assert.equal(rows["Total Processed"], "41k");
  assert.match(popover.textContent ?? "", /Cost as reported by the provider\./);
  // Occupancy and capacity stay with the context meter; the usage panel never repeats them.
  assert.doesNotMatch(popover.textContent ?? "", /Capacity|Remaining|258k/);

  await view.cleanup();
});

test("Escape dismisses the popover and the control keeps its own accessible name", async () => {
  const view = await mount(session(), { sessionId: "s1", totals: amount(), byModel: [] });
  await view.open();
  assert.ok(view.popover());
  await act(async () => {
    domWindow.document.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never);
  });
  assert.equal(view.popover(), null);
  assert.equal(view.button()!.getAttribute("aria-expanded"), "false");
  await view.cleanup();
});

test("an unpriced session refuses to show $0.00 and says so in the panel", async () => {
  const view = await mount(session({ costUsd: 0 }), {
    sessionId: "s1",
    totals: amount({
      inputTokens: 25_000,
      outputTokens: 900,
      processedTokens: 25_900,
      costSource: "unpriced",
      unpricedRecords: 4,
    }),
    byModel: [],
  });

  const button = view.button()!;
  assert.equal(button.textContent, "$—");
  assert.equal(button.getAttribute("aria-label"), "Session Usage: Cost Unavailable");
  assert.equal(button.classList.contains("is-unpriced"), true);

  await view.open();
  const popover = view.popover()!;
  assert.match(popover.querySelector(".session-usage-head")!.textContent ?? "", /Not Priced/);
  assert.doesNotMatch(popover.textContent ?? "", /\$0\.00/);
  assert.match(popover.textContent ?? "", /4 records could not be priced, so this cost is a lower bound\./);
  const rows = facts(popover.querySelector(".session-usage-facts"));
  assert.equal(rows["Input"], "25k");
  assert.equal(rows["Output"], "900");
  await view.cleanup();
});

test("a free session reports $0.00 once the ledger proves the provider priced it", async () => {
  const view = await mount(session({ costUsd: 0 }), {
    sessionId: "s1",
    totals: amount({
      inputTokens: 25_000,
      outputTokens: 900,
      processedTokens: 25_900,
      costUsd: 0,
      costSource: "providerReported",
    }),
    byModel: [
      { model: "local-llama", ...amount({ inputTokens: 25_000, outputTokens: 900, processedTokens: 25_900, costSource: "providerReported" }) },
    ],
  });

  // Before the ledger loads, the strip cannot tell "free" from "nobody priced it", so it says so.
  assert.equal(view.button()!.textContent, "$—");
  await view.open();
  const popover = view.popover()!;
  // Once provenance is known, zero is stated as the amount it is rather than as a missing price.
  assert.equal(view.button()!.textContent, "$0.00");
  assert.equal(view.button()!.getAttribute("aria-label"), "Session Usage: $0.00");
  assert.equal(view.button()!.classList.contains("is-unpriced"), false);
  assert.match(popover.querySelector(".session-usage-head")!.textContent ?? "", /\$0\.00/);
  assert.doesNotMatch(popover.textContent ?? "", /Not Priced/);
  assert.equal(facts(popover.querySelector(".session-usage-model dl"))["Cost"], "$0.00");
  await view.cleanup();
});

test("a provider-reported free snapshot keeps a $0.00 heading while detail is pending", async () => {
  const view = await mount(session({ costUsd: 0, costSource: "providerReported" }), null);

  assert.equal(view.button()!.textContent, "$0.00");
  await view.open();
  const heading = view.popover()!.querySelector(".session-usage-head")!.textContent ?? "";
  assert.match(heading, /\$0\.00/);
  assert.doesNotMatch(heading, /Not Priced/);
  await view.cleanup();
});

test("a provider-reported free snapshot keeps a $0.00 heading when detail fails", async () => {
  const view = await mount(
    session({ costUsd: 0, costSource: "providerReported" }),
    new Error("usage endpoint unavailable"),
  );

  await view.open();
  const popover = view.popover()!;
  const heading = popover.querySelector(".session-usage-head")!.textContent ?? "";
  assert.match(heading, /\$0\.00/);
  assert.doesNotMatch(heading, /Not Priced/);
  assert.match(popover.querySelector("[role=alert]")!.textContent ?? "", /usage endpoint unavailable/);
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

  assert.equal(view.button()!.textContent, "$—", "a stale priced zero must not be shown as $0.00");
  await view.open();
  const popover = view.popover()!;
  const rows = facts(popover.querySelector(".session-usage-facts"));
  assert.equal(rows["Input"], "9.0k");
  assert.equal(rows["Output"], "1.0k");
  assert.equal(rows["Total Processed"], "10k");
  assert.equal(view.button()!.textContent, "$—");
  // The rest of the rejected response is rejected too, so nothing on screen disagrees.
  assert.match(popover.querySelector(".session-usage-head")!.textContent ?? "", /Not Priced/);
  assert.equal(popover.querySelector(".session-usage-models"), null);
  assert.doesNotMatch(popover.textContent ?? "", /stale-model|rate table|reported by the provider/);
  await view.cleanup();
});

test("a session with an unknown context window still shows its cost", async () => {
  const view = await mount(
    session({ contextWindow: undefined, contextTokensUsed: undefined }),
    { sessionId: "s1", totals: amount({ inputTokens: 25_000, outputTokens: 900, processedTokens: 25_900, costUsd: 0.59 }), byModel: [] },
  );
  assert.equal(view.button()!.textContent, "$0.59");
  await view.open();
  const rows = facts(view.popover()!.querySelector(".session-usage-facts"));
  assert.equal(rows["Input"], "25k");
  assert.equal(rows["Total Processed"], "26k");
  await view.cleanup();
});

test("Codex App Server protocol details stay behind a compact info disclosure", async () => {
  const view = await mount(session({ driver: "codex-app-server" }), {
    sessionId: "s1",
    totals: amount({ inputTokens: 25_000, outputTokens: 900, processedTokens: 25_900, costUsd: 0.59 }),
    byModel: [],
  });
  await view.open();
  const disclosure = view.popover()!.querySelector(".session-usage-info")!;
  const button = disclosure.querySelector("button")!;
  const detail = disclosure.querySelector(".session-usage-info-detail")!;
  assert.equal(button.getAttribute("aria-label"), "About Codex App Server Usage");
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(button.getAttribute("aria-controls"), detail.id);
  assert.match(
    detail.textContent ?? "",
    /before protocol v127 is incomplete because it includes only the final model response.*v127\+ counts every response/s,
  );
  assert.equal(view.popover()!.querySelector("p")?.textContent?.includes("protocol v127"), false);
  await view.cleanup();
});

test("an estimated-cost URL is a compact link instead of visible source text", async () => {
  const source = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
  const view = await mount(session(), {
    sessionId: "s1",
    totals: amount({ inputTokens: 25_000, outputTokens: 900, processedTokens: 25_900, costUsd: 0.59, costSource: "modelPriced" }),
    byModel: [],
    pricing: { status: "fresh", source, fetchedAt: 1, knownModels: 1200 },
  });
  await view.open();
  const note = view.popover()!.querySelector(".session-usage-note")!;
  const link = note.querySelector("a")!;
  assert.equal(link.textContent, "Estimated API Costs");
  assert.equal(link.getAttribute("href"), source);
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.getAttribute("rel"), "noreferrer");
  assert.doesNotMatch(note.textContent ?? "", /raw\.githubusercontent\.com/);
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
  assert.equal(cached.popover()!.querySelector(".session-usage-note")!.textContent, "Estimated API Costs (Cached Rates)");
  assert.equal(cached.popover()!.querySelector(".session-usage-note a")!.getAttribute("href"), source);
  await cached.cleanup();

  const unavailable = await mount(session(), {
    sessionId: "s1",
    totals: amount({ inputTokens: 25_000, outputTokens: 900, processedTokens: 25_900, costUsd: 0.59, costSource: "modelPriced" }),
    byModel: [],
    pricing: { status: "unavailable", source, fetchedAt: null, knownModels: 0 },
  });
  await unavailable.open();
  assert.equal(unavailable.popover()!.querySelector(".session-usage-note")!.textContent, "No rate table is loaded, so cost is not estimated.");
  assert.equal(unavailable.popover()!.querySelector(".session-usage-note a"), null);
  await unavailable.cleanup();
});

test("a mixed-model session splits by model and names the unpriced one", async () => {
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
      {
        model: "gpt-5.5-codex",
        ...amount({
          inputTokens: 160_000,
          uncachedInputTokens: 20_000,
          cachedInputTokens: 140_000,
          outputTokens: 18_000,
          processedTokens: 178_000,
          costUsd: 1.21,
          costSource: "providerReported",
        }),
      },
      {
        model: "gpt-5.5-codex-mini",
        ...amount({
          inputTokens: 24_000,
          outputTokens: 3_000,
          processedTokens: 27_000,
          costSource: "unpriced",
          unpricedRecords: 3,
        }),
      },
    ],
    pricing: { status: "fresh", source: "litellm", fetchedAt: 1, knownModels: 1200 },
  });

  await view.open();
  const popover = view.popover()!;
  const models = [...popover.querySelectorAll(".session-usage-model")];
  assert.equal(models.length, 2);
  assert.equal(models[0]!.querySelector(".session-usage-model-name")!.textContent, "gpt-5.5-codex");
  assert.equal(facts(models[0]!.querySelector("dl"))["Cost"], "$1.21");
  assert.equal(models[1]!.querySelector(".session-usage-model-name")!.textContent, "gpt-5.5-codex-mini");
  assert.equal(facts(models[1]!.querySelector("dl"))["Cost"], "Not Priced");
  await view.cleanup();
});

test("a session that has processed nothing renders no control", async () => {
  const view = await mount(session({ tokensIn: 0, tokensOut: 0, costUsd: 0 }), null);
  assert.equal(view.button(), null);
  await view.cleanup();
});

test("a failed usage fetch reports the error and still shows the runner's own totals", async () => {
  const view = await mount(session(), new Error("usage endpoint unavailable"));
  await view.open();
  const popover = view.popover()!;
  assert.match(popover.querySelector("[role=alert]")!.textContent ?? "", /usage endpoint unavailable/);
  const rows = facts(popover.querySelector(".session-usage-facts"));
  assert.equal(rows["Input"], "25k");
  assert.equal(rows["Output"], "900");
  await view.cleanup();
});
