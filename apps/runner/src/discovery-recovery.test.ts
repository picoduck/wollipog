import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { AgentDefinition } from "@wollipog/protocol";
import { probeClaudeCode, applyClaudeAgentEnvironment } from "./discovery/claude-code.js";
import { DiscoveryCoordinator, DiscoveryRecovery, DISCOVERY_RECOVERY_DELAY_MS, DISCOVERY_RECOVERY_ATTEMPTS } from "./discovery-recovery.js";

test("transient Claude discovery recovers without starting a Claude session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const logs: string[] = [];
  let pass = 0;
  let agents: AgentDefinition[] = [];
  const discover = async () => {
    const failing = ++pass === 1;
    const capability = await probeClaudeCode(async (args) => {
      if (args[0] === "--help" && failing) return { code: 1, stdout: "", stderr: "private provider text", timedOut: true };
      return { code: 0, stderr: "", stdout: args[0] === "--version" ? "2.1.299"
        : args[0] === "--help" ? '--input-format stream-json\n--output-format stream-json\n--permission-mode (choices: "acceptEdits")'
          : JSON.stringify({ loggedIn: true }) };
    }, "path");
    agents = [applyClaudeAgentEnvironment({ id: "claude", name: "Claude", command: "claude", args: [], env: {},
      driver: "claude-code", claudeCode: capability, available: false })];
    return agents;
  };
  const recovery = new DiscoveryCoordinator(discover, (line) => logs.push(line), (error) => { throw error; });
  t.after(() => recovery.stop());
  await recovery.run();
  assert.equal(agents[0]!.available, false);
  assert.equal(agents[0]!.claudeCode?.failure?.code, "probe_timeout");
  t.mock.timers.tick(DISCOVERY_RECOVERY_DELAY_MS);
  await setImmediate();
  assert.equal(agents[0]!.available, true);
  assert.equal(pass, 2);
  assert.deepEqual(logs.map((line) => JSON.parse(line).reason), ["probe_timeout", "recovered"]);
  assert.equal(JSON.parse(logs[0]!).observedAt, 1000);
  assert.equal(JSON.parse(logs[1]!).entryPoint, "automatic_recovery");
  assert.doesNotMatch(logs.join(""), /private provider text/);
  t.mock.timers.tick(60_000);
  assert.equal(pass, 2, "success cancels recovery work");
});

test("steady definitive failures log once, changed reasons and recovery log once, and recurrence is visible", () => {
  const logs: string[] = [];
  const recovery = new DiscoveryRecovery(() => assert.fail("no transient failure"), (line) => logs.push(line));
  const observe = (reason?: "claude_unavailable" | "unauthenticated") => {
    recovery.begin();
    recovery.complete([{ id: "claude", driver: "claude-code", available: !reason,
      ...(reason ? { claudeCode: { failure: { code: reason } } } : {}) } as AgentDefinition]);
  };
  observe("claude_unavailable"); observe("claude_unavailable");
  observe("unauthenticated"); observe("unauthenticated");
  observe(); observe();
  observe("unauthenticated");
  assert.deepEqual(logs.map((line) => JSON.parse(line).reason),
    ["claude_unavailable", "unauthenticated", "recovered", "unauthenticated"]);
});

test("production coordinator bounds recovery, and a coalesced refresh resets the normal pass budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const agents = [{ id: "claude", driver: "claude-code", available: false,
    claudeCode: { failure: { code: "probe_timeout", retryable: true } } }] as AgentDefinition[];
  const calls: boolean[][] = [];
  let release: (() => void) | undefined;
  let held = true;
  const coordinator = new DiscoveryCoordinator(async (models, usage) => {
    calls.push([models, usage]);
    if (held) await new Promise<void>((resolve) => { release = resolve; });
    return agents;
  }, () => {}, (error) => { throw error; });
  t.after(() => coordinator.stop());
  const first = coordinator.run(false, false);
  await coordinator.run(true, false);
  await coordinator.run(false, true);
  assert.equal(calls.length, 1, "concurrent requests must not start parallel probes");
  held = false; release!(); await first; await setImmediate();
  assert.deepEqual(calls, [[false, false], [true, true]], "refresh flags coalesce into one normal pass");
  for (let i = 0; i < 10; i++) { t.mock.timers.tick(DISCOVERY_RECOVERY_DELAY_MS); await setImmediate(); }
  assert.equal(calls.length, 2 + DISCOVERY_RECOVERY_ATTEMPTS, "recovery callbacks must retain their bounded budget");
  assert.deepEqual(calls.slice(2), [[false, false], [false, false]], "retries do not force model or usage refresh");
  await coordinator.run();
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(DISCOVERY_RECOVERY_DELAY_MS); await setImmediate(); }
  assert.equal(calls.length, 3 + 2 * DISCOVERY_RECOVERY_ATTEMPTS, "ordinary inventory starts a fresh recovery budget");
});

test("production coordinator ignores late discovery results and coalesced work after shutdown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let release!: (agents: AgentDefinition[]) => void;
  const logs: string[] = [];
  const coordinator = new DiscoveryCoordinator(async () => {
    calls++;
    return new Promise<AgentDefinition[]>((resolve) => { release = resolve; });
  }, (line) => logs.push(line), (error) => { throw error; });
  const active = coordinator.run();
  await coordinator.run(true, true);
  coordinator.stop();
  release([{ id: "claude", driver: "claude-code", available: false,
    claudeCode: { failure: { code: "probe_timeout", retryable: true } } } as AgentDefinition]);
  await active;
  t.mock.timers.tick(60_000); await setImmediate();
  await coordinator.run();
  assert.equal(calls, 1);
  assert.deepEqual(logs, [], "late results must not schedule or report recovery after shutdown");
});

test("production coordinator reports a failed pass and still runs its queued refresh", async () => {
  let reject!: (error: unknown) => void;
  let calls = 0;
  const failures: unknown[] = [];
  const coordinator = new DiscoveryCoordinator(async () => {
    if (++calls === 1) return new Promise<AgentDefinition[]>((_, fail) => { reject = fail; });
    return [];
  }, () => {}, (error) => failures.push(error));
  const first = coordinator.run();
  await coordinator.run(true, true);
  reject(new Error("fixture failure")); await first; await setImmediate();
  coordinator.stop();
  assert.equal(calls, 2);
  assert.equal(failures.length, 1);
});

test("persistent discovery failures stop retrying, normal inventory gets a fresh bounded budget, and shutdown cancels", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const agents = [{ id: "claude", driver: "claude-code", available: false,
    claudeCode: { failure: { code: "probe_failed", retryable: true } } }] as AgentDefinition[];
  const recovery = new DiscoveryRecovery(() => { calls++; recovery.begin(true); recovery.complete(agents); }, () => {});
  recovery.begin(); recovery.complete(agents);
  for (let i = 0; i < 10; i++) t.mock.timers.tick(DISCOVERY_RECOVERY_DELAY_MS);
  assert.equal(calls, DISCOVERY_RECOVERY_ATTEMPTS);
  recovery.begin(); recovery.complete(agents);
  t.mock.timers.tick(DISCOVERY_RECOVERY_DELAY_MS);
  assert.equal(calls, DISCOVERY_RECOVERY_ATTEMPTS + 1);
  recovery.dispose();
  t.mock.timers.tick(60_000);
  assert.equal(calls, DISCOVERY_RECOVERY_ATTEMPTS + 1);
});

test("definitive authentication, unsupported installs and operator selection do not trigger recovery", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const recovery = new DiscoveryRecovery(() => { calls++; }, () => {});
  for (const code of ["unauthenticated", "unsupported_mode", "claude_unavailable"] as const) {
    recovery.begin();
    recovery.complete([{ id: "claude", driver: "claude-code", available: false,
      claudeCode: { failure: { code } } } as AgentDefinition]);
    t.mock.timers.tick(60_000);
  }
  recovery.begin();
  recovery.complete([{ id: "claude", driver: "claude-code", available: false, harnessSelectionBlocked: true,
    claudeCode: { failure: { code: "probe_timeout", retryable: true } } } as AgentDefinition]);
  t.mock.timers.tick(60_000);
  assert.equal(calls, 0);
});
