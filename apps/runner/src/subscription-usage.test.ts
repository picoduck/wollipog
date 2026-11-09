import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { AgentDefinition, HarnessInstallationChoice, SubscriptionUsageSnapshot } from "@wollipog/protocol";
import {
  hasSubscriptionUtilization,
  normalizeClaudeRateLimits,
  normalizeCodexRateLimits,
  probeClaudeSubscriptionIdentity,
  probeCodexSubscriptionUsage,
  readCodexSubscriptionIdentity,
  shouldPublishSubscriptionUsageInventory,
  SUBSCRIPTION_USAGE_REFRESH_DEDUPE_MS,
  subscriptionIdentityFingerprint,
  SubscriptionUsageManager,
  subscriptionUsageSourceId,
} from "./subscription-usage.js";
import type { AgentProcess, SpawnAgentOptions } from "./spawn.js";
import { agentForProviderAccount } from "./provider-accounts.js";
import { usageWindowRejection } from "./automatic-provider-account-switch.js";

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

test("Codex normalization is independent of provider insertion order", () => {
  const account = {
    limitId: "codex",
    limitName: "Codex",
    primary: { usedPercent: 42, windowDurationMins: 10_080, resetsAt: 2_000_000_000 },
  };
  const spark = {
    limitId: "codex_spark",
    limitName: "GPT-5.3-Codex-Spark",
    primary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 2_000_200_000 },
    secondary: { usedPercent: 85, windowDurationMins: 300, resetsAt: 2_000_100_000 },
  };
  const future = {
    limitId: "future_model",
    limitName: "Future Model",
    primary: { usedPercent: 100 },
  };
  const normalize = (rateLimitsByLimitId: Record<string, unknown>) =>
    normalizeCodexRateLimits({ rateLimitsByLimitId }, base, 1_000);

  const accountLast = normalize({ spark, future, account });
  const accountFirst = normalize({ account, future, spark });
  assert.ok(accountLast);
  assert.ok(accountFirst);
  assert.deepEqual(accountLast.buckets.map((bucket) => bucket.id), [
    "codex:primary",
    "codex_spark:secondary",
    "codex_spark:primary",
    "future_model:primary",
  ]);
  assert.deepEqual(accountFirst.buckets, accountLast.buckets,
    "ordering and each bucket's percentages, reset, warning, and exhaustion data stay associated");
});

test("Claude normalization accepts named, model-specific, additional, and status-only windows", () => {
  const snapshot = normalizeClaudeRateLimits({
    rate_limit_info: {
      rate_limit_type: "seven_day_opus",
      status: "allowed_warning",
      resetsAt: 2_000_200_000,
      unifiedWindows: {
        five_hour: { utilization: 0.1, resetsAt: 2_000_000_000 },
        seven_day_opus: { utilization: 0.85, resetsAt: 2_000_100_000 },
        future_lane: { utilization: 1, resetsAt: 2_000_100_000 },
      },
    },
  }, base, 2_000);
  assert.ok(snapshot);
  // The limiting window folds into the unified entry naming it instead of standing alone.
  assert.deepEqual(snapshot.buckets.map((bucket) => bucket.id), [
    "five_hour", "seven_day_opus", "future_lane",
  ]);
  const byId = new Map(snapshot.buckets.map((bucket) => [bucket.id, bucket]));
  assert.equal(byId.get("seven_day_opus")?.label, "Weekly — Opus");
  assert.equal(byId.get("seven_day_opus")?.status, "warning");
  assert.equal(byId.get("five_hour")?.status, "available");
  // An unrecognized window id stays renderable without a Wollipog release.
  assert.equal(byId.get("future_lane")?.label, "Future Lane");
  assert.equal(byId.get("future_lane")?.remainingPercent, 0);
});

test("a Claude payload carrying only a rate_limits map contributes no buckets", () => {
  // `rate_limits` was a guessed forward-compatibility shape; no Claude Code release emits it, and
  // the Claude normalizer no longer reads it. The identically named Codex fallback is unaffected.
  assert.equal(normalizeClaudeRateLimits({
    rate_limits: { five_hour: { used_percentage: 10, resets_at: 2_000_000_000 } },
  }, base, 2_000), null);
  const codex = normalizeCodexRateLimits({
    rate_limits: { limitId: "codex", primary: { usedPercent: 25, resetsAt: 2_000_000_000 } },
  }, base, 2_000);
  assert.ok(codex, "the Codex fallback still reads its own rate_limits shape");
  assert.equal(codex.buckets[0]?.usedPercent, 25);
});

test("provider-controlled bucket ids are sanitized to control-plane bounds", () => {
  const rawId = `${"x".repeat(140)}\u0007`;
  const codex = normalizeCodexRateLimits({
    rateLimitsByLimitId: { [rawId]: { primary: { usedPercent: 10 } } },
  }, base, 1_000);
  const claude = normalizeClaudeRateLimits({
    rate_limit_info: { status: "allowed", unifiedWindows: { [rawId]: { utilization: 0.1, resetsAt: 2_000_000_000 } } },
  }, base, 1_000);
  assert.ok(codex);
  assert.ok(claude);
  assert.ok((codex.buckets[0]?.id.length ?? 0) <= 96);
  assert.ok((claude.buckets[0]?.id.length ?? 0) <= 96);
  assert.doesNotMatch(JSON.stringify([codex.buckets[0], claude.buckets[0]]), /\u0007/);
});

test("provider numeric sentinels are omitted instead of invalidating whole snapshots", () => {
  const farFutureSeconds = 9_999_999_999;
  const codex = normalizeCodexRateLimits({
    rateLimits: {
      limitId: "codex",
      limitName: "x".repeat(120),
      primary: { usedPercent: 10, windowDurationMins: 0, resetsAt: farFutureSeconds },
    },
  }, base, 1_000);
  const claude = normalizeClaudeRateLimits({
    rate_limit_info: {
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.1,
      window_duration_minutes: -1,
      resets_at: farFutureSeconds,
    },
  }, base, 1_000);
  assert.ok(codex);
  assert.ok(claude);
  for (const bucket of [codex.buckets[0], claude.buckets[0]]) {
    assert.equal(bucket?.windowDurationMinutes, undefined);
    assert.equal(bucket?.resetsAt, undefined);
    assert.ok((bucket?.label.length ?? 0) <= 160);
  }
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
        ? { account: { type: "chatgpt", planType: "plus", email: "active@example.com" } }
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
  assert.equal(result.accountLabel, "active@example.com");
});

test("the Codex refresh probe accepts its final response between exit and close", async () => {
  const requestStream = new PassThrough();
  const responseStream = new PassThrough();
  const child = new EventEmitter() as AgentProcess;
  Object.assign(child, {
    pid: 123,
    stdin: requestStream,
    stdout: responseStream,
    stderr: new PassThrough(),
  });
  let buffered = "";
  requestStream.setEncoding("utf8");
  requestStream.on("data", (chunk: string) => {
    buffered += chunk;
    while (buffered.includes("\n")) {
      const index = buffered.indexOf("\n");
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      const message = JSON.parse(line) as { id?: number; method: string };
      if (message.id === undefined) continue;
      if (message.method === "account/rateLimits/read") child.emit("exit", 0, null);
      const result = message.method === "account/read"
        ? { account: { type: "chatgpt", planType: "plus", email: "active@example.com" } }
        : message.method === "account/rateLimits/read"
          ? { rateLimits: { limitId: "codex", primary: { usedPercent: 12 } } }
          : {};
      responseStream.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
      if (message.method === "account/rateLimits/read") child.emit("close", 0, null);
    }
  });

  const result = await probeCodexSubscriptionUsage(agent(), {}, 1_000, {
    spawn: (() => child) as never,
    kill: (() => {}) as never,
  }, { cwd: "/safe/subscription-probe" });
  assert.equal(result.state, "available");
  assert.equal(result.accountLabel, "active@example.com");
});

test("the Codex refresh probe rejects unsafe or overlong account labels", async () => {
  for (const email of ["line\nbreak@example.com", `${"a".repeat(155)}@example.com`]) {
    const requestStream = new PassThrough();
    const responseStream = new PassThrough();
    const child = new EventEmitter() as AgentProcess;
    Object.assign(child, { pid: 123, stdin: requestStream, stdout: responseStream, stderr: new PassThrough() });
    let buffered = "";
    requestStream.setEncoding("utf8");
    requestStream.on("data", (chunk: string) => {
      buffered += chunk;
      while (buffered.includes("\n")) {
        const index = buffered.indexOf("\n");
        const message = JSON.parse(buffered.slice(0, index)) as { id?: number; method: string };
        buffered = buffered.slice(index + 1);
        if (message.id === undefined) continue;
        const result = message.method === "account/read"
          ? { account: { type: "chatgpt", planType: "pro", email } }
          : message.method === "account/rateLimits/read"
            ? { rateLimits: { limitId: "codex", primary: { usedPercent: 12 } } }
            : {};
        responseStream.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
      }
    });
    const result = await probeCodexSubscriptionUsage(agent(), {}, 1_000, {
      spawn: (() => child) as never,
      kill: (() => {}) as never,
    }, { cwd: "/safe/subscription-probe" });
    assert.equal(result.accountLabel, undefined);
  }
});

test("a probe spawn error rejects through the refresh path and still reaps", async () => {
  const child = new EventEmitter() as AgentProcess;
  Object.assign(child, {
    pid: undefined,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  let killed = 0;
  const probe = probeCodexSubscriptionUsage(agent(), {}, 1_000, {
    spawn: (() => {
      queueMicrotask(() => child.emit("error", new Error("launch failed")));
      return child;
    }) as never,
    kill: (() => { killed++; }) as never,
  }, { cwd: "/safe/subscription-probe" });
  await assert.rejects(probe, (error: unknown) =>
    typeof error === "object" && error !== null &&
      "message" in error && String(error.message).includes("launch failed"));
  assert.equal(killed, 1);
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

test("Codex sparse events and refreshes retain normalized presentation order", async () => {
  let now = 1_760_000_000_000;
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [agent()],
    resolveEnv: () => ({}),
    authorizeProbe: () => ({ cwd: "/safe/subscription-probe" }),
    publish: () => {},
    now: () => now,
    probeCodex: async () => ({
      state: "available",
      rateLimits: {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: { usedPercent: 42, windowDurationMins: 10_080, resetsAt: 1_760_300_000 },
        },
      },
    }),
  });
  const observe = (rateLimits: Record<string, unknown>) => manager.observe(
    "codex",
    "codex-app-server",
    { kind: "native" },
    { provider: "codex", payload: { rateLimits } },
  );

  observe({
    limitId: "codex_spark",
    limitName: "GPT-5.3-Codex-Spark",
    primary: { usedPercent: 10, windowDurationMins: 10_080, resetsAt: 1_760_200_000 },
  });
  now += 2_000;
  observe({
    limitId: "codex_spark",
    limitName: "GPT-5.3-Codex-Spark",
    secondary: { usedPercent: 85, windowDurationMins: 300, resetsAt: 1_760_100_000 },
  });
  assert.deepEqual(manager.inventory()[0]?.buckets.map((bucket) => bucket.id), [
    "codex_spark:secondary", "codex_spark:primary",
  ], "a shorter window reported later moves ahead of the stored weekly window");

  now += 1_000;
  await manager.refreshAll();
  const buckets = manager.inventory()[0]?.buckets ?? [];
  assert.deepEqual(buckets.map((bucket) => bucket.id), [
    "codex:primary", "codex_spark:secondary", "codex_spark:primary",
  ], "an account-wide refresh moves ahead of model windows observed first");
  assert.deepEqual(buckets.map((bucket) => [bucket.usedPercent, bucket.resetsAt, bucket.status]), [
    [42, 1_760_300_000_000, "available"],
    [85, 1_760_100_000_000, "warning"],
    [10, 1_760_200_000_000, "available"],
  ], "sorting preserves each bucket's utilization, reset, and status");
});

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

test("a Codex account switch, including to an unlabeled account, replaces the complete snapshot", async () => {
  let now = 20_000;
  let activeAccount: string | undefined = "first@example.com";
  let usedPercent = 20;
  let includeSecondary = true;
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [agent()],
    resolveEnv: () => ({}),
    authorizeProbe: () => ({ cwd: "/safe/subscription-probe" }),
    publish: () => {},
    now: () => now,
    probeCodex: async () => ({
      state: "available",
      ...(activeAccount ? { accountLabel: activeAccount } : {}),
      plan: activeAccount?.startsWith("first") ? "pro" : "plus",
      rateLimits: { rateLimits: {
        limitId: "codex",
        primary: { usedPercent },
        ...(includeSecondary ? { secondary: { usedPercent: 70 } } : {}),
      } },
    }),
  });
  await manager.refreshAll();
  assert.deepEqual(manager.inventory()[0]?.buckets.map((bucket) => bucket.id), [
    "codex:primary", "codex:secondary",
  ]);
  manager.syncSources();
  manager.observe("codex", "codex-app-server", { kind: "native" }, {
    provider: "codex",
    kind: "sparse",
    payload: { rateLimits: { limitId: "codex", primary: { usedPercent: 25 } } },
  });
  const afterSparseUpdate = manager.inventory()[0]!;
  assert.equal(afterSparseUpdate.accountLabel, "first@example.com");
  assert.equal(afterSparseUpdate.plan, "pro");
  assert.deepEqual(afterSparseUpdate.buckets.map((bucket) => [bucket.id, bucket.usedPercent]), [
    ["codex:primary", 25], ["codex:secondary", 70],
  ], "source synchronization and sparse updates preserve the refreshed Codex account snapshot");
  activeAccount = "second@example.com";
  usedPercent = 5;
  includeSecondary = false;
  now += 20_000;
  await manager.refreshAll();
  const switched = manager.inventory()[0]!;
  assert.equal(switched.accountLabel, "second@example.com");
  assert.equal(switched.plan, "plus");
  assert.deepEqual(switched.buckets.map((bucket) => [bucket.id, bucket.usedPercent]), [
    ["codex:primary", 5],
  ], "a bucket absent from the replacement account cannot survive from the prior account");

  activeAccount = undefined;
  usedPercent = 2;
  now += 20_000;
  await manager.refreshAll();
  const unlabeled = manager.inventory()[0]!;
  assert.equal(unlabeled.accountLabel, undefined, "the prior account label cannot survive");
  assert.deepEqual(unlabeled.buckets.map((bucket) => [bucket.id, bucket.usedPercent]), [
    ["codex:primary", 2],
  ]);
});

test("subscription inventories wait for discovery and negotiated protocol support", () => {
  assert.equal(shouldPublishSubscriptionUsageInventory(false, 80), false);
  assert.equal(shouldPublishSubscriptionUsageInventory(true, 79), false);
  assert.equal(shouldPublishSubscriptionUsageInventory(true, 80), true);
});

test("shutdown reaps an in-flight detached probe and refuses new refreshes", async () => {
  const child = new EventEmitter() as AgentProcess;
  Object.assign(child, {
    pid: 321,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  let releaseProbe!: () => void;
  const gate = new Promise<void>((resolve) => { releaseProbe = resolve; });
  let killed = 0;
  let published = 0;
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [agent()],
    resolveEnv: () => ({}),
    authorizeProbe: () => ({ cwd: "/safe/subscription-probe" }),
    publish: () => { published++; },
    now: () => 20_000,
    killProbe: () => { killed++; },
    probeCodex: async (_agent, _env, _timeout, dependencies) => {
      dependencies.onSpawn?.(child);
      await gate;
      dependencies.onFinish?.(child);
      return {
        state: "available",
        rateLimits: { rateLimits: { limitId: "codex", primary: { usedPercent: 10 } } },
      };
    },
  });
  const refresh = manager.refreshAll();
  await new Promise<void>((resolve) => setImmediate(resolve));
  manager.shutdown();
  assert.equal(killed, 1);
  await assert.rejects(manager.refreshAll(), /shutting down/);
  releaseProbe();
  await refresh;
  assert.equal(published, 0, "shutdown suppresses late probe publication");
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

function claudeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return agent({
    id: "claude",
    name: "Claude Code",
    command: "claude",
    driver: "claude-code",
    claudeCode: {
      status: "ready",
      effortLevels: [],
      permissionModes: [],
      streamJsonInput: true,
      streamJsonImages: true,
      controlProtocol: true,
      forkSession: true,
      replayUserMessages: true,
      auth: { status: "authenticated", billingSource: "subscription", subscriptionType: "max" },
    },
    ...overrides,
  });
}

test("Claude account labels stay source-local and an account switch drops prior allowances", () => {
  let accountLabel: string | undefined = "first@example.com";
  const source = () => claudeAgent({
    claudeCode: {
      ...claudeAgent().claudeCode!,
      auth: { ...claudeAgent().claudeCode!.auth, accountLabel } as never,
    },
  });
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [source()],
    resolveEnv: () => ({}),
    publish: () => {},
    now: () => OBSERVED_AT,
  });
  manager.observe("claude", "claude-code", { kind: "native" }, {
    provider: "claude",
    kind: "sparse",
    payload: rateLimitEvent({
      status: "allowed",
      rateLimitType: "five_hour",
      unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: FIVE_HOUR_RESET } },
    }),
  });
  assert.equal(manager.inventory()[0]?.accountLabel, "first@example.com");
  assert.equal(manager.inventory()[0]?.buckets.length, 1);

  accountLabel = "second@example.com";
  manager.syncSources();
  assert.equal(manager.inventory()[0]?.accountLabel, "second@example.com");
  assert.equal(manager.inventory()[0]?.buckets.length, 0);
  assert.equal(manager.inventory()[0]?.state, "unavailable");

  manager.observe("claude", "claude-code", { kind: "native" }, {
    provider: "claude",
    kind: "sparse",
    payload: rateLimitEvent({
      status: "allowed",
      rateLimitType: "five_hour",
      unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: FIVE_HOUR_RESET } },
    }),
  });
  accountLabel = undefined;
  manager.syncSources();
  assert.equal(manager.inventory()[0]?.accountLabel, undefined);
  assert.equal(manager.inventory()[0]?.buckets.length, 0, "an unlabeled account cannot retain prior allowances");
});

test("a configured Claude credential scope never inherits the discovery account label", () => {
  const withLabel = (id: string) => claudeAgent({
    id,
    claudeCode: {
      ...claudeAgent().claudeCode!,
      auth: { ...claudeAgent().claudeCode!.auth, accountLabel: "default@example.com" } as never,
    },
  });
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [withLabel("default"), withLabel("work")],
    resolveEnv: () => ({}),
    usesDiscoveredClaudeAccount: (source) => source.id !== "work",
    publish: () => {},
    now: () => OBSERVED_AT,
  });

  assert.deepEqual(manager.syncSources().map((snapshot) => [snapshot.agentId, snapshot.accountLabel]), [
    ["default", "default@example.com"],
    ["work", undefined],
  ]);
});

test("Claude sessions on either agent of one account contribute to its usage source", () => {
  const shared = { id: "shared", path: "/usr/bin/claude", via: "path" as const };
  const work = claudeAgent({ id: "claude-work", defaultProviderAccountId: "work", installation: shared });
  const other = claudeAgent({ id: "claude-other", defaultProviderAccountId: "personal", installation: shared });
  const unselected = claudeAgent({ id: "claude-old", installation: { id: "old", path: "/opt/claude", via: "path" } });
  for (const choices of [[], [{ family: "claude" as const, context: { kind: "native" as const }, installationId: "shared" }]]) {
    const manager = new SubscriptionUsageManager({
      runnerId: "runner-1",
      agents: () => [work, other, unselected],
      installationChoices: () => choices,
      providerAccounts: () => [{ id: "work", label: "Work", provider: "claude", authStatus: "authenticated" }],
      resolveEnv: () => ({}),
      publish: () => {},
      now: () => OBSERVED_AT,
    });
    const update = { provider: "claude" as const, kind: "sparse" as const,
      payload: rateLimitEvent({ status: "allowed", rateLimitType: "five_hour",
        unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: FIVE_HOUR_RESET } } }) };
    const observed = manager.observe("claude-other", "claude-code", { kind: "native" }, update, "work");
    assert.equal(observed?.state, "available");
    assert.equal(observed?.agentId, "claude-work", "an account source keeps its canonical agent");
    assert.equal(manager.syncSources()[0]?.state, "available", "a later inventory does not erase the event");
    if (choices.length) {
      assert.equal(manager.observe("claude-old", "claude-code", { kind: "native" }, update, "work")?.state,
        "available", "an existing session still reports account usage after its installation is unselected");
    }
  }
});

test("a missing selected installation keeps the usage card unsupported but returns account events to the live session", () => {
  const old = claudeAgent({ id: "claude-old", defaultProviderAccountId: "work",
    installation: { id: "old", path: "/opt/claude", via: "path" } });
  const published: SubscriptionUsageSnapshot[] = [];
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [old],
    installationChoices: () => [{ family: "claude", context: { kind: "native" }, installationId: "missing" }],
    providerAccounts: () => [{ id: "work", label: "Work", provider: "claude", authStatus: "authenticated" }],
    resolveEnv: () => ({}),
    publish: (snapshot) => published.push(snapshot),
    now: () => OBSERVED_AT,
  });
  const observed = manager.observe("claude-old", "claude-code", { kind: "native" }, {
    provider: "claude", kind: "sparse",
    payload: rateLimitEvent({ status: "allowed_warning", rateLimitType: "five_hour",
      unifiedWindows: { five_hour: { utilization: 1, resetsAt: FIVE_HOUR_RESET } } }),
  }, "work");
  assert.equal(observed?.state, "available", "the running session still receives exhaustion evidence");
  assert.equal(manager.inventory()[0]?.state, "unsupported", "the unavailable selection is not replaced by old usage");
  assert.deepEqual(published, []);
});

/** Exactly the shape `claude --output-format stream-json` emits: `utilization` is the fraction of
 * the window consumed and `resetsAt` is unix epoch seconds. */
function rateLimitEvent(info: Record<string, unknown>): Record<string, unknown> {
  return { type: "rate_limit_event", rate_limit_info: info, uuid: "u-1", session_id: "s-1" };
}

// Reset times are only accepted within two years of the observation clock, so these run on a
// realistic epoch. Seconds on the wire; the normalizer stores milliseconds.
const OBSERVED_AT = 1_760_000_000_000;
const FIVE_HOUR_RESET = 1_760_018_000;
const WEEK_RESET = 1_760_400_000;
const PRIOR_FIVE_HOUR_RESET = 1_760_000_000;

test("Claude unified windows reach the snapshot with utilization scaled from fraction to percent", () => {
  const snapshot = normalizeClaudeRateLimits(rateLimitEvent({
    status: "allowed",
    rateLimitType: "five_hour",
    utilization: 0.42,
    resetsAt: FIVE_HOUR_RESET,
    unifiedWindows: {
      five_hour: { utilization: 0.42, resetsAt: FIVE_HOUR_RESET },
      seven_day: { utilization: 0.07, resetsAt: WEEK_RESET },
      seven_day_overage_included: { utilization: 0.9, resetsAt: WEEK_RESET },
    },
  }), base, OBSERVED_AT);
  assert.ok(snapshot);
  assert.equal(snapshot.state, "available");
  assert.deepEqual(snapshot.buckets.map((bucket) => [bucket.id, bucket.usedPercent, bucket.remainingPercent]), [
    ["five_hour", 42, 58],
    ["seven_day", 7, 93],
    ["seven_day_overage_included", 90, 10],
  ], "each window stays independently represented and reads as a percentage, not a fraction");
  assert.deepEqual(snapshot.buckets.map((bucket) => bucket.label), [
    "Five-Hour Window", "Weekly — All Models", "Weekly — Extra Usage",
  ]);
  assert.equal(snapshot.buckets[0]?.resetsAt, FIVE_HOUR_RESET * 1_000, "epoch seconds become milliseconds");
  assert.equal(snapshot.buckets[2]?.status, "warning", "a window past 80% warns on its own numbers");
});

test("the limiting window carries the top-level status instead of standing up a second card", () => {
  const snapshot = normalizeClaudeRateLimits(rateLimitEvent({
    status: "rejected",
    rateLimitType: "five_hour",
    utilization: 1.2,
    resetsAt: FIVE_HOUR_RESET,
    unifiedWindows: {
      five_hour: { utilization: 1.2, resetsAt: FIVE_HOUR_RESET },
      seven_day: { utilization: 0.3, resetsAt: WEEK_RESET },
    },
  }), base, OBSERVED_AT);
  assert.ok(snapshot);
  assert.deepEqual(snapshot.buckets.map((bucket) => bucket.id), ["five_hour", "seven_day"]);
  assert.equal(snapshot.buckets[0]?.status, "exhausted");
  assert.equal(snapshot.buckets[0]?.usedPercent, 100, "usage past a window cap clamps to full");
  assert.equal(snapshot.buckets[1]?.status, "available");
});

test("a Claude window the unified set does not name still gets its own bucket", () => {
  const snapshot = normalizeClaudeRateLimits(rateLimitEvent({
    status: "allowed_warning",
    rateLimitType: "seven_day_opus",
    utilization: 0.85,
    resetsAt: WEEK_RESET,
    unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: FIVE_HOUR_RESET } },
  }), base, OBSERVED_AT);
  assert.ok(snapshot);
  assert.deepEqual(snapshot.buckets.map((bucket) => [bucket.id, bucket.usedPercent]), [
    ["five_hour", 10], ["seven_day_opus", 85],
  ]);
  assert.equal(snapshot.buckets[1]?.label, "Weekly — Opus");
});

test("a reset-only Claude event yields a bucket with no percentage rather than a false zero", () => {
  const snapshot = normalizeClaudeRateLimits(
    rateLimitEvent({ status: "allowed", rateLimitType: "five_hour", resetsAt: FIVE_HOUR_RESET }),
    base,
    OBSERVED_AT,
  );
  assert.ok(snapshot);
  assert.deepEqual(snapshot.buckets.map((bucket) => bucket.id), ["five_hour"]);
  assert.equal(snapshot.buckets[0]?.usedPercent, undefined);
  assert.equal(snapshot.buckets[0]?.remainingPercent, undefined);
  assert.equal(hasSubscriptionUtilization(snapshot), false);
});

test("sparse Claude events preserve utilization and reject stale windows", () => {
  let now = OBSERVED_AT;
  const published: SubscriptionUsageSnapshot[] = [];
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [claudeAgent()],
    resolveEnv: () => ({}),
    publish: (snapshot) => published.push(snapshot),
    now: () => now,
  });
  const observe = (info: Record<string, unknown>) =>
    manager.observe("claude", "claude-code", { kind: "native" }, {
      provider: "claude",
      kind: "sparse",
      payload: rateLimitEvent(info),
    });

  observe({
    status: "allowed",
    rateLimitType: "five_hour",
    unifiedWindows: {
      five_hour: { utilization: 0.4, resetsAt: FIVE_HOUR_RESET },
      seven_day: { utilization: 0.1, resetsAt: WEEK_RESET },
    },
  });
  now = OBSERVED_AT + 2_000;
  // A status/reset-only event for one window must not blank that window's known utilization.
  observe({ status: "allowed_warning", rateLimitType: "five_hour", resetsAt: FIVE_HOUR_RESET });
  assert.deepEqual(manager.inventory()[0]?.buckets.map((bucket) => [bucket.id, bucket.usedPercent]), [
    ["five_hour", 40], ["seven_day", 10],
  ], "a sparse event merges into the previously observed windows");
  assert.equal(manager.inventory()[0]?.buckets[0]?.status, "warning");

  now = OBSERVED_AT + 3_000;
  observe({
    status: "allowed",
    rateLimitType: "five_hour",
    unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: FIVE_HOUR_RESET } },
  });
  now = OBSERVED_AT + 4_000;
  // Delivered late, but it describes the window that already rolled over — older data.
  observe({
    status: "allowed",
    rateLimitType: "five_hour",
    unifiedWindows: { five_hour: { utilization: 0.05, resetsAt: PRIOR_FIVE_HOUR_RESET } },
  });
  assert.equal(
    manager.inventory()[0]?.buckets.find((bucket) => bucket.id === "five_hour")?.usedPercent,
    90,
    "an out-of-order event for an earlier window cannot replace newer utilization",
  );
  assert.ok(published.length > 0);
  assert.equal(manager.inventory()[0]?.detail, undefined, "real utilization leaves no explanation behind");
});

test("a Claude version reporting resets but no utilization is explained, not left generic", () => {
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [claudeAgent()],
    resolveEnv: () => ({}),
    publish: () => {},
    now: () => OBSERVED_AT,
  });
  manager.syncSources();
  assert.match(manager.inventory()[0]?.detail ?? "", /after the first provider response/);
  manager.observe("claude", "claude-code", { kind: "native" }, {
    provider: "claude",
    kind: "sparse",
    payload: rateLimitEvent({ status: "allowed", rateLimitType: "five_hour", resetsAt: FIVE_HOUR_RESET }),
  });
  const snapshot = manager.inventory()[0];
  assert.equal(snapshot?.state, "available");
  assert.match(snapshot?.detail ?? "", /allowance windows for this source without utilization/);
  assert.doesNotMatch(snapshot?.detail ?? "", /first provider response/);
});

test("a status-only Claude event is explained without claiming a reset time was reported", () => {
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [claudeAgent()],
    resolveEnv: () => ({}),
    publish: () => {},
    now: () => OBSERVED_AT,
  });
  manager.observe("claude", "claude-code", { kind: "native" }, {
    provider: "claude",
    kind: "sparse",
    payload: rateLimitEvent({ status: "rejected", rateLimitType: "five_hour" }),
  });
  const snapshot = manager.inventory()[0];
  assert.equal(snapshot?.buckets[0]?.status, "exhausted");
  assert.equal(snapshot?.buckets[0]?.resetsAt, undefined, "the provider supplied no reset time");
  // The explanation may cite reset times as a trait of older builds, but must not assert that
  // this source reported one: a status-only event carries no reset at all.
  assert.doesNotMatch(snapshot?.detail ?? "", /reports allowance reset times/i);
  assert.match(snapshot?.detail ?? "", /reported allowance windows for this source without utilization/);
});

test("a single delayed event cannot walk utilization backwards inside one window", () => {
  let now = OBSERVED_AT;
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [claudeAgent()],
    resolveEnv: () => ({}),
    publish: () => {},
    now: () => now,
  });
  const observe = (utilization: number) =>
    manager.observe("claude", "claude-code", { kind: "native" }, {
      provider: "claude",
      kind: "sparse",
      payload: rateLimitEvent({
        status: "allowed",
        rateLimitType: "five_hour",
        unifiedWindows: { five_hour: { utilization, resetsAt: FIVE_HOUR_RESET } },
      }),
    });
  const fiveHourUsed = () =>
    manager.inventory()[0]?.buckets.find((bucket) => bucket.id === "five_hour")?.usedPercent;
  observe(0.9);
  now = OBSERVED_AT + 1_000;
  // Concurrent sessions share one source; this one observed the account earlier but reported
  // later. Same window, and nothing yet confirms its lower usage, so the window holds.
  observe(0.4);
  assert.equal(fiveHourUsed(), 90, "one lower reading inside a window is held, not applied");
  now = OBSERVED_AT + 2_000;
  observe(0.95);
  assert.equal(fiveHourUsed(), 95, "a genuine increase in the same window still applies");
  now = OBSERVED_AT + 3_000;
  observe(0.4);
  now = OBSERVED_AT + 4_000;
  observe(0.96);
  now = OBSERVED_AT + 5_000;
  observe(0.4);
  assert.equal(
    fiveHourUsed(),
    96,
    "a higher reading discards the held one, so lower readings must arrive consecutively to apply",
  );
});

test("a quota reset inside one window applies once a second event confirms it", () => {
  let now = OBSERVED_AT;
  const published: SubscriptionUsageSnapshot[] = [];
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [claudeAgent()],
    resolveEnv: () => ({}),
    publish: (snapshot) => published.push(snapshot),
    now: () => now,
  });
  // The shape Claude Code reported before and after a user applied a quota reset (#3482): the
  // weekly window keeps its reset time while its utilization drops.
  const observe = (status: string, rateLimitType: string, weekly: number) =>
    manager.observe("claude", "claude-code", { kind: "native" }, {
      provider: "claude",
      kind: "sparse",
      payload: rateLimitEvent({
        status,
        rateLimitType,
        resetsAt: rateLimitType === "seven_day" ? WEEK_RESET : FIVE_HOUR_RESET,
        unifiedWindows: {
          five_hour: { utilization: 0.25, resetsAt: FIVE_HOUR_RESET },
          seven_day: { utilization: weekly, resetsAt: WEEK_RESET },
        },
      }),
    });
  const weekly = () => manager.inventory()[0]?.buckets.find((bucket) => bucket.id === "seven_day");
  observe("rejected", "seven_day", 1);
  assert.equal(weekly()?.status, "exhausted");
  assert.deepEqual(usageWindowRejection(manager.inventory()[0], now), { resetsAt: WEEK_RESET * 1000 });

  now = OBSERVED_AT + 60_000;
  observe("allowed", "five_hour", 0.29);
  assert.equal(weekly()?.usedPercent, 100, "the first lower reading alone is indistinguishable from a late event");

  // Within the event dedupe interval: the identical repeat is the confirmation, not noise.
  now = OBSERVED_AT + 61_000;
  observe("allowed", "five_hour", 0.29);
  assert.deepEqual(weekly(), {
    id: "seven_day",
    label: "Weekly — All Models",
    usedPercent: 29,
    remainingPercent: 71,
    resetsAt: WEEK_RESET * 1000,
    observedAt: OBSERVED_AT + 61_000,
    status: "available",
  });
  assert.equal(usageWindowRejection(manager.inventory()[0], now), null,
    "the account is eligible for switching again");
  assert.equal(published.at(-1)?.buckets.find((bucket) => bucket.id === "seven_day")?.usedPercent, 29);

  now = OBSERVED_AT + 62_000;
  observe("allowed", "five_hour", 0.3);
  assert.equal(weekly()?.usedPercent, 30, "usage accumulates again from the reset level");
});

test("only the repeat of an event holding a decrease skips the event dedupe", () => {
  let now = OBSERVED_AT;
  let publishes = 0;
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [claudeAgent()],
    resolveEnv: () => ({}),
    publish: () => { publishes += 1; },
    now: () => now,
  });
  const observe = (unifiedWindows: Record<string, unknown>) =>
    manager.observe("claude", "claude-code", { kind: "native" }, {
      provider: "claude",
      kind: "sparse",
      payload: rateLimitEvent({ status: "allowed", rateLimitType: "five_hour", unifiedWindows }),
    });
  observe({
    five_hour: { utilization: 0.2, resetsAt: FIVE_HOUR_RESET },
    seven_day: { utilization: 0.9, resetsAt: WEEK_RESET },
  });
  now += 1_000;
  observe({
    five_hour: { utilization: 0.2, resetsAt: FIVE_HOUR_RESET },
    seven_day: { utilization: 0.5, resetsAt: WEEK_RESET },
  });
  // The weekly reading stays held while events that never mention that window keep arriving.
  const fiveHourOnly = { five_hour: { utilization: 0.3, resetsAt: FIVE_HOUR_RESET } };
  now += 1_000;
  observe(fiveHourOnly);
  const afterFirst = publishes;
  now += 1_000;
  observe(fiveHourOnly);
  assert.equal(publishes, afterFirst, "an identical event that held nothing is still deduplicated");
  assert.equal(
    manager.inventory()[0]?.buckets.find((bucket) => bucket.id === "seven_day")?.usedPercent,
    90,
    "an event that does not report the held window neither confirms nor discards it",
  );
});

test("the Claude bucket list stays inside the control-plane bound", () => {
  const snapshot = normalizeClaudeRateLimits(rateLimitEvent({
    status: "allowed",
    // A limiting window the unified set does not name adds a bucket beyond the capped 64.
    rateLimitType: "five_hour",
    utilization: 0.5,
    resetsAt: FIVE_HOUR_RESET,
    unifiedWindows: Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`window${index}`, { utilization: 0.5, resetsAt: FIVE_HOUR_RESET }])),
  }), base, OBSERVED_AT);
  assert.ok(snapshot);
  // The control plane rejects a snapshot above 64 buckets outright, discarding the whole update.
  assert.equal(snapshot.buckets.length, 64);
});

test("an authoritative Codex refresh applies a decrease that a sparse event would not", async () => {
  let now = OBSERVED_AT;
  let usedPercent = 80;
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [agent()],
    resolveEnv: () => ({}),
    authorizeProbe: () => ({ cwd: "/safe/subscription-probe" }),
    publish: () => {},
    now: () => now,
    probeCodex: async () => ({
      state: "available",
      rateLimits: { rateLimits: { limitId: "codex", primary: { usedPercent, resetsAt: FIVE_HOUR_RESET } } },
    }),
  });
  await manager.refreshAll();
  assert.equal(manager.inventory()[0]?.buckets[0]?.usedPercent, 80);
  // A probe is a fresh read of account state, so a genuine decrease (a raised allowance, corrected
  // accounting) must apply even though the window's reset time has not moved.
  now = OBSERVED_AT + 60_000;
  usedPercent = 60;
  await manager.refreshAll();
  assert.equal(
    manager.inventory()[0]?.buckets[0]?.usedPercent,
    60,
    "out-of-order rules are for unordered notifications, never for an authoritative read",
  );
});

test("a source that answered stops claiming it is waiting for its first provider response", () => {
  const published: SubscriptionUsageSnapshot[] = [];
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [claudeAgent()],
    resolveEnv: () => ({}),
    publish: (snapshot) => published.push(snapshot),
    now: () => OBSERVED_AT,
  });
  manager.syncSources();
  assert.match(manager.inventory()[0]?.detail ?? "", /after the first provider response/);
  manager.observe("claude", "claude-code", { kind: "native" }, {
    provider: "claude",
    kind: "response_observed",
  });
  const snapshot = manager.inventory()[0];
  assert.equal(snapshot?.state, "unavailable");
  assert.doesNotMatch(snapshot?.detail ?? "", /after the first provider response/);
  assert.match(snapshot?.detail ?? "", /answered without reporting subscription allowances/);
  assert.equal(published.length, 1, "the corrected explanation is published once");
  manager.observe("claude", "claude-code", { kind: "native" }, {
    provider: "claude",
    kind: "response_observed",
  });
  assert.equal(published.length, 1, "a repeat response signal republishes nothing");
});

test("a response signal never disturbs a source already reporting allowances", () => {
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [claudeAgent()],
    resolveEnv: () => ({}),
    publish: () => {},
    now: () => OBSERVED_AT,
  });
  manager.observe("claude", "claude-code", { kind: "native" }, {
    provider: "claude",
    kind: "sparse",
    payload: rateLimitEvent({
      status: "allowed",
      rateLimitType: "five_hour",
      unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: FIVE_HOUR_RESET } },
    }),
  });
  manager.observe("claude", "claude-code", { kind: "native" }, {
    provider: "claude",
    kind: "response_observed",
  });
  const snapshot = manager.inventory()[0];
  assert.equal(snapshot?.state, "available");
  assert.equal(snapshot?.buckets[0]?.usedPercent, 50);
});

test("Claude execution contexts stay separate sources and a manual refresh starts no Claude turn", async () => {
  let probes = 0;
  const native = claudeAgent({ id: "claude", context: { kind: "native" } });
  const wsl = claudeAgent({ id: "claude-wsl", context: { kind: "wsl", distro: "Ubuntu" } });
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [native, wsl],
    resolveEnv: () => ({}),
    publish: () => {},
    now: () => OBSERVED_AT,
    probeCodex: async () => { probes++; return { state: "unavailable" }; },
  });
  manager.observe("claude", "claude-code", { kind: "native" }, {
    provider: "claude",
    kind: "sparse",
    payload: rateLimitEvent({
      status: "allowed",
      rateLimitType: "five_hour",
      unifiedWindows: { five_hour: { utilization: 0.6, resetsAt: FIVE_HOUR_RESET } },
    }),
  });
  manager.observe("claude-wsl", "claude-code", { kind: "wsl", distro: "Ubuntu" }, {
    provider: "claude",
    kind: "response_observed",
  });
  assert.notEqual(
    subscriptionUsageSourceId("runner-1", "claude", "claude", { kind: "native" }),
    subscriptionUsageSourceId("runner-1", "claude-wsl", "claude", { kind: "wsl", distro: "Ubuntu" }),
  );
  assert.deepEqual(manager.inventory().map((snapshot) => [snapshot.agentId, snapshot.state]), [
    ["claude", "available"], ["claude-wsl", "unavailable"],
  ]);
  assert.equal(manager.inventory()[0]?.buckets[0]?.usedPercent, 60);
  assert.match(manager.inventory()[1]?.detail ?? "", /answered without reporting/);

  const before = JSON.stringify(manager.inventory());
  await manager.refreshAll();
  assert.equal(probes, 0, "an installation without the lockdown flags is never probed, so a refresh cannot start a turn");
  assert.equal(JSON.stringify(manager.inventory()), before, "a refresh leaves Claude sources untouched");
});

test("a Codex push update is merged plainly, exactly as before Claude gained ordering rules", () => {
  let now = OBSERVED_AT;
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [agent()],
    resolveEnv: () => ({}),
    publish: () => {},
    now: () => now,
  });
  const observe = (usedPercent: number) =>
    manager.observe("codex", "codex-app-server", { kind: "native" }, {
      provider: "codex",
      kind: "sparse",
      payload: { rateLimits: { limitId: "codex", primary: { usedPercent, resetsAt: FIVE_HOUR_RESET } } },
    });
  observe(80);
  now = OBSERVED_AT + 60_000;
  observe(60);
  // The ordering rules were derived from Claude's per-window contract. Codex keeps the merge it
  // had before this PR rather than inheriting a premise nothing verified for it.
  assert.equal(manager.inventory()[0]?.buckets[0]?.usedPercent, 60);
});

test("newly reported Claude windows are never evicted by buckets already stored", () => {
  let now = OBSERVED_AT;
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [claudeAgent()],
    resolveEnv: () => ({}),
    publish: () => {},
    now: () => now,
  });
  const observe = (payload: unknown) =>
    manager.observe("claude", "claude-code", { kind: "native" }, { provider: "claude", kind: "sparse", payload });
  observe(rateLimitEvent({
    status: "allowed",
    unifiedWindows: Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`retired${index}`, { utilization: 0.05, resetsAt: FIVE_HOUR_RESET }])),
  }));
  assert.equal(manager.inventory()[0]?.buckets.length, 64);
  now = OBSERVED_AT + 60_000;
  observe(rateLimitEvent({
    status: "allowed",
    rateLimitType: "five_hour",
    unifiedWindows: {
      five_hour: { utilization: 0.83, resetsAt: FIVE_HOUR_RESET },
      seven_day: { utilization: 0.4, resetsAt: WEEK_RESET },
    },
  }));
  const buckets = manager.inventory()[0]?.buckets ?? [];
  assert.equal(buckets.length, 64, "the control plane's bound still holds");
  assert.equal(buckets.find((bucket) => bucket.id === "five_hour")?.usedPercent, 83);
  assert.equal(buckets.find((bucket) => bucket.id === "seven_day")?.usedPercent, 40);
});

test("a limiting window id past the control-plane bound still receives its status", () => {
  const longId = "w".repeat(100);
  const snapshot = normalizeClaudeRateLimits(rateLimitEvent({
    status: "rejected",
    rateLimitType: longId,
    unifiedWindows: { [longId]: { utilization: 0.99, resetsAt: FIVE_HOUR_RESET } },
  }), base, OBSERVED_AT);
  assert.ok(snapshot);
  assert.equal(snapshot.buckets.length, 1, "the truncated key is the same window, not a second one");
  assert.equal(snapshot.buckets[0]?.id.length, 96);
  assert.equal(
    snapshot.buckets[0]?.status,
    "exhausted",
    "a rejected window must not read as merely approaching its limit",
  );
});

test("Codex merges sort before truncation so account-wide and stable future groups stay visible", () => {
  let now = OBSERVED_AT;
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [agent()],
    resolveEnv: () => ({}),
    publish: () => {},
    now: () => now,
  });
  const limits = (entries: Array<[string, number]>) => Object.fromEntries(entries.map(([id, usedPercent]) =>
    [id, { limitId: id, primary: { usedPercent }, secondary: { usedPercent } }]));
  const observe = (payload: unknown) =>
    manager.observe("codex", "codex-app-server", { kind: "native" }, { provider: "codex", kind: "sparse", payload });
  observe({ rateLimitsByLimitId: limits(
    Array.from({ length: 32 }, (_, index) => [`old${index}`, 10] as [string, number])) });
  assert.equal(manager.inventory()[0]?.buckets.length, 64);
  now = OBSERVED_AT + 60_000;
  observe({ rateLimitsByLimitId: limits([["new", 50], ["codex", 60]]) });
  const ids = manager.inventory()[0]?.buckets.map((bucket) => bucket.id) ?? [];
  assert.equal(ids.length, 64);
  assert.deepEqual(ids.slice(0, 4), [
    "codex:primary", "codex:secondary", "new:primary", "new:secondary",
  ]);
  assert.ok(!ids.includes("old9:primary"), "the deterministic tail is truncated after sorting");
});

test("Claude window ids that collide once bounded do not fuse into a hybrid window", () => {
  const shared = "x".repeat(96);
  const snapshot = normalizeClaudeRateLimits(rateLimitEvent({
    status: "rejected",
    rateLimitType: `${shared}A`,
    unifiedWindows: {
      [`${shared}A`]: { utilization: 0.1, resetsAt: FIVE_HOUR_RESET },
      [`${shared}B`]: { utilization: 0.9, resetsAt: WEEK_RESET },
    },
  }), base, OBSERVED_AT);
  assert.ok(snapshot);
  assert.equal(snapshot.buckets.length, 1);
  assert.equal(snapshot.buckets[0]?.status, "exhausted");
  assert.equal(
    snapshot.buckets[0]?.usedPercent,
    10,
    "the limiting window keeps its own utilization instead of a colliding window's",
  );
  assert.equal(snapshot.buckets[0]?.resetsAt, FIVE_HOUR_RESET * 1_000);
});

test("configured accounts have independent sources, homes, and targeted refreshes", async () => {
  let now = 20_000;
  const probedHomes: string[] = [];
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [agent()],
    providerAccounts: () => [
      { id: "work", label: "Work", provider: "codex", authStatus: "authenticated" },
      { id: "personal", label: "Personal", provider: "codex", authStatus: "authenticated" },
    ],
    resolveEnv: (_agentId, _driver, _context, accountId) => ({ CODEX_HOME: `/accounts/${accountId}` }),
    authorizeProbe: () => ({ cwd: "/safe/subscription-probe" }),
    publish: () => {},
    now: () => now,
    probeCodex: async (_agent, env) => {
      probedHomes.push(env.CODEX_HOME!);
      return {
        state: "available",
        rateLimits: { rateLimits: { limitId: "codex", primary: {
          usedPercent: env.CODEX_HOME?.endsWith("work") ? 25 : 75,
        } } },
      };
    },
  });
  manager.syncSources();
  assert.deepEqual(manager.inventory().map((snapshot) => [
    snapshot.providerAccountId, snapshot.accountLabel, snapshot.sourceId,
  ]), [
    ["work", "Work", subscriptionUsageSourceId("runner-1", "codex", "codex", { kind: "native" }, "work")],
    ["personal", "Personal", subscriptionUsageSourceId("runner-1", "codex", "codex", { kind: "native" }, "personal")],
  ]);
  await manager.refreshAccount("work");
  assert.deepEqual(probedHomes, ["/accounts/work"]);
  assert.equal(manager.inventory().find((snapshot) => snapshot.providerAccountId === "work")
    ?.buckets[0]?.usedPercent, 25);
  assert.equal(manager.inventory().find((snapshot) => snapshot.providerAccountId === "personal")
    ?.buckets.length, 0, "refreshing Work leaves Personal unchanged");
  now += 20_000;
  await manager.refreshAccount("personal");
  assert.deepEqual(probedHomes, ["/accounts/work", "/accounts/personal"]);
  assert.equal(manager.inventory().find((snapshot) => snapshot.providerAccountId === "personal")
    ?.buckets[0]?.usedPercent, 75);
});

function identityManager(options: {
  resolve: NonNullable<ConstructorParameters<typeof SubscriptionUsageManager>[0]["resolveSubscriptionIdentity"]>;
  published?: SubscriptionUsageSnapshot[];
  now?: () => number;
  authStatus?: "authenticated" | "unauthenticated";
  probeFails?: () => boolean;
}) {
  return new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [agent()],
    providerAccounts: () => [
      { id: "work", label: "Work", provider: "codex", authStatus: options.authStatus ?? "authenticated" },
    ],
    resolveEnv: (_agentId, _driver, _context, accountId) => ({ CODEX_HOME: `/accounts/${accountId}` }),
    authorizeProbe: () => ({ cwd: "/safe/subscription-probe" }),
    publish: (snapshot) => options.published?.push(snapshot),
    now: options.now ?? (() => 20_000),
    resolveSubscriptionIdentity: options.resolve,
    probeCodex: async () => {
      if (options.probeFails?.()) throw new Error("provider is unavailable");
      return {
        state: "available",
        rateLimits: { rateLimits: { limitId: "codex", primary: { usedPercent: 25 } } },
      };
    },
  });
}

test("an old account's windows never carry a new identity, even with no identity in between", async () => {
  const published: SubscriptionUsageSnapshot[] = [];
  let now = 20_000;
  let probeFails = false;
  let identity: string | undefined = JSON.stringify(["codex", "user-1", "workspace-1"]);
  const manager = identityManager({ resolve: async () => identity, published, now: () => now, probeFails: () => probeFails });
  manager.syncSources();
  await manager.refreshAccount("work");
  assert.equal(manager.inventory()[0]?.buckets.length, 1);

  now += SUBSCRIPTION_USAGE_REFRESH_DEDUPE_MS;
  identity = undefined;
  await manager.refreshIdentities();
  assert.equal(manager.inventory()[0]?.subscriptionIdentity, undefined);
  assert.equal(manager.inventory()[0]?.buckets.length, 0, "the windows have no known owner once the identity is gone");

  now += SUBSCRIPTION_USAGE_REFRESH_DEDUPE_MS;
  identity = JSON.stringify(["codex", "user-2", "workspace-2"]);
  probeFails = true;
  const seen = published.length;
  await manager.refreshAccount("work");
  const carryingNew = published.slice(seen).filter((snapshot) => snapshot.subscriptionIdentity !== undefined);
  assert.ok(carryingNew.length > 0);
  assert.ok(carryingNew.every((snapshot) => snapshot.buckets.length === 0), "a failed probe leaves nothing of the old account");
});

test("a selection change during Claude's authorization stops the old harness from starting", async () => {
  let grant: (authorization: { cwd: string; settle: (children: readonly AgentProcess[]) => Promise<void> }) => void = () => {};
  const settled: Array<readonly AgentProcess[]> = [];
  let started = false;
  let authorizing = false;
  const logs: string[] = [];
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [claudeAgent()],
    resolveEnv: () => ({}),
    publish: () => {},
    now: () => 20_000,
    log: (message) => logs.push(message),
    authorizeProbe: () => new Promise((resolve) => {
      authorizing = true;
      grant = resolve;
    }),
    resolveSubscriptionIdentity: async (request) => {
      await request.authorize();
      started = true;
      return JSON.stringify(["claude", "person@example.test", "org-1"]);
    },
  });
  manager.syncSources();
  const pending = manager.refreshIdentities();
  while (!authorizing) await new Promise((resolve) => setImmediate(resolve));
  manager.selectionChanged();
  grant({ cwd: "/safe/subscription-probe", settle: async (children) => { settled.push(children); } });
  await pending;
  assert.equal(started, false, "the old harness never runs");
  assert.deepEqual(settled, [[]], "the authorization it took is released with no process");
  assert.equal(manager.inventory()[0]?.subscriptionIdentity, undefined);
  assert.deepEqual(logs, [], "a superseded read is not a failure");
});

test("each window records when its percentage was reported, through sparse and status-only updates", () => {
  let now = OBSERVED_AT;
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [claudeAgent()],
    resolveEnv: () => ({}),
    publish: () => {},
    now: () => now,
  });
  const observe = (info: Record<string, unknown>) => manager.observe("claude", "claude-code", { kind: "native" }, {
    provider: "claude",
    kind: "sparse",
    payload: rateLimitEvent(info),
  });
  const window = (id: string) => manager.inventory()[0]?.buckets.find((bucket) => bucket.id === id);

  observe({ unifiedWindows: { seven_day: { utilization: 0.2, resetsAt: WEEK_RESET } } });
  assert.equal(window("seven_day")?.observedAt, OBSERVED_AT);

  now = OBSERVED_AT + 1_000;
  observe({ unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: FIVE_HOUR_RESET } } });
  assert.equal(window("five_hour")?.observedAt, OBSERVED_AT + 1_000);
  assert.equal(window("seven_day")?.observedAt, OBSERVED_AT, "a window the update did not report keeps its own time");

  now = OBSERVED_AT + 2_000;
  observe({ status: "allowed_warning", rateLimitType: "seven_day", resetsAt: WEEK_RESET });
  assert.equal(window("seven_day")?.status, "warning");
  assert.equal(window("seven_day")?.observedAt, OBSERVED_AT, "a status-only event reports no percentage");

  now = OBSERVED_AT + 3_000;
  observe({ unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: WEEK_RESET } } });
  assert.equal(window("seven_day")?.observedAt, OBSERVED_AT + 3_000);
});

test("a Codex refresh records when each window was read", async () => {
  const manager = identityManager({ resolve: async () => undefined, now: () => 50_000 });
  manager.syncSources();
  await manager.refreshAccount("work");
  assert.equal(manager.inventory()[0]?.buckets[0]?.observedAt, 50_000);
});

test("a repeated event is still deduplicated although its receipt time differs", () => {
  let now = OBSERVED_AT;
  const published: SubscriptionUsageSnapshot[] = [];
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [claudeAgent()],
    resolveEnv: () => ({}),
    publish: (snapshot) => published.push(snapshot),
    now: () => now,
  });
  const event = () => manager.observe("claude", "claude-code", { kind: "native" }, {
    provider: "claude",
    kind: "sparse",
    payload: rateLimitEvent({ unifiedWindows: { seven_day: { utilization: 0.2, resetsAt: WEEK_RESET } } }),
  });
  event();
  now += 1_000;
  event();
  assert.equal(published.length, 1);
});

test("a resolved subscription identity is published as a one-way fingerprint and survives refreshes", async () => {
  const published: SubscriptionUsageSnapshot[] = [];
  const identity = JSON.stringify(["codex", "user-1", "workspace-1"]);
  const manager = identityManager({ resolve: async () => identity, published });
  manager.syncSources();
  assert.equal(manager.inventory()[0]?.subscriptionIdentity, undefined, "syncing sources starts no identity read");
  await manager.refreshIdentities();
  const fingerprint = manager.inventory()[0]?.subscriptionIdentity;
  assert.match(fingerprint ?? "", /^[a-f0-9]{64}$/);
  assert.equal(fingerprint, subscriptionIdentityFingerprint(identity));
  assert.equal(published.at(-1)?.subscriptionIdentity, fingerprint, "learning the identity publishes it");
  assert.doesNotMatch(JSON.stringify(manager.inventory()), /user-1|workspace-1/);

  await manager.refreshAccount("work");
  assert.equal(published.at(-1)?.buckets.length, 1);
  assert.equal(published.at(-1)?.subscriptionIdentity, fingerprint, "a provider refresh keeps it");
  assert.equal(manager.syncSources()[0]?.subscriptionIdentity, fingerprint, "a resync keeps it");
});

test("a partial identity is not enough to fingerprint: a shared org or a bare email could be another subscription", () => {
  assert.equal(subscriptionIdentityFingerprint(JSON.stringify(["claude", null, "org-1"])), undefined);
  assert.equal(subscriptionIdentityFingerprint(JSON.stringify(["claude", "person@example.test", null])), undefined);
  assert.equal(subscriptionIdentityFingerprint(undefined), undefined);
  assert.notEqual(
    subscriptionIdentityFingerprint(JSON.stringify(["claude", "person@example.test", "org-1"])),
    subscriptionIdentityFingerprint(JSON.stringify(["claude", "person@example.test", "org-2"])),
    "one email in two organizations is two subscriptions",
  );
});

test("signing in to another subscription in one home drops the old account's windows", async () => {
  const published: SubscriptionUsageSnapshot[] = [];
  let now = 20_000;
  let identity = JSON.stringify(["codex", "user-1", "workspace-1"]);
  const manager = identityManager({ resolve: async () => identity, published, now: () => now });
  manager.syncSources();
  await manager.refreshIdentities();
  await manager.refreshAccount("work");
  assert.equal(manager.inventory()[0]?.buckets.length, 1);
  const before = manager.inventory()[0]?.subscriptionIdentity;

  now += SUBSCRIPTION_USAGE_REFRESH_DEDUPE_MS;
  identity = JSON.stringify(["codex", "user-2", "workspace-2"]);
  await manager.refreshIdentities();
  const after = manager.inventory()[0];
  assert.notEqual(after?.subscriptionIdentity, before);
  assert.equal(after?.buckets.length, 0, "the old subscription's windows are gone");
  assert.equal(published.at(-1)?.subscriptionIdentity, after?.subscriptionIdentity);
  assert.equal(published.at(-1)?.buckets.length, 0);
});

test("a failed identity read keeps the known identity, and a proven absence clears it", async () => {
  let now = 20_000;
  let outcome: () => string | undefined = () => JSON.stringify(["codex", "user-1", "workspace-1"]);
  const logs: string[] = [];
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [agent()],
    providerAccounts: () => [{ id: "work", label: "Work", provider: "codex", authStatus: "authenticated" }],
    resolveEnv: () => ({}),
    publish: () => {},
    now: () => now,
    log: (message) => logs.push(message),
    resolveSubscriptionIdentity: async () => outcome(),
  });
  manager.syncSources();
  await manager.refreshIdentities();
  const known = manager.inventory()[0]?.subscriptionIdentity;
  assert.ok(known);

  now += SUBSCRIPTION_USAGE_REFRESH_DEDUPE_MS;
  outcome = () => { throw new Error("credential file is being rewritten"); };
  await manager.refreshIdentities();
  assert.equal(manager.inventory()[0]?.subscriptionIdentity, known);
  assert.match(logs.join("\n"), /subscription identity read failed/);

  now += SUBSCRIPTION_USAGE_REFRESH_DEDUPE_MS;
  outcome = () => undefined;
  await manager.refreshIdentities();
  assert.equal(manager.inventory()[0]?.subscriptionIdentity, undefined);
});

test("a signed-out source has no identity and is never asked for one", async () => {
  let asked = 0;
  const manager = identityManager({
    authStatus: "unauthenticated",
    resolve: async () => { asked += 1; return JSON.stringify(["codex", "user-1", "workspace-1"]); },
  });
  manager.syncSources();
  await manager.refreshIdentities();
  assert.equal(asked, 0);
  assert.equal(manager.inventory()[0]?.subscriptionIdentity, undefined);
});

test("repeated identity refreshes inside the dedupe window read the provider once", async () => {
  let asked = 0;
  const manager = identityManager({
    resolve: async () => { asked += 1; return JSON.stringify(["codex", "user-1", "workspace-1"]); },
  });
  manager.syncSources();
  await manager.refreshIdentities();
  await manager.refreshIdentities();
  assert.equal(asked, 1);
});

test("a manual refresh does not wait for a slow Claude status command", async () => {
  let release: (identity: string) => void = () => {};
  let asked = false;
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [{ ...agent(), id: "claude", command: "claude", driver: "claude-code" }],
    resolveEnv: () => ({}),
    publish: () => {},
    now: () => 20_000,
    resolveSubscriptionIdentity: () => {
      asked = true;
      return new Promise((resolve) => { release = resolve; });
    },
  });
  manager.syncSources();
  await manager.refreshAll();
  while (!asked) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.inventory()[0]?.subscriptionIdentity, undefined, "the refresh returned with the read still pending");
  release(JSON.stringify(["claude", "person@example.test", "org-1"]));
  await manager.refreshIdentities();
  assert.ok(manager.inventory()[0]?.subscriptionIdentity);
});

test("a Codex refresh learns its identity before the probe, and a changed sign-in keeps the new windows", async () => {
  const published: SubscriptionUsageSnapshot[] = [];
  let now = 20_000;
  let identity = JSON.stringify(["codex", "user-1", "workspace-1"]);
  const manager = identityManager({ resolve: async () => identity, published, now: () => now });
  manager.syncSources();
  await manager.refreshAll();
  assert.equal(manager.inventory()[0]?.buckets.length, 1);
  const before = manager.inventory()[0]?.subscriptionIdentity;
  assert.ok(before);

  now += SUBSCRIPTION_USAGE_REFRESH_DEDUPE_MS;
  identity = JSON.stringify(["codex", "user-2", "workspace-2"]);
  await manager.refreshAll();
  const after = manager.inventory()[0];
  assert.notEqual(after?.subscriptionIdentity, before);
  assert.equal(after?.buckets.length, 1, "the probe that followed filled the new account's windows");
});

test("without an identity resolver a source never reports one", async () => {
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [agent()],
    providerAccounts: () => [{ id: "work", label: "Work", provider: "codex", authStatus: "authenticated" }],
    resolveEnv: () => ({}),
    authorizeProbe: () => ({ cwd: "/safe/subscription-probe" }),
    publish: () => {},
    now: () => 20_000,
    probeCodex: async () => ({
      state: "available",
      rateLimits: { rateLimits: { limitId: "codex", primary: { usedPercent: 25 } } },
    }),
  });
  manager.syncSources();
  await manager.refreshAll();
  await manager.refreshIdentities();
  assert.equal(manager.inventory()[0]?.subscriptionIdentity, undefined);
});

test("an identity read that finishes after shutdown is dropped", async () => {
  let release: (identity: string) => void = () => {};
  const published: SubscriptionUsageSnapshot[] = [];
  const manager = identityManager({ published, resolve: () => new Promise((resolve) => { release = resolve; }) });
  manager.syncSources();
  const pending = manager.refreshIdentities();
  manager.shutdown();
  release(JSON.stringify(["codex", "user-1", "workspace-1"]));
  await pending;
  assert.equal(published.length, 0);
});

test("the Claude identity probe reads auth status for a claude.ai sign-in and reaps the process", async () => {
  const stdout = (payload: unknown) => JSON.stringify(payload);
  const run = async (payload: string | null) => {
    const child = new EventEmitter() as unknown as AgentProcess;
    const output = new PassThrough();
    Object.assign(child, { stdout: output, stderr: new PassThrough(), stdin: new PassThrough() });
    const spawned: SpawnAgentOptions[] = [];
    let killed = 0;
    let finished = 0;
    const result = probeClaudeSubscriptionIdentity(
      { ...agent(), id: "claude", command: "claude", args: ["--flag"], driver: "claude-code" },
      { HOME: "/accounts/personal" },
      { cwd: "/safe/subscription-probe" },
      {
        spawn: (options) => { spawned.push(options); return child; },
        kill: () => { killed += 1; },
        onSpawn: () => {},
        onFinish: () => { finished += 1; },
      },
    );
    // A child process reports `close` only after its output streams have ended.
    output.once("end", () => (child as unknown as EventEmitter).emit("close", payload === null ? 1 : 0));
    if (payload !== null) output.write(payload);
    output.end();
    return { identity: await result, spawned, killed, finished };
  };

  const signedIn = await run(stdout({
    loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "Person@Example.test", orgId: "org-1",
  }));
  assert.equal(signedIn.identity, JSON.stringify(["claude", "person@example.test", "org-1"]));
  assert.deepEqual(signedIn.spawned[0]?.args, ["--flag", "auth", "status"]);
  assert.equal(signedIn.spawned[0]?.cwd, "/safe/subscription-probe");
  assert.equal(signedIn.killed, 1);
  assert.equal(signedIn.finished, 1);

  assert.equal((await run(stdout({ loggedIn: true, authMethod: "console", email: "p@example.test", orgId: "org-1" }))).identity,
    undefined, "API billing is not a subscription");
  assert.equal((await run(stdout({ loggedIn: true, authMethod: "claude.ai", apiProvider: "bedrock", email: "p@example.test", orgId: "org-1" }))).identity,
    undefined, "Bedrock is not a subscription");
  assert.equal((await run(stdout({ loggedIn: false }))).identity, undefined);
  await assert.rejects(run("not json"), "unreadable status is a failed read, not proof of no identity");
});

test("the Codex identity reader uses the source's credential home and native context only", async () => {
  const claims = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_user_id: "user-1", chatgpt_account_id: "workspace-1" },
  })).toString("base64url");
  const files = new Map([["/accounts/work/auth.json", JSON.stringify({ tokens: { id_token: `h.${claims}.s` } })]]);
  const read = async (path: string) => {
    const content = files.get(path);
    if (content === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return content;
  };
  assert.equal(
    await readCodexSubscriptionIdentity(agent(), { CODEX_HOME: "/accounts/work" }, read),
    JSON.stringify(["codex", "user-1", "workspace-1"]),
  );
  assert.equal(await readCodexSubscriptionIdentity(agent(), { CODEX_HOME: "/accounts/other" }, read), undefined,
    "no credential file means no ChatGPT sign-in here");
  assert.equal(
    await readCodexSubscriptionIdentity({ ...agent(), context: { kind: "wsl", distro: "Ubuntu" } }, { CODEX_HOME: "/accounts/work" }, read),
    undefined,
    "a WSL home is not readable as a host path",
  );
});

test("provider events without an advertised account source are ignored", () => {
  const published: unknown[] = [];
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [claudeAgent()],
    providerAccounts: () => [
      { id: "work", label: "Work", provider: "claude", authStatus: "authenticated" },
    ],
    resolveEnv: () => ({}),
    publish: (snapshot) => published.push(snapshot),
  });
  const observed = manager.observe(
    "claude", "claude-code", { kind: "native" },
    { kind: "usage", provider: "claude", payload: { fiveHour: { utilization: 0.5 } } },
  );
  assert.equal(observed, null);
  assert.deepEqual(published, []);
});

test("an unbound WSL agent keeps its legacy source beside same-provider accounts", () => {
  const wsl = {
    ...claudeAgent(),
    id: "claude-wsl",
    context: { kind: "wsl" as const, distro: "Ubuntu" },
  };
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [claudeAgent(), wsl],
    providerAccounts: () => [
      { id: "work", label: "Work", provider: "claude", authStatus: "authenticated" },
    ],
    resolveEnv: () => ({}),
    publish: () => {},
  });
  manager.syncSources();
  assert.deepEqual(manager.inventory().map((source) => [source.agentId, source.providerAccountId]), [
    ["claude", "work"],
    ["claude-wsl", undefined],
  ]);
});

test("an incompatible account context stays unsupported without spawning a usage probe", async () => {
  const wsl = {
    ...agent(),
    id: "codex-wsl",
    context: { kind: "wsl" as const, distro: "Ubuntu" },
    defaultProviderAccountId: "work",
  };
  let authorized = 0;
  let probed = 0;
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [wsl],
    providerAccounts: () => [
      { id: "work", label: "Work", provider: "codex", authStatus: "authenticated" },
    ],
    resolveProviderAccountAgent: () => undefined,
    resolveEnv: () => ({ CODEX_HOME: "C:\\credentials\\work" }),
    authorizeProbe: () => { authorized++; return { cwd: "/safe/subscription-probe" }; },
    probeCodex: async () => { probed++; return { state: "unavailable" }; },
    publish: () => {},
    now: () => 20_000,
  });

  await manager.refreshAccount("work");
  const first = manager.inventory()[0];
  assert.equal(first?.state, "unsupported");
  assert.equal(first?.providerAccountId, "work");
  assert.match(first?.detail ?? "", /compatible provider execution context/);
  assert.doesNotMatch(first?.detail ?? "", /credentials|[A-Z]:\\\\/);
  await manager.refreshAccount("work");
  assert.deepEqual(manager.inventory()[0], first, "manual refresh retains the stable unsupported snapshot");
  assert.equal(authorized, 0);
  assert.equal(probed, 0);
});

test("a configured account uses the compatible context resolved by the runner", () => {
  const native = agent();
  const wsl = agent({ id: "codex-wsl", context: { kind: "wsl", distro: "Ubuntu" } });
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [native, wsl],
    providerAccounts: () => [
      { id: "work", label: "Work", provider: "codex", authStatus: "authenticated" },
    ],
    resolveProviderAccountAgent: () => wsl,
    resolveEnv: () => ({ CODEX_HOME: "/home/operator/.codex-work" }),
    publish: () => {},
  });

  manager.syncSources();
  assert.deepEqual(manager.inventory().map((snapshot) => [snapshot.agentId, snapshot.providerAccountId]), [
    ["codex", undefined],
    ["codex-wsl", "work"],
  ], "the selected WSL account source remains distinct from the native legacy scope");
});

test("a failed account refresh preserves the configured label over provider identity", async () => {
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [agent()],
    providerAccounts: () => [
      { id: "work", label: "Work", provider: "codex", authStatus: "authenticated" },
    ],
    resolveEnv: () => ({ CODEX_HOME: "/accounts/work" }),
    authorizeProbe: () => ({ cwd: "/safe/subscription-probe" }),
    publish: () => {},
    probeCodex: async () => ({
      state: "unavailable",
      detail: "No allowance returned.",
      accountLabel: "provider@example.com",
    }),
  });
  await manager.refreshAccount("work");
  assert.equal(manager.inventory()[0]?.accountLabel, "Work");
});

test("configured account login state does not inherit a sibling or agent-wide status", () => {
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [{ ...agent(), authStatus: "authenticated" }],
    providerAccounts: () => [
      { id: "work", label: "Work", provider: "codex", authStatus: "authenticated" },
      { id: "personal", label: "Personal", provider: "codex", authStatus: "unauthenticated" },
    ],
    resolveEnv: () => ({}),
    publish: () => {},
  });
  manager.syncSources();
  assert.deepEqual(manager.inventory().map((snapshot) => [snapshot.providerAccountId, snapshot.state]), [
    ["work", "unavailable"],
    ["personal", "unauthenticated"],
  ]);
});

test("configured Claude accounts do not inherit default-home auth or billing", () => {
  for (const claudeCode of [
    { ...claudeAgent().claudeCode!, status: "unauthenticated" as const },
    {
      ...claudeAgent().claudeCode!,
      auth: { status: "authenticated" as const, billingSource: "api" as const },
    },
  ]) {
    const manager = new SubscriptionUsageManager({
      runnerId: "runner-1",
      agents: () => [claudeAgent({ claudeCode })],
      providerAccounts: () => [
        { id: "work", label: "Work", provider: "claude", authStatus: "authenticated" },
      ],
      resolveEnv: () => ({ CLAUDE_CONFIG_DIR: "/accounts/work" }),
      publish: () => {},
    });
    manager.syncSources();
    assert.deepEqual(manager.inventory().map((snapshot) => [snapshot.providerAccountId, snapshot.state]), [
      ["work", "unavailable"],
    ]);
  }
});

test("configuring one provider keeps the other provider's legacy usage source", () => {
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [agent(), {
      id: "claude", name: "Claude", command: "claude", args: [], env: {},
      driver: "claude-code", context: { kind: "native" }, available: true,
    }],
    providerAccounts: () => [
      { id: "work", label: "Work", provider: "codex", authStatus: "authenticated" },
    ],
    resolveEnv: () => ({}),
    publish: () => {},
  });
  manager.syncSources();
  assert.deepEqual(manager.inventory().map((source) => [
    source.provider, source.providerAccountId, source.agentId,
  ]), [
    ["claude", undefined, "claude"],
    ["codex", "work", "codex"],
  ]);
});

test("usage probes only the selected installation in each context and survives rediscovery", async () => {
  const system = agent({ id: "system", command: "/usr/bin/codex",
    installation: { id: "system", path: "/usr/bin/codex", via: "path" } });
  const local = agent({ id: "local", command: "/home/user/.local/bin/codex",
    installation: { id: "local", path: "/home/user/.local/bin/codex", via: "common-dir" } });
  const wsl = agent({ id: "wsl", context: { kind: "wsl", distro: "Ubuntu" }, command: "/usr/bin/codex",
    installation: { id: "ubuntu", path: "/usr/bin/codex", via: "path" } });
  let discovered = [system, local, wsl];
  const choices: HarnessInstallationChoice[] = [
    { family: "codex", context: { kind: "native" }, installationId: "local" },
    { family: "codex", context: { kind: "wsl", distro: "Ubuntu" }, installationId: "ubuntu" },
  ];
  let now = 20_000;
  const probed: string[] = [];
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => discovered,
    installationChoices: () => choices,
    resolveEnv: () => ({}),
    authorizeProbe: () => ({ cwd: "/safe/probe" }),
    publish: () => {},
    now: () => now,
    probeCodex: async (candidate) => {
      probed.push(candidate.id);
      return { state: "available", rateLimits: { rateLimits: {
        limitId: "codex", primary: { usedPercent: 10 },
      } } };
    },
  });
  await manager.refreshAll();
  assert.deepEqual(probed, ["local", "wsl"]);
  assert.deepEqual(manager.inventory().map((snapshot) => snapshot.agentId), ["local", "wsl"]);

  discovered = [system, wsl];
  manager.selectionChanged();
  now += 20_000;
  await manager.refreshAll();
  assert.deepEqual(probed, ["local", "wsl", "wsl"]);
  assert.deepEqual(manager.inventory().map((snapshot) => [snapshot.agentId, snapshot.state]), [
    ["system", "unsupported"], ["wsl", "available"],
  ]);

  discovered = [system, local, wsl];
  manager.selectionChanged();
  now += 20_000;
  await manager.refreshAll();
  assert.deepEqual(probed, ["local", "wsl", "wsl", "local", "wsl"]);
  assert.deepEqual(manager.inventory().map((snapshot) => snapshot.agentId), ["local", "wsl"]);
});

test("account probes keep credential-home compatibility before applying the selected installation", async () => {
  const system = agent({ id: "system", installation: { id: "system", path: "/usr/bin/codex", via: "path" } });
  const local = agent({ id: "local", installation: { id: "local", path: "/home/user/.local/bin/codex", via: "common-dir" } });
  const wsl = agent({ id: "wsl", context: { kind: "wsl", distro: "Ubuntu" },
    installation: { id: "wsl", path: "/usr/bin/codex", via: "path" } });
  let discovered = [system, local, wsl];
  const choices: HarnessInstallationChoice[] = [
    { family: "codex", context: { kind: "native" }, installationId: "local" },
    { family: "codex", context: { kind: "wsl", distro: "Ubuntu" }, installationId: "wsl" },
  ];
  const probed: string[] = [];
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => discovered,
    installationChoices: () => choices,
    providerAccounts: () => [{ id: "work", label: "Work", provider: "codex", authStatus: "authenticated" }],
    resolveProviderAccountAgent: (_account, drivers, candidates) =>
      agentForProviderAccount(candidates, { id: "work", provider: "codex", directory: "/accounts/work" }, drivers, "linux"),
    resolveEnv: () => ({ CODEX_HOME: "/accounts/work" }),
    authorizeProbe: () => ({ cwd: "/safe/probe" }),
    publish: () => {},
    now: () => 20_000,
    probeCodex: async (candidate) => {
      probed.push(candidate.id);
      return { state: "unavailable" };
    },
  });
  await manager.refreshAccount("work");
  assert.deepEqual(probed, ["local"]);
  assert.equal(manager.inventory().find((snapshot) => snapshot.providerAccountId === "work")?.agentId, "local");

  discovered = [system, wsl];
  manager.selectionChanged();
  await manager.refreshAccount("work");
  assert.deepEqual(probed, ["local"], "neither the unselected native binary nor WSL may use this home");
  assert.equal(manager.inventory().find((snapshot) => snapshot.providerAccountId === "work")?.state, "unsupported");
});

test("a selected installation preserves each account's compatible default agent environment", async () => {
  const installation = { id: "shared", path: "/usr/bin/codex", via: "path" as const };
  const work = agent({ id: "codex-work", defaultProviderAccountId: "work", installation });
  const personal = agent({ id: "codex-personal", defaultProviderAccountId: "personal", installation });
  const probed: string[] = [];
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [work, personal],
    installationChoices: () => [{ family: "codex", context: { kind: "native" }, installationId: "shared" }],
    providerAccounts: () => [
      { id: "work", label: "Work", provider: "codex", authStatus: "authenticated" },
      { id: "personal", label: "Personal", provider: "codex", authStatus: "authenticated" },
    ],
    resolveEnv: (agentId) => agentId === "codex-work" ? { OPENAI_API_KEY: "test-only" } : {},
    authorizeProbe: () => ({ cwd: "/safe/probe" }),
    publish: () => {},
    now: () => 20_000,
    probeCodex: async (candidate) => { probed.push(candidate.id); return { state: "unavailable" }; },
  });
  await manager.refreshAccount("personal");
  assert.deepEqual(probed, ["codex-personal"]);
  assert.equal(manager.inventory().find((snapshot) => snapshot.providerAccountId === "personal")?.agentId,
    "codex-personal");
});

test("a selected account probe uses a generic agent before another account's default", async () => {
  const work = agent({ id: "codex-work", defaultProviderAccountId: "work",
    installation: { id: "old", path: "/opt/codex", via: "path" } });
  const personal = agent({ id: "codex-personal", defaultProviderAccountId: "personal",
    installation: { id: "selected", path: "/usr/bin/codex", via: "path" } });
  const generic = agent({ id: "codex-generic",
    installation: { id: "selected", path: "/usr/bin/codex", via: "path" } });
  const selectedWork = agent({ id: "codex-work-selected", defaultProviderAccountId: "work",
    installation: { id: "selected", path: "/usr/bin/codex", via: "path" } });
  let discovered = [work, personal, generic, selectedWork];
  const probed: string[] = [];
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => discovered,
    installationChoices: () => [{ family: "codex", context: { kind: "native" }, installationId: "selected" }],
    providerAccounts: () => [{ id: "work", label: "Work", provider: "codex", authStatus: "authenticated" }],
    resolveEnv: (agentId) => agentId === "codex-personal" ? { OPENAI_API_KEY: "test-only" } : {},
    authorizeProbe: () => ({ cwd: "/safe/probe" }),
    publish: () => {},
    now: () => 20_000,
    probeCodex: async (candidate) => { probed.push(candidate.id); return { state: "unavailable" }; },
  });
  await manager.refreshAccount("work");
  assert.deepEqual(probed, ["codex-work-selected"], "the account's selected default precedes a generic agent");
  assert.equal(manager.inventory().find((source) => source.providerAccountId === "work")?.agentId,
    "codex-work-selected");
  discovered = [work, personal, generic];
  manager.selectionChanged();
  await manager.refreshAccount("work");
  assert.deepEqual(probed, ["codex-work-selected", "codex-generic"]);
  assert.equal(manager.inventory().find((source) => source.providerAccountId === "work")?.agentId,
    "codex-generic");
  discovered = [work, personal];
  manager.selectionChanged();
  await manager.refreshAccount("work");
  assert.deepEqual(probed, ["codex-work-selected", "codex-generic"],
    "another account's configured agent is not borrowed");
  assert.equal(manager.inventory().find((source) => source.providerAccountId === "work")?.state,
    "unsupported");
  discovered = [personal];
  manager.selectionChanged();
  await manager.refreshAccount("work");
  assert.deepEqual(probed, ["codex-work-selected", "codex-generic"],
    "the sole selected agent still belongs to another account");
  assert.equal(manager.inventory().find((source) => source.providerAccountId === "work")?.state,
    "unsupported");
});

test("an incompatible account does not hide a selected generic WSL usage source", async () => {
  const wsl = agent({ id: "wsl-generic", context: { kind: "wsl", distro: "Ubuntu" },
    installation: { id: "selected", path: "/usr/bin/codex", via: "path" } });
  const probed: string[] = [];
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [wsl],
    installationChoices: () => [{ family: "codex", context: { kind: "wsl", distro: "Ubuntu" },
      installationId: "selected" }],
    providerAccounts: () => [{ id: "work", label: "Work", provider: "codex", authStatus: "authenticated" }],
    resolveProviderAccountAgent: () => undefined,
    resolveEnv: () => ({}),
    authorizeProbe: () => ({ cwd: "/safe/probe" }),
    publish: () => {},
    now: () => 20_000,
    probeCodex: async (candidate) => { probed.push(candidate.id); return { state: "unavailable" }; },
  });
  await manager.refreshAll();
  assert.deepEqual(probed, ["wsl-generic"]);
  assert.deepEqual(manager.inventory().map((source) => [source.agentId, source.providerAccountId, source.state]), [
    ["wsl-generic", "work", "unsupported"],
    ["wsl-generic", undefined, "unavailable"],
  ]);
});

test("a runner without synchronized choices does not advertise selection-bound usage", async () => {
  let ready = false;
  let probes = 0;
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [agent()],
    selectionReady: () => ready,
    resolveEnv: () => ({}),
    authorizeProbe: () => ({ cwd: "/safe/probe" }),
    publish: () => {},
    now: () => 20_000,
    probeCodex: async () => { probes++; return { state: "unavailable" }; },
  });
  await manager.refreshAll();
  assert.deepEqual(manager.inventory(), []);
  ready = true;
  manager.selectionChanged();
  await manager.refreshAll();
  assert.equal(probes, 1);
});

test("a selection change discards an in-flight probe from the former installation", async () => {
  const system = agent({ id: "system", installation: { id: "system", path: "/usr/bin/codex", via: "path" } });
  const local = agent({ id: "local", installation: { id: "local", path: "/home/user/.local/bin/codex", via: "common-dir" } });
  const choices: HarnessInstallationChoice[] = [
    { family: "codex", context: { kind: "native" }, installationId: "system" },
  ];
  let finishOld!: () => void;
  const oldProbe = new Promise<void>((resolve) => { finishOld = resolve; });
  const published: string[] = [];
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [system, local],
    installationChoices: () => choices,
    resolveEnv: () => ({}),
    authorizeProbe: () => ({ cwd: "/safe/probe" }),
    publish: (snapshot) => { published.push(snapshot.agentId); },
    now: () => 20_000,
    probeCodex: async (candidate) => {
      if (candidate.id === "system") await oldProbe;
      return { state: "available", rateLimits: { rateLimits: {
        limitId: "codex", primary: { usedPercent: 10 },
      } } };
    },
  });
  const firstRefresh = manager.refreshAll();
  await new Promise<void>((resolve) => setImmediate(resolve));
  choices[0] = { ...choices[0]!, installationId: "local" };
  manager.selectionChanged();
  finishOld();
  await firstRefresh;
  await manager.refreshAll();
  assert.deepEqual(published, ["local"]);
  assert.deepEqual(manager.inventory().map((snapshot) => snapshot.agentId), ["local"]);
});

test("an in-flight probe stays invalid after selection changes away and back", async () => {
  const system = agent({ id: "system", installation: { id: "system", path: "/usr/bin/codex", via: "path" } });
  const local = agent({ id: "local", installation: { id: "local", path: "/home/user/.local/bin/codex", via: "common-dir" } });
  const choices: HarnessInstallationChoice[] = [
    { family: "codex", context: { kind: "native" }, installationId: "system" },
  ];
  let finishOld!: () => void;
  const oldProbe = new Promise<void>((resolve) => { finishOld = resolve; });
  const published: string[] = [];
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [system, local],
    installationChoices: () => choices,
    resolveEnv: () => ({}),
    authorizeProbe: () => ({ cwd: "/safe/probe" }),
    publish: (snapshot) => { published.push(snapshot.agentId); },
    now: () => 20_000,
    probeCodex: async () => {
      await oldProbe;
      return { state: "available", rateLimits: { rateLimits: {
        limitId: "codex", primary: { usedPercent: 10 },
      } } };
    },
  });
  const refresh = manager.refreshAll();
  await new Promise<void>((resolve) => setImmediate(resolve));
  choices[0] = { ...choices[0]!, installationId: "local" };
  manager.selectionChanged();
  choices[0] = { ...choices[0]!, installationId: "system" };
  manager.selectionChanged();
  finishOld();
  await refresh;
  assert.deepEqual(published, []);
  assert.equal(manager.inventory()[0]?.state, "unavailable");
});

test("a queued unsupported source cannot republish after rediscovery selects an installation", async () => {
  const native = agent({ id: "native" });
  const wslSystem = agent({ id: "wsl-system", context: { kind: "wsl", distro: "Ubuntu" },
    installation: { id: "system", path: "/usr/bin/codex", via: "path" } });
  const wslLocal = agent({ id: "wsl-local", context: { kind: "wsl", distro: "Ubuntu" },
    installation: { id: "local", path: "/home/user/bin/codex", via: "common-dir" } });
  let discovered = [native, wslSystem];
  const choices: HarnessInstallationChoice[] = [
    { family: "codex", context: { kind: "wsl", distro: "Ubuntu" }, installationId: "local" },
  ];
  let finishNative!: () => void;
  const nativeProbe = new Promise<void>((resolve) => { finishNative = resolve; });
  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => discovered,
    installationChoices: () => choices,
    resolveEnv: () => ({}),
    authorizeProbe: () => ({ cwd: "/safe/probe" }),
    publish: () => {},
    now: () => 20_000,
    probeCodex: async () => {
      await nativeProbe;
      return { state: "unavailable" };
    },
  });
  const refresh = manager.refreshAll();
  await new Promise<void>((resolve) => setImmediate(resolve));
  discovered = [native, wslSystem, wslLocal];
  manager.selectionChanged();
  finishNative();
  await refresh;
  assert.deepEqual(manager.inventory().map((source) => source.agentId), ["native", "wsl-local"]);
});
