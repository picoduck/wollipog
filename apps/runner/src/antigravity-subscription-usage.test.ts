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

test("probeAntigravitySubscriptionUsage preserves model quotas when /credits fails transiently", async () => {
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
          stdout.write(`${JSON.stringify({ event: "result", result: { status: "SUCCESS", num_turns: 0 } })}\n`);
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

test("probeAntigravitySubscriptionUsage requires a successful zero-turn terminal result and exit 0", async () => {
  const cases: Array<{ name: string; emit: (child: EventEmitter, stdout: PassThrough) => void }> = [
    {
      name: "missing terminal result frame",
      emit: (child, stdout) => {
        stdout.write(`${JSON.stringify({ event: "command_result", command: { name: "usage", data: sampleUsageData() } })}\n`);
        stdout.end();
        child.emit("close", 0);
      },
    },
    {
      name: "terminal ERROR frame after command_result",
      emit: (child, stdout) => {
        stdout.write(`${JSON.stringify({ event: "command_result", command: { name: "usage", data: sampleUsageData() } })}\n`);
        stdout.write(`${JSON.stringify({ event: "result", result: { status: "ERROR", num_turns: 0, error: "backend interrupted" } })}\n`);
        stdout.end();
        child.emit("close", 0);
      },
    },
    {
      name: "nonzero exit code after SUCCESS frame",
      emit: (child, stdout) => {
        stdout.write(`${JSON.stringify({ event: "command_result", command: { name: "usage", data: sampleUsageData() } })}\n`);
        stdout.write(`${JSON.stringify({ event: "result", result: { status: "SUCCESS", num_turns: 0 } })}\n`);
        stdout.end();
        child.emit("close", 1);
      },
    },
    {
      name: "terminal SUCCESS missing num_turns",
      emit: (child, stdout) => {
        stdout.write(`${JSON.stringify({ event: "command_result", command: { name: "usage", data: sampleUsageData() } })}\n`);
        stdout.write(`${JSON.stringify({ event: "result", result: { status: "SUCCESS" } })}\n`);
        stdout.end();
        child.emit("close", 0);
      },
    },
  ];
  for (const tc of cases) {
    await assert.rejects(
      () => probeAntigravitySubscriptionUsage({
        command: "/managed/agy",
        cwd: "/safe/probe",
        context: antigravityCredentialContext(),
        timeoutMs: 2_000,
        now: () => NOW,
        deps: {
          spawn: () => fakeProcess((child, stdout) => tc.emit(child, stdout)),
          kill: () => {},
        },
      }),
      /zero-turn result/,
      tc.name,
    );
  }
});

test("probeAntigravitySubscriptionUsage propagates unsupported and unauthenticated results from /credits", async () => {
  const runCreditsCase = async (emitCredits: (child: EventEmitter, stdout: PassThrough) => void) => {
    let killed = 0;
    const result = await probeAntigravitySubscriptionUsage({
      command: "/managed/agy",
      cwd: "/safe/probe",
      context: antigravityCredentialContext(),
      timeoutMs: 2_000,
      now: () => NOW,
      deps: {
        spawn: (opts) => fakeProcess((child, stdout) => {
          if (opts.args.includes("/usage")) {
            stdout.write(`${JSON.stringify({ event: "command_result", command: { name: "usage", data: sampleUsageData() } })}\n`);
            stdout.write(`${JSON.stringify({ event: "result", result: { status: "SUCCESS", num_turns: 0 } })}\n`);
            stdout.end();
            child.emit("close", 0);
          } else {
            emitCredits(child, stdout);
          }
        }),
        kill: () => { killed += 1; },
      },
    });
    return { result, killed };
  };

  const initCase = await runCreditsCase((_child, stdout) => {
    stdout.write(`${JSON.stringify({ event: "init", conversation_id: "c1" })}\n`);
  });
  assert.equal(initCase.result.state, "unsupported");
  assert.equal(initCase.killed, 2);

  const turnsCase = await runCreditsCase((child, stdout) => {
    stdout.write(`${JSON.stringify({ event: "result", result: { status: "SUCCESS", num_turns: 1 } })}\n`);
    stdout.end();
    child.emit("close", 0);
  });
  assert.equal(turnsCase.result.state, "unsupported");
  assert.equal(turnsCase.killed, 2);

  const authCase = await runCreditsCase((_child, stdout) => {
    stdout.write("Authentication required. Please visit the URL to log in:\nhttps://accounts.google.com/o/oauth2/auth\n");
  });
  assert.equal(authCase.result.state, "unauthenticated");
  assert.equal(authCase.killed, 2);
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
    acquireAntigravityLaunch: () => ({ command: agent.command, version: agent.version, context: antigravityCredentialContext(), release: () => {} }),
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

test("SubscriptionUsageManager enforces the CLI version floor on the acquired executable (never probes an old committed generation)", async () => {
  let agent = antigravityAgent({ version: "1.5.14", command: "/managed/current/agy" });
  let committed: { command: string; version: string } = { command: "/managed/generations/g1/agy", version: "1.1.10" };
  const probedCommands: string[] = [];

  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [agent],
    resolveEnv: () => ({}),
    authorizeProbe: async () => ({ cwd: "/safe/probe" }),
    publish: () => {},
    now: () => NOW,
    antigravityEnabled: () => true,
    antigravityLaunchTarget: () => committed,
    acquireAntigravityLaunch: () => ({
      command: committed.command,
      version: committed.version,
      context: antigravityCredentialContext({}, { managed: true }),
      release: () => {},
    }),
    probeAntigravity: async (opts) => {
      probedCommands.push(opts.command);
      const normalized = normalizeAntigravityUsageData(sampleUsageData(), NOW)!;
      assert.equal(normalized.state, "available");
      return { state: "available", buckets: normalized.buckets };
    },
  });

  // Activation confirmation is still pending: catalog advertises 1.5.14 while committed ledger holds 1.1.10.
  manager.syncSources();
  await manager.refreshAntigravitySources();
  assert.deepEqual(probedCommands, [], "must never send /usage to an old committed generation");

  // Once activation commits, the supported generation is probed immediately without hitting dedupe.
  committed = { command: "/managed/generations/g2/agy", version: "1.5.14" };
  manager.syncSources();
  const afterCommit = await manager.refreshAntigravitySources();
  assert.deepEqual(probedCommands, ["/managed/generations/g2/agy"]);
  assert.equal(afterCommit[0]?.state, "available");
  assert.equal(afterCommit[0]?.buckets.length, 4);
});

test("SubscriptionUsageManager discards in-flight Antigravity probe results superseded by sign-out or executable change", async () => {
  let agent = antigravityAgent({ version: "1.5.14", command: "/managed/current/agy" });
  let committed = { command: "/managed/generations/g1/agy", version: "1.5.14" };
  const published: SubscriptionUsageSnapshot[] = [];
  let releaseProbe!: () => void;

  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [agent],
    resolveEnv: () => ({}),
    authorizeProbe: async () => ({ cwd: "/safe/probe" }),
    publish: (snapshot) => published.push(snapshot),
    now: () => NOW,
    antigravityEnabled: () => true,
    antigravityLaunchTarget: () => committed,
    acquireAntigravityLaunch: () => ({
      command: committed.command,
      version: committed.version,
      context: antigravityCredentialContext({}, { managed: true }),
      release: () => {},
    }),
    probeAntigravity: async () => {
      await new Promise<void>((resolve) => { releaseProbe = resolve; });
      const normalized = normalizeAntigravityUsageData(sampleUsageData(), NOW)!;
      assert.equal(normalized.state, "available");
      return { state: "available", buckets: normalized.buckets, credits: { hasCredits: true, balance: "3000" } };
    },
  });

  manager.syncSources();
  const inFlight = manager.refreshAntigravitySources();
  await Promise.resolve();
  await Promise.resolve();

  // Sign-out occurs while the probe is paused in flight.
  agent = antigravityAgent({ version: "1.5.14", available: false, authStatus: "unauthenticated" });
  const signedOut = manager.syncSources();
  assert.equal(signedOut[0]?.state, "unauthenticated");

  // Resolving the stale probe must not overwrite the signed-out state or publish available quotas.
  releaseProbe();
  await inFlight;
  assert.equal(manager.inventory()[0]?.state, "unauthenticated");
  assert.equal(published.length, 0);

  // Also test executable change superseding an in-flight probe.
  agent = antigravityAgent({ version: "1.5.14", available: true, authStatus: "authenticated" });
  manager.syncSources();
  const secondInFlight = manager.refreshAntigravitySources();
  await Promise.resolve();
  await Promise.resolve();

  committed = { command: "/managed/generations/g2/agy", version: "1.5.15" };
  agent = antigravityAgent({ version: "1.5.15", available: true, authStatus: "authenticated" });
  manager.syncSources();
  releaseProbe();
  await secondInFlight;
  assert.equal(published.length, 0, "probe from superseded executable generation must not publish");
});

test("SubscriptionUsageManager shares an active Antigravity probe across entry points before and after the dedupe window", async () => {
  let clock = NOW;
  const agent = antigravityAgent();
  const sourceId = subscriptionUsageSourceId("runner-1", ANTIGRAVITY_AGENT_ID, "antigravity", { kind: "native" });
  let probeCalls = 0;
  let releaseProbe!: () => void;

  const manager = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [agent],
    resolveEnv: () => ({}),
    authorizeProbe: async () => ({ cwd: "/safe/probe" }),
    publish: () => {},
    now: () => clock,
    antigravityEnabled: () => true,
    acquireAntigravityLaunch: () => ({
      command: agent.command,
      version: agent.version,
      context: antigravityCredentialContext(),
      release: () => {},
    }),
    probeAntigravity: async () => {
      probeCalls += 1;
      await new Promise<void>((resolve) => { releaseProbe = resolve; });
      const normalized = normalizeAntigravityUsageData(sampleUsageData(), clock)!;
      assert.equal(normalized.state, "available");
      return { state: "available", buckets: normalized.buckets, credits: { hasCredits: true, balance: "1200" } };
    },
  });

  manager.syncSources();
  const autoRefresh = manager.refreshAntigravitySources();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(probeCalls, 1);

  // Before the dedupe window expires, Refresh Account joins the in-flight probe instead of returning stale data.
  let earlyDone = false;
  const earlyRefresh = manager.refreshSourceById(sourceId).then((res) => {
    earlyDone = true;
    return res;
  });
  await Promise.resolve();
  assert.equal(earlyDone, false, "must wait for the active probe instead of returning stale data immediately");

  // After the dedupe window expires while the probe is still running, Refresh Account still shares the active probe.
  clock += SUBSCRIPTION_USAGE_REFRESH_DEDUPE_MS + 5_000;
  const lateRefresh = manager.refreshSourceById(sourceId);
  await Promise.resolve();
  assert.equal(probeCalls, 1, "must not launch a second overlapping probe while the first is in flight");

  releaseProbe();
  const [autoResult, earlyResult, lateResult] = await Promise.all([autoRefresh, earlyRefresh, lateRefresh]);
  assert.equal(probeCalls, 1);
  for (const res of [autoResult, earlyResult, lateResult]) {
    assert.equal(res[0]?.state, "available");
    assert.equal(res[0]?.buckets.length, 4);
    assert.deepEqual(res[0]?.credits, { hasCredits: true, balance: "1200" });
  }
});
