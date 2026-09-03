import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FALLBACK_CACHE_READ_INPUT_RATIO,
  FALLBACK_CACHE_WRITE_INPUT_RATIO,
  lookupRate,
  parseRateTable,
  priceUsage,
  resolveCostSource,
} from "./usage-pricing.js";

const document = {
  sample_spec: { input_cost_per_token: 0, output_cost_per_token: 0 },
  "claude-fable-5-1": {
    input_cost_per_token: 0.000005,
    output_cost_per_token: 0.000025,
    cache_read_input_token_cost: 0.0000005,
    cache_creation_input_token_cost: 0.00000625,
  },
  "anthropic/claude-fable-5-1": {
    input_cost_per_token: 0.000005,
    output_cost_per_token: 0.000025,
    cache_read_input_token_cost: 0.0000005,
    cache_creation_input_token_cost: 0.00000625,
  },
  "openai/gpt-5.5-codex": { input_cost_per_token: 0.00000125, output_cost_per_token: 0.00001 },
  "azure/gpt-5.5-codex": { input_cost_per_token: 0.000002, output_cost_per_token: 0.00001 },
  "vertex/gemini-3-pro": { input_cost_per_token: 0.000002, output_cost_per_token: 0.000012 },
  "gemini/gemini-3-pro": { input_cost_per_token: 0.000002, output_cost_per_token: 0.000012 },
  "half-priced": { input_cost_per_token: 0.000001 },
  "not-an-entry": "text",
};

test("rate table parsing keeps complete entries, derives cache rates, and aliases only unambiguous bare names", () => {
  const table = parseRateTable(document);
  assert.equal(table.has("sample_spec"), false);
  assert.equal(table.has("half-priced"), false, "an entry without an output rate is dropped rather than half-priced");
  assert.equal(table.has("not-an-entry"), false);

  const codex = table.get("openai/gpt-5.5-codex")!;
  assert.equal(codex.cacheReadCostPerToken, 0.00000125 * FALLBACK_CACHE_READ_INPUT_RATIO);
  assert.equal(codex.cacheCreationCostPerToken, 0.00000125 * FALLBACK_CACHE_WRITE_INPUT_RATIO);
  assert.equal(table.has("gpt-5.5-codex"), false, "qualified entries disagree, so the bare name is not aliased");
  assert.deepEqual(table.get("gemini-3-pro"), table.get("vertex/gemini-3-pro"), "agreeing entries alias the bare name");
  assert.equal(table.get("claude-fable-5-1")!.cacheReadCostPerToken, 0.0000005, "published cache rates win over ratios");
  assert.equal(parseRateTable(null).size, 0);
  assert.equal(parseRateTable("nope").size, 0);
});

test("rate lookup normalizes case, provider prefixes, variant suffixes, and snapshot dates", () => {
  const table = parseRateTable(document);
  const fable = table.get("claude-fable-5-1")!;
  assert.deepEqual(lookupRate(table, "Claude-Fable-5-1"), fable);
  assert.deepEqual(lookupRate(table, "anthropic/claude-fable-5-1[1m]"), fable);
  assert.deepEqual(lookupRate(table, "claude-fable-5-1-20260601"), fable);
  assert.equal(lookupRate(table, "gpt-5.5-codex"), null, "an ambiguous bare name stays unpriced");
  assert.deepEqual(lookupRate(table, "openai/gpt-5.5-codex"), table.get("openai/gpt-5.5-codex"));
  for (const ambiguous of ["opus", "sonnet", "haiku", "fable", "<synthetic>", "default", "", "   "]) {
    assert.equal(lookupRate(table, ambiguous), null, `${JSON.stringify(ambiguous)} must never be priced by guesswork`);
  }
  assert.equal(lookupRate(table, null), null);
});

test("pricing uses a provider-reported cost unchanged, prices each bucket at its rate, and never charges reasoning", () => {
  const table = parseRateTable(document);
  const buckets = { uncachedInputTokens: 1000, cachedInputTokens: 10_000, cacheCreationTokens: 2000, outputTokens: 500 };

  const reported = priceUsage(table, "claude-fable-5-1", buckets, 0.42);
  assert.equal(reported.costUsd, 0.42);
  assert.equal(reported.costSource, "providerReported");
  assert.ok(Math.abs(reported.cacheSavingsUsd - 10_000 * (0.000005 - 0.0000005)) < 1e-12, "savings still derive from the table");

  const priced = priceUsage(table, "claude-fable-5-1", buckets, undefined);
  assert.equal(priced.costSource, "modelPriced");
  const expected = 1000 * 0.000005 + 10_000 * 0.0000005 + 2000 * 0.00000625 + 500 * 0.000025;
  assert.ok(Math.abs(priced.costUsd - expected) < 1e-12);

  const unpriced = priceUsage(table, "gpt-5.5-codex", buckets, null);
  assert.deepEqual(unpriced, { costUsd: 0, costSource: "unpriced", cacheSavingsUsd: 0 });
  assert.deepEqual(priceUsage(null, "claude-fable-5-1", buckets, null), { costUsd: 0, costSource: "unpriced", cacheSavingsUsd: 0 });
  assert.equal(priceUsage(table, "claude-fable-5-1", buckets, Number.NaN).costSource, "modelPriced", "a malformed reported cost falls back to the table");
  assert.equal(priceUsage(table, "claude-fable-5-1", buckets, -1).costSource, "modelPriced");
});

test("mixed provenance resolves to the weakest source", () => {
  assert.equal(resolveCostSource({ providerReported: 3, modelPriced: 0, unpriced: 0 }), "providerReported");
  assert.equal(resolveCostSource({ providerReported: 3, modelPriced: 1, unpriced: 0 }), "modelPriced");
  assert.equal(resolveCostSource({ providerReported: 3, modelPriced: 1, unpriced: 1 }), "unpriced");
  assert.equal(resolveCostSource({ providerReported: 0, modelPriced: 0, unpriced: 0 }), "unpriced");
});
