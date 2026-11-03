import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import {
  USAGE_PRICING_ERROR_MAX_LENGTH,
  USAGE_PRICING_REFRESH_FLOOR_MS,
  USAGE_PRICING_TTL_MS,
  UsageRateTableService,
  defaultUsagePricingCachePath,
  describeRefreshFailure,
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
  assert.equal(h.service.status().status, "fresh");
  h.advance(2);
  assert.equal(h.service.status().status, "cached", "an expired table reads as cached before anyone refreshes it");
  await h.service.ensure();
  assert.equal(h.calls.length, 2, "past the TTL the table is refetched");
  assert.equal(h.service.status().status, "fresh");
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

test("a failed refresh keeps its reason on the status until a successful one clears it (#4056)", async () => {
  const h = harness();
  await h.service.ensure();
  assert.equal("lastRefreshError" in h.service.status(), false, "a healthy table carries no failure");

  h.advance(USAGE_PRICING_TTL_MS + 1);
  h.setDocument("<!DOCTYPE html><html>Moved</html>");
  const failedAt = 1_000_000 + USAGE_PRICING_TTL_MS + 1;
  const failed = await h.service.ensure(true);
  assert.equal(failed.status, "cached");
  assert.deepEqual(failed.lastRefreshError, { message: "rate table document contained no priced models", at: failedAt });
  assert.deepEqual(h.service.status().lastRefreshError, failed.lastRefreshError, "the usage summary carries it too");
  assert.equal("refreshSkipped" in failed, false, "an attempt that ran was not skipped");

  h.advance(USAGE_PRICING_REFRESH_FLOOR_MS + 1);
  h.setDocument(document);
  const recovered = await h.service.ensure(true);
  assert.equal(recovered.status, "fresh");
  assert.equal("lastRefreshError" in recovered, false, "a successful refresh clears the stored failure");
  assert.equal("lastRefreshError" in h.service.status(), false);
});

test("a refresh inside the floor says it was skipped and when the next may run, keeping the last failure (#4056)", async () => {
  const h = harness();
  h.setFailure(new Error("rate table returned HTTP 503"));
  const first = await h.service.ensure(true);
  assert.equal(first.lastRefreshError?.message, "rate table returned HTTP 503");

  h.advance(15_000);
  const second = await h.service.ensure(true);
  assert.equal(h.calls.length, 1, "no new attempt");
  assert.deepEqual(second.refreshSkipped, { nextAttemptAt: 1_000_000 + USAGE_PRICING_REFRESH_FLOOR_MS, retryAfterMs: 45_000 });
  assert.deepEqual(second.lastRefreshError, first.lastRefreshError, "the failure that set the floor is still reported");
  assert.equal("refreshSkipped" in h.service.status(), false, "only the absorbed answer says it was skipped");

  h.advance(45_000);
  const third = await h.service.ensure(true);
  assert.equal(h.calls.length, 2, "at the floor the next attempt runs");
  assert.equal("refreshSkipped" in third, false);
});

test("a rate source that never answers is a timeout failure, not a hang (#4056)", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const service = new UsageRateTableService({
      sourceUrl: "https://rates.example/prices.json",
      cachePath: null,
      now: () => 5_000,
      log: () => {},
      fetchDocument: (_url, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
      }),
    });
    const pending = service.ensure(true);
    mock.timers.tick(30_000);
    const status = await pending;
    assert.equal(status.status, "unavailable");
    assert.deepEqual(status.lastRefreshError, { message: "the rate source didn't answer within 30 seconds", at: 5_000 });
  } finally {
    mock.timers.reset();
  }
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test("the real fetch reports an HTTP error and a document that isn't JSON by their reason alone (#4056)", async () => {
  const { server, origin } = await listen((request, response) => {
    if (request.url === "/gone.json") {
      response.writeHead(502, { "content-type": "text/plain" }).end("upstream secret page");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" }).end("<!DOCTYPE html><p>password=hunter2</p>");
  });
  try {
    for (const [path, expected] of [["/gone.json", "rate table returned HTTP 502"], ["/rates.json", "rate table document isn't valid JSON"]]) {
      const service = new UsageRateTableService({ sourceUrl: `${origin}${path}`, cachePath: null, log: () => {} });
      const status = await service.ensure(true);
      assert.equal(status.lastRefreshError?.message, expected);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a source URL carrying credentials never reaches the reported failure (#4056)", async () => {
  const service = new UsageRateTableService({
    sourceUrl: "https://mirror-user:mirror-pass@rates.example/prices.json?access=abc123#frag",
    cachePath: null,
    log: () => {},
  });
  const status = await service.ensure(true);
  const message = status.lastRefreshError?.message ?? "";
  assert.ok(message.length > 0, "the failure is reported");
  assert.doesNotMatch(message, /mirror-user|mirror-pass|abc123|frag/);
});

test("a refresh failure is one bounded line without headers or credentials (#4056)", () => {
  const network = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND rates.example"), { code: "ENOTFOUND" }) });
  assert.equal(describeRefreshFailure(network, null), "fetch failed (ENOTFOUND)");
  assert.equal(describeRefreshFailure(new Error("x"), 30_000), "the rate source didn't answer within 30 seconds");

  const leaky = describeRefreshFailure(new Error([
    "request to https://user:pw@rates.example/p.json?sig=abc failed",
    "Authorization: Basic dXNlcjpwdw==",
    "cookie=session=s3cr3t; other=1",
    "with Bearer eyJhbGciOi",
  ].join("\n")), null);
  assert.doesNotMatch(leaky, /\n/);
  assert.doesNotMatch(leaky, /user:pw|sig=abc|dXNlcjpwdw|s3cr3t|eyJhbGciOi/);
  assert.match(leaky, /^request to https:\/\/rates\.example\/p\.json failed Authorization: \[redacted\]/);

  const long = describeRefreshFailure(new Error("x".repeat(5_000)), null);
  assert.equal(long.length, USAGE_PRICING_ERROR_MAX_LENGTH);
  assert.ok(long.endsWith("…"));
  assert.equal(describeRefreshFailure(new Error("  \n "), null), "the refresh failed without saying why");
  assert.equal(describeRefreshFailure("plain words", null), "plain words");
});
