import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { ANTIGRAVITY_AGENT_ID, type AgentDefinition, type SubscriptionUsageSnapshot } from "@wollipog/protocol";
import { advertisedAntigravityTier, antigravityCredentialContext } from "./antigravity-setup.js";
import {
  ANTIGRAVITY_CREDITS_PROBE_ARGS,
  ANTIGRAVITY_USAGE_PROBE_ARGS,
  normalizeAntigravityCreditsData,
  normalizeAntigravityUsageData,
  probeAntigravitySubscriptionUsage,
} from "./antigravity-subscription-usage.js";
import {
  SUBSCRIPTION_USAGE_REFRESH_DEDUPE_MS,
  SubscriptionUsageManager,
  readSubscriptionIdentity,
  subscriptionUsageSourceId,
} from "./subscription-usage.js";
import type { AgentProcess, SpawnAgentOptions } from "./spawn.js";

const NOW = 1_795_581_600_000;
const FIVE_HOUR_RESET_ISO = "2026-11-25T09:33:45Z";
const FIVE_HOUR_RESET_MS = Date.parse(FIVE_HOUR_RESET_ISO);
const WEEKLY_RESET_ISO = "2026-11-30T20:14:16Z";
const WEEKLY_RESET_MS = Date.parse(WEEKLY_RESET_ISO);

function antigravityAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: ANTIGRAVITY_AGENT_ID,
    name: "Google Antigravity",
    command: "/usr/local/bin/agy",
    args: ["acp"],
    env: {},
    driver: "acp",
    context: { kind: "native" },
    source: "discovered",
    version: "1.5.14",
    available: true,
    authStatus: "authenticated",
    ...overrides,
  };
}

function sampleUsageData() {
  return {
    description: "Within each group, models share a weekly limit and a 5-hour limit.",
    groups: [
      {
        name: "Gemini Models",
        buckets: [
          {
            id: "gemini-weekly",
            name: "Weekly Limit Remaining",
            window: "weekly",
            remaining_fraction: 0.92555,
            reset_time: WEEKLY_RESET_ISO,
          },
          {
            id: "gemini-5h",
            name: "Five Hour Limit Remaining",
            window: "5h",
            remaining_fraction: 0.15,
            reset_time: FIVE_HOUR_RESET_ISO,
          },
        ],
      },
      {
        name: "Claude and GPT models",
        buckets: [
          {
            id: "3p-weekly",
            name: "Weekly Limit Remaining",
            window: "weekly",
            remaining_fraction: 0,
            reset_time: WEEKLY_RESET_ISO,
          },
          {
            id: "3p-5h",
            name: "Five Hour Limit Remaining",
            window: "5h",
            remaining_fraction: 1,
            reset_time: FIVE_HOUR_RESET_ISO,
          },
        ],
      },
    ],
  };
}

function fakeProcess(run: (child: EventEmitter, stdout: PassThrough, stderr: PassThrough) => void): AgentProcess {
  const child = new EventEmitter() as unknown as AgentProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  Object.assign(child, { stdout, stderr, stdin });
  queueMicrotask(() => run(child as unknown as EventEmitter, stdout, stderr));
  return child;
}

test("normalizeAntigravityUsageData produces group-qualified Title Case windows ordered 5h before weekly", () => {
  const normalized = normalizeAntigravityUsageData(sampleUsageData(), NOW);
  assert.ok(normalized && normalized.state === "available");
  assert.deepEqual(normalized.buckets, [
    {
      id: "gemini-5h",
      label: "Gemini Models — Five-Hour Window",
      usedPercent: 85,
      remainingPercent: 15,
      windowDurationMinutes: 300,
      resetsAt: FIVE_HOUR_RESET_MS,
      status: "warning",
    },
    {
      id: "gemini-weekly",
      label: "Gemini Models — Weekly",
      usedPercent: 7.44,
      remainingPercent: 92.56,
      windowDurationMinutes: 10_080,
      resetsAt: WEEKLY_RESET_MS,
      status: "available",
    },
    {
      id: "3p-5h",
      label: "Claude and GPT Models — Five-Hour Window",
      usedPercent: 0,
      remainingPercent: 100,
      windowDurationMinutes: 300,
      resetsAt: FIVE_HOUR_RESET_MS,
      status: "available",
    },
    {
      id: "3p-weekly",
      label: "Claude and GPT Models — Weekly",
      usedPercent: 100,
      remainingPercent: 0,
      windowDurationMinutes: 10_080,
      resetsAt: WEEKLY_RESET_MS,
      status: "exhausted",
    },
  ]);
});

test("normalizeAntigravityUsageData preserves unknown future groups/windows and maps empty groups to not_applicable", () => {
  const future = normalizeAntigravityUsageData({
    groups: [
      {
        name: "Future AI Family",
        buckets: [
          { id: "future-12h", name: "Burst Limit Remaining", window: "12h", remaining_fraction: 0.5, reset_time: FIVE_HOUR_RESET_ISO },
        ],
      },
    ],
  }, NOW);
  assert.ok(future && future.state === "available");
  assert.deepEqual(future.buckets, [{
    id: "future-12h",
    label: "Future AI Family — Burst",
    usedPercent: 50,
    remainingPercent: 50,
    windowDurationMinutes: 720,
    resetsAt: FIVE_HOUR_RESET_MS,
    status: "available",
  }]);

  assert.deepEqual(normalizeAntigravityUsageData({ groups: [] }, NOW), { state: "not_applicable" });
  assert.deepEqual(normalizeAntigravityUsageData({ groups: [{ name: "Enterprise", buckets: [] }] }, NOW), { state: "not_applicable" });
  assert.equal(normalizeAntigravityUsageData("not an object", NOW), null);
});

test("normalizeAntigravityCreditsData formats integer and fractional balances and drops invalid values", () => {
  assert.deepEqual(normalizeAntigravityCreditsData({ remaining_credits: 3000 }), { hasCredits: true, balance: "3000" });
  assert.deepEqual(normalizeAntigravityCreditsData({ remaining_credits: 0 }), { hasCredits: false, balance: "0" });
  assert.deepEqual(normalizeAntigravityCreditsData({ remaining_credits: 42.5 }), { hasCredits: true, balance: "42.5" });
  assert.equal(normalizeAntigravityCreditsData({ remaining_credits: -1 }), undefined);
  assert.equal(normalizeAntigravityCreditsData({}), undefined);
});

test("advertisedAntigravityTier reads _meta.antigravity.tier from ACP session/new responses", () => {
  assert.equal(advertisedAntigravityTier({
    sessionId: "s1",
    _meta: { antigravity: { tier: { name: "Google AI Ultra", id: "g1-ultra-lite-tier" } } },
  }), "Google AI Ultra");
  assert.equal(advertisedAntigravityTier({
    _meta: { antigravity: { tier: "Google AI Pro" } },
  }), "Google AI Pro");
  assert.equal(advertisedAntigravityTier({ _meta: { antigravity: { tier: { name: "bad\nline" } } } }), undefined);
  assert.equal(advertisedAntigravityTier({ sessionId: "s1" }), undefined);
});

test("probeAntigravitySubscriptionUsage runs zero-turn /usage and /credits in antigravityCredentialContext", async () => {
  const spawned: SpawnAgentOptions[] = [];
  let killed = 0;
  let finished = 0;
  const context = antigravityCredentialContext({ GEMINI_API_KEY: "secret", GOOGLE_CLOUD_PROJECT: "proj" }, { managed: true });

  const result = await probeAntigravitySubscriptionUsage({
    command: "/managed/agy",
    cwd: "/safe/probe",
    context,
    timeoutMs: 2_000,
    now: () => NOW,
    deps: {
      spawn: (opts) => {
        spawned.push(opts);
        const isUsage = opts.args.includes("/usage");
        return fakeProcess((child, stdout) => {
          if (isUsage) {
            stdout.write(`${JSON.stringify({ event: "command_result", command: { name: "usage", data: sampleUsageData() } })}\n`);
            stdout.write(`${JSON.stringify({ event: "result", result: { status: "SUCCESS", num_turns: 0 } })}\n`);
          } else {
            stdout.write(`${JSON.stringify({ event: "command_result", command: { name: "credits", data: { remaining_credits: 2500 } } })}\n`);
            stdout.write(`${JSON.stringify({ event: "result", result: { status: "SUCCESS", num_turns: 0 } })}\n`);
          }
          stdout.end();
          child.emit("close", 0);
        });
      },
      kill: () => { killed += 1; },
      onFinish: () => { finished += 1; },
    },
  });

  assert.equal(result.state, "available");
  assert.equal(result.buckets.length, 4);
  assert.deepEqual(result.credits, { hasCredits: true, balance: "2500" });
  assert.deepEqual(spawned.map((entry) => entry.args), [ANTIGRAVITY_USAGE_PROBE_ARGS, ANTIGRAVITY_CREDITS_PROBE_ARGS]);
  assert.ok(spawned[0]?.scrubInheritedEnv?.includes("GEMINI_API_KEY"));
  assert.ok(spawned[0]?.scrubInheritedEnv?.includes("GOOGLE_CLOUD_PROJECT"));
  assert.equal(spawned[0]?.env?.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
  assert.equal(killed, 2);
  assert.equal(finished, 2);
});

test("probeAntigravitySubscriptionUsage preserves model quotas when /credits fails", async () => {
  const result = await probeAntigravitySubscriptionUsage({
    command: "/managed/agy",
    cwd: "/safe/probe",
    context: antigravityCredentialContext(),
    timeoutMs: 2_000,
    now: () => NOW,
    deps: {
      spawn: (opts) => fakeProcess((child, stdout, stderr) => {
        if (opts.args.includes("/usage")) {
          stdout.write(`${JSON.stringify({ event: "command_result", command: { name: "usage", data: sampleUsageData() } })}\n`);
          stdout.end();
          child.emit("close", 0);
        } else {
          stderr.write("temporary credits error\n");
          child.emit("close", 1);
        }
      }),
      kill: () => {},
    },
  });
  assert.equal(result.state, "available");
  assert.equal(result.buckets.length, 4);
  assert.equal(result.credits, undefined);
});

test("probeAntigravitySubscriptionUsage aborts immediately on init event or non-zero turns (never runs a prompt)", async () => {
  let killed = 0;
  const initResult = await probeAntigravitySubscriptionUsage({
    command: "/old/agy",
    cwd: "/safe/probe",
    context: antigravityCredentialContext(),
    timeoutMs: 2_000,
    now: () => NOW,
    deps: {
      spawn: () => fakeProcess((_child, stdout) => {
        // An older CLI that treats /usage as an LLM prompt starts with an `init` event.
        stdout.write(`${JSON.stringify({ event: "init", conversation_id: "c1", init: { cwd: "/safe/probe" } })}\n`);
      }),
      kill: () => { killed += 1; },
    },
  });
  assert.equal(initResult.state, "unsupported");
  assert.equal(killed, 1);

  const turnResult = await probeAntigravitySubscriptionUsage({
    command: "/old/agy",
    cwd: "/safe/probe",
    context: antigravityCredentialContext(),
    timeoutMs: 2_000,
    now: () => NOW,
    deps: {
      spawn: () => fakeProcess((child, stdout) => {
        stdout.write(`${JSON.stringify({ status: "SUCCESS", num_turns: 1, response: "model reply" })}\n`);
        stdout.end();
        child.emit("close", 0);
      }),
      kill: () => {},
    },
  });
  assert.equal(turnResult.state, "unsupported");
});

test("probeAntigravitySubscriptionUsage cancels immediately on OAuth prompt without leaking URLs", async () => {
  let killed = 0;
  const result = await probeAntigravitySubscriptionUsage({
    command: "/managed/agy",
    cwd: "/safe/probe",
    context: antigravityCredentialContext(),
    timeoutMs: 10_000,
    now: () => NOW,
    deps: {
      spawn: () => fakeProcess((_child, stdout) => {
        stdout.write("Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?state=secret\nWaiting for authentication (timeout 60s)...\n");
      }),
      kill: () => { killed += 1; },
    },
  });
  assert.equal(result.state, "unauthenticated");
  assert.equal(killed, 1);
  assert.doesNotMatch(result.detail, /accounts\.google\.com|secret/u);
});

test("probeAntigravitySubscriptionUsage maps Gemini API key exit-2 errors to not_applicable", async () => {
  const result = await probeAntigravitySubscriptionUsage({
    command: "/managed/agy",
    cwd: "/safe/probe",
    context: antigravityCredentialContext(),
    timeoutMs: 2_000,
    now: () => NOW,
    deps: {
      spawn: () => fakeProcess((child, stdout, stderr) => {
        stderr.write("error: /usage failed: not available with a Gemini API key\n");
        stdout.write(`${JSON.stringify({ status: "ERROR", num_turns: 0, error: "/usage failed: not available with a Gemini API key" })}\n`);
        stdout.end();
        child.emit("close", 2);
      }),
      kill: () => {},
    },
  });
  assert.equal(result.state, "not_applicable");
});

test("SubscriptionUsageManager probes Antigravity, gates old CLIs and old control planes, and keeps last-known on failure", async () => {
  let clock = NOW;
  let agent = antigravityAgent();
  let enabled = true;
  let tier: string | undefined = "Google AI Ultra";
  let probeCalls = 0;
  let unauthNotified = 0;
  let mode: "ok" | "fail" | "unauth" = "ok";
  const published: SubscriptionUsageSnapshot[] = [];

  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [agent],
    resolveEnv: () => ({}),
    authorizeProbe: async () => ({ cwd: "/safe/probe" }),
    publish: (snapshot) => published.push(snapshot),
    now: () => clock,
    antigravityEnabled: () => enabled,
    antigravityPlanTier: () => tier,
    acquireAntigravityLaunch: () => ({ command: agent.command, context: antigravityCredentialContext(), release: () => {} }),
    onAntigravityUnauthenticated: () => { unauthNotified += 1; },
    probeAntigravity: async () => {
      probeCalls += 1;
      if (mode === "fail") throw new Error("network down");
      if (mode === "unauth") return { state: "unauthenticated", detail: "Google Antigravity is not signed in." };
      const normalized = normalizeAntigravityUsageData(sampleUsageData(), clock)!;
      assert.equal(normalized.state, "available");
      return { state: "available", buckets: normalized.buckets, credits: { hasCredits: true, balance: "3000" } };
    },
  });

  // Older control plane: Antigravity snapshots are withheld completely.
  enabled = false;
  assert.deepEqual(manager.syncSources(), []);

  // Supported control plane + ready v1.5.14 CLI.
  enabled = true;
  const sourceId = subscriptionUsageSourceId("runner-1", ANTIGRAVITY_AGENT_ID, "antigravity", { kind: "native" });
  const initial = manager.syncSources();
  assert.equal(initial.length, 1);
  assert.equal(initial[0]?.sourceId, sourceId);
  assert.equal(initial[0]?.provider, "antigravity");
  assert.equal(initial[0]?.plan, "Google AI Ultra");

  // Identity read returns undefined (Antigravity does not expose a non-interactive account ID yet).
  assert.equal(await readSubscriptionIdentity({
    agent,
    provider: "antigravity",
    env: {},
    authorize: async () => ({ cwd: "/safe/probe" }),
    processes: { kill: () => {} },
  }), undefined);

  // Source-targeted refresh populates buckets, plan, and credits.
  const refreshed = await manager.refreshSourceById(sourceId);
  assert.equal(probeCalls, 1);
  assert.equal(refreshed[0]?.state, "available");
  assert.equal(refreshed[0]?.plan, "Google AI Ultra");
  assert.equal(refreshed[0]?.buckets.length, 4);
  assert.deepEqual(refreshed[0]?.credits, { hasCredits: true, balance: "3000" });

  // Dedupe prevents immediate repeat probes.
  await manager.refreshSourceById(sourceId);
  assert.equal(probeCalls, 1);

  // Transient failure after dedupe window retains last-known quota windows.
  clock += SUBSCRIPTION_USAGE_REFRESH_DEDUPE_MS + 1;
  mode = "fail";
  const afterFail = await manager.refreshAll();
  assert.equal(probeCalls, 2);
  assert.equal(afterFail[0]?.state, "available");
  assert.equal(afterFail[0]?.buckets.length, 4);
  assert.match(afterFail[0]?.detail ?? "", /last provider snapshot/);

  // Probe detecting expired sign-in notifies setup and transitions to unauthenticated.
  clock += SUBSCRIPTION_USAGE_REFRESH_DEDUPE_MS + 1;
  mode = "unauth";
  const afterUnauth = await manager.refreshAntigravitySources();
  assert.equal(afterUnauth[0]?.state, "unauthenticated");
  assert.equal(unauthNotified, 1);

  // Older CLI (< 1.1.11) reports unsupported without probing.
  agent = antigravityAgent({ version: "1.1.10" });
  const oldCli = manager.syncSources();
  assert.equal(oldCli[0]?.state, "unsupported");
  clock += SUBSCRIPTION_USAGE_REFRESH_DEDUPE_MS + 1;
  mode = "ok";
  await manager.refreshAll();
  assert.equal(probeCalls, 3, "unsupported CLI versions are never probed");

  // Signed-out agent reports unauthenticated (even though available is false).
  agent = antigravityAgent({ version: "1.5.14", available: false, authStatus: "unauthenticated" });
  assert.equal(manager.syncSources()[0]?.state, "unauthenticated");
  assert.ok(published.length > 0);
});
