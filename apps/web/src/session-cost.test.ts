import assert from "node:assert/strict";
import test from "node:test";
import type { SessionUsageResponse, SessionView, UsageAmount, UsageCostSource } from "@wollipog/protocol";
import { costProvenanceNote, sessionCostLabel, sessionUsageTotals } from "./session-cost.js";

function session(overrides: Partial<SessionView> = {}): SessionView {
  return { tokensIn: 0, tokensOut: 0, costUsd: 0, ...overrides } as SessionView;
}

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

function response(overrides: Partial<SessionUsageResponse> = {}): SessionUsageResponse {
  return { sessionId: "s1", totals: amount(), byModel: [], ...overrides };
}

test("a priced session shows the formatted cost and names it as usage", () => {
  assert.deepEqual(sessionCostLabel(session({ tokensIn: 25_000, tokensOut: 900, costUsd: 0.59 })), {
    text: "$0.59",
    priced: true,
    ariaLabel: "Session Usage: $0.59",
  });
});

test("an unpriced session with real tokens says the cost is unavailable, never $0.00", () => {
  const label = sessionCostLabel(session({ tokensIn: 25_000, tokensOut: 900, costUsd: 0 }));
  assert.equal(label?.text, "$—");
  assert.equal(label?.priced, false);
  assert.equal(label?.ariaLabel, "Session Usage: Cost Unavailable");
  assert.doesNotMatch(label!.text, /0\.00/);
});

test("a session that has processed nothing renders no cost control at all", () => {
  assert.equal(sessionCostLabel(session()), null);
});

test("totals fall back to the runner's running counters until the ledger answers", () => {
  const totals = sessionUsageTotals(session({ tokensIn: 1_000, tokensOut: 250, costUsd: 0.5 }), null);
  assert.equal(totals.detailed, false);
  assert.equal(totals.inputTokens, 1_000);
  assert.equal(totals.outputTokens, 250);
  assert.equal(totals.processedTokens, 1_250);
  assert.equal(totals.cachedInputTokens, 0);
});

test("a ledger row with a cache split reports the uncached input and the cache buckets", () => {
  const totals = sessionUsageTotals(
    session({ tokensIn: 1_000, tokensOut: 250, costUsd: 0.5 }),
    response({
      totals: amount({
        inputTokens: 40_000,
        uncachedInputTokens: 2_000,
        cachedInputTokens: 36_000,
        cacheCreationTokens: 2_000,
        outputTokens: 900,
        reasoningTokens: 300,
        processedTokens: 40_900,
        cacheSavingsUsd: 0.2,
        costUsd: 0.61,
      }),
    }),
  );
  assert.equal(totals.detailed, true);
  assert.equal(totals.inputTokens, 2_000);
  assert.equal(totals.cachedInputTokens, 36_000);
  assert.equal(totals.cacheCreationTokens, 2_000);
  assert.equal(totals.reasoningTokens, 300);
  assert.equal(totals.processedTokens, 40_900);
  assert.equal(totals.costUsd, 0.61);
});

test("a legacy ledger row without a cache split reports the provider's input verbatim", () => {
  const totals = sessionUsageTotals(
    session({ tokensIn: 5_000, tokensOut: 400, costUsd: 0 }),
    response({ totals: amount({ inputTokens: 5_000, outputTokens: 400, processedTokens: 5_400 }) }),
  );
  assert.equal(totals.inputTokens, 5_000);
  assert.equal(totals.cachedInputTokens, 0);
  assert.equal(totals.reasoningTokens, 0);
});

test("the runner's counters stay the floor when the ledger reports less", () => {
  const totals = sessionUsageTotals(
    session({ tokensIn: 9_000, tokensOut: 1_000, costUsd: 2 }),
    response({ totals: amount({ inputTokens: 100, outputTokens: 10, processedTokens: 110, costUsd: 0.5 }) }),
  );
  assert.equal(totals.processedTokens, 10_000);
  assert.equal(totals.costUsd, 2);
});

test("cost provenance is stated honestly per source", () => {
  assert.equal(costProvenanceNote(null), null);
  assert.equal(
    costProvenanceNote(response({ totals: amount({ costSource: "providerReported" }) })),
    "Cost as reported by the provider.",
  );
  assert.equal(
    costProvenanceNote(response({
      totals: amount({ costSource: "modelPriced" }),
      pricing: { status: "fresh", source: "litellm", fetchedAt: 1, knownModels: 1200 },
    })),
    "Estimated from the litellm rate table.",
  );
  assert.equal(
    costProvenanceNote(response({
      totals: amount({ costSource: "modelPriced" }),
      pricing: { status: "cached", source: "litellm", fetchedAt: 1, knownModels: 1200 },
    })),
    "Estimated from a cached litellm rate table.",
  );
  assert.equal(
    costProvenanceNote(response({
      totals: amount({ costSource: "modelPriced" }),
      pricing: { status: "unavailable", source: "litellm", fetchedAt: null, knownModels: 0 },
    })),
    "No rate table is loaded, so cost is not estimated.",
  );
  assert.equal(
    costProvenanceNote(response({ totals: amount({ costSource: "unpriced", unpricedRecords: 3 }) })),
    "3 records could not be priced, so this cost is a lower bound.",
  );
  assert.equal(
    costProvenanceNote(response({ totals: amount({ costSource: "unpriced", unpricedRecords: 1 }) })),
    "1 record could not be priced, so this cost is a lower bound.",
  );
});
