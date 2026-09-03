import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  USAGE_PRICING_REFRESH_FLOOR_MS,
  USAGE_PRICING_TTL_MS,
  UsageRateTableService,
  defaultUsagePricingCachePath,
  resolveUsagePricingUrl,
} from "./usage-rate-table.js";

const document = {
  "gpt-5.5-codex": { input_cost_per_token: 0.00000125, output_cost_per_token: 0.00001 },
  "claude-fable-5-1": { input_cost_per_token: 0.000005, output_cost_per_token: 0.000025 },
};

function harness(options: { cachePath?: string | null; sourceUrl?: string | null } = {}) {
  let now = 1_000_000;
  const calls: string[] = [];
  let nextDocument: unknown = document;
  let fail: Error | null = null;
  const logs: string[] = [];
  const service = new UsageRateTableService({
    sourceUrl: options.sourceUrl === undefined ? "https://rates.example/prices.json" : options.sourceUrl,
    cachePath: options.cachePath ?? null,
    now: () => now,
    log: (message) => logs.push(message),
    fetchDocument: async (url) => {
      calls.push(url);
      if (fail) throw fail;
      return nextDocument;
    },
  });
  return {
    service,
    calls,
    logs,
    advance: (ms: number) => { now += ms; },
    setDocument: (value: unknown) => { nextDocument = value; },
    setFailure: (error: Error | null) => { fail = error; },
  };
}

test("configuration resolves the disable sentinels and a cache path beside the database", () => {
  assert.equal(resolveUsagePricingUrl(undefined)?.includes("litellm"), true);
  assert.equal(resolveUsagePricingUrl("https://mirror.example/rates.json"), "https://mirror.example/rates.json");
  for (const raw of ["", "  ", "off", "OFF", "none", "0", "false", "disabled"]) {
    assert.equal(resolveUsagePricingUrl(raw), null, `${JSON.stringify(raw)} disables pricing`);
  }
  assert.equal(defaultUsagePricingCachePath(":memory:"), null);
  assert.equal(defaultUsagePricingCachePath("/var/lib/wollipog/control-plane.db"), "/var/lib/wollipog/usage-model-rates.json");
  assert.equal(defaultUsagePricingCachePath("/var/lib/wollipog/control-plane.db", "/elsewhere/rates.json"), "/elsewhere/rates.json");
});

test("a fetched table is fresh inside its TTL, shared across concurrent callers, and refetched after it", async () => {
  const h = harness();
  assert.deepEqual(h.service.status(), { status: "unavailable", source: "https://rates.example/prices.json", fetchedAt: null, knownModels: 0 });
  assert.equal(h.service.current(), null);

  const [first, second] = await Promise.all([h.service.ensure(), h.service.ensure()]);
  assert.equal(h.calls.length, 1, "concurrent ensures share one fetch");
  assert.equal(first.status, "fresh");
  assert.deepEqual(first, second);
  assert.equal(first.knownModels, 2);
  assert.equal(h.service.current()?.has("gpt-5.5-codex"), true);

  h.advance(USAGE_PRICING_TTL_MS - 1);
  await h.service.ensure();
  assert.equal(h.calls.length, 1, "inside the TTL nothing is refetched");
  h.advance(2);
  await h.service.ensure();
  assert.equal(h.calls.length, 2, "past the TTL the table is refetched");
});

test("a forced refresh ignores the TTL but respects the refresh floor", async () => {
  const h = harness();
  await h.service.ensure();
  await h.service.ensure(true);
  assert.equal(h.calls.length, 1, "a forced refresh inside the floor is absorbed");
  h.advance(USAGE_PRICING_REFRESH_FLOOR_MS + 1);
  h.setDocument({ ...document, "gemini-3-pro": { input_cost_per_token: 0.000002, output_cost_per_token: 0.000012 } });
  const status = await h.service.ensure(true);
  assert.equal(h.calls.length, 2);
  assert.equal(status.knownModels, 3, "a model released since the last fetch becomes priceable");
});

test("a failed refresh keeps serving the last table as cached and never claims freshness", async () => {
  const h = harness();
  await h.service.ensure();
  h.advance(USAGE_PRICING_TTL_MS + 1);
  h.setFailure(new Error("HTTP 503"));
  const status = await h.service.ensure();
  assert.equal(status.status, "cached");
  assert.equal(status.knownModels, 2);
  assert.equal(h.service.current()?.size, 2, "the old table stays available for pricing");
  assert.match(h.logs.at(-1) ?? "", /serving the cached rate table.*HTTP 503/);

  assert.equal((await h.service.ensure(true)).status, "cached");
  assert.equal(h.calls.length, 2, "a forced retry inside the attempt floor does not hit a down upstream again");
  h.advance(USAGE_PRICING_REFRESH_FLOOR_MS + 1);
  await h.service.ensure();
  assert.equal(h.calls.length, 3, "a cached table is retried on the next call past the floor, without waiting a TTL");

  h.setDocument({});
  h.setFailure(null);
  h.advance(USAGE_PRICING_REFRESH_FLOOR_MS + 1);
  assert.equal((await h.service.ensure()).status, "cached", "an empty document is a failed refresh, not a wipe");
});

test("a failing first fetch reports unavailable and a disabled source never fetches", async () => {
  const h = harness();
  h.setFailure(new Error("offline"));
  assert.equal((await h.service.ensure()).status, "unavailable");
  assert.equal(h.service.current(), null);
  assert.match(h.logs.at(-1) ?? "", /cost estimates are unavailable/);

  const disabled = harness({ sourceUrl: null });
  assert.deepEqual(await disabled.service.ensure(true), { status: "unavailable", source: "disabled", fetchedAt: null, knownModels: 0 });
  assert.equal(disabled.calls.length, 0);
});

test("the disk cache survives a restart, ages into cached past the TTL, and ignores a foreign source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-usage-rates-"));
  const cachePath = join(dir, "nested", "usage-model-rates.json");
  try {
    const writer = harness({ cachePath });
    await writer.service.ensure();
    assert.equal(existsSync(cachePath), true);
    const written = JSON.parse(readFileSync(cachePath, "utf8")) as { version: number; source: string; fetchedAt: number };
    assert.equal(written.version, 1);
    assert.equal(written.source, "https://rates.example/prices.json");

    const reloaded = new UsageRateTableService({
      sourceUrl: "https://rates.example/prices.json", cachePath, now: () => written.fetchedAt + 1, fetchDocument: async () => { throw new Error("unreachable"); },
      log: () => {},
    });
    assert.equal(reloaded.status().status, "fresh", "a cache inside the TTL is served as fresh without a fetch");
    assert.equal(reloaded.current()?.size, 2);

    const aged = new UsageRateTableService({
      sourceUrl: "https://rates.example/prices.json", cachePath, now: () => written.fetchedAt + USAGE_PRICING_TTL_MS + 1,
      fetchDocument: async () => { throw new Error("unreachable"); }, log: () => {},
    });
    assert.equal(aged.status().status, "cached");
    assert.equal(aged.status().fetchedAt, written.fetchedAt);

    const foreignCalls: string[] = [];
    const foreign = new UsageRateTableService({
      sourceUrl: "https://other.example/prices.json", cachePath, now: () => written.fetchedAt + 1,
      fetchDocument: async (url) => { foreignCalls.push(url); return { ...document, "gemini-3-pro": { input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 } }; },
      log: () => {},
    });
    assert.equal(foreign.status().status, "cached", "a cache fetched from another source is not fresh for this one");
    const refreshed = await foreign.ensure();
    assert.deepEqual(foreignCalls, ["https://other.example/prices.json"], "the configured source is fetched immediately, not after a TTL");
    assert.equal(refreshed.status, "fresh");
    assert.equal(refreshed.knownModels, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
