import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { AgentDefinition } from "@wollipog/protocol";
import { probeClaudeCode, applyClaudeAgentEnvironment } from "./discovery/claude-code.js";
import { DiscoveryRecovery, DISCOVERY_RECOVERY_DELAY_MS, DISCOVERY_RECOVERY_ATTEMPTS } from "./discovery-recovery.js";

test("transient Claude discovery recovers without starting a Claude session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const logs: string[] = [];
  let pass = 0;
  let agents: AgentDefinition[] = [];
  const discover = async (retry = false) => {
    recovery.begin(retry);
    const failing = ++pass === 1;
    const capability = await probeClaudeCode(async (args) => {
      if (args[0] === "--help" && failing) return { code: 1, stdout: "", stderr: "private provider text", timedOut: true };
      return { code: 0, stderr: "", stdout: args[0] === "--version" ? "2.1.299"
        : args[0] === "--help" ? '--input-format stream-json\n--output-format stream-json\n--permission-mode (choices: "acceptEdits")'
          : JSON.stringify({ loggedIn: true }) };
    }, "path");
    agents = [applyClaudeAgentEnvironment({ id: "claude", name: "Claude", command: "claude", args: [], env: {},
      driver: "claude-code", claudeCode: capability, available: false })];
    recovery.complete(agents);
  };
  const recovery = new DiscoveryRecovery(() => { void discover(true); }, (line) => logs.push(line));
  t.after(() => recovery.dispose());
  await discover();
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
