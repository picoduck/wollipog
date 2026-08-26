import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDefinition, GenerateSessionTitleMessage } from "@wollipog/protocol";
import {
  CODEX_SESSION_NAMING_DISABLED_FEATURES,
  claudeSessionNamingArgs,
  codexSessionNamingArgs,
  codexSessionNamingThreadParams,
  codexSessionNamingTurnParams,
  normalizeRunnerSessionTitle,
  SessionNamingExecutor,
  sessionNamingAccountForAgent,
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
    timeoutMs: 5_000,
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
  assert.deepEqual(thread.dynamicTools, []);
  assert.deepEqual(thread.environments, []);
  assert.deepEqual(thread.selectedCapabilityRoots, []);
  assert.deepEqual(thread.config, { mcp_servers: {} });

  const turn = codexSessionNamingTurnParams("thread-one", "/neutral", "bounded prompt");
  assert.equal(turn.approvalPolicy, "never");
  assert.deepEqual(turn.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.deepEqual(turn.environments, []);
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

test("runner title normalization rejects multiline, oversized, and malformed model output", () => {
  assert.equal(normalizeRunnerSessionTitle("  Semantic Session Names  "), "Semantic Session Names");
  assert.equal(normalizeRunnerSessionTitle('{"title":"Runner Account Naming"}'), "Runner Account Naming");
  assert.equal(normalizeRunnerSessionTitle("one\ntwo"), null);
  assert.equal(normalizeRunnerSessionTitle("x".repeat(121)), null);
  assert.equal(normalizeRunnerSessionTitle('{"other":"missing"}'), null);
});

test("executor returns only a bounded title and secret-free provider boundary", async () => {
  let cleaned = 0;
  const executor = new SessionNamingExecutor({
    prepareDirectory: async () => ({ cwd: "/neutral", cleanup: async () => { cleaned += 1; } }),
    generate: async (account, _agent, cwd, env, prompt, timeoutMs) => {
      assert.deepEqual(account, { provider: "claude", billingSource: "subscription" });
      assert.equal(cwd, "/neutral");
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "runner-secret");
      assert.match(prompt, /Fix the session naming flow/);
      assert.ok(timeoutMs <= 5_000 && timeoutMs >= 4_900, `unexpected remaining timeout ${timeoutMs}`);
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
    type: "generate_session_title_result", requestId: "concurrent", ok: false, code: "rate_limited",
  });
  release();
  const failed = await first;
  assert.deepEqual(failed, {
    type: "generate_session_title_result", requestId: "first", ok: false, code: "provider_failed",
  });
  assert.equal(JSON.stringify(failed).includes("provider-secret"), false);
  assert.equal(calls, 1);

  const rateLimited = await executor.execute(request("rate"), codexAgent(), {});
  assert.deepEqual(rateLimited, {
    type: "generate_session_title_result", requestId: "rate", ok: false, code: "rate_limited",
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
