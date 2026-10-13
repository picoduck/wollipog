import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RATE_PRICED_USAGE_MAX_ENTRIES,
  accrueRatePricedUsage,
  parseRatePricedUsage,
  ratePricedUsageRecord,
  type RatePricedUsageTotal,
} from "./index.js";

const republished = { kind: "token_usage" as const, model: " claude-opus-5 ", inputTokens: 10, outputTokens: 5,
  cachedInputTokens: 1_000, cacheCreationInputTokens: 200, pricingContext: { requestInputTokens: 1_210 }, liveUsage: "republished" as const };

test("only usage the control plane rate-prices into the session total is accrued", () => {
  assert.deepEqual(ratePricedUsageRecord(republished), {
    model: "claude-opus-5", requestInputTokens: { min: 1_210, max: 1_210 }, inputTokens: 10, netInputTokens: 0, outputTokens: 5,
    cachedInputTokens: 1_000, cacheCreationInputTokens: 200, reasoningOutputTokens: 0,
  });
  for (const excluded of [
    { ...republished, costUsd: 0.01 },
    { ...republished, costUsd: 0 },
    { ...republished, liveUsage: "provisional" as const },
    { ...republished, accountingIncomplete: true as const },
    { ...republished, parentToolUseId: "task" },
    { kind: "token_usage" as const, liveUsage: "settled" as const },
    { kind: "agent_message" as const, text: "not usage" },
  ]) {
    assert.equal(ratePricedUsageRecord(excluded), null, JSON.stringify(excluded));
  }
  assert.notEqual(ratePricedUsageRecord({ ...republished, parentToolUseId: "child", independentUsage: true }), null);
  assert.notEqual(ratePricedUsageRecord({ ...republished, costUsd: Number.NaN }), null, "an unusable cost is rate-priced");
  // Pricing reads the tier verbatim, so only an absent tier is absent.
  assert.deepEqual(["", " standard ", 7].map((serviceTier) =>
    ratePricedUsageRecord({ ...republished, pricingContext: { serviceTier } as never })!.serviceTier), ["", " standard ", "<invalid>"]);
  assert.equal(ratePricedUsageRecord({ kind: "token_usage", inputTokens: 100, cachedInputTokens: 600 })!.netInputTokens, 0,
    "input inclusive of cache reads is normalized per record");
});

test("records accrue per pricing key and widen the request-size range", () => {
  let totals: readonly RatePricedUsageTotal[] = [];
  totals = accrueRatePricedUsage(totals, republished)!;
  totals = accrueRatePricedUsage(totals, { ...republished, inputTokens: 3, pricingContext: { requestInputTokens: 250_000 } })!;
  totals = accrueRatePricedUsage(totals, { ...republished, pricingContext: { serviceTier: "priority", requestInputTokens: 50 } })!;
  totals = accrueRatePricedUsage(totals, { ...republished, pricingContext: undefined })!;
  const unchanged = accrueRatePricedUsage(totals, { ...republished, costUsd: 1 });
  assert.equal(unchanged, totals, "a record that is not rate-priced returns the same entries");
  assert.deepEqual(totals.map((entry) => [entry.serviceTier, entry.requestInputTokens, entry.inputTokens]), [
    [undefined, { min: 1_210, max: 250_000 }, 13],
    ["priority", { min: 50, max: 50 }, 10],
    [undefined, undefined, 10],
  ]);
  assert.deepEqual(parseRatePricedUsage(JSON.parse(JSON.stringify(totals))), totals, "entries survive the wire");
});

test("a session with too many pricing keys stops reporting entries", () => {
  let totals: readonly RatePricedUsageTotal[] = [];
  for (let index = 0; index < RATE_PRICED_USAGE_MAX_ENTRIES; index++) {
    totals = accrueRatePricedUsage(totals, { ...republished, model: `model-${index}` })!;
  }
  assert.equal(totals.length, RATE_PRICED_USAGE_MAX_ENTRIES);
  assert.notEqual(accrueRatePricedUsage(totals, { ...republished, model: "model-0" }), null, "a known key still accrues");
  assert.equal(accrueRatePricedUsage(totals, { ...republished, model: "one-too-many" }), null);
});

test("peer-supplied entries are rejected whole when any entry is malformed", () => {
  const entry = ratePricedUsageRecord(republished)!;
  assert.deepEqual(parseRatePricedUsage([entry]), [entry]);
  for (const invalid of [
    {},
    [entry, entry],
    [{ ...entry, cachedInputTokens: -1 }],
    [{ ...entry, outputTokens: 1.5 }],
    [{ ...entry, model: "" }],
    [{ ...entry, model: " padded" }],
    [{ ...entry, requestInputTokens: { min: 5, max: 4 } }],
    Array.from({ length: RATE_PRICED_USAGE_MAX_ENTRIES + 1 }, (_, index) => ({ ...entry, model: `model-${index}` })),
  ]) {
    assert.equal(parseRatePricedUsage(invalid), null, JSON.stringify(invalid).slice(0, 80));
  }
});
