import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDefinition, GenerateSessionTitleMessage } from "@wollipog/protocol";
import {
  SESSION_NAMING_GENERATION_BUDGET_MS,
  SESSION_NAMING_PREPARATION_BUDGET_MS,
  SESSION_NAMING_RUNNER_BUDGET_MS,
} from "@wollipog/protocol";
import {
  CODEX_SESSION_NAMING_DISABLED_FEATURES,
  claudeSessionNamingArgs,
  codexSessionNamingArgs,
  codexSessionNamingThreadParams,
  codexSessionNamingTurnParams,
  normalizeRunnerSessionTitle,
  SessionNamingExecutor,
  sessionNamingAccountForAgent,
  sessionNamingPreparationBudgetMs,
} from "./session-naming.js";

function claudeAgent(): AgentDefinition {
  return {
    id: "claude-code",
    name: "Claude Code",
    command: "claude",
    args: [],
    env: {},
    driver: "claude-code",
    context: { kind: "native" },
    available: true,
    authStatus: "authenticated",
    claudeCode: {
      status: "ready",
      effortLevels: [],
      permissionModes: ["plan"],
      streamJsonInput: true,
      streamJsonImages: true,
      controlProtocol: true,
      forkSession: true,
      replayUserMessages: true,
      sessionNaming: true,
      auth: { status: "authenticated", billingSource: "subscription" },
    },
  };
}

function codexAgent(): AgentDefinition {
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
    codexAppServer: {
      status: "supported",
      appServerAvailable: true,
      transport: "stdio",
      verification: "help-and-version",
      contractFingerprint: "test",
      sessionNaming: true,
    },
  };
}

function request(id = "request-one"): GenerateSessionTitleMessage {
  return {
    type: "generate_session_title",
    requestId: id,
    sessionId: "session-one",
    messages: [{ role: "user", text: "Fix the session naming flow" }],
    timeoutMs: SESSION_NAMING_RUNNER_BUDGET_MS,
  };
}

test("provider eligibility requires verified authenticated native account surfaces", () => {
  assert.deepEqual(sessionNamingAccountForAgent(claudeAgent()), {
    provider: "claude",
    billingSource: "subscription",
  });
  assert.deepEqual(sessionNamingAccountForAgent(codexAgent()), {
    provider: "codex",
    billingSource: "provider_account",
  });
  assert.deepEqual(sessionNamingAccountForAgent({ ...codexAgent(), codexBillingSource: "api" }), {
    provider: "codex",
    billingSource: "api",
  });
  assert.equal(sessionNamingAccountForAgent({ ...claudeAgent(), authStatus: "unknown" }), null);
  assert.equal(sessionNamingAccountForAgent({
    ...codexAgent(),
    codexAppServer: { status: "unsupported", appServerAvailable: true },
  }), null);
  assert.equal(sessionNamingAccountForAgent({
    ...codexAgent(),
    codexAppServer: { ...codexAgent().codexAppServer!, sessionNaming: false },
  }), null);
});

test("Claude naming argv disables tools, persistence, repository customizations, MCP, and browser integration", () => {
  const args = claudeSessionNamingArgs(["--configured-prefix"]);
  assert.deepEqual(args.slice(0, 2), ["--configured-prefix", "-p"]);
  for (const flag of [
    "--safe-mode",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--no-chrome",
  ]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
  assert.equal(args.some((arg) => arg.includes("Fix the session naming flow")), false, "user text never enters argv");
});

test("Codex naming uses an ephemeral read-only thread and a no-approval turn", () => {
  const thread = codexSessionNamingThreadParams("/neutral");
  assert.equal(thread.cwd, "/neutral");
  assert.equal(thread.ephemeral, true);
  assert.equal(thread.approvalPolicy, "never");
  assert.equal(thread.sandbox, "read-only");
  assert.equal(thread.dynamicTools, undefined, "experimental fields stay out of the unnegotiated request");
  assert.equal(thread.environments, undefined, "experimental fields stay out of the unnegotiated request");
  assert.equal(thread.selectedCapabilityRoots, undefined, "experimental fields stay out of the unnegotiated request");
  assert.equal(thread.config, undefined);

  const turn = codexSessionNamingTurnParams("thread-one", "/neutral", "bounded prompt");
  assert.equal(turn.approvalPolicy, "never");
  assert.deepEqual(turn.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.equal(turn.environments, undefined, "experimental fields stay out of the unnegotiated request");
  assert.deepEqual(turn.input, [{ type: "text", text: "bounded prompt" }]);
  assert.deepEqual(turn.outputSchema, {
    type: "object",
    properties: { title: { type: "string", minLength: 1, maxLength: 120, pattern: "^[^\\r\\n]+$" } },
    required: ["title"],
    additionalProperties: false,
  });

  const args = codexSessionNamingArgs(["--configured-prefix"]);
  assert.equal(args[0], "--configured-prefix");
  assert.deepEqual(args.slice(-3), ["--config", "mcp_servers={}", "app-server"]);
  for (const feature of CODEX_SESSION_NAMING_DISABLED_FEATURES) {
    const index = args.indexOf(feature);
    assert.ok(index > 0 && args[index - 1] === "--disable", feature);
  }
});

test("explicit naming targets pass only an advertised model and effort to the selected harness", async () => {
  const target = { agentId: "codex", driver: "codex-app-server" as const, model: "luna", effort: "low" };
  const codex = {
    ...codexAgent(),
    capabilities: {
      models: [{ id: "luna", displayName: "Luna", efforts: ["low", "medium"] }],
      effortLevels: ["low", "medium"],
      slashCommands: [],
      supportsImages: false,
      supportsApprovals: true,
    },
  };
  const turn = codexSessionNamingTurnParams("thread", "/neutral", "prompt", target);
  assert.equal(turn.model, "luna");
  assert.equal(turn.effort, "low");
  const claudeArgs = claudeSessionNamingArgs([], {
    agentId: "claude-code", driver: "claude-code", model: "haiku", effort: "low",
  });
  assert.deepEqual(claudeArgs.slice(0, 4), ["--model", "haiku", "--effort", "low"]);

  let generated = 0;
  const executor = new SessionNamingExecutor({
    prepareDirectory: async () => ({ cwd: "/neutral", cleanup: async () => {} }),
    generate: async () => { generated++; return "Explicit Target"; },
  });
  assert.equal((await executor.execute({ ...request(), target }, codex, {})).ok, true);
  assert.deepEqual(await executor.execute(
    { ...request("bad-effort"), target: { ...target, effort: "max" } }, codex, {}, 97,
  ), {
    type: "generate_session_title_result", requestId: "bad-effort", ok: false, code: "model_unavailable", phase: "preflight",
  });
  assert.deepEqual(await executor.execute(
    { ...request("bad-model"), target: { ...target, model: "unknown" } }, codex, {}, 97,
  ), {
    type: "generate_session_title_result", requestId: "bad-model", ok: false, code: "model_unavailable", phase: "preflight",
  });
  assert.equal((await executor.execute(
    { ...request("bad-harness"), target: { ...target, agentId: "missing" } }, codex, {}, 97,
  )).code,
    "harness_unavailable");
  assert.equal((await executor.execute(
    { ...request("unknown-peer"), target: { ...target, agentId: "missing" } }, codex, {},
  )).code, "session_unavailable", "an unknown control-plane version fails closed to the legacy vocabulary");
  assert.equal((await executor.execute(
    { ...request("legacy-bad-model"), target: { ...target, model: "unknown" } }, codex, {}, 96,
  )).code, "provider_unsupported", "older control planes receive the legacy model-drift code");
  assert.equal((await executor.execute(
    { ...request("legacy-bad-harness"), target: { ...target, agentId: "missing" } }, codex, {}, 96,
  )).code, "session_unavailable", "older control planes receive the legacy harness-drift code");
  assert.equal((await executor.execute(
    { ...request("harness-capability"), target }, {
      ...codex,
      codexAppServer: { ...codex.codexAppServer!, sessionNaming: false },
    }, {}, 97,
  )).code, "harness_unavailable");
  assert.equal((await executor.execute(
    { ...request("legacy-harness-capability"), target }, {
      ...codex,
      codexAppServer: { ...codex.codexAppServer!, sessionNaming: false },
    }, {}, 96,
  )).code, "session_unavailable");
  assert.equal(generated, 1, "invalid targets never reach provider execution");
});

test("runner title normalization rejects multiline, oversized, and malformed model output", () => {
  assert.equal(normalizeRunnerSessionTitle("  Semantic Session Names  "), "Semantic Session Names");
  assert.equal(normalizeRunnerSessionTitle('{"title":"Runner Account Naming"}'), "Runner Account Naming");
  assert.equal(normalizeRunnerSessionTitle("one\ntwo"), null);
  assert.equal(normalizeRunnerSessionTitle("x".repeat(121)), null);
  assert.equal(normalizeRunnerSessionTitle('{"other":"missing"}'), null);
});

test("executor returns only a bounded title and secret-free provider boundary", async () => {
  let cleaned = 0;
  let boundaryCleaned = 0;
  const isolation = { backend: "bwrap" as const, command: "bwrap", args: [], network: "inherit" as const };
  const executor = new SessionNamingExecutor({
    prepareDirectory: async () => ({ cwd: "/neutral", cleanup: async () => { cleaned += 1; } }),
    authorize: async (_agent, env, cwd) => {
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "runner-secret");
      assert.equal(cwd, "/neutral");
      return { isolation, cleanup: async () => { boundaryCleaned += 1; } };
    },
    generate: async (account, _agent, cwd, env, prompt, timeoutMs, actualIsolation) => {
      assert.deepEqual(account, { provider: "claude", billingSource: "subscription" });
      assert.equal(cwd, "/neutral");
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "runner-secret");
      assert.match(prompt, /Fix the session naming flow/);
      // Generation keeps its whole allowance; preparation is charged to its own budget.
      assert.ok(timeoutMs >= SESSION_NAMING_GENERATION_BUDGET_MS && timeoutMs <= SESSION_NAMING_RUNNER_BUDGET_MS,
        `unexpected remaining timeout ${timeoutMs}`);
      assert.equal(actualIsolation, isolation);
      return "Runner-Hosted Session Naming";
    },
  });
  const result = await executor.execute(request(), claudeAgent(), { CLAUDE_CODE_OAUTH_TOKEN: "runner-secret" });
  assert.deepEqual(result, {
    type: "generate_session_title_result",
    requestId: "request-one",
    ok: true,
    title: "Runner-Hosted Session Naming",
    provider: "claude",
    billingSource: "subscription",
  });
  assert.equal(JSON.stringify(result).includes("runner-secret"), false);
  assert.equal(cleaned, 1);
  assert.equal(boundaryCleaned, 1);
});

test("the naming budget splits an explicit preparation allowance from the generation allowance", () => {
  assert.equal(SESSION_NAMING_PREPARATION_BUDGET_MS + SESSION_NAMING_GENERATION_BUDGET_MS,
    SESSION_NAMING_RUNNER_BUDGET_MS, "the chain must account for preparation, not absorb it");
  assert.ok(SESSION_NAMING_GENERATION_BUDGET_MS > 5_000,
    "generation alone must outlast the old five-second total budget");
  assert.equal(sessionNamingPreparationBudgetMs(SESSION_NAMING_RUNNER_BUDGET_MS),
    SESSION_NAMING_PREPARATION_BUDGET_MS);
  // A smaller total scales preparation down rather than starving generation of a fixed 3s.
  assert.equal(sessionNamingPreparationBudgetMs(5_000), 1_000);
  assert.ok(sessionNamingPreparationBudgetMs(250) <= 250);
  // Any requested budget stays clamped to the bounded runner maximum.
  assert.equal(sessionNamingPreparationBudgetMs(10 * 60_000), SESSION_NAMING_PREPARATION_BUDGET_MS);
});

test("slow preparation is charged to its own allowance and leaves generation the full budget", async () => {
  // An injected clock keeps this deterministic: no wall-clock waiting, no sleeping test.
  let clock = 1_000;
  const observed: number[] = [];
  const executor = new SessionNamingExecutor({
    now: () => clock,
    prepareDirectory: async () => {
      clock += 1_800;
      return { cwd: "/neutral", cleanup: async () => {} };
    },
    authorize: async () => {
      clock += 1_000;
      return { cleanup: async () => {} };
    },
    generate: async (_account, _agent, _cwd, _env, _prompt, timeoutMs) => {
      observed.push(timeoutMs);
      return "Naming After Slow Preparation";
    },
  });
  const result = await executor.execute(request(), claudeAgent(), {});
  assert.equal(result.ok, true);
  assert.equal(result.title, "Naming After Slow Preparation");
  // 2.8s of isolation and authentication used to leave ~2.2s of a 5s total; the provider now keeps
  // its whole allowance, so a response just past the old five-second boundary still lands.
  assert.equal(observed.length, 1);
  assert.ok(observed[0]! >= SESSION_NAMING_GENERATION_BUDGET_MS,
    `preparation must not consume the generation allowance (got ${observed[0]})`);
  assert.ok(observed[0]! > 5_100, "the provider budget must outlast the old five-second boundary");
});

test("preparation that overruns its allowance fails closed instead of starving generation", async () => {
  let clock = 1_000;
  let generated = 0;
  const executor = new SessionNamingExecutor({
    now: () => clock,
    prepareDirectory: async () => {
      clock += SESSION_NAMING_PREPARATION_BUDGET_MS + 500;
      return { cwd: "/neutral", cleanup: async () => {} };
    },
    generate: async () => {
      generated += 1;
      return "Never Generated";
    },
  });
  const result = await executor.execute(request(), claudeAgent(), {});
  assert.equal(result.ok, false);
  assert.equal(result.code, "timed_out");
  assert.equal(result.phase, "isolation");
  assert.equal(generated, 0, "an overrun preparation must not hand the provider a sliver of budget");
});

test("a stalled preparation step stays bounded and releases its late result", async () => {
  let released = 0;
  let settle: ((value: { cwd: string; cleanup(): Promise<void> }) => void) | undefined;
  const executor = new SessionNamingExecutor({
    prepareDirectory: () => new Promise((resolve) => { settle = resolve; }),
    generate: async () => "Never Generated",
  });
  // The smallest accepted total keeps the bound short; the point is that it is bounded at all.
  const result = await executor.execute({ ...request(), timeoutMs: 250 }, claudeAgent(), {});
  assert.equal(result.ok, false);
  assert.equal(result.code, "timed_out");
  assert.equal(result.phase, "isolation");
  settle!({ cwd: "/neutral", cleanup: async () => { released += 1; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released, 1, "a late preparation result is cleaned up rather than leaked");
});

test("a stalled teardown cannot turn a generated title into a transport timeout", async () => {
  let cleaned = 0;
  const executor = new SessionNamingExecutor({
    // Teardown that never settles. Awaiting it would hold the result past the control plane's
    // round-trip deadline, and a valid title would come back as a timeout.
    cleanupBudgetMs: 25,
    prepareDirectory: async () => ({ cwd: "/neutral", cleanup: () => new Promise<void>(() => {}) }),
    authorize: async () => ({ cleanup: async () => { cleaned += 1; } }),
    generate: async () => "Generated Before Teardown Stalled",
  });
  const result = await executor.execute(request(), claudeAgent(), {});
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.title, "Generated Before Teardown Stalled");
  assert.equal(cleaned, 1, "teardown still runs; only waiting for it is bounded");
});

test("executor preflight rejects before preparing a target-local naming directory", async () => {
  let prepared = 0;
  let generated = 0;
  let rejectPreflight = true;
  const executor = new SessionNamingExecutor({
    rateLimit: 1,
    preflight: () => {
      if (rejectPreflight) throw new Error("execution context unavailable");
    },
    prepareDirectory: async () => {
      prepared++;
      return { cwd: "/must-not-exist", cleanup: async () => {} };
    },
    generate: async () => { generated++; return "Valid Native Title"; },
  });
  assert.deepEqual(await executor.execute(request("preflight"), claudeAgent(), {}), {
    type: "generate_session_title_result",
    requestId: "preflight",
    ok: false,
    code: "provider_failed",
    phase: "isolation",
  });
  assert.deepEqual({ prepared, generated }, { prepared: 0, generated: 0 });

  rejectPreflight = false;
  assert.deepEqual(await executor.execute(request("native-after-rejection"), claudeAgent(), {}), {
    type: "generate_session_title_result",
    requestId: "native-after-rejection",
    ok: true,
    title: "Valid Native Title",
    provider: "claude",
    billingSource: "subscription",
  });
  assert.deepEqual({ prepared, generated }, { prepared: 1, generated: 1 });
});

test("executor fails closed under concurrency/rate pressure and sanitizes provider errors", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const executor = new SessionNamingExecutor({
    maxConcurrent: 1,
    rateLimit: 1,
    prepareDirectory: async () => ({ cwd: "/neutral", cleanup: async () => {} }),
    generate: async () => {
      calls += 1;
      await blocked;
      throw new Error("token=provider-secret path=/private/repo");
    },
  });
  const first = executor.execute(request("first"), codexAgent(), {});
  const concurrent = await executor.execute(request("concurrent"), codexAgent(), {});
  assert.deepEqual(concurrent, {
    type: "generate_session_title_result", requestId: "concurrent", ok: false, code: "rate_limited", phase: "preflight",
  });
  release();
  const failed = await first;
  assert.deepEqual(failed, {
    type: "generate_session_title_result", requestId: "first", ok: false, code: "provider_failed", phase: "generation",
  });
  assert.equal(JSON.stringify(failed).includes("provider-secret"), false);
  assert.equal(calls, 1);

  const rateLimited = await executor.execute(request("rate"), codexAgent(), {});
  assert.deepEqual(rateLimited, {
    type: "generate_session_title_result", requestId: "rate", ok: false, code: "rate_limited", phase: "preflight",
  });
});

test("executor rejects unbounded input and unavailable accounts before provider execution", async () => {
  let generated = false;
  const executor = new SessionNamingExecutor({ generate: async () => { generated = true; return "unused"; } });
  const oversized = request("oversized");
  oversized.messages = [{ role: "user", text: "x".repeat(12_001) }];
  assert.equal((await executor.execute(oversized, claudeAgent(), {})).code, "invalid_result");
  assert.equal((await executor.execute(request("signed-out"), { ...claudeAgent(), authStatus: "unauthenticated" }, {})).code,
    "account_unavailable");
  assert.equal((await executor.execute(request("unsupported"), {
    ...codexAgent(),
    codexAppServer: { status: "unsupported", appServerAvailable: true },
  }, {})).code, "provider_unsupported");
  assert.equal(generated, false);
});
