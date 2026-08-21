import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import type { SessionEventPayload } from "@wollipog/protocol";
import {
  claudeHookCircuitPath,
  claudeHookTokenPath,
  writeClaudeHookSettings,
  writeHookCircuitState,
} from "../hook-settings.js";
import {
  approvalScopeContext,
  buildClaudeUserMessage,
  CLAUDE_GRACEFUL_STOP_BUDGET_MS,
  CLAUDE_PENDING_MAX_MS,
  CLAUDE_PERSISTENT_FLAG,
  CLAUDE_PERSISTENT_IDLE_MS,
  ClaudeCodeDriver,
  claudeCapabilityError,
  claudePermissionArgs,
  claudePersistentSettings,
  claudePersistentSettingsForAgent,
  createPersistentSettingWarningEmitter,
  LEGACY_CLAUDE_PENDING_MAX_MS,
  LEGACY_CLAUDE_PERSISTENT_FLAG,
  LEGACY_CLAUDE_PERSISTENT_IDLE_MS,
  normalizeQuestions,
  renderApprovalInput,
  warnLegacyClaudeLifetimeEnvironment,
} from "./claude-code.js";
import type { DriverCallbacks, DriverOptions } from "./driver.js";

/**
 * Unit tests for the claude stream-json -> SessionEventPayload mapping.
 * These exercise the private `handleEvent(msg)` mapper directly, with NO process
 * spawn: we construct the driver with a minimal DriverOptions and a fake
 * DriverCallbacks that records every emitted event.
 */

interface Harness {
  driver: ClaudeCodeDriver;
  events: SessionEventPayload[];
  stderr: string[];
  resolvedModels: string[];
  authenticationFailures: number;
  subscriptionUsage: unknown[];
  /** Invoke the private mapper and return its StopReason | null. */
  feed: (msg: unknown) => unknown;
}

function makeHarness(): Harness {
  const events: SessionEventPayload[] = [];
  const stderr: string[] = [];
  const resolvedModels: string[] = [];
  let authenticationFailures = 0;
  const subscriptionUsage: unknown[] = [];
  const cb: DriverCallbacks = {
    onEvent: (payload) => events.push(payload),
    onStderr: (text) => stderr.push(text),
    onModelResolved: (model) => resolvedModels.push(model),
    onAuthenticationFailure: () => { authenticationFailures += 1; },
    onSubscriptionUsage: (update) => subscriptionUsage.push(update),
    onExit: () => {},
  };
  const opts: DriverOptions = {
    command: "claude",
    args: [],
    cwd: "/tmp/work",
    env: {},
    // Only the fields the mapper might touch matter; cast keeps the test minimal.
    config: {} as DriverOptions["config"],
    context: {} as DriverOptions["context"],
  };
  const driver = new ClaudeCodeDriver(opts, cb);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feed = (msg: unknown) => (driver as any).handleEvent(msg);
  return {
    driver,
    events,
    stderr,
    resolvedModels,
    get authenticationFailures() { return authenticationFailures; },
    subscriptionUsage,
    feed,
  };
}

test("Claude rate-limit events forward during and between turns without transcript or stderr noise", () => {
  const h = makeHarness();
  const active = { type: "rate_limit_event", rate_limit_info: { rate_limit_type: "five_hour", resets_at: 2_000_000_000 } };
  assert.equal(h.feed(active), null);
  (h.driver as any).processPersistentLine(JSON.stringify({
    type: "rate_limit_event",
    rate_limits: { seven_day: { used_percentage: 45 } },
  }));
  assert.equal(h.subscriptionUsage.length, 2);
  assert.deepEqual(h.subscriptionUsage[0], { provider: "claude", kind: "sparse", payload: active });
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.stderr, []);
});

const baseOpts: DriverOptions = {
  command: "claude",
  args: [],
  cwd: "/tmp/work",
  env: {},
  config: {} as DriverOptions["config"],
  context: {} as DriverOptions["context"],
};
const noopCb: DriverCallbacks = { onEvent: () => {}, onStderr: () => {}, onExit: () => {} };

function fakeProcess(stdin: Writable = new PassThrough()) {
  const child = new EventEmitter() as any;
  child.pid = 123;
  child.stdin = stdin;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("provider commands are synchronously prepared, driver-bound, and single-use", async () => {
  const first = new ClaudeCodeDriver(baseOpts, noopCb);
  const second = new ClaudeCodeDriver(baseOpts, noopCb);
  const calls: unknown[][] = [];
  first.prompt = async (...args) => {
    calls.push(args);
    return "end_turn";
  };

  const prepared = first.prepareCommand({
    commandName: "review",
    argumentText: "focus on storage",
    executionMode: "passthrough",
  });
  assert.equal(await first.invokeCommand(prepared), "end_turn");
  assert.deepEqual(calls, [["focus on storage", [], "review"]]);
  assert.throws(() => first.invokeCommand(prepared), /not prepared/);
  assert.throws(() => second.invokeCommand(prepared), /not prepared/);
  assert.throws(() => first.prepareCommand({
    commandName: "review",
    argumentText: "",
    executionMode: "structured",
  }), /does not support structured/);
  assert.throws(() => first.prepareCommand({
    commandName: "bad command",
    argumentText: "",
    executionMode: "passthrough",
  }), /invalid.*command name/i);
});

test("auth failures retain a secret-free diagnostic when no structured callback is installed", () => {
  const stderr: string[] = [];
  const driver = new ClaudeCodeDriver(baseOpts, {
    onEvent: () => {},
    onStderr: (text) => stderr.push(text),
    onExit: () => {},
  });
  (driver as any).handleEvent({
    type: "system",
    subtype: "api_retry",
    error: "authentication_failed secret-value",
    attempt: 1,
    max_retries: 5,
  });
  assert.deepEqual(stderr, ["provider authentication is required"]);
  assert.equal(stderr.join(" ").includes("secret-value"), false);
});

test("persistent settings default on, accept zero/unbounded values, and reject footguns loudly", () => {
  assert.equal(CLAUDE_GRACEFUL_STOP_BUDGET_MS, 11_500);
  assert.deepEqual(claudePersistentSettings({}), {
    enabled: true,
    idleMs: 3_600_000,
    pendingMaxMs: 604_800_000,
    warnings: [],
  });
  assert.equal(claudePersistentSettings({ [CLAUDE_PERSISTENT_FLAG]: "0" }).enabled, false);
  assert.deepEqual(
    claudePersistentSettings({
      [CLAUDE_PERSISTENT_FLAG]: "1",
      [CLAUDE_PERSISTENT_IDLE_MS]: "0",
      [CLAUDE_PENDING_MAX_MS]: "0",
    }),
    { enabled: true, idleMs: 0, pendingMaxMs: 0, warnings: [] },
  );
  assert.equal(claudePersistentSettings({ [CLAUDE_PERSISTENT_IDLE_MS]: "999999999999" }).idleMs, 999_999_999_999);
  const rejected = claudePersistentSettings({ [CLAUDE_PERSISTENT_IDLE_MS]: "29999" });
  assert.equal(rejected.idleMs, 3_600_000);
  assert.match(rejected.warnings.join("\n"), /WOLLIPOG_CLAUDE_PERSISTENT_IDLE_MS.*rejected/);
});

test("persistent settings prefer Wollipog names and warn on legacy fallback", () => {
  const preferred = claudePersistentSettings({
    [CLAUDE_PERSISTENT_FLAG]: "0",
    [LEGACY_CLAUDE_PERSISTENT_FLAG]: "1",
    [CLAUDE_PERSISTENT_IDLE_MS]: "30000",
    [LEGACY_CLAUDE_PERSISTENT_IDLE_MS]: "60000",
    [CLAUDE_PENDING_MAX_MS]: "0",
    [LEGACY_CLAUDE_PENDING_MAX_MS]: "30000",
  });
  assert.deepEqual(preferred, { enabled: false, idleMs: 30_000, pendingMaxMs: 0, warnings: [] });

  const legacy = claudePersistentSettings({
    [LEGACY_CLAUDE_PERSISTENT_FLAG]: "0",
    [LEGACY_CLAUDE_PERSISTENT_IDLE_MS]: "30000",
    [LEGACY_CLAUDE_PENDING_MAX_MS]: "0",
  });
  assert.equal(legacy.enabled, false);
  assert.equal(legacy.idleMs, 30_000);
  assert.equal(legacy.pendingMaxMs, 0);
  assert.deepEqual(legacy.warnings, [
    "MAM_CLAUDE_PERSISTENT is deprecated; use WOLLIPOG_CLAUDE_PERSISTENT",
    "MAM_CLAUDE_PERSISTENT_IDLE_MS is deprecated; use WOLLIPOG_CLAUDE_PERSISTENT_IDLE_MS",
    "MAM_CLAUDE_PENDING_MAX_MS is deprecated; use WOLLIPOG_CLAUDE_PENDING_MAX_MS",
  ]);
});

test("per-agent lifetime aliases remain authoritative over daemon defaults", () => {
  const settings = claudePersistentSettingsForAgent(
    {
      [LEGACY_CLAUDE_PERSISTENT_FLAG]: "0",
      [LEGACY_CLAUDE_PERSISTENT_IDLE_MS]: "60000",
      [LEGACY_CLAUDE_PENDING_MAX_MS]: "30000",
    },
    {
      [CLAUDE_PERSISTENT_FLAG]: "1",
      [CLAUDE_PERSISTENT_IDLE_MS]: "3600000",
      [CLAUDE_PENDING_MAX_MS]: "604800000",
    },
  );
  assert.equal(settings.enabled, false);
  assert.equal(settings.idleMs, 60_000);
  assert.equal(settings.pendingMaxMs, 30_000);
  assert.equal(settings.warnings.length, 3, "each selected per-agent legacy alias warns");

  assert.equal(
    claudePersistentSettingsForAgent(
      { [CLAUDE_PERSISTENT_IDLE_MS]: "" },
      { [CLAUDE_PERSISTENT_IDLE_MS]: "120000", [LEGACY_CLAUDE_PERSISTENT_IDLE_MS]: "60000" },
    ).idleMs,
    3_600_000,
    "an explicit empty per-agent current value blocks every daemon fallback and selects the default",
  );
});

test("daemon startup warns once for every selected legacy Claude lifetime alias without values", () => {
  const warnings: string[] = [];
  warnLegacyClaudeLifetimeEnvironment(
    {
      [LEGACY_CLAUDE_PERSISTENT_FLAG]: "do-not-log-persistent",
      [LEGACY_CLAUDE_PERSISTENT_IDLE_MS]: "do-not-log-idle",
      [LEGACY_CLAUDE_PENDING_MAX_MS]: "do-not-log-pending",
    },
    (warning) => warnings.push(warning),
  );

  assert.deepEqual(warnings, [
    "MAM_CLAUDE_PERSISTENT is deprecated; use WOLLIPOG_CLAUDE_PERSISTENT",
    "MAM_CLAUDE_PERSISTENT_IDLE_MS is deprecated; use WOLLIPOG_CLAUDE_PERSISTENT_IDLE_MS",
    "MAM_CLAUDE_PENDING_MAX_MS is deprecated; use WOLLIPOG_CLAUDE_PENDING_MAX_MS",
  ]);
  assert.doesNotMatch(warnings.join("\n"), /do-not-log/);

  const preferredWarnings: string[] = [];
  warnLegacyClaudeLifetimeEnvironment(
    {
      [CLAUDE_PERSISTENT_FLAG]: "",
      [LEGACY_CLAUDE_PERSISTENT_FLAG]: "do-not-log-shadowed",
      [CLAUDE_PERSISTENT_IDLE_MS]: "0",
      [CLAUDE_PENDING_MAX_MS]: "0",
    },
    (warning) => preferredWarnings.push(warning),
  );
  assert.deepEqual(preferredWarnings, [], "explicit current values suppress every legacy fallback warning");

  const emptyLegacyWarnings: string[] = [];
  warnLegacyClaudeLifetimeEnvironment(
    { [LEGACY_CLAUDE_PERSISTENT_IDLE_MS]: "" },
    (warning) => emptyLegacyWarnings.push(warning),
  );
  assert.deepEqual(emptyLegacyWarnings, [
    "MAM_CLAUDE_PERSISTENT_IDLE_MS is deprecated; use WOLLIPOG_CLAUDE_PERSISTENT_IDLE_MS",
  ], "an explicitly empty legacy alias still warns when it supplies the effective value");
});

test("raw Windows process environment retains case-insensitive lifetime lookup", {
  skip: process.platform !== "win32",
}, () => {
  const lowercaseName = CLAUDE_PERSISTENT_FLAG.toLowerCase();
  const previous = process.env[CLAUDE_PERSISTENT_FLAG];
  delete process.env[CLAUDE_PERSISTENT_FLAG];
  process.env[lowercaseName] = "0";
  try {
    assert.equal(claudePersistentSettingsForAgent({}, process.env).enabled, false);
  } finally {
    delete process.env[lowercaseName];
    if (previous === undefined) delete process.env[CLAUDE_PERSISTENT_FLAG];
    else process.env[CLAUDE_PERSISTENT_FLAG] = previous;
  }
});

test("legacy lifetime warnings emit once per process while invalid settings warn per driver", () => {
  const emitPersistentSettingWarnings = createPersistentSettingWarningEmitter();
  const legacyWarnings: string[] = [];
  for (let index = 0; index < 2; index++) {
    new ClaudeCodeDriver(
      {
        ...baseOpts,
        env: {
          [LEGACY_CLAUDE_PERSISTENT_FLAG]: "0",
          [CLAUDE_PERSISTENT_IDLE_MS]: "0",
          [CLAUDE_PENDING_MAX_MS]: "0",
        },
      },
      { ...noopCb, onStderr: (warning) => legacyWarnings.push(warning) },
      { emitPersistentSettingWarnings },
    );
  }
  assert.equal(
    legacyWarnings.filter((warning) => warning.includes(`${LEGACY_CLAUDE_PERSISTENT_FLAG} is deprecated`)).length,
    1,
  );

  const invalidWarnings: string[] = [];
  for (let index = 0; index < 2; index++) {
    new ClaudeCodeDriver(
      {
        ...baseOpts,
        env: {
          [CLAUDE_PERSISTENT_FLAG]: "1",
          [CLAUDE_PERSISTENT_IDLE_MS]: "29999",
          [CLAUDE_PENDING_MAX_MS]: "0",
        },
      },
      { ...noopCb, onStderr: (warning) => invalidWarnings.push(warning) },
      { emitPersistentSettingWarnings },
    );
  }
  assert.equal(invalidWarnings.filter((warning) => warning.includes("was rejected")).length, 2);
});

test("initialize reconciles persisted task seeds before the first recovery turn", async () => {
  const background: Parameters<NonNullable<DriverCallbacks["onBackgroundWork"]>>[0][] = [];
  const driver = new ClaudeCodeDriver(
    {
      ...baseOpts,
      initialBackgroundTaskIds: ["already-done", "still-live"],
      config: { permissionMode: "acceptEdits" },
    },
    { ...noopCb, onBackgroundWork: (update) => background.push(update) },
    {
      inspectBackgroundWork: async (_context: unknown, _cwd: string, _sessionId: string, ids: Iterable<string>) => {
        assert.deepEqual([...ids].sort(), ["already-done", "still-live"]);
        return {
          incompleteArtifacts: [{ id: "still-live", outputFile: "/tmp/still-live.output" }],
          terminalTaskIds: new Set(["already-done"]),
        };
      },
    } as any,
  );

  await driver.initialize();
  assert.equal(background.at(-1)?.state, "running");
  assert.deepEqual(background.at(-1)?.pendingTaskIds, ["still-live"]);
  assert.deepEqual(background.at(-1)?.observedTaskIds, []);
  assert.deepEqual(background.at(-1)?.jobs?.map((job) => job.id), ["still-live"]);
  assert.equal(background.at(-1)?.terminalJobs?.[0]?.id, "already-done");
  assert.equal(background.at(-1)?.terminalJobs?.[0]?.continuationRequired, false);
  driver.dispose();
});

test("graceful persistent shutdown is tracked until the child confirms close", async () => {
  const child = fakeProcess();
  const tracked: Promise<void>[] = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, config: { permissionMode: "acceptEdits" } },
    noopCb,
    {
      spawn: () => child,
      kill: () => {},
      trackKill: (work: Promise<void>) => { tracked.push(work); },
    } as any,
  );
  const turn = driver.prompt("one");
  await nextTask();
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  await turn;

  driver.dispose();
  assert.equal(tracked.length, 1);
  child.emit("close", 0);
  await tracked[0];
});

test("explicit disposal kills a persistent child without the shutdown grace interval", async () => {
  const child = fakeProcess();
  const killed: any[] = [];
  const delays: number[] = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, config: { permissionMode: "acceptEdits" } },
    noopCb,
    {
      spawn: () => child,
      kill: (process: any) => killed.push(process),
      trackKill: () => {},
      setTimer: (_callback: () => void, delay: number) => {
        delays.push(delay);
        return { unref() {} } as any;
      },
      clearTimer: () => {},
    } as any,
  );
  const turn = driver.prompt("stop now");
  await nextTask();
  driver.dispose({ forceImmediate: true });
  assert.equal(await turn, "cancelled");
  assert.deepEqual(killed, [child]);
  assert.deepEqual(delays, [6_500]);
  child.emit("close", 0);
});

test("explicit disposal escalates a transport already inside graceful retirement", async () => {
  const child = fakeProcess();
  const killed: any[] = [];
  const timers: Array<{ callback: () => void; delay: number; active: boolean }> = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, config: { permissionMode: "acceptEdits" } },
    noopCb,
    {
      spawn: () => child,
      kill: (process: any) => killed.push(process),
      trackKill: () => {},
      setTimer: (callback: () => void, delay: number) => {
        const timer = { callback, delay, active: true };
        timers.push(timer);
        return timer as any;
      },
      clearTimer: (timer: { active: boolean }) => { timer.active = false; },
    } as any,
  );
  const turn = driver.prompt("finish then retire");
  await nextTask();
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  assert.equal(await turn, "end_turn");
  void (driver as any).stopPersistentTransport(false, "process_exit");
  assert.equal(killed.length, 0);
  assert.ok(timers.some((timer) => timer.active && timer.delay === 5_000));

  driver.dispose({ forceImmediate: true });
  assert.deepEqual(killed, [child]);
  assert.equal(timers.some((timer) => timer.active && timer.delay === 5_000), false);
  assert.ok(timers.some((timer) => timer.active && timer.delay === 6_500));
  child.emit("close", 0);
});

test("zero idle TTL keeps a quiescent persistent process alive indefinitely", async () => {
  const child = fakeProcess();
  let scheduled = 0;
  const driver = new ClaudeCodeDriver(
    {
      ...baseOpts,
      env: { [CLAUDE_PERSISTENT_IDLE_MS]: "0" },
      config: { permissionMode: "acceptEdits" },
    },
    noopCb,
    {
      spawn: () => child,
      kill: () => {},
      setTimer: () => {
        scheduled++;
        return { unref() {} } as any;
      },
      clearTimer: () => {},
    } as any,
  );
  const turn = driver.prompt("stay warm");
  await nextTask();
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  await turn;
  assert.equal(scheduled, 0, "quiescent idle eviction must not arm at all");
  driver.dispose();
});

test("persistent mode reuses one process across correlated turns and keeps feature flags out of child env", async () => {
  const children: any[] = [];
  const launches: any[] = [];
  const killed: any[] = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, env: { [CLAUDE_PERSISTENT_FLAG]: "1", [CLAUDE_PERSISTENT_IDLE_MS]: "60000" }, config: { permissionMode: "acceptEdits" } },
    noopCb,
    {
      spawn: (opts: any) => {
        launches.push(opts);
        const child = fakeProcess();
        children.push(child);
        return child;
      },
      kill: (child: any) => killed.push(child),
    } as any,
  );

  const first = driver.prompt("first");
  await nextTask();
  children[0].stdout.write(JSON.stringify({ type: "result", subtype: "success", usage: { input_tokens: 1 } }) + "\n");
  assert.equal(await first, "end_turn");

  const second = driver.prompt("second");
  await nextTask();
  children[0].stdout.write(JSON.stringify({ type: "result", subtype: "success", usage: { output_tokens: 2 } }) + "\n");
  assert.equal(await second, "end_turn");
  assert.equal(launches.length, 1);
  assert.ok(launches[0].args.includes("--input-format"));
  assert.equal(launches[0].env[CLAUDE_PERSISTENT_FLAG], undefined);
  assert.equal(launches[0].env[CLAUDE_PERSISTENT_IDLE_MS], undefined);
  assert.equal(killed.length, 0);
  driver.dispose();
  assert.equal(children[0].stdin.writableEnded, true);
  assert.equal(killed.length, 0, "a clean EOF gets a grace interval before the backstop");
  children[0].emit("close", 0);
  assert.equal(killed.length, 0, "a graceful exit cancels the kill-tree backstop");
});

test("persistent cumulative process cost is emitted as a per-turn delta while usage stays per-turn", async () => {
  const child = fakeProcess();
  const events: SessionEventPayload[] = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, env: { [CLAUDE_PERSISTENT_FLAG]: "1" }, config: { permissionMode: "acceptEdits" } },
    { ...noopCb, onEvent: (event) => events.push(event) },
    { spawn: () => child, kill: () => {} } as any,
  );
  const first = driver.prompt("one");
  await nextTask();
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.01, usage: { input_tokens: 100 } }) + "\n");
  await first;
  const second = driver.prompt("two");
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.03, usage: { input_tokens: 40 } }) + "\n");
  await second;
  const usage = events.filter((event): event is Extract<SessionEventPayload, { kind: "token_usage" }> => event.kind === "token_usage");
  assert.deepEqual(usage.map((event) => event.inputTokens), [100, 40]);
  assert.ok(Math.abs((usage[0].costUsd ?? 0) - 0.01) < 1e-9);
  assert.ok(Math.abs((usage[1].costUsd ?? 0) - 0.02) < 1e-9);
  driver.dispose();
});

test("persistent cost baseline resets when an evicted process resumes", async () => {
  const children: any[] = [];
  const events: SessionEventPayload[] = [];
  let idleCallback: (() => void) | null = null;
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, env: { [CLAUDE_PERSISTENT_FLAG]: "1" }, config: { permissionMode: "acceptEdits" } },
    { ...noopCb, onEvent: (event) => events.push(event) },
    {
      spawn: () => {
        const child = fakeProcess();
        children.push(child);
        return child;
      },
      kill: () => {},
      setTimer: (cb: () => void) => {
        idleCallback = cb;
        return { unref() {} } as any;
      },
      clearTimer: () => { idleCallback = null; },
    } as any,
  );
  const first = driver.prompt("one");
  await nextTask();
  children[0].stdout.write(JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.01 }) + "\n");
  await first;
  (idleCallback as unknown as () => void)();

  const resumed = driver.prompt("two");
  await nextTask();
  assert.equal(children.length, 1, "the replacement waits for confirmed old-process close");
  children[0].emit("close", 0);
  await nextTask();
  children[1].stdout.write(JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.02 }) + "\n");
  await resumed;
  const costs = events
    .filter((event): event is Extract<SessionEventPayload, { kind: "token_usage" }> => event.kind === "token_usage")
    .map((event) => event.costUsd);
  assert.deepEqual(costs, [0.01, 0.02]);
  driver.dispose();
});

test("persistent interactive approvals reuse stdin across two turns", async () => {
  const child = fakeProcess();
  const writes: string[] = [];
  child.stdin.on("data", (chunk: Buffer) => writes.push(chunk.toString("utf8")));
  const events: SessionEventPayload[] = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, env: { [CLAUDE_PERSISTENT_FLAG]: "1" }, config: { permissionMode: "default" } },
    { ...noopCb, onEvent: (event) => events.push(event) },
    { spawn: () => child, kill: () => {} } as any,
  );

  for (const [index, prompt] of ["first", "second"].entries()) {
    const turn = driver.prompt(prompt);
    await nextTask();
    const requestId = `approval-${index}`;
    child.stdout.write(JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "pwd" } },
    }) + "\n");
    await nextTask();
    assert.ok(events.some((event) => event.kind === "permission_request" && event.requestId === requestId));
    assert.equal(driver.resolvePermission(requestId, "allow"), true);
    await nextTask();
    assert.ok(writes.some((write) => write.includes(`\"request_id\":\"${requestId}\"`) && write.includes("control_response")));
    child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
    assert.equal(await turn, "end_turn");
  }
  assert.equal(writes.filter((write) => write.includes("\"type\":\"user\"")).length, 2);
  driver.dispose();
});

test("persistent AskUserQuestion is answered on the shared stdin channel", async () => {
  const child = fakeProcess();
  const writes: string[] = [];
  child.stdin.on("data", (chunk: Buffer) => writes.push(chunk.toString("utf8")));
  const events: SessionEventPayload[] = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, env: { [CLAUDE_PERSISTENT_FLAG]: "1" }, config: { permissionMode: "default" } },
    { ...noopCb, onEvent: (event) => events.push(event) },
    { spawn: () => child, kill: () => {} } as any,
  );
  const turn = driver.prompt("ask me");
  await nextTask();
  child.stdout.write(JSON.stringify({
    type: "control_request",
    request_id: "question-1",
    request: {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      input: { questions: [{ question: "Choose?", header: "Choice", options: [{ label: "A", description: "first" }], multiSelect: false }] },
    },
  }) + "\n");
  await nextTask();
  assert.ok(events.some((event) => event.kind === "question_request" && event.requestId === "question-1"));
  assert.equal(driver.answerQuestion("question-1", { "Choose?": "A" }), true);
  await nextTask();
  assert.ok(writes.some((write) => write.includes("question-1") && write.includes("control_response") && write.includes("answers")));
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  assert.equal(await turn, "end_turn");
  driver.dispose();
});

test("persistent image content rides the reused stream-json stdin envelope", async () => {
  const child = fakeProcess();
  const writes: string[] = [];
  child.stdin.on("data", (chunk: Buffer) => writes.push(chunk.toString("utf8")));
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, env: { [CLAUDE_PERSISTENT_FLAG]: "1" }, config: { permissionMode: "acceptEdits" } },
    noopCb,
    { spawn: () => child, kill: () => {} } as any,
  );
  const turn = driver.prompt("inspect", [{ mimeType: "image/png", data: "aW1hZ2U=" }]);
  await nextTask();
  const user = writes.find((write) => write.includes("\"type\":\"user\""));
  assert.ok(user);
  assert.match(user, /\"type\":\"image\"/);
  assert.match(user, /\"media_type\":\"image\/png\"/);
  assert.match(user, /aW1hZ2U=/);
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  assert.equal(await turn, "end_turn");
  driver.dispose();
});

test("trailing control request at persistent exit cannot surface a phantom card", async () => {
  const child = fakeProcess();
  const events: SessionEventPayload[] = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, env: { [CLAUDE_PERSISTENT_FLAG]: "1" }, config: { permissionMode: "default" } },
    { ...noopCb, onEvent: (event) => events.push(event) },
    { spawn: () => child, kill: () => {} } as any,
  );
  const turn = driver.prompt("ask");
  await nextTask();
  child.stdout.write(JSON.stringify({
    type: "control_request",
    request_id: "dead-approval",
    request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "pwd" } },
  })); // deliberately no newline; close flushes this trailing frame
  child.emit("close", 1);
  assert.equal(await turn, "refusal");
  assert.equal(events.some((event) => event.kind === "permission_request" || event.kind === "question_request"), false);
  assert.equal(driver.resolvePermission("dead-approval", "allow"), false);
  driver.dispose();
});

test("malformed trailing output at pre-ack exit schedules exactly one prompt retry", async () => {
  const children: any[] = [];
  const recoveredWrites: string[] = [];
  const blockedStdin = new Writable({ write(_chunk, _encoding, _callback) {} });
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, env: { [CLAUDE_PERSISTENT_FLAG]: "1" }, config: { permissionMode: "acceptEdits" } },
    noopCb,
    {
      spawn: () => {
        const child = fakeProcess(children.length === 0 ? blockedStdin : new PassThrough());
        if (children.length > 0) child.stdin.on("data", (chunk: Buffer) => recoveredWrites.push(chunk.toString("utf8")));
        children.push(child);
        return child;
      },
      kill: () => {},
    } as any,
  );
  const turn = driver.prompt("run once");
  children[0].stdout.write('{"type":"resu');
  children[0].emit("close", 1);
  await nextTask();
  assert.equal(children.length, 2, "only one recovery process is spawned");
  assert.equal(recoveredWrites.filter((write) => write.includes("\"type\":\"user\"")).length, 1);
  children[1].stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  assert.equal(await turn, "end_turn");
  driver.dispose();
});

test("a valid trailing result settles the persistent turn without a spurious failure", async () => {
  const child = fakeProcess();
  const events: SessionEventPayload[] = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, env: { [CLAUDE_PERSISTENT_FLAG]: "1" }, config: { permissionMode: "acceptEdits" } },
    { ...noopCb, onEvent: (event) => events.push(event) },
    { spawn: () => child, kill: () => {} } as any,
  );
  const turn = driver.prompt("finish in trailing buffer");
  await nextTask();
  let settled = false;
  void turn.then(() => { settled = true; }, () => { settled = true; });
  child.emit("exit", 0);
  await nextTask();
  assert.equal(settled, false, "process exit must not settle before stdout closes");
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success", usage: { output_tokens: 3 } }));
  child.emit("close", 0);
  assert.equal(await turn, "end_turn");
  assert.equal(events.filter((event) => event.kind === "token_usage").length, 1);
  assert.equal(events.some((event) => event.kind === "error"), false);
  driver.dispose();
});

test("newline-delimited non-JSON stdout is ignored without aborting a healthy persistent turn", async () => {
  const child = fakeProcess();
  const events: SessionEventPayload[] = [];
  const stderr: string[] = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, env: { [CLAUDE_PERSISTENT_FLAG]: "1" }, config: { permissionMode: "acceptEdits" } },
    { ...noopCb, onEvent: (event) => events.push(event), onStderr: (text) => stderr.push(text) },
    { spawn: () => child, kill: () => {} } as any,
  );
  const first = driver.prompt("one");
  await nextTask();
  child.stdout.write("harmless banner\n");
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  assert.equal(await first, "end_turn");
  assert.equal(events.some((event) => event.kind === "error"), false);
  assert.ok(stderr.some((text) => /ignored non-JSON/.test(text)));

  const second = driver.prompt("two");
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  assert.equal(await second, "end_turn");
  driver.dispose();
});

test("persistent config changes restart and resume instead of mutating live argv", async () => {
  const children: any[] = [];
  const launches: any[] = [];
  const killed: any[] = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, env: { [CLAUDE_PERSISTENT_FLAG]: "1" }, config: { permissionMode: "acceptEdits" } },
    noopCb,
    {
      spawn: (opts: any) => {
        launches.push(opts);
        const child = fakeProcess();
        children.push(child);
        return child;
      },
      kill: (child: any) => killed.push(child),
    } as any,
  );
  const first = driver.prompt("one");
  await nextTask();
  children[0].stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  await first;
  driver.setConfig({ permissionMode: "plan" });
  const second = driver.prompt("two");
  await nextTask();
  assert.equal(launches.length, 1, "the replacement waits for confirmed old-process close");
  assert.equal(children[0].stdin.writableEnded, true);
  assert.equal(killed.length, 0, "the old transport receives a grace interval");
  children[0].emit("close", 0);
  await nextTask();
  assert.equal(launches.length, 2);
  assert.ok(launches[1].args.includes("--resume"));
  assert.ok(launches[1].args.includes("plan"));
  children[1].stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  assert.equal(await second, "end_turn");
  driver.dispose();
});

test("a config change with pending work delivers the prompt and defers the restart", async () => {
  const child = fakeProcess();
  const launches: any[] = [];
  const writes: string[] = [];
  const stderr: string[] = [];
  child.stdin.on("data", (chunk: Buffer) => writes.push(chunk.toString("utf8")));
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, env: { [CLAUDE_PERSISTENT_FLAG]: "1" }, config: { permissionMode: "acceptEdits" } },
    { ...noopCb, onStderr: (text) => stderr.push(text) },
    { spawn: (options: any) => { launches.push(options); return child; }, kill: () => {} } as any,
  );
  const first = driver.prompt("one");
  await nextTask();
  child.stdout.write(JSON.stringify({ type: "system", subtype: "task_started", task_id: "watcher" }) + "\n");
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  assert.equal(await first, "end_turn");

  driver.setConfig({ permissionMode: "plan" });
  const second = driver.prompt("two must be delivered");
  await nextTask();
  assert.equal(launches.length, 1);
  assert.ok(writes.some((write) => write.includes("two must be delivered")));
  assert.ok(stderr.some((text) => /configuration change deferred/.test(text)));
  child.stdout.write(JSON.stringify({
    type: "system", subtype: "task_notification", task_id: "watcher", status: "completed",
  }) + "\n");
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  assert.equal(await second, "end_turn");
  driver.dispose();
});

test("an idle terminal notification preserves launch metadata and requests one continuation", async () => {
  const child = fakeProcess();
  const background: Parameters<NonNullable<DriverCallbacks["onBackgroundWork"]>>[0][] = [];
  let acceptedPrompts = 0;
  const driver = new ClaudeCodeDriver(
    {
      ...baseOpts,
      env: { [CLAUDE_PERSISTENT_FLAG]: "1" },
      config: { permissionMode: "acceptEdits" },
    },
    {
      ...noopCb,
      onBackgroundWork: (update) => background.push(update),
      onPromptAccepted: () => { acceptedPrompts += 1; },
    },
    { spawn: () => child, kill: () => {}, now: () => 1234 } as any,
  );
  const turn = driver.prompt("launch an agent");
  await nextTask();
  assert.equal(acceptedPrompts, 1, "acceptance is emitted from the stdin write callback");
  child.stdout.write(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "spawn", name: "Task", input: { run_in_background: true } }] },
  }) + "\n");
  child.stdout.write(JSON.stringify({
    type: "system", subtype: "task_started", task_id: "task-1", tool_use_id: "spawn",
  }) + "\n");
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  assert.equal(await turn, "end_turn");
  assert.deepEqual(background.at(-1)?.jobs, [{
    id: "task-1", toolUseId: "spawn", launchType: "agent", startedAt: 1234,
  }]);

  child.stdout.write(JSON.stringify({
    type: "system", subtype: "task_notification", task_id: "task-1", status: "completed",
  }) + "\n");
  await nextTask();
  assert.deepEqual(background.at(-1), {
    state: null,
    pendingTaskIds: [],
    terminalJobs: [{
      id: "task-1",
      toolUseId: "spawn",
      launchType: "agent",
      startedAt: 1234,
      status: "completed",
      terminalAt: 1234,
      continuationRequired: true,
    }],
  });
  driver.dispose();
});

test("a task finishing during an unrelated turn still requests its parent continuation", async () => {
  const child = fakeProcess();
  const background: Parameters<NonNullable<DriverCallbacks["onBackgroundWork"]>>[0][] = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, env: { [CLAUDE_PERSISTENT_FLAG]: "1" }, config: { permissionMode: "acceptEdits" } },
    { ...noopCb, onBackgroundWork: (update) => background.push(update) },
    { spawn: () => child, kill: () => {} } as any,
  );
  const parent = driver.prompt("launch");
  await nextTask();
  child.stdout.write(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "spawn", name: "Task", input: {} }] },
  }) + "\n");
  child.stdout.write(JSON.stringify({
    type: "system", subtype: "task_started", task_id: "task-a", tool_use_id: "spawn",
  }) + "\n");
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  await parent;

  const unrelated = driver.prompt("unrelated user turn");
  await nextTask();
  child.stdout.write(JSON.stringify({
    type: "system", subtype: "task_notification", task_id: "task-a", status: "completed",
  }) + "\n");
  await nextTask();
  assert.equal(background.at(-1)?.terminalJobs?.[0]?.continuationRequired, true);
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  await unrelated;
  driver.dispose();
});

test("idle eviction reaps the transport and the next turn transparently resumes", async () => {
  const children: any[] = [];
  const launches: any[] = [];
  const killed: any[] = [];
  let idleCallback: (() => void) | null = null;
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, env: { [CLAUDE_PERSISTENT_FLAG]: "1", [CLAUDE_PERSISTENT_IDLE_MS]: "1000" }, config: { permissionMode: "acceptEdits" } },
    noopCb,
    {
      spawn: (opts: any) => {
        launches.push(opts);
        const child = fakeProcess();
        children.push(child);
        return child;
      },
      kill: (child: any) => killed.push(child),
      setTimer: (cb: () => void) => {
        idleCallback = cb;
        return { unref() {} } as any;
      },
      clearTimer: () => { idleCallback = null; },
    } as any,
  );
  const first = driver.prompt("one");
  await nextTask();
  children[0].stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  await first;
  assert.ok(idleCallback);
  const evict = idleCallback as () => void;
  evict();
  assert.equal(children[0].stdin.writableEnded, true);
  assert.equal(killed.length, 0);
  const second = driver.prompt("two");
  await nextTask();
  assert.equal(launches.length, 1, "an immediate prompt waits behind the retiring transport");
  const backstop = idleCallback as unknown as () => void;
  backstop();
  assert.equal(killed.length, 1);
  assert.equal(launches.length, 1, "sending the kill is not yet proof of process exit");
  const forceSettle = idleCallback as unknown as () => void;
  forceSettle();
  await nextTask();
  assert.equal(launches.length, 2, "a wedged relay cannot block the session beyond the kill safety cap");
  assert.ok(launches[1].args.includes("--resume"));
  children[1].stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  await second;
  driver.dispose();
});

test("runtime WSL reconciliation keeps a process alive when its stream missed a task artifact", async () => {
  const child = fakeProcess();
  const killed: any[] = [];
  const background: Parameters<NonNullable<DriverCallbacks["onBackgroundWork"]>>[0][] = [];
  let idleCallback: (() => void) | null = null;
  const driver = new ClaudeCodeDriver(
    {
      ...baseOpts,
      context: { kind: "wsl", distro: "Ubuntu" },
      env: { HOME: "/custom/home", TMPDIR: "/custom/tmp", [CLAUDE_PERSISTENT_IDLE_MS]: "30000" },
      isolation: {
        backend: "bwrap",
        command: "bwrap",
        args: [],
        network: "inherit",
        writableBinds: [{ source: "/runner/provider-state/projects", target: "/custom/home/.claude/projects" }],
      },
      config: { permissionMode: "acceptEdits" },
    },
    { ...noopCb, onBackgroundWork: (update) => background.push(update) },
    {
      spawn: () => child,
      kill: (process: any) => killed.push(process),
      inspectBackgroundWork: async (context: unknown, _cwd: string, _sessionId: string, _ids: unknown, options: any) => {
        assert.deepEqual(context, { kind: "wsl", distro: "Ubuntu" });
        assert.equal(options.env.HOME, "/custom/home");
        assert.equal(options.env.TMPDIR, "/custom/tmp");
        assert.equal(options.projectsRoot, "/runner/provider-state/projects");
        return {
          incompleteArtifacts: [{ id: "missed-wsl-task", outputFile: "/custom/tmp/task.output" }],
          terminalTaskIds: new Set<string>(),
        };
      },
      setTimer: (callback: () => void, delay: number) => {
        if (delay === 30_000) idleCallback = callback;
        return { unref() {} } as any;
      },
      clearTimer: () => {},
    } as any,
  );
  const turn = driver.prompt("quiet turn");
  await nextTask();
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  await turn;
  (idleCallback as unknown as () => void)();
  await nextTask();
  assert.equal(killed.length, 0);
  assert.deepEqual(background.at(-1)?.pendingTaskIds, ["missed-wsl-task"]);
  assert.deepEqual(background.at(-1)?.observedTaskIds, [], "disk artifacts are not live stream evidence");
  driver.dispose();
});

test("one-shot task completion never arms persistent idle eviction during the live turn", async () => {
  const child = fakeProcess();
  const killed: any[] = [];
  const activeTimers = new Set<object>();
  const background: Parameters<NonNullable<DriverCallbacks["onBackgroundWork"]>>[0][] = [];
  const driver = new ClaudeCodeDriver(
    {
      ...baseOpts,
      env: { [CLAUDE_PERSISTENT_FLAG]: "0", [CLAUDE_PERSISTENT_IDLE_MS]: "30000" },
      config: { permissionMode: "default" },
    },
    { ...noopCb, onBackgroundWork: (update) => background.push(update) },
    {
      spawn: () => child,
      kill: (process: any) => killed.push(process),
      setTimer: (callback: () => void) => {
        const timer = { callback, unref() {} };
        activeTimers.add(timer);
        return timer as any;
      },
      clearTimer: (timer: object) => activeTimers.delete(timer),
    } as any,
  );
  const turn = driver.prompt("long one-shot turn");
  await nextTask();
  child.stdout.write(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "task", name: "Task", input: {} }] },
  }) + "\n");
  child.stdout.write(JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "task", content: "done" }] },
  }) + "\n");
  await nextTask();
  assert.equal(activeTimers.size, 0);
  assert.deepEqual(killed, []);
  assert.equal(child.stdin.writableEnded, false);
  assert.equal(
    background.flatMap((update) => update.terminalJobs ?? []).at(-1)?.continuationRequired,
    false,
    "a Task completed inside a one-shot turn must not trigger a second provider turn",
  );
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  child.emit("close", 0);
  assert.equal(await turn, "end_turn");
  driver.dispose();
});

test("one-shot recovery publishes its reconciled orphan set after settling unseen seeds", async () => {
  const child = fakeProcess();
  const background: Parameters<NonNullable<DriverCallbacks["onBackgroundWork"]>>[0][] = [];
  const driver = new ClaudeCodeDriver(
    {
      ...baseOpts,
      env: { [CLAUDE_PERSISTENT_FLAG]: "0" },
      initialBackgroundTaskIds: ["unseen-seed", "live-seed"],
      config: { permissionMode: "default" },
    },
    { ...noopCb, onBackgroundWork: (update) => background.push(update) },
    { spawn: () => child, kill: () => {} } as any,
  );
  const turn = driver.prompt("recover once");
  await nextTask();
  child.stdout.write(JSON.stringify({
    type: "system",
    subtype: "task_progress",
    task_id: "live-seed",
  }) + "\n");
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  child.emit("close", 0);
  assert.equal(await turn, "end_turn");
  assert.deepEqual(background.at(-1), {
    state: "orphaned",
    pendingTaskIds: ["live-seed"],
    observedTaskIds: ["live-seed"],
    oldestPendingAt: background.at(-1)?.oldestPendingAt,
    reason: "process_exit",
  });
  driver.dispose();
});

test("task lifecycle keeps a six-hour-silent session alive until out-of-turn completion arrives", async () => {
  const child = fakeProcess();
  const killed: any[] = [];
  const background: Parameters<NonNullable<DriverCallbacks["onBackgroundWork"]>>[0][] = [];
  let now = 1_000;
  let idleCallback: (() => void) | null = null;
  let pendingCallback: (() => void) | null = null;
  let graceCallback: (() => void) | null = null;
  let pendingDelay = 0;
  const driver = new ClaudeCodeDriver(
    {
      ...baseOpts,
      env: { [CLAUDE_PERSISTENT_IDLE_MS]: "30000" },
      config: { permissionMode: "acceptEdits" },
    },
    { ...noopCb, onBackgroundWork: (update) => background.push(update) },
    {
      spawn: () => child,
      kill: (process: any) => killed.push(process),
      now: () => now,
      setTimer: (callback: () => void, delay: number) => {
        if (delay === 30_000) idleCallback = callback;
        else if (delay === 5_000) graceCallback = callback;
        else {
          pendingCallback = callback;
          pendingDelay = delay;
        }
        return { unref() {} } as any;
      },
      clearTimer: () => {},
    } as any,
  );

  const turn = driver.prompt("delegate");
  await nextTask();
  child.stdout.write(JSON.stringify({
    type: "system",
    subtype: "task_started",
    task_id: "task-1",
    tool_use_id: "tool-1",
    description: "long task",
  }) + "\n");
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  assert.equal(await turn, "end_turn");
  assert.equal(idleCallback, null, "pending work must not arm idle eviction");
  assert.ok(pendingCallback, "the leak backstop remains armed");
  assert.equal(pendingDelay, 7 * 24 * 60 * 60_000);
  now += 6 * 60 * 60_000;
  assert.equal(killed.length, 0, "six hours of stream silence is not quiescence");
  assert.equal(background.at(-1)?.state, "running");
  assert.deepEqual(background.at(-1)?.pendingTaskIds, ["task-1"]);
  assert.deepEqual(background.at(-1)?.observedTaskIds, ["task-1"]);
  assert.deepEqual(background.at(-1)?.jobs?.map((job) => job.id), ["task-1"]);

  child.stdout.write(JSON.stringify({
    type: "system",
    subtype: "task_notification",
    task_id: "task-1",
    tool_use_id: "tool-1",
    status: "stopped",
  }) + "\n");
  await nextTask();
  assert.equal(background.at(-1)?.state, "running", "stopped work remains recoverable");

  child.stdout.write(JSON.stringify({
    type: "system",
    subtype: "task_notification",
    task_id: "task-1",
    tool_use_id: "tool-1",
    status: "completed",
    output_file: "task-1.output",
  }) + "\n");
  await nextTask();
  assert.equal(background.at(-1)?.state, null);
  assert.deepEqual(background.at(-1)?.pendingTaskIds, []);
  assert.equal(background.at(-1)?.terminalJobs?.[0]?.continuationRequired, true);
  assert.ok(idleCallback, "quiescence after completion re-arms idle eviction");
  (idleCallback as unknown as () => void)();
  assert.equal(killed.length, 0);
  (graceCallback as unknown as () => void)();
  assert.deepEqual(killed, [child]);
  driver.dispose();
});

test("Agent, background shell, Monitor, and Workflow launches all participate in quiescence", async () => {
  const child = fakeProcess();
  const background: Parameters<NonNullable<DriverCallbacks["onBackgroundWork"]>>[0][] = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, config: { permissionMode: "acceptEdits" } },
    { ...noopCb, onBackgroundWork: (update) => background.push(update) },
    { spawn: () => child, kill: () => {} } as any,
  );
  const turn = driver.prompt("watch everything");
  await nextTask();
  child.stdout.write(JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "agent", name: "Agent", input: {} },
        { type: "tool_use", id: "shell", name: "Bash", input: { run_in_background: true } },
        { type: "tool_use", id: "monitor", name: "Monitor", input: {} },
        { type: "tool_use", id: "workflow", name: "Workflow", input: {} },
        { type: "tool_use", id: "foreground", name: "Task", input: { run_in_background: false } },
      ],
    },
  }) + "\n");
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  await turn;
  assert.deepEqual(background.at(-1)?.pendingTaskIds, [
    "tool:agent",
    "tool:monitor",
    "tool:shell",
    "tool:workflow",
  ]);

  child.stdout.write(JSON.stringify({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "agent", content: "ordinary foreground agent result" },
        { type: "tool_result", tool_use_id: "shell", content: "background process launched" },
      ],
    },
  }) + "\n");
  await nextTask();
  assert.deepEqual(
    background.at(-1)?.pendingTaskIds,
    ["tool:monitor", "tool:workflow"],
    "a plain launch result releases a provisional shell hold without positive task lifecycle evidence",
  );

  child.stdout.write(JSON.stringify({
    type: "user",
    message: {
      content: ["shell", "monitor", "workflow"].map((tool_use_id) => ({
        type: "tool_result",
        tool_use_id,
        content: JSON.stringify({ status: "completed" }),
      })),
    },
  }) + "\n");
  await nextTask();
  assert.equal(background.at(-1)?.state, null);
  assert.deepEqual(background.at(-1)?.pendingTaskIds, []);
  assert.ok(background.at(-1)?.terminalJobs?.every((job) => job.continuationRequired));
  driver.dispose();
});

test("provider lifecycle evidence promotes a provisional background shell until notification", async () => {
  const child = fakeProcess();
  const background: Parameters<NonNullable<DriverCallbacks["onBackgroundWork"]>>[0][] = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, config: { permissionMode: "acceptEdits" } },
    { ...noopCb, onBackgroundWork: (update) => background.push(update) },
    { spawn: () => child, kill: () => {} } as any,
  );
  const turn = driver.prompt("watch shell");
  await nextTask();
  child.stdout.write(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "shell", name: "Bash", input: { run_in_background: true } }] },
  }) + "\n");
  child.stdout.write(JSON.stringify({
    type: "system", subtype: "task_started", task_id: "shell-task", tool_use_id: "shell",
  }) + "\n");
  child.stdout.write(JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "shell", content: "Command running" }] },
  }) + "\n");
  await nextTask();
  assert.deepEqual(background.at(-1)?.pendingTaskIds, ["shell-task"]);
  child.stdout.write(JSON.stringify({
    type: "system", subtype: "task_notification", task_id: "shell-task", status: "completed",
  }) + "\n");
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  assert.equal(await turn, "end_turn");
  assert.equal(background.at(-1)?.state, null);
  assert.deepEqual(background.at(-1)?.pendingTaskIds, []);
  assert.equal(background.at(-1)?.terminalJobs?.[0]?.launchType, "shell");
  driver.dispose();
});

test("foreground Task results ignore nested status prose and complete normally", async () => {
  const child = fakeProcess();
  const background: Parameters<NonNullable<DriverCallbacks["onBackgroundWork"]>>[0][] = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, config: { permissionMode: "acceptEdits" } },
    { ...noopCb, onBackgroundWork: (update) => background.push(update) },
    { spawn: () => child, kill: () => {} } as any,
  );
  const turn = driver.prompt("delegate");
  await nextTask();
  child.stdout.write(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "task-tool", name: "Task", input: {} }] },
  }) + "\n");
  child.stdout.write(JSON.stringify({
    type: "user",
    message: { content: [{
      type: "tool_result",
      tool_use_id: "task-tool",
      content: JSON.stringify({ summary: "background API payload", detail: { status: "pending" } }),
    }] },
  }) + "\n");
  await nextTask();
  assert.equal(background.at(-1)?.state, null);
  assert.deepEqual(background.at(-1)?.pendingTaskIds, []);
  assert.equal(background.at(-1)?.terminalJobs?.[0]?.launchType, "agent");
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  assert.equal(await turn, "end_turn");
  driver.dispose();
});

test("task progress without tool_use_id preserves the original completion correlation", async () => {
  const child = fakeProcess();
  const background: Parameters<NonNullable<DriverCallbacks["onBackgroundWork"]>>[0][] = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, config: { permissionMode: "acceptEdits" } },
    { ...noopCb, onBackgroundWork: (update) => background.push(update) },
    { spawn: () => child, kill: () => {} } as any,
  );
  const turn = driver.prompt("delegate");
  await nextTask();
  child.stdout.write(JSON.stringify({
    type: "system", subtype: "task_started", task_id: "task-1", tool_use_id: "tool-1",
  }) + "\n");
  child.stdout.write(JSON.stringify({ type: "system", subtype: "task_progress", task_id: "task-1" }) + "\n");
  child.stdout.write(JSON.stringify({
    type: "user",
    message: { content: [{
      type: "tool_result", tool_use_id: "tool-1", content: JSON.stringify({ status: "completed" }),
    }] },
  }) + "\n");
  await nextTask();
  assert.equal(background.at(-1)?.state, null);
  assert.deepEqual(background.at(-1)?.pendingTaskIds, []);
  assert.equal(background.at(-1)?.terminalJobs?.[0]?.toolUseId, "tool-1");
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  assert.equal(await turn, "end_turn");
  driver.dispose();
});

test("the one-shot circuit breaker orphans pending work when its process exits", async () => {
  const child = fakeProcess();
  const background: Parameters<NonNullable<DriverCallbacks["onBackgroundWork"]>>[0][] = [];
  const driver = new ClaudeCodeDriver(
    {
      ...baseOpts,
      env: { [CLAUDE_PERSISTENT_FLAG]: "0" },
      config: { permissionMode: "acceptEdits" },
    },
    { ...noopCb, onBackgroundWork: (update) => background.push(update) },
    { spawn: () => child, kill: () => {} } as any,
  );
  const turn = driver.prompt("delegate once");
  await nextTask();
  child.stdout.write(JSON.stringify({
    type: "system",
    subtype: "task_started",
    task_id: "one-shot-task",
  }) + "\n");
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  child.emit("close", 0);
  assert.equal(await turn, "end_turn");
  assert.deepEqual(background.at(-1)?.pendingTaskIds, ["one-shot-task"]);
  assert.equal(background.at(-1)?.state, "orphaned");
  driver.dispose();
});

test("one-shot cancellation marks pending work orphaned before killing the process", async () => {
  const child = fakeProcess();
  const killed: any[] = [];
  const background: Parameters<NonNullable<DriverCallbacks["onBackgroundWork"]>>[0][] = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, env: { [CLAUDE_PERSISTENT_FLAG]: "0" }, config: { permissionMode: "acceptEdits" } },
    { ...noopCb, onBackgroundWork: (update) => background.push(update) },
    { spawn: () => child, kill: (process: any) => killed.push(process) } as any,
  );
  void driver.prompt("delegate once");
  await nextTask();
  child.stdout.write(JSON.stringify({ type: "system", subtype: "task_started", task_id: "cancelled-task" }) + "\n");
  await nextTask();
  driver.cancel();
  assert.equal(background.at(-1)?.state, "orphaned");
  assert.deepEqual(background.at(-1)?.pendingTaskIds, ["cancelled-task"]);
  assert.deepEqual(killed, [child]);
  child.emit("close", null);
  driver.dispose();
});

test("pending ceiling writes an orphan marker before gracefully reaping the Claude process", async () => {
  const child = fakeProcess();
  const killed: any[] = [];
  const background: Parameters<NonNullable<DriverCallbacks["onBackgroundWork"]>>[0][] = [];
  let pendingCallback: (() => void) | null = null;
  let graceCallback: (() => void) | null = null;
  const driver = new ClaudeCodeDriver(
    {
      ...baseOpts,
      env: { [CLAUDE_PERSISTENT_IDLE_MS]: "30000", [CLAUDE_PENDING_MAX_MS]: "30000" },
      config: { permissionMode: "acceptEdits" },
    },
    { ...noopCb, onBackgroundWork: (update) => background.push(update) },
    {
      spawn: () => child,
      kill: (process: any) => killed.push(process),
      setTimer: (callback: () => void, delay: number) => {
        if (delay === 5_000) graceCallback = callback;
        else pendingCallback = callback;
        return { unref() {} } as any;
      },
      clearTimer: () => {},
    } as any,
  );
  const turn = driver.prompt("delegate");
  await nextTask();
  child.stdout.write(JSON.stringify({ type: "system", subtype: "task_started", task_id: "task-2" }) + "\n");
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  await turn;
  (pendingCallback as unknown as () => void)();
  assert.equal(background.at(-1)?.state, "orphaned");
  assert.equal(background.at(-1)?.reason, "ceiling");
  assert.deepEqual(background.at(-1)?.pendingTaskIds, ["task-2"]);
  assert.equal(child.stdin.writableEnded, true, "EOF is sent before the kill-tree backstop");
  assert.deepEqual(killed, [], "the process receives a real grace interval");
  (graceCallback as unknown as () => void)();
  assert.deepEqual(killed, [child]);
  driver.dispose();
});

test("a live hold sentinel delays quiescent eviction only until its required TTL expires", async () => {
  const child = fakeProcess();
  const killed: any[] = [];
  let now = 1_000;
  const expiresAt = 2_000;
  const callbacks: Array<() => void> = [];
  const driver = new ClaudeCodeDriver(
    {
      ...baseOpts,
      env: { [CLAUDE_PERSISTENT_IDLE_MS]: "30000" },
      sessionStateDir: "C:\\runner\\session",
      config: { permissionMode: "acceptEdits" },
    },
    noopCb,
    {
      spawn: () => child,
      kill: (process: any) => killed.push(process),
      now: () => now,
      readFile: () => JSON.stringify({ expiresAt }),
      setTimer: (callback: () => void) => {
        callbacks.push(callback);
        return { unref() {} } as any;
      },
      clearTimer: () => {},
    } as any,
  );
  const turn = driver.prompt("done soon");
  await nextTask();
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  await turn;
  callbacks.shift()!();
  assert.equal(killed.length, 0);
  now = 2_001;
  callbacks.shift()!();
  assert.equal(killed.length, 0);
  callbacks.shift()!();
  assert.deepEqual(killed, [child]);
  driver.dispose();
});

test("an agent-authored hold cannot outlive the configured pending-work ceiling", async () => {
  const child = fakeProcess();
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const driver = new ClaudeCodeDriver(
    {
      ...baseOpts,
      env: {
        [CLAUDE_PERSISTENT_IDLE_MS]: "30000",
        [CLAUDE_PENDING_MAX_MS]: "1000",
      },
      sessionStateDir: "C:\\runner\\session",
      config: { permissionMode: "acceptEdits" },
    },
    noopCb,
    {
      spawn: () => child,
      kill: () => {},
      now: () => 1_000,
      readFile: () => JSON.stringify({ expiresAt: 99_999_999_999_999 }),
      setTimer: (callback: () => void, delay: number) => {
        timers.push({ callback, delay });
        return { unref() {} } as any;
      },
      clearTimer: () => {},
    } as any,
  );
  const turn = driver.prompt("done soon");
  await nextTask();
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  await turn;
  assert.equal(timers[0]?.delay, 30_000);
  timers[0]?.callback();
  assert.equal(timers[1]?.delay, 1_000);
  child.emit("close", 0);
  driver.dispose();
});

test("an unsolicited idle process exit is transparently resumed by the next prompt", async () => {
  const children: any[] = [];
  const launches: any[] = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, env: { [CLAUDE_PERSISTENT_FLAG]: "1" }, config: { permissionMode: "acceptEdits" } },
    noopCb,
    {
      spawn: (opts: any) => {
        launches.push(opts);
        const child = fakeProcess();
        children.push(child);
        return child;
      },
      kill: () => {},
    } as any,
  );
  const first = driver.prompt("one");
  await nextTask();
  children[0].stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  await first;
  children[0].emit("close", 0);
  const second = driver.prompt("two");
  await nextTask();
  assert.equal(children.length, 2);
  assert.ok(launches[1].args.includes("--resume"));
  children[1].stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  assert.equal(await second, "end_turn");
  driver.dispose();
});

test("an acknowledged prompt is never resent after transport termination", async () => {
  const children: any[] = [];
  const launches: any[] = [];
  const events: SessionEventPayload[] = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, env: { [CLAUDE_PERSISTENT_FLAG]: "1" }, config: { permissionMode: "acceptEdits" } },
    { ...noopCb, onEvent: (event) => events.push(event) },
    {
      spawn: (opts: any) => {
        launches.push(opts);
        const child = fakeProcess();
        children.push(child);
        return child;
      },
      kill: () => {},
    } as any,
  );
  const turn = driver.prompt("do not duplicate");
  await nextTask(); // PassThrough acknowledged the write.
  children[0].stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: driver.agentSessionId() }) + "\n");
  await nextTask();
  children[0].emit("close", 7);
  assert.equal(await turn, "refusal");
  await nextTask();
  assert.equal(children.length, 1, "no automatic resend/spawn after an acknowledged prompt");
  assert.ok(events.some((event) => event.kind === "error" && /not replayed/.test(event.message)));

  const recovered = driver.prompt("a distinct follow-up");
  await nextTask();
  assert.equal(children.length, 2);
  assert.ok(launches[1].args.includes("--input-format"), "first distinct follow-up retries persistent mode");
  assert.ok(launches[1].args.includes("--resume"));
  children[1].stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  assert.equal(await recovered, "end_turn");

  const secondFailure = driver.prompt("another distinct prompt");
  await nextTask();
  children[1].emit("close", 8);
  assert.equal(await secondFailure, "refusal");
  assert.ok(events.some((event) => event.kind === "error" && /disabled/.test(event.message)));

  const fallback = driver.prompt("one-shot fallback");
  await nextTask();
  assert.equal(children.length, 3);
  assert.equal(launches[2].args.includes("--input-format"), false, "circuit-open session uses one-shot fallback");
  children[2].stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  children[2].emit("close", 0);
  assert.equal(await fallback, "end_turn");
  driver.dispose();
});

test("an acknowledged first-turn exit before init retains session-id for the recovery prompt", async () => {
  const children: any[] = [];
  const launches: any[] = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, env: { [CLAUDE_PERSISTENT_FLAG]: "1" }, config: { permissionMode: "acceptEdits" } },
    noopCb,
    {
      spawn: (opts: any) => {
        launches.push(opts);
        const child = fakeProcess();
        children.push(child);
        return child;
      },
      kill: () => {},
    } as any,
  );
  const first = driver.prompt("first");
  await nextTask(); // stdin write acknowledged, but no system/init was observed
  children[0].emit("close", 1);
  assert.equal(await first, "refusal");

  const recovery = driver.prompt("distinct recovery prompt");
  await nextTask();
  assert.ok(launches[1].args.includes("--session-id"));
  assert.equal(launches[1].args.includes("--resume"), false);
  children[1].stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  assert.equal(await recovery, "end_turn");
  driver.dispose();
});

test("a pre-acknowledgement transport failure retries exactly once", async () => {
  const children: any[] = [];
  let firstWriteCallback: ((error?: Error | null) => void) | null = null;
  const blockedStdin = new Writable({
    write(_chunk, _encoding, callback) {
      firstWriteCallback = callback;
    },
  });
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, env: { [CLAUDE_PERSISTENT_FLAG]: "1" }, config: { permissionMode: "acceptEdits" } },
    noopCb,
    {
      spawn: () => {
        const child = fakeProcess(children.length === 0 ? blockedStdin : new PassThrough());
        children.push(child);
        return child;
      },
      kill: () => {},
    } as any,
  );
  const turn = driver.prompt("safe retry");
  assert.ok(firstWriteCallback, "first write remains unacknowledged");
  children[0].emit("close", 1);
  await nextTask();
  assert.equal(children.length, 2);
  children[1].stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  assert.equal(await turn, "end_turn");
  assert.equal(children.length, 2, "the retry budget is one");
  driver.dispose();
});

test("an async persistent spawn error settles the turn without waiting for an exit event", async () => {
  const children: any[] = [];
  const events: SessionEventPayload[] = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, env: { [CLAUDE_PERSISTENT_FLAG]: "1" }, config: { permissionMode: "acceptEdits" } },
    { ...noopCb, onEvent: (event) => events.push(event) },
    {
      spawn: () => {
        const child = fakeProcess();
        children.push(child);
        return child;
      },
      kill: () => {},
    } as any,
  );
  const failed = driver.prompt("first");
  await nextTask(); // acknowledge stdin so the failure must not replay this prompt
  children[0].emit("error", new Error("spawn claude ENOENT")); // deliberately no exit event
  assert.equal(await failed, "refusal");
  assert.ok(events.some((event) => event.kind === "error" && /not replayed/.test(event.message)));

  const recovered = driver.prompt("distinct follow-up");
  await nextTask();
  assert.equal(children.length, 2);
  children[1].stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  assert.equal(await recovered, "end_turn");
  driver.dispose();
});

test("cancel settles only the active persistent turn and kills its process immediately", async () => {
  const children: any[] = [];
  const killed: any[] = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, env: { [CLAUDE_PERSISTENT_FLAG]: "1" }, config: { permissionMode: "acceptEdits" } },
    noopCb,
    {
      spawn: () => {
        const child = fakeProcess();
        children.push(child);
        return child;
      },
      kill: (child: any) => killed.push(child),
    } as any,
  );
  const turn = driver.prompt("cancel me");
  await nextTask();
  driver.cancel();
  assert.equal(await turn, "cancelled");
  assert.equal(children[0].stdin.writableEnded, true);
  assert.deepEqual(killed, [children[0]]);
  children[0].emit("close", 0);

  const next = driver.prompt("still usable");
  await nextTask();
  assert.equal(children.length, 2);
  children[1].stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  assert.equal(await next, "end_turn");
  driver.dispose();
});

test("cancel fences an idle persistent child before an immediate new prompt", async () => {
  const children: any[] = [];
  const killed: any[] = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, env: { [CLAUDE_PERSISTENT_FLAG]: "1" }, config: { permissionMode: "acceptEdits" } },
    noopCb,
    {
      spawn: () => {
        const child = fakeProcess();
        children.push(child);
        return child;
      },
      kill: (child: any) => killed.push(child),
    } as any,
  );
  const first = driver.prompt("one");
  await nextTask();
  children[0].stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  assert.equal(await first, "end_turn");

  driver.cancel(); // idle-but-alive transport
  assert.equal(children[0].stdin.writableEnded, true);
  assert.deepEqual(killed, [children[0]]);
  const second = driver.prompt("two"); // must not reuse the dying child
  await nextTask();
  assert.equal(children.length, 1, "cancelled transport must exit before replacement");
  children[0].emit("close", 1); // stale provider handlers are generation-fenced
  await nextTask();
  assert.equal(children.length, 2);
  children[1].stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  assert.equal(await second, "end_turn");
  driver.dispose();
});

test("one-shot fixed-rule mode delivers multiline prompts through stdin, never argv", async () => {
  const child = fakeProcess();
  const writes: string[] = [];
  let acceptedPrompts = 0;
  child.stdin.on("data", (chunk: Buffer) => writes.push(chunk.toString("utf8")));
  const launches: any[] = [];
  const driver = new ClaudeCodeDriver(
    { ...baseOpts, env: { [CLAUDE_PERSISTENT_FLAG]: "0" }, config: { permissionMode: "acceptEdits" } },
    { ...noopCb, onPromptAccepted: () => { acceptedPrompts += 1; } },
    { spawn: (opts: any) => { launches.push(opts); return child; }, kill: () => {} } as any,
  );
  const prompt = "first line\r\nsecond line with %USERPROFILE% & more";

  const turn = driver.prompt(prompt);
  await nextTask();

  assert.equal(launches.length, 1);
  assert.equal(launches[0].args.includes(prompt), false, "user content must not reach cmd.exe argv");
  assert.equal(writes.join(""), prompt);
  assert.equal(child.stdin.writableEnded, true);
  assert.equal(acceptedPrompts, 1, "one-shot acceptance is emitted from the stdin end callback");

  let settled = false;
  void turn.then(() => { settled = true; }, () => { settled = true; });
  child.emit("exit", 0);
  await nextTask();
  assert.equal(settled, false, "process exit must not settle before final one-shot stdout");
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
  child.emit("close", 0);
  assert.equal(await turn, "end_turn");
  driver.dispose();
});

test("one-shot first/resume turns heal managed hook settings and circuit-open persistent turns restart hook-less", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-claude-hook-driver-"));
  try {
    const settings = join(root, "sess.settings.json");
    writeClaudeHookSettings(settings, {
      sessionId: "sess",
      launch: { command: "runner", args: ["--policy-hook"] },
      cpHttpUrl: "http://127.0.0.1:4317",
      tokenFile: claudeHookTokenPath(settings),
    });
    const base = {
      ...baseOpts,
      args: ["--settings", settings],
      config: { permissionMode: "acceptEdits" },
    };
    const oneShotChildren: any[] = [];
    const oneShotLaunches: any[] = [];
    const oneShot = new ClaudeCodeDriver(base, noopCb, {
      spawn: (options: any) => {
        oneShotLaunches.push(options);
        const child = fakeProcess();
        oneShotChildren.push(child);
        return child;
      },
      kill: () => {},
    } as any);
    const first = oneShot.prompt("first");
    await nextTask();
    assert.ok(oneShotLaunches[0].args.includes(settings));
    oneShotChildren[0].stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
    oneShotChildren[0].emit("close", 0);
    await first;
    rmSync(settings);
    const resumed = oneShot.prompt("resumed");
    await nextTask();
    assert.ok(oneShotLaunches[1].args.includes("--resume"));
    assert.ok(oneShotLaunches[1].args.includes(settings));
    oneShotChildren[1].stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
    oneShotChildren[1].emit("close", 0);
    await resumed;
    oneShot.dispose();

    const persistentChildren: any[] = [];
    const persistentLaunches: any[] = [];
    const persistent = new ClaudeCodeDriver(
      { ...base, env: { [CLAUDE_PERSISTENT_FLAG]: "1" } },
      noopCb,
      {
        spawn: (options: any) => {
          persistentLaunches.push(options);
          const child = fakeProcess();
          persistentChildren.push(child);
          return child;
        },
        kill: () => {},
      } as any,
    );
    const persistentFirst = persistent.prompt("first");
    await nextTask();
    persistentChildren[0].stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
    await persistentFirst;
    writeHookCircuitState(
      claudeHookCircuitPath(settings),
      { consecutiveFailures: 3, open: true, openedAt: Date.now() },
    );
    const fallback = persistent.prompt("fallback");
    await nextTask();
    assert.equal(persistentLaunches.length, 1, "hook fingerprint restart waits for old transport exit");
    persistentChildren[0].emit("close", 0);
    await nextTask();
    assert.equal(persistentLaunches.length, 2, "fingerprint change restarts the persistent process");
    assert.equal(persistentLaunches[1].args.includes(settings), false, "new process is hook-less");
    persistentChildren[1].stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
    await fallback;
    persistent.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successful cooldown re-probe publishes runner-owned hook elicitation recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-claude-hook-recovery-"));
  try {
    const settings = join(root, "sess.settings.json");
    writeClaudeHookSettings(settings, {
      sessionId: "sess",
      launch: { command: "runner", args: ["--policy-hook"] },
      cpHttpUrl: "http://127.0.0.1:4317",
      tokenFile: claudeHookTokenPath(settings),
      askCapable: true,
    });
    const events: SessionEventPayload[] = [];
    const children: any[] = [];
    const launches: any[] = [];
    const driver = new ClaudeCodeDriver(
      {
        ...baseOpts,
        args: ["--settings", settings],
        config: { permissionMode: "acceptEdits" },
      },
      { ...noopCb, onEvent: (event) => events.push(event) },
      {
        spawn: (options: any) => {
          launches.push(options);
          const child = fakeProcess();
          children.push(child);
          return child;
        },
        kill: () => {},
      } as any,
    );

    const openedAt = Date.now();
    writeHookCircuitState(
      claudeHookCircuitPath(settings),
      { consecutiveFailures: 3, open: true, openedAt },
    );
    const fallback = driver.prompt("fallback");
    await nextTask();
    assert.equal(launches[0].args.includes(settings), false);
    children[0].stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
    children[0].emit("close", 0);
    await fallback;

    writeHookCircuitState(
      claudeHookCircuitPath(settings),
      { consecutiveFailures: 3, open: true, openedAt: Date.now() - 30_001 },
    );
    const recovered = driver.prompt("recover");
    await nextTask();
    assert.equal(launches[1].args.includes(settings), true);
    writeHookCircuitState(
      claudeHookCircuitPath(settings),
      { consecutiveFailures: 0, open: false, lastDurationMs: 1 },
    );
    children[1].stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
    children[1].emit("close", 0);
    await recovered;

    assert.deepEqual(events.filter((event) => event.kind === "policy_transport"), [
      { kind: "policy_transport", state: "open", openedAt },
      {
        kind: "policy_transport",
        state: "recovered",
        openedAt,
        restoresElicitation: true,
      },
    ]);
    driver.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner-side capability gate rejects stale optional flags and image input", () => {
  const capabilities = {
    models: [], effortLevels: ["low"], slashCommands: [], supportsImages: false,
    supportsApprovals: false, permissionModes: ["acceptEdits"],
  };
  assert.match(claudeCapabilityError({ effort: "max" }, [], capabilities)!, /effort/);
  assert.match(claudeCapabilityError({ permissionMode: "auto" }, [], capabilities)!, /permission mode/);
  assert.match(claudeCapabilityError({}, [{ mimeType: "image/png", data: "x" }], capabilities)!, /image input/);
  assert.equal(claudeCapabilityError({ effort: "low", permissionMode: "acceptEdits" }, [], capabilities), null);
});

test("resumeId seeds the agent session id (resume) instead of minting a new one (Phase 2)", () => {
  const resumed = new ClaudeCodeDriver({ ...baseOpts, resumeId: "11111111-2222-3333-4444-555555555555" }, noopCb);
  assert.equal(resumed.agentSessionId(), "11111111-2222-3333-4444-555555555555");

  // A fresh session mints its own id (non-null, and distinct from the resumed one).
  const fresh = new ClaudeCodeDriver(baseOpts, noopCb);
  assert.notEqual(fresh.agentSessionId(), null);
  assert.notEqual(fresh.agentSessionId(), resumed.agentSessionId());
});

test("Claude fork mints a deterministic target session with a zero-cost local bootstrap", async () => {
  const source = "11111111-2222-3333-4444-555555555555";
  const child = fakeProcess();
  const writes: string[] = [];
  child.stdin.on("data", (chunk: Buffer) => writes.push(chunk.toString("utf8")));
  const launches: any[] = [];
  const driver = new ClaudeCodeDriver(
    {
      ...baseOpts,
      resumeId: source,
      capabilities: {
        models: [], effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: true,
        supportsConversationFork: true, permissionModes: ["acceptEdits"],
      },
    },
    noopCb,
    { spawn: (opts: any) => { launches.push(opts); return child; }, kill: () => {} } as any,
  );
  assert.equal(driver.agentTurnId(), source);
  const fork = driver.forkSession(source, "/tmp/fork-worktree");
  await nextTask();
  const args = launches[0].args as string[];
  const target = args[args.indexOf("--session-id") + 1]!;
  assert.notEqual(target, source);
  assert.equal(launches[0].cwd, "/tmp/fork-worktree");
  assert.ok(args.includes("--fork-session"));
  assert.equal(args[args.indexOf("--resume") + 1], source);
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.ok(writes.some((write) => write.includes("/context")), "local zero-cost bootstrap is sent");
  let settled = false;
  void fork.then(() => { settled = true; }, () => { settled = true; });
  child.emit("exit", 0);
  await nextTask();
  assert.equal(settled, false, "process exit must not reject before fork confirmation drains");
  child.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: target }) + "\n");
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: target, total_cost_usd: 0 }) + "\n");
  child.emit("close", 0);
  assert.equal(await fork, target);
  assert.equal(driver.agentSessionId(), source, "source driver id is immutable");
  driver.dispose();
});

test("Claude fork bootstrap heals and carries the managed hook settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-claude-hook-fork-"));
  try {
    const settings = join(root, "source.settings.json");
    writeClaudeHookSettings(settings, {
      sessionId: "source",
      launch: { command: "runner", args: ["--policy-hook"] },
      cpHttpUrl: "http://127.0.0.1:4317",
      tokenFile: claudeHookTokenPath(settings),
    });
    const source = "11111111-2222-3333-4444-555555555555";
    const child = fakeProcess();
    const launches: any[] = [];
    const driver = new ClaudeCodeDriver({
      ...baseOpts,
      args: ["--settings", settings],
      resumeId: source,
      capabilities: {
        models: [], effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: true,
        supportsConversationFork: true, permissionModes: ["acceptEdits"],
      },
    }, noopCb, {
      spawn: (options: any) => { launches.push(options); return child; },
      kill: () => {},
    } as any);
    const fork = driver.forkSession(source, "/tmp/fork-worktree");
    await nextTask();
    assert.ok(launches[0].args.includes(settings));
    const args = launches[0].args as string[];
    const target = args[args.indexOf("--session-id") + 1]!;
    child.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: target }) + "\n");
    child.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: target, total_cost_usd: 0 }) + "\n");
    child.emit("close", 0);
    await fork;
    driver.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude fork rejects unverified capability and wrong source coordinate", async () => {
  const source = "11111111-2222-3333-4444-555555555555";
  const noCapability = new ClaudeCodeDriver({ ...baseOpts, resumeId: source }, noopCb);
  await assert.rejects(noCapability.forkSession(source, "/tmp/fork"), /not verified/);
  const verified = new ClaudeCodeDriver({
    ...baseOpts,
    resumeId: source,
    capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: false,
      supportsConversationFork: true,
    },
  }, noopCb);
  await assert.rejects(verified.forkSession("wrong", "/tmp/fork"), /does not match/);
});

test("Claude fork rejects a mismatched provider id and reaps the bootstrap process", async () => {
  const source = "11111111-2222-3333-4444-555555555555";
  const child = fakeProcess();
  const killed: any[] = [];
  const driver = new ClaudeCodeDriver({
    ...baseOpts,
    resumeId: source,
    capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: false,
      supportsConversationFork: true,
    },
  }, noopCb, { spawn: () => child, kill: (process: any) => killed.push(process) } as any);
  const fork = driver.forkSession(source, "/tmp/fork");
  child.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "wrong" }) + "\n");
  await assert.rejects(fork, /wrong session id/);
  assert.deepEqual(killed, [child]);
  driver.dispose();
});

test("Claude fork fails closed if the local bootstrap reports model cost", async () => {
  const source = "11111111-2222-3333-4444-555555555555";
  const child = fakeProcess();
  const killed: any[] = [];
  const launches: any[] = [];
  const driver = new ClaudeCodeDriver({
    ...baseOpts,
    resumeId: source,
    capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: false,
      supportsConversationFork: true,
    },
  }, noopCb, {
    spawn: (options: any) => { launches.push(options); return child; },
    kill: (process: any) => killed.push(process),
  } as any);
  const fork = driver.forkSession(source, "/tmp/fork");
  const args = launches[0].args as string[];
  const target = args[args.indexOf("--session-id") + 1]!;
  child.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: target }) + "\n");
  child.stdout.write(JSON.stringify({
    type: "result", subtype: "success", session_id: target, total_cost_usd: 0.01,
  }) + "\n");
  await assert.rejects(fork, /zero model cost/);
  assert.deepEqual(killed, [child]);
  driver.dispose();
});

test("system/init reports the provider-resolved model without emitting an event", () => {
  const h = makeHarness();
  const r = h.feed({
    type: "system",
    subtype: "init",
    session_id: "abc",
    model: "claude-opus-5[1m]",
  });
  assert.equal(r, null);
  assert.equal(h.events.length, 0);
  assert.equal(h.stderr.length, 0);
  assert.deepEqual(h.resolvedModels, ["claude-opus-5[1m]"]);
});

test("system/api_retry surfaces a stderr note (no onEvent)", () => {
  const h = makeHarness();
  const r = h.feed({
    type: "system",
    subtype: "api_retry",
    attempt: 2,
    max_retries: 5,
    error: "overloaded",
  });
  assert.equal(r, null);
  assert.equal(h.events.length, 0);
  assert.deepEqual(h.stderr, ["retry 2/5: overloaded"]);
});

test("system/api_retry converts authentication failures to a secret-free stop signal", () => {
  const h = makeHarness();
  const secretBearingError = "authentication_failed https://login.example/callback?token=secret";
  assert.equal(h.feed({
    type: "system",
    subtype: "api_retry",
    attempt: 1,
    max_retries: 5,
    error: secretBearingError,
  }), null);
  assert.equal(h.authenticationFailures, 1);
  assert.deepEqual(h.stderr, []);
  assert.equal(JSON.stringify(h.events).includes(secretBearingError), false);
});

test("stream_event text_delta -> agent_message", () => {
  const h = makeHarness();
  const r = h.feed({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Hello" },
    },
  });
  assert.equal(r, null);
  assert.deepEqual(h.events, [{ kind: "agent_message", text: "Hello" }]);
});

test("stream_event thinking_delta -> agent_thought", () => {
  const h = makeHarness();
  h.feed({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking: "pondering" },
    },
  });
  assert.deepEqual(h.events, [{ kind: "agent_thought", text: "pondering" }]);
});

test("Claude message_start id and block index identify only evidence-backed stream chunks", () => {
  const h = makeHarness();
  h.feed({ type: "stream_event", event: { type: "message_start", message: { id: "msg_1" } } });
  h.feed({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } } });
  h.feed({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } } });
  h.feed({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Second" } } });
  h.feed({ type: "stream_event", event: { type: "message_stop" } });
  h.feed({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Unscoped" } } });
  assert.deepEqual(h.events, [
    { kind: "agent_message", text: "Hel", messageId: "msg_1:0" },
    { kind: "agent_message", text: "lo", messageId: "msg_1:0" },
    { kind: "agent_message", text: "Second", messageId: "msg_1:1" },
    { kind: "agent_message", text: "Unscoped" },
  ]);
});

test("Claude stream identity is isolated between top-level and subagent message lanes", () => {
  const h = makeHarness();
  h.feed({ type: "stream_event", event: { type: "message_start", message: { id: "top" } } });
  h.feed({ type: "stream_event", parent_tool_use_id: "task-1", event: { type: "message_start", message: { id: "child" } } });
  h.feed({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Top" } } });
  h.feed({ type: "stream_event", parent_tool_use_id: "task-1", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Child" } } });
  assert.deepEqual(h.events, [
    { kind: "agent_message", text: "Top", messageId: "top:0" },
    { kind: "agent_message", text: "Child", messageId: "child:0", parentToolUseId: "task-1" },
  ]);
});

test("Claude cancellation drops identity once and leaves one coalescible id-less tail", () => {
  const h = makeHarness();
  h.feed({ type: "stream_event", event: { type: "message_start", message: { id: "msg_cancelled" } } });
  h.feed({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Before" } } });
  h.driver.cancel();
  h.feed({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " late" } } });
  h.feed({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " tail" } } });
  assert.deepEqual(h.events, [
    { kind: "agent_message", text: "Before", messageId: "msg_cancelled:0" },
    { kind: "agent_message", text: " late" },
    { kind: "agent_message", text: " tail" },
  ]);
});

test("stream_event text_delta with empty text emits nothing", () => {
  const h = makeHarness();
  h.feed({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "" },
    },
  });
  assert.equal(h.events.length, 0);
});

test("stream_event with no event object returns null and emits nothing", () => {
  const h = makeHarness();
  const r = h.feed({ type: "stream_event" });
  assert.equal(r, null);
  assert.equal(h.events.length, 0);
});

test("stream_event content_block_start tool_use -> pending tool_call", () => {
  const h = makeHarness();
  h.feed({
    type: "stream_event",
    event: {
      type: "content_block_start",
      content_block: { type: "tool_use", id: "tu_1", name: "Bash" },
    },
  });
  assert.deepEqual(h.events, [
    { kind: "tool_call", toolCallId: "tu_1", title: "Bash", toolKind: "execute", status: "pending" },
  ]);
});

test("assistant TodoWrite tool_use -> plan (+ tool_call)", () => {
  const h = makeHarness();
  h.feed({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "tu_todo",
          name: "TodoWrite",
          input: {
            todos: [
              { content: "first", status: "completed" },
              { content: "second", status: "in_progress" },
              { content: "third", status: "pending" },
              { activeForm: "fourth doing", status: "weird" },
            ],
          },
        },
      ],
    },
  });

  const plan = h.events.find((e) => e.kind === "plan");
  assert.ok(plan, "a plan event was emitted");
  assert.deepEqual((plan as Extract<SessionEventPayload, { kind: "plan" }>).entries, [
    { content: "first", status: "completed" },
    { content: "second", status: "in_progress" },
    { content: "third", status: "pending" },
    // unknown status falls back to "pending"; content falls back to activeForm
    { content: "fourth doing", status: "pending" },
  ]);

  // The TodoWrite also produces a tool_call (in_progress).
  const call = h.events.find((e) => e.kind === "tool_call");
  assert.ok(call, "a tool_call event was emitted for TodoWrite");
  assert.equal((call as Extract<SessionEventPayload, { kind: "tool_call" }>).status, "in_progress");
  assert.equal((call as Extract<SessionEventPayload, { kind: "tool_call" }>).toolCallId, "tu_todo");
});

test("assistant Edit tool_use -> file_edit + tool_call(edit)", () => {
  const h = makeHarness();
  const r = h.feed({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "tu_edit",
          name: "Edit",
          input: { file_path: "/repo/src/a.ts", old_string: "x", new_string: "y" },
        },
      ],
    },
  });
  assert.equal(r, null);

  const call = h.events.find((e) => e.kind === "tool_call") as Extract<
    SessionEventPayload,
    { kind: "tool_call" }
  >;
  assert.ok(call);
  assert.equal(call.toolCallId, "tu_edit");
  assert.equal(call.title, "Edit: /repo/src/a.ts");
  assert.equal(call.toolKind, "edit");
  assert.equal(call.status, "in_progress");
  assert.ok(typeof call.text === "string" && call.text.includes("file_path"));

  const fileEdit = h.events.find((e) => e.kind === "file_edit") as Extract<
    SessionEventPayload,
    { kind: "file_edit" }
  >;
  assert.ok(fileEdit, "file_edit emitted");
  assert.equal(fileEdit.path, "/repo/src/a.ts");

  // Order: tool_call precedes file_edit for the same block.
  assert.ok(h.events.indexOf(call) < h.events.indexOf(fileEdit));
});

test("assistant Write and MultiEdit also emit file_edit", () => {
  for (const name of ["Write", "MultiEdit"]) {
    const h = makeHarness();
    h.feed({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "x", name, input: { file_path: "/p/f" } },
        ],
      },
    });
    const fileEdit = h.events.find((e) => e.kind === "file_edit") as Extract<
      SessionEventPayload,
      { kind: "file_edit" }
    >;
    assert.ok(fileEdit, `${name} emits file_edit`);
    assert.equal(fileEdit.path, "/p/f");
  }
});

test("assistant Edit without a string file_path emits no file_edit", () => {
  const h = makeHarness();
  h.feed({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "x", name: "Edit", input: {} }],
    },
  });
  assert.equal(h.events.filter((e) => e.kind === "file_edit").length, 0);
  // still emits the tool_call
  assert.equal(h.events.filter((e) => e.kind === "tool_call").length, 1);
});

test("assistant non-edit tool (Bash) -> tool_call(execute), no file_edit", () => {
  const h = makeHarness();
  h.feed({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "b1", name: "Bash", input: { command: "ls -la" } },
      ],
    },
  });
  const call = h.events.find((e) => e.kind === "tool_call") as Extract<
    SessionEventPayload,
    { kind: "tool_call" }
  >;
  assert.equal(call.toolKind, "execute");
  assert.equal(call.title, "Bash: ls -la");
  assert.equal(h.events.filter((e) => e.kind === "file_edit").length, 0);
});

test("assistant non-tool_use blocks (text) are ignored", () => {
  const h = makeHarness();
  const r = h.feed({
    type: "assistant",
    message: { content: [{ type: "text", text: "hi there" }] },
  });
  assert.equal(r, null);
  assert.equal(h.events.length, 0);
});

test("assistant with no content array does not throw and emits nothing", () => {
  const h = makeHarness();
  const r = h.feed({ type: "assistant", message: {} });
  assert.equal(r, null);
  assert.equal(h.events.length, 0);
});

test("user tool_result (success) -> tool_call_update completed", () => {
  const h = makeHarness();
  const r = h.feed({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "tu_edit", is_error: false, content: "ok done" },
      ],
    },
  });
  assert.equal(r, null);
  assert.deepEqual(h.events, [
    { kind: "tool_call_update", toolCallId: "tu_edit", status: "completed", text: "ok done" },
  ]);
});

test("user tool_result error -> failed; array content is flattened", () => {
  const h = makeHarness();
  h.feed({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_bash",
          is_error: true,
          content: [{ type: "text", text: "boom" }, "!", { text: "x" }],
        },
      ],
    },
  });
  assert.deepEqual(h.events, [
    { kind: "tool_call_update", toolCallId: "tu_bash", status: "failed", text: "boom!x" },
  ]);
});

test("user tool_result missing tool_use_id falls back to 'tool'", () => {
  const h = makeHarness();
  h.feed({
    type: "user",
    message: { content: [{ type: "tool_result", content: "" }] },
  });
  const upd = h.events[0] as Extract<SessionEventPayload, { kind: "tool_call_update" }>;
  assert.equal(upd.toolCallId, "tool");
  assert.equal(upd.status, "completed");
});

test("result event -> token_usage then end_turn", () => {
  const h = makeHarness();
  const r = h.feed({
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 100,
      output_tokens: 42,
      cache_read_input_tokens: 80,
    },
  });
  assert.equal(r, "end_turn");
  assert.deepEqual(h.events, [
    {
      kind: "token_usage",
      inputTokens: 100,
      outputTokens: 42,
      cachedInputTokens: 80,
      costUsd: 0.0123,
    },
  ]);
});

test("subagent result attributes provider duration and usage to its spawning task", () => {
  const h = makeHarness();
  h.feed({
    type: "result",
    subtype: "success",
    parent_tool_use_id: "task1",
    duration_ms: 4321,
    usage: { input_tokens: 11, output_tokens: 5 },
  });
  assert.deepEqual(h.events, [{
    kind: "token_usage",
    inputTokens: 11,
    outputTokens: 5,
    cachedInputTokens: undefined,
    costUsd: undefined,
    durationMs: 4321,
    parentToolUseId: "task1",
  }]);
});

test("result is_error -> refusal (still emits token_usage first)", () => {
  const h = makeHarness();
  const r = h.feed({ type: "result", is_error: true, usage: {} });
  assert.equal(r, "refusal");
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].kind, "token_usage");
});

test("result subtype error_during_execution -> refusal", () => {
  const h = makeHarness();
  const r = h.feed({ type: "result", subtype: "error_during_execution" });
  assert.equal(r, "refusal");
});

test("result subtype error_max_turns -> max_turn_requests", () => {
  const h = makeHarness();
  const r = h.feed({ type: "result", subtype: "error_max_turns" });
  assert.equal(r, "max_turn_requests");
});

test("result with no usage emits token_usage with undefined fields", () => {
  const h = makeHarness();
  const r = h.feed({ type: "result", subtype: "success" });
  assert.equal(r, "end_turn");
  assert.deepEqual(h.events, [
    {
      kind: "token_usage",
      inputTokens: undefined,
      outputTokens: undefined,
      cachedInputTokens: undefined,
      costUsd: undefined,
    },
  ]);
});

test("unknown message type returns null and emits nothing", () => {
  const h = makeHarness();
  const r = h.feed({ type: "totally_unknown" });
  assert.equal(r, null);
  assert.equal(h.events.length, 0);
});

test("tool_use missing id/name falls back to 'tool'", () => {
  const h = makeHarness();
  h.feed({
    type: "assistant",
    message: { content: [{ type: "tool_use" }] },
  });
  const call = h.events[0] as Extract<SessionEventPayload, { kind: "tool_call" }>;
  assert.equal(call.toolCallId, "tool");
  assert.equal(call.title, "tool");
  assert.equal(call.toolKind, "other");
  // no input -> text undefined
  assert.equal(call.text, undefined);
});

test("after dispose, handleEvent is inert (returns null, no events)", () => {
  const h = makeHarness();
  h.driver.dispose();
  const r = h.feed({ type: "result", is_error: true, usage: {} });
  assert.equal(r, null);
  assert.equal(h.events.length, 0);
});

test("control_request (can_use_tool) -> permission_request with allow/deny options", () => {
  const h = makeHarness();
  // Asks are only meaningful while the process is alive (the child-null guard).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h.driver as any).child = { stdin: { write: () => {} } };
  const r = h.feed({
    type: "control_request",
    request_id: "req-1",
    request: { subtype: "can_use_tool", tool_name: "Write", description: "notes.md", input: { file_path: "notes.md", content: "hi" } },
  });
  assert.equal(r, null);
  assert.equal(h.events.length, 1);
  const ev = h.events[0]!;
  assert.equal(ev.kind, "permission_request");
  if (ev.kind !== "permission_request") return;
  assert.equal(ev.requestId, "req-1");
  assert.match(ev.title, /Write/);
  assert.deepEqual(
    ev.options.map((o) => o.optionId),
    ["allow", "deny"],
  );
  // the tool input is stashed so resolvePermission can echo it back on allow
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.deepEqual((h.driver as any).pendingApprovals.get("req-1"), { file_path: "notes.md", content: "hi" });
});

test("control_request without a description falls back to the tool input in the title (MCP card legibility)", () => {
  const h = makeHarness();
  // MCP tools (mcp__manager__*) are not guaranteed a description — without the fallback the
  // card would read just the tool name, making Allow/Reject a blind decision.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h.driver as any).child = { stdin: { write: () => {} } };
  const r = h.feed({
    type: "control_request",
    request_id: "req-mcp",
    request: {
      subtype: "can_use_tool",
      tool_name: "mcp__manager__create_session",
      input: { runnerId: "r1", agentId: "claude-code", prompt: "fix the flaky discovery test" },
    },
  });
  assert.equal(r, null);
  const ev = h.events[0]!;
  assert.equal(ev.kind, "permission_request");
  if (ev.kind !== "permission_request") return;
  assert.ok(ev.title.startsWith("mcp__manager__create_session: "), ev.title);
  assert.ok(ev.title.includes('"runnerId"'), "the input JSON rides the title");
  // tool name + ": " + 80-char truncation (+ ellipsis)
  assert.ok(ev.title.length <= "mcp__manager__create_session: ".length + 81, ev.title);
});

test("control_request with a description keeps the existing description-based title", () => {
  const h = makeHarness();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h.driver as any).child = { stdin: { write: () => {} } };
  h.feed({
    type: "control_request",
    request_id: "req-desc",
    request: { subtype: "can_use_tool", tool_name: "Write", description: "notes.md", input: { file_path: "notes.md" } },
  });
  const ev = h.events[0]!;
  if (ev.kind !== "permission_request") return assert.fail("expected a permission_request");
  assert.equal(ev.title, "Write: notes.md");
});

test("control_request with a non-permission subtype is auto-declined loudly (drift canary)", () => {
  const h = makeHarness();
  const writes: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h.driver as any).child = { stdin: { write: (s: string) => writes.push(s) } };
  const r = h.feed({ type: "control_request", request_id: "x", request: { subtype: "something_else" } });
  assert.equal(r, null);
  assert.equal(h.events.length, 0, "no permission_request for an unknown ask");
  assert.ok(
    h.stderr.some((s) => s.includes("unrecognized control_request")),
    "canary surfaced on stderr",
  );
  const frame = JSON.parse(writes[0]!);
  assert.deepEqual(frame, {
    type: "control_response",
    response: { subtype: "error", request_id: "x", error: "unsupported control request" },
  });
});

test("a control_request surfacing after process exit is dropped (no phantom card for a dead process)", () => {
  const h = makeHarness();
  // The close handler nulls child before the trailing-line flush — an ask parsed then is
  // unanswerable and must not mint a card or repopulate the just-cleared map.
  const r = h.feed({
    type: "control_request",
    request_id: "req-late",
    request: { subtype: "can_use_tool", tool_name: "Bash", description: "ls", input: {} },
  });
  assert.equal(r, null);
  assert.equal(h.events.length, 0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((h.driver as any).pendingApprovals.size, 0);
});

test("control_request without a string request_id is ignored entirely (no write, no event)", () => {
  const h = makeHarness();
  const writes: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h.driver as any).child = { stdin: { write: (s: string) => writes.push(s) } };
  const r = h.feed({ type: "control_request", request: { subtype: "something_else" } });
  assert.equal(r, null);
  assert.equal(h.events.length, 0);
  assert.equal(writes.length, 0);
});

/* ------------------- resolvePermission delivery contract ------------------ */

function askThenChild(h: Harness): string[] {
  const writes: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h.driver as any).child = { stdin: { write: (s: string) => writes.push(s) } };
  h.feed({
    type: "control_request",
    request_id: "req-1",
    request: { subtype: "can_use_tool", tool_name: "Bash", description: "ls", input: { command: "ls" } },
  });
  return writes;
}

test("resolvePermission('allow') writes the exact control_response with the stashed input verbatim and returns true", () => {
  const h = makeHarness();
  const writes = askThenChild(h);
  assert.equal(h.driver.resolvePermission("req-1", "allow"), true);
  const frame = JSON.parse(writes[0]!);
  assert.deepEqual(frame, {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "req-1",
      response: { behavior: "allow", updatedInput: { command: "ls" } },
    },
  });
  assert.ok(writes[0]!.endsWith("\n"), "JSONL frame");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((h.driver as any).pendingApprovals.has("req-1"), false, "ask consumed");
});

test("resolvePermission('deny') writes the deny message and returns true; deny does not end the turn", () => {
  const h = makeHarness();
  const writes = askThenChild(h);
  assert.equal(h.driver.resolvePermission("req-1", "deny"), true);
  const frame = JSON.parse(writes[0]!);
  assert.deepEqual(frame.response.response, { behavior: "deny", message: "The user declined this tool call." });
});

test("resolvePermission returns false for an unknown requestId and writes nothing", () => {
  const h = makeHarness();
  const writes = askThenChild(h);
  assert.equal(h.driver.resolvePermission("nope", "allow"), false);
  assert.equal(writes.length, 0);
});

test("resolvePermission returns false when the child is gone (exited before the click)", () => {
  const h = makeHarness();
  askThenChild(h);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h.driver as any).child = null;
  assert.equal(h.driver.resolvePermission("req-1", "allow"), false);
});

test("resolvePermission returns false when the stdin write throws (dead pipe), swallowing the error", () => {
  const h = makeHarness();
  askThenChild(h);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h.driver as any).child = {
    stdin: {
      write: () => {
        throw new Error("EPIPE");
      },
    },
  };
  assert.equal(h.driver.resolvePermission("req-1", "allow"), false);
});

test("claudePermissionArgs: 'default' uses the stdio prompt tool (interactive, no --permission-mode)", () => {
  const { interactive, args } = claudePermissionArgs("default");
  assert.equal(interactive, true);
  assert.deepEqual(args, ["--input-format", "stream-json", "--permission-prompt-tool", "stdio"]);
  assert.equal(args.includes("--permission-mode"), false);
});

test("claudePermissionArgs: 'auto' is interactive AND passes --permission-mode auto (classifier + UI escalation)", () => {
  const { interactive, args } = claudePermissionArgs("auto");
  assert.equal(interactive, true);
  // stdio prompt tool so blocked actions escalate to the UI instead of aborting the -p run
  assert.ok(args.includes("--permission-prompt-tool") && args.includes("stdio"));
  // and the classifier mode itself
  const i = args.indexOf("--permission-mode");
  assert.ok(i >= 0 && args[i + 1] === "auto");
});

test("claudePermissionArgs: fixed-rule modes are non-interactive, just --permission-mode <mode>", () => {
  for (const mode of ["acceptEdits", "plan", "bypassPermissions"]) {
    const { interactive, streamInput, args } = claudePermissionArgs(mode);
    assert.equal(interactive, false, `${mode} is non-interactive`);
    assert.equal(streamInput, false, `${mode} without images uses plain-text stdin`);
    assert.deepEqual(args, ["--permission-mode", mode]);
  }
});

test("claudePermissionArgs: a fixed-rule mode WITH images switches to stream-json input", () => {
  const { interactive, streamInput, args } = claudePermissionArgs("acceptEdits", true);
  assert.equal(interactive, false); // still no approvals
  assert.equal(streamInput, true); // but images must ride as content blocks
  assert.deepEqual(args, ["--input-format", "stream-json", "--permission-mode", "acceptEdits"]);
});

test("claudePermissionArgs: interactive modes always stream input", () => {
  assert.equal(claudePermissionArgs("default").streamInput, true);
  assert.equal(claudePermissionArgs("auto", true).streamInput, true);
});

test("buildClaudeUserMessage: text + base64 image content blocks (Messages API shape)", () => {
  const msg = buildClaudeUserMessage("look at this", [{ mimeType: "image/png", data: "AAAA" }]);
  assert.equal(msg.type, "user");
  assert.deepEqual(msg.message.content, [
    { type: "text", text: "look at this" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
  ]);
});

test("buildClaudeUserMessage: image-only (no text) omits the empty text block", () => {
  const msg = buildClaudeUserMessage("", [{ mimeType: "image/jpeg", data: "ZZ" }]);
  assert.deepEqual(msg.message.content, [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "ZZ" } },
  ]);
});

test("buildClaudeUserMessage: never produces empty content (falls back to an empty text block)", () => {
  assert.deepEqual(buildClaudeUserMessage("", []).message.content, [{ type: "text", text: "" }]);
});

test("normalizeQuestions maps AskUserQuestion input, keying ids by question text", () => {
  const qs = normalizeQuestions({
    questions: [
      {
        question: "Which language?",
        header: "Language",
        multiSelect: false,
        options: [
          { label: "TypeScript", description: "Node.js" },
          { label: "Python" },
        ],
      },
      { question: "", options: [] }, // dropped: empty question
      { question: "Pick features", multiSelect: true, options: [{ label: "Auth" }, { label: "API" }] },
    ],
  });
  assert.equal(qs.length, 2);
  assert.equal(qs[0]!.id, "Which language?");
  assert.equal(qs[0]!.header, "Language");
  assert.deepEqual(qs[0]!.options.map((o) => o.label), ["TypeScript", "Python"]);
  assert.equal(qs[1]!.multiSelect, true);
});

test("normalizeQuestions tolerates malformed input", () => {
  assert.deepEqual(normalizeQuestions(null), []);
  assert.deepEqual(normalizeQuestions({}), []);
  assert.deepEqual(normalizeQuestions({ questions: "nope" }), []);
});

test("renderApprovalInput shows the command for Bash and path+content for Write, bounded", () => {
  assert.equal(renderApprovalInput("Bash", { command: "rm -rf build" }), "rm -rf build");
  assert.equal(
    renderApprovalInput("Write", { file_path: "/repo/a.ts", content: "export {}" }),
    "/repo/a.ts\n---\nexport {}",
  );
  const big = renderApprovalInput("Bash", { command: "x".repeat(5000) })!;
  assert.ok(big.length <= 2001, `bounded (got ${big.length})`);
  assert.equal(renderApprovalInput("Whatever", null), undefined);
  assert.ok(renderApprovalInput("Other", { a: 1 })!.includes('"a": 1'));
});

test("approvalScopeContext extracts only bounded structured path/network/branch selectors", () => {
  assert.deepEqual(approvalScopeContext({
    file_path: "/repo/a.ts",
    url: "https://api.example.com/v1",
    branch_name: "feature/x",
  }), {
    path: "/repo/a.ts",
    network: "https://api.example.com/v1",
    branch: "feature/x",
  });
  assert.equal(approvalScopeContext({ path: "x".repeat(2000) }).path?.length, 1025);
  assert.deepEqual(approvalScopeContext("free form"), {});
});

test("normalizeQuestions rejects duplicate question text (the answer map can't represent both)", () => {
  const qs = normalizeQuestions({
    questions: [
      { question: "Pick one", options: [{ label: "A" }] },
      { question: "Pick one", header: "Other", options: [{ label: "B" }] },
    ],
  });
  assert.deepEqual(qs, []);
});

test("normalizeQuestions rejects the whole ask when any question has zero valid options", () => {
  const qs = normalizeQuestions({
    questions: [
      { question: "Answerable", options: [{ label: "A" }] },
      { question: "Unanswerable", options: [] },
    ],
  });
  assert.deepEqual(qs, [], "one option-less question poisons the ask (deny, not an unanswerable card)");
});

test("parent_tool_use_id is carried onto subagent events; absent for top-level", () => {
  const h = makeHarness();
  // Top-level assistant tool_use: no parentToolUseId key.
  h.feed({ type: "assistant", message: { content: [{ type: "tool_use", id: "task1", name: "Task", input: {} }] } });
  const top = h.events.find((e) => e.kind === "tool_call") as Extract<SessionEventPayload, { kind: "tool_call" }>;
  assert.equal("parentToolUseId" in top, false, "a top-level call carries no parent");
  assert.equal(top.toolKind, "agent");

  // A subagent assistant message + tool_use tagged with the Task's id.
  h.feed({
    type: "assistant",
    parent_tool_use_id: "task1",
    message: { content: [{ type: "tool_use", id: "grep1", name: "Grep", input: { pattern: "x" } }] },
  });
  const child = h.events.find(
    (e) => e.kind === "tool_call" && (e as { toolCallId?: string }).toolCallId === "grep1",
  ) as Extract<SessionEventPayload, { kind: "tool_call" }>;
  assert.equal(child.parentToolUseId, "task1");

  // A subagent tool_result → tool_call_update carries the parent too.
  h.feed({
    type: "user",
    parent_tool_use_id: "task1",
    message: { content: [{ type: "tool_result", tool_use_id: "grep1", content: "found" }] },
  });
  const upd = h.events.find((e) => e.kind === "tool_call_update") as Extract<SessionEventPayload, { kind: "tool_call_update" }>;
  assert.equal(upd.parentToolUseId, "task1");

  // A null parent_tool_use_id (top-level, explicit) yields no key.
  h.feed({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "read1", name: "Read", input: {} }] } });
  const top2 = h.events.find((e) => e.kind === "tool_call" && (e as { toolCallId?: string }).toolCallId === "read1") as Extract<SessionEventPayload, { kind: "tool_call" }>;
  assert.equal("parentToolUseId" in top2, false);
});

test("parented assistant message usage emits a subagent token rollup without duplicating top-level usage", () => {
  const h = makeHarness();
  h.feed({
    type: "assistant",
    parent_tool_use_id: "task1",
    message: { content: [], usage: { input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 2 } },
  });
  assert.deepEqual(h.events, [{
    kind: "token_usage",
    inputTokens: 9,
    outputTokens: 4,
    cachedInputTokens: 2,
    parentToolUseId: "task1",
  }]);

  const top = makeHarness();
  top.feed({ type: "assistant", message: { content: [], usage: { input_tokens: 99, output_tokens: 99 } } });
  assert.deepEqual(top.events, [], "the terminal result remains authoritative for top-level usage");
});

test("stream_event deltas + TodoWrite/Edit carry the subagent parent", () => {
  const h = makeHarness();
  // Streaming text + thinking + a tool_use start, all inside a subagent.
  h.feed({ type: "stream_event", parent_tool_use_id: "task1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } });
  h.feed({ type: "stream_event", parent_tool_use_id: "task1", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } });
  h.feed({ type: "stream_event", parent_tool_use_id: "task1", event: { type: "content_block_start", content_block: { type: "tool_use", id: "g1", name: "Grep" } } });
  const msg = h.events.find((e) => e.kind === "agent_message") as Extract<SessionEventPayload, { kind: "agent_message" }>;
  const th = h.events.find((e) => e.kind === "agent_thought") as Extract<SessionEventPayload, { kind: "agent_thought" }>;
  const call = h.events.find((e) => e.kind === "tool_call") as Extract<SessionEventPayload, { kind: "tool_call" }>;
  assert.equal(msg.parentToolUseId, "task1");
  assert.equal(th.parentToolUseId, "task1");
  assert.equal(call.parentToolUseId, "task1");

  // A subagent TodoWrite → plan carries the parent; a subagent Edit → file_edit too.
  const h2 = makeHarness();
  h2.feed({
    type: "assistant",
    parent_tool_use_id: "task1",
    message: { content: [{ type: "tool_use", id: "td", name: "TodoWrite", input: { todos: [{ content: "x", status: "pending" }] } }] },
  });
  const plan = h2.events.find((e) => e.kind === "plan") as Extract<SessionEventPayload, { kind: "plan" }>;
  assert.equal(plan.parentToolUseId, "task1");

  h2.feed({
    type: "assistant",
    parent_tool_use_id: "task1",
    message: { content: [{ type: "tool_use", id: "ed", name: "Edit", input: { file_path: "/repo/a.ts" } }] },
  });
  const fe = h2.events.find((e) => e.kind === "file_edit") as Extract<SessionEventPayload, { kind: "file_edit" }>;
  assert.equal(fe.parentToolUseId, "task1");
});

test("empty-string parent_tool_use_id omits the key (treated as top-level)", () => {
  const h = makeHarness();
  h.feed({ type: "assistant", parent_tool_use_id: "", message: { content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] } });
  const call = h.events.find((e) => e.kind === "tool_call") as Extract<SessionEventPayload, { kind: "tool_call" }>;
  assert.equal("parentToolUseId" in call, false);
});
