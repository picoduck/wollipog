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

test("variant rates require their request coordinates even when pricing context is absent", () => {
  const table = parseRateTable({
    "base-only": { input_cost_per_token: 1, output_cost_per_token: 2 },
    "context-only": { input_cost_per_token: 1, output_cost_per_token: 2,
      input_cost_per_token_above_272k_tokens: 3, output_cost_per_token_above_272k_tokens: 4 },
    "tier-only": { input_cost_per_token: 1, output_cost_per_token: 2,
      input_cost_per_token_priority: 3, output_cost_per_token_priority: 4, cache_read_input_token_cost_priority: 0.2 },
    combined: { input_cost_per_token: 1, output_cost_per_token: 2,
      input_cost_per_token_priority: 3, output_cost_per_token_priority: 4,
      input_cost_per_token_above_272k_tokens: 3, output_cost_per_token_above_272k_tokens: 4 },
    incomplete: { input_cost_per_token: 1, output_cost_per_token: 2,
      input_cost_per_token_above_272k_tokens: 3 },
  });
  const buckets = { uncachedInputTokens: 300000, cachedInputTokens: 10, cacheCreationTokens: 0, outputTokens: 1 };
  const unpriced = { costUsd: 0, costSource: "unpriced", cacheSavingsUsd: 0 };
  for (const model of ["context-only", "tier-only", "combined", "incomplete"]) {
    for (const context of [undefined, {}]) {
      assert.deepEqual(priceUsage(table, model, buckets, undefined, context), unpriced, model);
      for (const cost of [0, 42]) {
        const reported = priceUsage(table, model, buckets, cost, context);
        assert.equal(reported.costUsd, cost);
        assert.equal(reported.costSource, "providerReported");
        assert.equal(priceUsage(table, model, buckets, cost, context, true).costSource, "modelPriced");
      }
    }
  }
  assert.deepEqual(priceUsage(table, "combined", buckets, null, { requestInputTokens: 10 }), unpriced);
  assert.deepEqual(priceUsage(table, "combined", buckets, null, { serviceTier: "default" }), unpriced);
  assert.deepEqual(priceUsage(table, "context-only", buckets, null, { requestInputTokens: Number.NaN }), unpriced);
  assert.equal(priceUsage(table, "context-only", buckets, null, { requestInputTokens: 10 }).costSource, "modelPriced");
  assert.equal(priceUsage(table, "tier-only", buckets, null, { serviceTier: "standard" }).costSource, "modelPriced");
  assert.equal(priceUsage(table, "tier-only", buckets, null, { serviceTier: "fast" }).costUsd, 900006);
  const base = priceUsage(table, "base-only", buckets, null);
  assert.equal(base.costSource, "modelPriced");
  assert.equal(base.costUsd, 300003);
  assert.deepEqual(priceUsage(table, "base-only", buckets, null, {}), base);
});

test("request tier and long-context rates apply to every billable bucket and cache savings", () => {
  const raw: Record<string, number> = {};
  const fields = ["input_cost_per_token", "output_cost_per_token", "cache_read_input_token_cost", "cache_creation_input_token_cost"];
  for (const [suffix, rates] of [["", [2, 10, 0.1, 2.5]], ["_priority", [4, 20, 0.2, 5]],
    ["_above_272k_tokens", [4, 15, 0.2, 5]], ["_above_272k_tokens_priority", [8, 30, 0.4, 10]]] as const) {
    fields.forEach((field, i) => { raw[field + suffix] = rates[i]! / 1e6; });
  }
  const table = parseRateTable({ "test-model": raw });
  const buckets = { uncachedInputTokens: 100000, cachedInputTokens: 200000, cacheCreationTokens: 10000, outputTokens: 1000 };
  const standard = priceUsage(table, "test-model", buckets, null, { requestInputTokens: 272000, serviceTier: "default" });
  const long = priceUsage(table, "test-model", buckets, null, { requestInputTokens: 272001, serviceTier: "default" });
  const priority = priceUsage(table, "test-model", buckets, null, { requestInputTokens: 272001, serviceTier: "priority" });
  assert.ok(Math.abs(standard.costUsd - 0.255) < 1e-10);
  assert.ok(Math.abs(long.costUsd - 0.505) < 1e-10);
  assert.ok(Math.abs(priority.costUsd - 1.01) < 1e-10);
  assert.ok(Math.abs(priority.cacheSavingsUsd - 1.52) < 1e-10);
  assert.equal(priceUsage(table, "test-model", buckets, null, { serviceTier: "priority" }).costSource, "unpriced");
  assert.equal(priceUsage(table, "test-model", buckets, null, { requestInputTokens: 10, serviceTier: "unknown" }).costSource, "unpriced");
  assert.equal(priceUsage(table, "test-model", buckets, 42, { serviceTier: "unknown" }).costUsd, 42);
  assert.equal(priceUsage(table, "test-model", buckets, 42, undefined, true).costSource, "modelPriced");
});

test("a missing combined context/tier rate cannot fall back to a cheaper short-context tier", () => {
  const raw: Record<string, number> = {};
  for (const field of ["input_cost_per_token", "output_cost_per_token", "cache_read_input_token_cost", "cache_creation_input_token_cost"]) {
    raw[field] = 1;
    raw[field + "_priority"] = 2;
    raw[field + "_above_272k_tokens"] = 3;
  }
  const table = parseRateTable({ example: raw });
  const value = priceUsage(table, "example", { uncachedInputTokens: 1, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 1 },
    null, { serviceTier: "priority", requestInputTokens: 300000 });
  assert.equal(value.costSource, "unpriced");
});


test("an incomplete published context premium stays unpriced instead of disappearing", () => {
  const table = parseRateTable({ example: { input_cost_per_token: 1, output_cost_per_token: 1,
    input_cost_per_token_above_272k_tokens: 2 } });
  const buckets = { uncachedInputTokens: 1, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 1 };
  assert.equal(priceUsage(table, "example", buckets, null, { serviceTier: "default", requestInputTokens: 300000 }).costSource, "unpriced");
  assert.equal(priceUsage(table, "example", buckets, null, { serviceTier: "default" }).costSource, "unpriced");
  assert.equal(priceUsage(table, "example", buckets, null, { serviceTier: "default", requestInputTokens: 100 }).costUsd, 2);
});

test("published OpenAI variants price zero cache writes without inventing a write rate", () => {
  // LiteLLM gpt-5.5 publishes these priority fields with no cache-creation field.
  const table = parseRateTable({ "gpt-5.5": { input_cost_per_token: 5e-6, output_cost_per_token: 30e-6,
    cache_read_input_token_cost: 0.5e-6, input_cost_per_token_priority: 12.5e-6,
    output_cost_per_token_priority: 75e-6, cache_read_input_token_cost_priority: 1.25e-6,
    input_cost_per_token_above_272k_tokens: 10e-6, output_cost_per_token_above_272k_tokens: 45e-6,
    cache_read_input_token_cost_above_272k_tokens: 1e-6 } });
  const buckets = { uncachedInputTokens: 1000, cachedInputTokens: 1000, cacheCreationTokens: 0, outputTokens: 100 };
  const fast = priceUsage(table, "gpt-5.5", buckets, null, { serviceTier: "fast", requestInputTokens: 2000 });
  assert.equal(fast.costSource, "modelPriced");
  assert.ok(Math.abs(fast.costUsd - 0.02125) < 1e-12);
  assert.ok(Math.abs(fast.cacheSavingsUsd - 0.01125) < 1e-12);
  const long = priceUsage(table, "gpt-5.5", buckets, null, { serviceTier: "default", requestInputTokens: 300000 });
  assert.ok(Math.abs(long.costUsd - 0.0155) < 1e-12);
  assert.equal(priceUsage(table, "gpt-5.5", { ...buckets, cacheCreationTokens: 1 }, null,
    { serviceTier: "fast", requestInputTokens: 2000 }).costSource, "unpriced");
});
