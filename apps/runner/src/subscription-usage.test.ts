import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { AgentDefinition, SubscriptionUsageSnapshot } from "@wollipog/protocol";
import {
  normalizeClaudeRateLimits,
  normalizeCodexRateLimits,
  probeCodexSubscriptionUsage,
  shouldPublishSubscriptionUsageInventory,
  SubscriptionUsageManager,
  subscriptionUsageSourceId,
} from "./subscription-usage.js";
import type { AgentProcess, SpawnAgentOptions } from "./spawn.js";

const base = { sourceId: "a".repeat(32), runnerId: "runner-1", agentId: "agent-1" };

test("Codex normalization preserves arbitrary limit IDs, both windows, credits, and spend controls", () => {
  const snapshot = normalizeCodexRateLimits({
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        limitName: "All Models",
        planType: "plus",
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2_000_000_000 },
        secondary: { usedPercent: 90, windowDurationMins: 10_080, resetsAt: 2_000_100_000 },
        credits: { hasCredits: true, unlimited: false, balance: "12.50" },
      },
      future_model: {
        limitName: "Future Model",
        primary: { usedPercent: 100, windowDurationMins: 60 },
        individualLimit: { limit: "100", used: "100", remainingPercent: 0 },
        spendControlReached: true,
      },
    },
  }, base, 1_000);
  assert.ok(snapshot);
  assert.equal(snapshot.plan, "plus");
  assert.equal(snapshot.buckets.length, 3);
  assert.deepEqual(snapshot.buckets.map((bucket) => bucket.id), [
    "codex:primary", "codex:secondary", "future_model:primary",
  ]);
  assert.equal(snapshot.buckets[1]?.status, "warning");
  assert.equal(snapshot.buckets[2]?.status, "exhausted");
  assert.deepEqual(snapshot.credits, { hasCredits: true, unlimited: false, balance: "12.50" });
  assert.equal(snapshot.spendControls?.[0]?.reached, true);
});

test("Claude normalization accepts named, model-specific, additional, and status-only windows", () => {
  const snapshot = normalizeClaudeRateLimits({
    rate_limits: {
      five_hour: { used_percentage: 10, resets_at: 2_000_000_000 },
      seven_day_opus: { used_percentage: 85, resets_at: 2_000_100_000 },
      future_lane: { utilization: 100, status: "exhausted" },
    },
    rate_limit_info: { rate_limit_type: "burst_lane", status: "allowed_warning", resetsAt: 2_000_200_000 },
  }, base, 2_000);
  assert.ok(snapshot);
  assert.deepEqual(snapshot.buckets.map((bucket) => bucket.id), [
    "five_hour", "seven_day_opus", "future_lane", "burst_lane",
  ]);
  assert.equal(snapshot.buckets[1]?.label, "Weekly — Opus");
  assert.equal(snapshot.buckets[1]?.status, "warning");
  assert.equal(snapshot.buckets[2]?.remainingPercent, 0);
  assert.equal(snapshot.buckets[3]?.status, "warning");
});

test("provider-controlled bucket ids are sanitized to control-plane bounds", () => {
  const rawId = `${"x".repeat(140)}\u0007`;
  const codex = normalizeCodexRateLimits({
    rateLimitsByLimitId: { [rawId]: { primary: { usedPercent: 10 } } },
  }, base, 1_000);
  const claude = normalizeClaudeRateLimits({
    rate_limits: { [rawId]: { used_percentage: 10 } },
  }, base, 1_000);
  assert.ok(codex);
  assert.ok(claude);
  assert.ok((codex.buckets[0]?.id.length ?? 0) <= 96);
  assert.ok((claude.buckets[0]?.id.length ?? 0) <= 96);
  assert.doesNotMatch(JSON.stringify([codex.buckets[0], claude.buckets[0]]), /\u0007/);
});

test("the Codex refresh probe uses only account APIs, never starts a turn, and always reaps", async () => {
  const requestStream = new PassThrough();
  const responseStream = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as AgentProcess;
  Object.assign(child, { pid: 123, stdin: requestStream, stdout: responseStream, stderr });
  const methods: string[] = [];
  let launched: SpawnAgentOptions | undefined;
  let killed = 0;
  let buffered = "";
  requestStream.setEncoding("utf8");
  requestStream.on("data", (chunk: string) => {
    buffered += chunk;
    while (buffered.includes("\n")) {
      const index = buffered.indexOf("\n");
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      const message = JSON.parse(line) as { id?: number; method: string };
      methods.push(message.method);
      if (message.id === undefined) continue;
      const result = message.method === "account/read"
        ? { account: { type: "chatgpt", planType: "plus" } }
        : message.method === "account/rateLimits/read"
          ? { rateLimits: { limitId: "codex", primary: { usedPercent: 12 } } }
          : {};
      responseStream.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
    }
  });
  const isolation = { backend: "bwrap" as const, command: "bwrap", args: [], network: "deny" as const };
  const result = await probeCodexSubscriptionUsage(agent(), {}, 1_000, {
    spawn: ((options: SpawnAgentOptions) => { launched = options; return child; }) as never,
    kill: (() => { killed++; }) as never,
  }, { cwd: "/safe/subscription-probe", isolation });
  assert.deepEqual(methods, ["initialize", "initialized", "account/read", "account/rateLimits/read"]);
  assert.equal(methods.some((method) => /turn|thread|session/i.test(method)), false);
  assert.deepEqual(launched?.args, ["app-server"]);
  assert.equal(launched?.cwd, "/safe/subscription-probe");
  assert.equal(launched?.isolation, isolation);
  assert.equal(killed, 1);
  assert.equal(result.state, "available");
});

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "codex",
    name: "Codex",
    command: "codex",
    args: [],
    env: {},
    driver: "codex-app-server",
    context: { kind: "native" },
    available: true,
    authStatus: "authenticated",
    codexAppServer: { status: "supported", appServerAvailable: true, transport: "stdio", contractFingerprint: "test" },
    ...overrides,
  };
}

test("event updates merge sparse buckets and concurrent manual refreshes share one no-turn probe", async () => {
  let now = 1_000;
  let probes = 0;
  let authorizations = 0;
  let probeAuthorization: unknown;
  let releaseProbe!: () => void;
  const gate = new Promise<void>((resolve) => { releaseProbe = resolve; });
  const published: SubscriptionUsageSnapshot[] = [];
  const sourceAgent = agent();
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [sourceAgent],
    resolveEnv: () => ({}),
    authorizeProbe: () => {
      authorizations++;
      return {
        cwd: "/safe/subscription-probe",
        isolation: { backend: "bwrap", command: "bwrap", args: [], network: "deny" },
      };
    },
    publish: (snapshot) => published.push(snapshot),
    now: () => now,
    probeCodex: async (_agent, _env, _timeout, _dependencies, authorization) => {
      probes++;
      probeAuthorization = authorization;
      await gate;
      return {
        state: "available",
        rateLimits: { rateLimits: { limitId: "codex", primary: { usedPercent: 40 } } },
      };
    },
  });
  const sourceId = subscriptionUsageSourceId("runner-1", "codex", "codex", { kind: "native" });
  manager.observe("codex", "codex-app-server", { kind: "native" }, {
    provider: "codex",
    payload: { rateLimits: { limitId: "codex", primary: { usedPercent: 20 }, secondary: { usedPercent: 70 } } },
  });
  now = 2_000;
  manager.observe("codex", "codex-app-server", { kind: "native" }, {
    provider: "codex",
    payload: { rateLimits: { limitId: "codex", primary: { usedPercent: 30 } } },
  });
  const publishedAfterFreshUpdate = published.length;
  manager.observe("codex", "codex-app-server", { kind: "native" }, {
    provider: "codex",
    payload: { rateLimits: { limitId: "codex", primary: { usedPercent: 30 } } },
  });
  assert.equal(published.length, publishedAfterFreshUpdate, "identical event updates are deduplicated");
  assert.equal(manager.inventory()[0]?.sourceId, sourceId);
  assert.deepEqual(manager.inventory()[0]?.buckets.map((bucket) => [bucket.id, bucket.usedPercent]), [
    ["codex:primary", 30], ["codex:secondary", 70],
  ]);
  assert.equal(manager.inventory()[0]?.detail, undefined, "live data clears the pre-first-response detail");
  now = 1_500;
  manager.observe("codex", "codex-app-server", { kind: "native" }, {
    provider: "codex",
    payload: { rateLimits: { limitId: "codex", primary: { usedPercent: 99 } } },
  });
  assert.equal(
    manager.inventory()[0]?.buckets.find((bucket) => bucket.id === "codex:primary")?.usedPercent,
    30,
    "an older sparse observation cannot overwrite a newer snapshot",
  );
  assert.equal(published.length, publishedAfterFreshUpdate, "out-of-order events are not republished");

  now = 20_000;
  const first = manager.refreshAll();
  const second = manager.refreshAll();
  assert.equal(first, second, "concurrent refresh requests share the same bounded provider probe");
  releaseProbe();
  await Promise.all([first, second]);
  assert.equal(probes, 1);
  assert.equal(authorizations, 1, "HOME authorization runs once before the shared provider probe");
  assert.deepEqual(probeAuthorization, {
    cwd: "/safe/subscription-probe",
    isolation: { backend: "bwrap", command: "bwrap", args: [], network: "deny" },
  });
  assert.equal(published.at(-1)?.buckets.find((bucket) => bucket.id === "codex:secondary")?.usedPercent, 70);
});

test("a successful refresh clears a prior fallback detail", async () => {
  let now = 1_000;
  let fail = true;
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [agent()],
    resolveEnv: () => ({}),
    authorizeProbe: () => ({ cwd: "/safe/subscription-probe" }),
    publish: () => {},
    now: () => now,
    probeCodex: async () => {
      if (fail) throw new Error("temporary provider failure");
      return {
        state: "available",
        rateLimits: { rateLimits: { limitId: "codex", primary: { usedPercent: 10 } } },
      };
    },
  });
  manager.observe("codex", "codex-app-server", { kind: "native" }, {
    provider: "codex",
    payload: { rateLimits: { limitId: "codex", primary: { usedPercent: 20 } } },
  });
  now = 20_000;
  await manager.refreshAll();
  assert.match(manager.inventory()[0]?.detail ?? "", /latest Codex refresh failed/);
  fail = false;
  now = 40_000;
  await manager.refreshAll();
  assert.equal(manager.inventory()[0]?.detail, undefined);
});

test("subscription inventories wait for discovery and negotiated protocol support", () => {
  assert.equal(shouldPublishSubscriptionUsageInventory(false, 78), false);
  assert.equal(shouldPublishSubscriptionUsageInventory(true, 77), false);
  assert.equal(shouldPublishSubscriptionUsageInventory(true, 78), true);
});

test("source synchronization reports auth modes without probing or exposing account identity", async () => {
  let probes = 0;
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [
      agent({ id: "signed-out", authStatus: "unauthenticated" }),
      agent({ id: "api-key", env: { OPENAI_API_KEY: "secret" } }),
      agent({ id: "old", codexAppServer: { status: "unsupported", appServerAvailable: false,
        failure: { code: "version_unverified", message: "Upgrade Codex." } } }),
    ],
    resolveEnv: (agentId) => agentId === "api-key" ? { OPENAI_API_KEY: "secret" } : {},
    publish: () => {},
    now: () => 20_000,
    probeCodex: async () => { probes++; return { state: "unavailable" }; },
  });
  await manager.refreshAll();
  assert.deepEqual(manager.inventory().map((snapshot) => [snapshot.agentId, snapshot.state]), [
    ["api-key", "not_applicable"],
    ["old", "unsupported"],
    ["signed-out", "unauthenticated"],
  ]);
  assert.equal(probes, 0);
  assert.doesNotMatch(JSON.stringify(manager.inventory()), /secret|email|accountId/i);
});
