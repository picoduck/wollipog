import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import type { AgentDefinition, SubscriptionUsageSnapshot } from "@wollipog/protocol";
import {
  ClaudeUsageUnsupportedError,
  CLAUDE_USAGE_PROBE_ARGS,
  normalizeClaudeUsageReply,
  probeClaudeSubscriptionIdentity,
  probeClaudeSubscriptionUsage,
  SUBSCRIPTION_USAGE_REFRESH_DEDUPE_MS,
  SubscriptionUsageManager,
} from "./subscription-usage.js";
import type { AgentProcess, SpawnAgentOptions } from "./spawn.js";

// Reset times are accepted only within two years of the observation clock, so these run on a
// realistic epoch. Claude Code's get_usage reply carries ISO 8601 resets with microseconds.
const NOW = 1_760_000_000_000;
const WEEK_RESET_ISO = "2025-10-14T00:00:00.344173+00:00";
const WEEK_RESET_MS = Date.parse("2025-10-14T00:00:00Z");
const FIVE_HOUR_RESET_ISO = "2025-10-09T13:00:00.42+00:00";
const FIVE_HOUR_RESET_MS = Date.parse("2025-10-09T13:00:00Z");

function claudeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    args: ["--flag"],
    env: {},
    driver: "claude-code",
    context: { kind: "native" },
    available: true,
    claudeCode: {
      status: "ready",
      effortLevels: [],
      permissionModes: [],
      streamJsonInput: true,
      streamJsonImages: true,
      controlProtocol: true,
      forkSession: true,
      replayUserMessages: true,
      sessionNaming: true,
      auth: { status: "authenticated", billingSource: "subscription", subscriptionType: "max" },
    },
    ...overrides,
  };
}

/** The shape Claude Code 2.1.318 answered with, trimmed, including fields Wollipog must ignore. */
function usageReply(rateLimits: Record<string, unknown> | null = {
  five_hour: null,
  seven_day: { utilization: 86, resets_at: WEEK_RESET_ISO, limit_dollars: null },
  seven_day_opus: { utilization: 12, resets_at: WEEK_RESET_ISO },
  seven_day_sonnet: null,
  tangelo: { utilization: 50, resets_at: WEEK_RESET_ISO },
  model_scoped: [{ display_name: "Fable", utilization: 3, resets_at: WEEK_RESET_ISO }],
  extra_usage: {
    is_enabled: true, monthly_limit: 7500, used_credits: 1234, utilization: 16.45, currency: "USD",
    decimal_places: 2, spend_limit_reached: false,
  },
  limits: [{ kind: "weekly", group: "all", severity: "normal", is_active: true }],
  seven_day_breakdown: { rows: [] },
}, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: rateLimits,
    behaviors: null,
    ...overrides,
  };
}

test("a get_usage reply becomes the windows sessions report, with extra usage as a spend control", () => {
  const reading = normalizeClaudeUsageReply(usageReply(), NOW);
  assert.ok(reading && reading.state === "available");
  assert.equal(reading.plan, "max");
  assert.deepEqual(reading.buckets, [
    { id: "seven_day", label: "Weekly — All Models", usedPercent: 86, remainingPercent: 14, resetsAt: WEEK_RESET_MS, status: "warning" },
    { id: "seven_day_opus", label: "Weekly — Opus", usedPercent: 12, remainingPercent: 88, resetsAt: WEEK_RESET_MS, status: "available" },
    { id: "seven_day_fable", label: "Weekly — Fable", usedPercent: 3, remainingPercent: 97, resetsAt: WEEK_RESET_MS, status: "available" },
  ], "reset times round to the second, so session events for the same window still compare equal");
  assert.deepEqual(reading.cleared.sort(), ["five_hour", "seven_day_sonnet"],
    "a window the reply names with no reading holds nothing now");
  assert.ok(!reading.buckets.some((bucket) => bucket.id === "tangelo"), "unrecognized keys are not shown as windows");
  assert.deepEqual(reading.spendControls, [{
    id: "extra_usage", label: "Extra Usage", used: "$12.34", limit: "$75.00", remainingPercent: 83.55, reached: false,
  }]);
});

test("a reset reported just before its boundary rounds to the second sessions report", () => {
  // Claude Code 2.1.318 reported one weekly reset as 00:00:00.344 and, a minute later, 23:59:59.99.
  const reading = normalizeClaudeUsageReply(usageReply({
    seven_day: { utilization: 86, resets_at: "2025-10-13T23:59:59.991+00:00" },
  }), NOW);
  assert.ok(reading && reading.state === "available");
  assert.equal(reading.buckets[0]?.resetsAt, WEEK_RESET_MS);
});

test("a full window is exhausted, and extra usage that is switched off is not a spend control", () => {
  const reading = normalizeClaudeUsageReply(usageReply({
    five_hour: { utilization: 100, resets_at: FIVE_HOUR_RESET_ISO },
    extra_usage: { is_enabled: false, monthly_limit: 7500, used_credits: 0, utilization: 0, currency: "USD" },
  }), NOW);
  assert.ok(reading && reading.state === "available");
  assert.deepEqual(reading.buckets, [
    { id: "five_hour", label: "Five-Hour Window", usedPercent: 100, remainingPercent: 0, resetsAt: FIVE_HOUR_RESET_MS, status: "exhausted" },
  ]);
  assert.deepEqual(reading.spendControls, []);
});

test("a sign-in without plan limits is not applicable, and a reply without readings is no reading", () => {
  assert.deepEqual(normalizeClaudeUsageReply(usageReply(null, { rate_limits_available: false, subscription_type: null }), NOW),
    { state: "not_applicable", buckets: [], cleared: [], spendControls: [] });
  assert.equal(normalizeClaudeUsageReply(usageReply(null), NOW), null, "the usage service did not answer");
  assert.equal(normalizeClaudeUsageReply("not an object", NOW), null);
});

function fakeClaude(reply: (request: Record<string, unknown>) => unknown) {
  const child = new EventEmitter() as unknown as AgentProcess;
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  Object.assign(child, { stdout, stderr: new PassThrough(), stdin });
  const written: Record<string, unknown>[] = [];
  let buffer = "";
  stdin.on("data", (chunk) => {
    buffer += String(chunk);
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      buffer = buffer.slice(newline + 1);
      written.push(message);
      const answer = reply(message);
      if (answer === "exit") {
        stdout.end();
        (child as unknown as EventEmitter).emit("close", 1);
        continue;
      }
      // Hook noise arrives before the reply on a real CLI.
      stdout.write(`${JSON.stringify({ type: "system", subtype: "init" })}\n`);
      stdout.write(`${JSON.stringify({ type: "control_response", response: answer })}\n`);
    }
  });
  return { child, written };
}

async function runProbe(reply: (request: Record<string, unknown>) => unknown) {
  const { child, written } = fakeClaude(reply);
  const spawned: SpawnAgentOptions[] = [];
  let killed = 0;
  let finished = 0;
  const result = probeClaudeSubscriptionUsage(
    claudeAgent(),
    { CLAUDE_CONFIG_DIR: "/accounts/personal" },
    { cwd: "/safe/subscription-probe" },
    {
      spawn: (options) => { spawned.push(options); return child; },
      kill: () => { killed += 1; },
      onSpawn: () => {},
      onFinish: () => { finished += 1; },
    },
    2_000,
  );
  return { result, spawned, written, reaped: () => ({ killed, finished }) };
}

test("the Claude usage probe sends only get_usage to a locked-down Claude Code and reaps it", async () => {
  const body = usageReply();
  const probe = await runProbe((request) => ({
    subtype: "success",
    request_id: request.request_id,
    response: body,
  }));
  assert.deepEqual(await probe.result, body);
  assert.deepEqual(probe.spawned[0]?.args, ["--flag", ...CLAUDE_USAGE_PROBE_ARGS]);
  assert.equal(probe.spawned[0]?.cwd, "/safe/subscription-probe");
  assert.equal(probe.spawned[0]?.env?.CLAUDE_CONFIG_DIR, "/accounts/personal");
  for (const flag of ["-p", "--setting-sources", "--strict-mcp-config", "--no-session-persistence", "--tools", "--safe-mode"]) {
    assert.ok(CLAUDE_USAGE_PROBE_ARGS.includes(flag), `${flag} keeps the probe away from hooks, tools and transcripts`);
  }
  assert.equal(probe.written.length, 1, "one message, and never a user message, so no turn can start");
  assert.deepEqual(probe.written[0]?.request, { subtype: "get_usage", skip_behaviors: true });
  assert.equal(probe.written[0]?.type, "control_request");
  assert.deepEqual(probe.reaped(), { killed: 1, finished: 1 });
});

test("an older Claude Code that refuses get_usage is told apart from a failed read", async () => {
  const unsupported = await runProbe((request) => ({
    subtype: "error",
    request_id: request.request_id,
    error: "Unsupported control request subtype: get_usage",
  }));
  await assert.rejects(unsupported.result, ClaudeUsageUnsupportedError);
  assert.deepEqual(unsupported.reaped(), { killed: 1, finished: 1 });

  const failed = await runProbe((request) => ({ subtype: "error", request_id: request.request_id, error: "usage endpoint 500" }));
  await assert.rejects(failed.result, (error) => !(error instanceof ClaudeUsageUnsupportedError) && /usage endpoint 500/.test(String(error)));

  const exited = await runProbe(() => "exit");
  await assert.rejects(exited.result, /exited before/);
  assert.deepEqual(exited.reaped(), { killed: 1, finished: 1 });
});

test("a Claude Code that closed its input rejects the probe instead of crashing the runner", async () => {
  const child = new EventEmitter() as unknown as AgentProcess;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      },
    }),
  });
  let killed = 0;
  await assert.rejects(probeClaudeSubscriptionUsage(
    claudeAgent(),
    {},
    { cwd: "/safe/subscription-probe" },
    { spawn: () => child, kill: () => { killed += 1; } },
    2_000,
  ), /EPIPE/);
  assert.equal(killed, 1);
});

test("the Claude identity probe survives a status command that closed its input", async () => {
  const child = new EventEmitter() as unknown as AgentProcess;
  const stdout = new PassThrough();
  Object.assign(child, {
    stdout,
    stderr: new PassThrough(),
    stdin: new Writable({
      final(callback) {
        callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      },
    }),
  });
  const identity = probeClaudeSubscriptionIdentity(
    claudeAgent(),
    {},
    { cwd: "/safe/subscription-probe" },
    { spawn: () => child, kill: () => {} },
    2_000,
  );
  stdout.once("end", () => (child as unknown as EventEmitter).emit("close", 0));
  stdout.end(JSON.stringify({
    loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "p@example.test", orgId: "org-1",
  }));
  assert.equal(await identity, JSON.stringify(["claude", "p@example.test", "org-1"]),
    "the status it printed still decides");
});

interface ManagerOptions {
  agent?: AgentDefinition;
  probe?: (env: Record<string, string>) => Promise<unknown>;
  enabled?: () => boolean;
  identity?: () => Promise<string | undefined>;
  order?: string[];
  providerAccount?: boolean;
}

function manager(options: ManagerOptions = {}) {
  let now = NOW;
  const published: SubscriptionUsageSnapshot[] = [];
  let probes = 0;
  const instance = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [options.agent ?? claudeAgent()],
    ...(options.providerAccount
      ? { providerAccounts: () => [{ id: "personal", label: "Personal", provider: "claude" as const, authStatus: "authenticated" as const }] }
      : {}),
    resolveEnv: (_agentId, _driver, _context, accountId) => (accountId ? { CLAUDE_CONFIG_DIR: `/accounts/${accountId}` } : {}) as Record<string, string>,
    authorizeProbe: () => ({ cwd: "/safe/subscription-probe" }),
    publish: (snapshot) => published.push(snapshot),
    now: () => now,
    ...(options.enabled ? { claudeRefreshEnabled: options.enabled } : {}),
    ...(options.identity ? { resolveSubscriptionIdentity: async () => {
      options.order?.push("identity");
      return options.identity!();
    } } : {}),
    probeClaude: async (_agent, env) => {
      probes += 1;
      options.order?.push("probe");
      return (options.probe ?? (async () => usageReply()))(env);
    },
  });
  instance.syncSources();
  return {
    instance,
    published,
    probes: () => probes,
    advance: (ms: number) => { now += ms; },
    snapshot: () => instance.inventory()[0]!,
    observe: (unifiedWindows: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      instance.observe("claude", "claude-code", { kind: "native" }, {
        provider: "claude",
        kind: "sparse",
        payload: { type: "rate_limit_event", rate_limit_info: { unifiedWindows, ...extra }, uuid: "u", session_id: "s" },
      }),
  };
}

const window = (snapshot: SubscriptionUsageSnapshot, id: string) => snapshot.buckets.find((bucket) => bucket.id === id);

test("Refresh All reads Claude usage on request, and that reading is current whatever it says", async () => {
  const usage = manager();
  // A session reported this week at 95% and a five-hour window; the read is lower and names no five-hour window.
  usage.observe({
    seven_day: { utilization: 0.95, resetsAt: WEEK_RESET_MS / 1000 },
    five_hour: { utilization: 0.4, resetsAt: FIVE_HOUR_RESET_MS / 1000 },
    seven_day_overage_included: { utilization: 0.3, resetsAt: WEEK_RESET_MS / 1000 },
  });
  usage.advance(1_000);
  await usage.instance.refreshAll();
  assert.equal(usage.probes(), 1);
  const snapshot = usage.snapshot();
  assert.equal(snapshot.state, "available");
  assert.equal(snapshot.plan, "max");
  assert.equal(window(snapshot, "seven_day")?.usedPercent, 86, "a lower authoritative reading applies at once, with no confirmation");
  assert.equal(window(snapshot, "seven_day")?.observedAt, NOW + 1_000);
  assert.equal(window(snapshot, "five_hour"), undefined, "the reply said the five-hour window holds nothing");
  assert.equal(window(snapshot, "seven_day_overage_included")?.usedPercent, 30, "a window only sessions report is kept");
  assert.equal(window(snapshot, "seven_day_fable")?.usedPercent, 3);
  assert.equal(snapshot.spendControls?.[0]?.id, "extra_usage");
  assert.equal(snapshot.detail, undefined);
  assert.deepEqual(usage.published.at(-1)?.buckets, snapshot.buckets, "the reading was published");

  // The next session event for the same window still applies: its whole-second reset matches.
  usage.advance(1_000);
  usage.observe({ seven_day: { utilization: 0.9, resetsAt: WEEK_RESET_MS / 1000 } });
  assert.equal(window(usage.snapshot(), "seven_day")?.usedPercent, 90);
});

test("repeated Claude refreshes inside the dedupe window probe once", async () => {
  const usage = manager();
  await usage.instance.refreshAll();
  await usage.instance.refreshAll();
  assert.equal(usage.probes(), 1);
  usage.advance(SUBSCRIPTION_USAGE_REFRESH_DEDUPE_MS);
  await usage.instance.refreshAll();
  assert.equal(usage.probes(), 2);
});

test("a Claude account's Refresh Account reads its own credential home, after its identity", async () => {
  const homes: string[] = [];
  const order: string[] = [];
  const usage = manager({
    providerAccount: true,
    order,
    identity: async () => JSON.stringify(["claude", "person@example.test", "org-1"]),
    probe: async (env) => { homes.push(env.CLAUDE_CONFIG_DIR ?? ""); return usageReply(); },
  });
  await usage.instance.refreshAccount("personal");
  assert.deepEqual(homes, ["/accounts/personal"]);
  assert.deepEqual(order, ["identity", "probe"], "a changed sign-in clears the old windows before the new ones arrive");
  assert.equal(window(usage.snapshot(), "seven_day")?.usedPercent, 86);
  assert.ok(usage.snapshot().subscriptionIdentity);
});

test("an older Claude Code keeps what sessions reported, and says why when there is nothing", async () => {
  const withEvents = manager({ probe: async () => { throw new ClaudeUsageUnsupportedError(); } });
  withEvents.observe({ seven_day: { utilization: 0.5, resetsAt: WEEK_RESET_MS / 1000 } });
  const before = withEvents.snapshot();
  await withEvents.instance.refreshAll();
  assert.deepEqual(withEvents.snapshot(), before, "nothing is lost or relabelled");

  const empty = manager({ probe: async () => { throw new ClaudeUsageUnsupportedError(); } });
  await empty.instance.refreshAll();
  assert.equal(empty.snapshot().state, "unavailable");
  assert.match(empty.snapshot().detail ?? "", /can't report usage on request/);
});

test("a failed Claude read keeps the last reading and says so", async () => {
  let fail = false;
  const usage = manager({ probe: async () => { if (fail) throw new Error("timed out"); return usageReply(); } });
  await usage.instance.refreshAll();
  fail = true;
  usage.advance(SUBSCRIPTION_USAGE_REFRESH_DEDUPE_MS);
  await usage.instance.refreshAll();
  assert.equal(window(usage.snapshot(), "seven_day")?.usedPercent, 86);
  assert.match(usage.snapshot().detail ?? "", /latest Claude refresh failed/);

  const never = manager({ probe: async () => { throw new Error("timed out"); } });
  await never.instance.refreshAll();
  assert.equal(never.snapshot().state, "unavailable");
  assert.match(never.snapshot().detail ?? "", /could not be refreshed/);

  const silent = manager({ probe: async () => usageReply(null) });
  await silent.instance.refreshAll();
  assert.equal(silent.snapshot().state, "unavailable", "a reply with no readings is not a reading");
});

test("a sign-in without plan limits reads as not applicable", async () => {
  const usage = manager({ probe: async () => usageReply(null, { rate_limits_available: false, subscription_type: null }) });
  await usage.instance.refreshAll();
  assert.equal(usage.snapshot().state, "not_applicable");
  assert.equal(usage.snapshot().buckets.length, 0);
});

test("Claude is probed only where the CLI can be locked down and the control plane expects it", async () => {
  const { sessionNaming: _naming, ...withoutLockdown } = claudeAgent().claudeCode!;
  const old = manager({ agent: claudeAgent({ claudeCode: withoutLockdown }) });
  await old.instance.refreshAll();
  assert.equal(old.probes(), 0, "an installation without the lockdown flags keeps reporting from sessions");

  const noControl = manager({ agent: claudeAgent({ claudeCode: { ...claudeAgent().claudeCode!, controlProtocol: false } }) });
  await noControl.instance.refreshAll();
  assert.equal(noControl.probes(), 0);

  const oldPlane = manager({ enabled: () => false });
  await oldPlane.instance.refreshAll();
  assert.equal(oldPlane.probes(), 0, "an older control plane's refresh deadline does not count Claude");

  const unavailable = manager({ agent: claudeAgent({ available: false }) });
  await unavailable.instance.refreshAll();
  assert.equal(unavailable.probes(), 0);
});

test("a selection change while a Claude probe waits for authorization keeps the old harness from starting", async () => {
  let grant: (authorization: { cwd: string; settle: (children: readonly AgentProcess[]) => Promise<void> }) => void = () => {};
  let authorizing = false;
  const settled: Array<readonly AgentProcess[]> = [];
  let probes = 0;
  const instance = new SubscriptionUsageManager({
    runnerId: "runner-1",
    agents: () => [claudeAgent()],
    resolveEnv: () => ({}),
    publish: () => {},
    now: () => NOW,
    authorizeProbe: () => new Promise((resolve) => { authorizing = true; grant = resolve; }),
    probeClaude: async () => { probes += 1; return usageReply(); },
  });
  instance.syncSources();
  const pending = instance.refreshAll();
  while (!authorizing) await new Promise((resolve) => setImmediate(resolve));
  instance.selectionChanged();
  grant({ cwd: "/safe/subscription-probe", settle: async (children) => { settled.push(children); } });
  await pending;
  assert.equal(probes, 0);
  assert.deepEqual(settled, [[]]);
});
