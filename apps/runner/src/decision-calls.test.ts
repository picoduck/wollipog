import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDefinition, RunDecisionMessage } from "@wollipog/protocol";
import { DECISION_ATTEMPT_BUDGET_MS } from "@wollipog/protocol";
import {
  claudeDecisionArgs,
  codexDecisionErrorClass,
  codexDecisionThreadParams,
  codexDecisionTurnParams,
  DecisionCallFailure,
  decisionErrorClassForStatus,
  DecisionExecutor,
  interpretClaudeDecisionEnvelope,
} from "./decision-calls.js";
import { codexSessionNamingArgs } from "./session-naming.js";

const SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["confirm", "uncertain"] }, reason: { type: "string" } },
  required: ["verdict", "reason"],
  additionalProperties: false,
};

const models = {
  models: [{ id: "haiku", displayName: "Haiku", efforts: ["low", "medium"] }],
  effortLevels: ["low", "medium"],
  slashCommands: [],
  supportsImages: false,
  supportsApprovals: false,
};

function claudeAgent(overrides: Partial<NonNullable<AgentDefinition["claudeCode"]>> = {}): AgentDefinition {
  return {
    id: "claude-code",
    name: "Claude Code",
    command: "claude",
    args: ["--base"],
    env: {},
    driver: "claude-code",
    context: { kind: "native" },
    available: true,
    authStatus: "authenticated",
    capabilities: models,
    claudeCode: {
      status: "ready",
      effortLevels: ["low", "medium"],
      permissionModes: ["plan"],
      streamJsonInput: true,
      streamJsonImages: true,
      controlProtocol: true,
      forkSession: true,
      replayUserMessages: true,
      sessionNaming: true,
      decisionCalls: true,
      auth: { status: "authenticated", billingSource: "subscription" },
      ...overrides,
    },
  };
}

function message(overrides: Partial<RunDecisionMessage> = {}): RunDecisionMessage {
  return {
    type: "run_decision",
    requestId: "decision_req_1",
    occurrenceId: "dec_1",
    attempt: 1,
    target: { agentId: "claude-code", driver: "claude-code", model: "haiku", effort: "low" },
    instructions: "Answer with the schema.",
    input: "<untrusted_data name=\"probe\">\"x\"</untrusted_data>",
    outputSchema: SCHEMA,
    timeoutMs: DECISION_ATTEMPT_BUDGET_MS,
    ...overrides,
  };
}

function executor(generate: NonNullable<ConstructorParameters<typeof DecisionExecutor>[0]>["generate"]) {
  return new DecisionExecutor({
    prepareDirectory: async () => ({ cwd: "/neutral", cleanup: async () => {} }),
    generate,
  });
}

test("Claude Decision calls run with no tools, no MCP servers, no settings and no persistence", () => {
  const args = claudeDecisionArgs(["--base"], message().target, "fixed instructions", SCHEMA);
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], "--base");
  assert.equal(value("--tools"), "");
  assert.equal(value("--mcp-config"), '{"mcpServers":{}}');
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(value("--setting-sources"), "");
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--safe-mode"));
  assert.ok(args.includes("--disable-slash-commands"));
  assert.equal(value("--permission-mode"), "plan");
  assert.equal(value("--output-format"), "json");
  assert.equal(value("--system-prompt"), "fixed instructions");
  assert.deepEqual(JSON.parse(value("--json-schema")!), SCHEMA);
  assert.equal(value("--model"), "haiku");
  assert.equal(value("--effort"), "low");
});

test("Codex Decision calls disable every tool surface and enforce the schema on the turn", () => {
  const args = codexSessionNamingArgs([]);
  assert.ok(args.includes("shell_tool"));
  assert.ok(args.includes("mcp_servers={}"));
  assert.deepEqual(codexDecisionThreadParams("/neutral", "fixed"), {
    cwd: "/neutral", ephemeral: true, approvalPolicy: "never", sandbox: "read-only", developerInstructions: "fixed",
  });
  const turn = codexDecisionTurnParams("thread", "/neutral", "input", message().target, SCHEMA);
  assert.deepEqual(turn.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.deepEqual(turn.outputSchema, SCHEMA);
  assert.equal(turn.approvalPolicy, "never");
});

test("only Claude's structured_output is the answer; the free-text result is never parsed", () => {
  const ok = interpretClaudeDecisionEnvelope(JSON.stringify({
    type: "result", subtype: "success", is_error: false,
    result: "{\"verdict\":\"confirm\",\"reason\":\"from text\"}",
    structured_output: { verdict: "confirm", reason: "structured" },
    usage: { input_tokens: 2, output_tokens: 78, cache_read_input_tokens: 5, cache_creation_input_tokens: 3208 },
    modelUsage: { "claude-haiku-4-5": {} },
  }), 0);
  assert.deepEqual(JSON.parse(ok.outputText), { verdict: "confirm", reason: "structured" });
  assert.equal(ok.model, "claude-haiku-4-5");
  assert.deepEqual(ok.usage, { inputTokens: 2, outputTokens: 78, cacheReadInputTokens: 5, cacheCreationInputTokens: 3208 });
  assert.throws(
    () => interpretClaudeDecisionEnvelope(JSON.stringify({
      type: "result", subtype: "success", is_error: false, result: "{\"verdict\":\"confirm\",\"reason\":\"x\"}",
    }), 0),
    (error: unknown) => error instanceof DecisionCallFailure && error.errorClass === "invalid_output",
  );
  assert.throws(() => interpretClaudeDecisionEnvelope("not json", 0),
    (error: unknown) => error instanceof DecisionCallFailure && error.errorClass === "invalid_output");
});

test("Claude provider errors are classified from api_error_status and stop_reason", () => {
  const classify = (fields: Record<string, unknown>) => {
    try {
      interpretClaudeDecisionEnvelope(JSON.stringify({ type: "result", subtype: "success", ...fields }), 1);
    } catch (error) {
      return (error as DecisionCallFailure).errorClass;
    }
    return null;
  };
  assert.equal(classify({ is_error: true, api_error_status: 429 }), "rate_limited");
  assert.equal(classify({ is_error: true, api_error_status: 529 }), "provider_overloaded");
  assert.equal(classify({ is_error: true, api_error_status: 401 }), "authentication");
  assert.equal(classify({ is_error: true, api_error_status: 404 }), "model_unavailable");
  assert.equal(classify({ is_error: true, api_error_status: null }), "provider_failed");
  assert.equal(classify({ is_error: false, stop_reason: "refusal" }), "refused");
  assert.equal(decisionErrorClassForStatus(400), "refused");
  assert.equal(decisionErrorClassForStatus(undefined), null);
});

test("Codex typed errors map onto Decision error classes", () => {
  assert.equal(codexDecisionErrorClass("unauthorized"), "authentication");
  assert.equal(codexDecisionErrorClass("usageLimitExceeded"), "rate_limited");
  assert.equal(codexDecisionErrorClass("internalServerError"), "provider_overloaded");
  assert.equal(codexDecisionErrorClass("badRequest"), "configuration");
  assert.equal(codexDecisionErrorClass({ httpConnectionFailed: { httpStatusCode: null } }), "transport");
  assert.equal(codexDecisionErrorClass({ responseStreamConnectionFailed: { httpStatusCode: 503 } }), "provider_overloaded");
  assert.equal(codexDecisionErrorClass({ httpConnectionFailed: { httpStatusCode: 429 } }), "rate_limited");
  assert.equal(codexDecisionErrorClass("other"), "provider_failed");
});

test("a harness that cannot host Decision calls fails non-transiently and never runs the provider", async () => {
  let ran = 0;
  const run = executor(async () => {
    ran++;
    return { outputText: "{}" };
  });
  const noDecisions = await run.execute(message(), claudeAgent({ decisionCalls: false }), {});
  assert.equal(noDecisions.ok, false);
  assert.equal(noDecisions.errorClass, "harness_unavailable");
  const missing = await run.execute(message(), undefined, {});
  assert.equal(missing.errorClass, "harness_unavailable");
  const signedOut = await run.execute(message(), {
    ...claudeAgent({ auth: { status: "unauthenticated", billingSource: "unknown" } }),
  }, {});
  assert.equal(signedOut.errorClass, "authentication");
  const wrongModel = await run.execute(message({ target: { ...message().target, model: "opus" } }), claudeAgent(), {});
  assert.equal(wrongModel.errorClass, "model_unavailable");
  const wrongEffort = await run.execute(message({ target: { ...message().target, effort: "max" } }), claudeAgent(), {});
  assert.equal(wrongEffort.errorClass, "model_unavailable");
  assert.equal(ran, 0);
});

test("an attempt returns the structured output, account boundary and usage, and failures keep usage", async () => {
  const usage = { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  let seen: RunDecisionMessage | undefined;
  const ok = await executor(async (_account, _agent, received) => {
    seen = received;
    return { outputText: "{\"verdict\":\"confirm\",\"reason\":\"ok\"}", model: "claude-haiku-4-5", usage };
  }).execute(message(), claudeAgent(), {});
  assert.deepEqual(ok, {
    type: "run_decision_result",
    requestId: "decision_req_1",
    ok: true,
    outputText: "{\"verdict\":\"confirm\",\"reason\":\"ok\"}",
    provider: "claude",
    billingSource: "subscription",
    model: "claude-haiku-4-5",
    usage,
  });
  assert.equal(seen?.instructions, "Answer with the schema.");
  const failed = await executor(async () => {
    throw new DecisionCallFailure("rate_limited", "generation", usage, 1_500);
  }).execute(message(), claudeAgent(), {});
  assert.equal(failed.ok, false);
  assert.equal(failed.errorClass, "rate_limited");
  assert.equal(failed.retryAfterMs, 1_500);
  assert.deepEqual(failed.usage, usage);
  const empty = await executor(async () => ({ outputText: "  " })).execute(message(), claudeAgent(), {});
  assert.equal(empty.errorClass, "invalid_output");
});

test("malformed or oversized requests are refused before any provider runs", async () => {
  let ran = 0;
  const run = executor(async () => {
    ran++;
    return { outputText: "{}" };
  });
  assert.equal((await run.execute(message({ input: "" }), claudeAgent(), {})).errorClass, "configuration");
  assert.equal((await run.execute(message({ input: "x".repeat(48_001) }), claudeAgent(), {})).errorClass, "configuration");
  assert.equal((await run.execute(message({ attempt: 0 }), claudeAgent(), {})).errorClass, "configuration");
  assert.equal(ran, 0);
});

test("concurrent attempts beyond the limit answer rate_limited at once", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const run = new DecisionExecutor({
    maxConcurrent: 1,
    prepareDirectory: async () => ({ cwd: "/neutral", cleanup: async () => {} }),
    generate: async () => {
      await gate;
      return { outputText: "{\"verdict\":\"confirm\",\"reason\":\"ok\"}" };
    },
  });
  const first = run.execute(message(), claudeAgent(), {});
  const second = await run.execute(message({ requestId: "decision_req_2" }), claudeAgent(), {});
  assert.equal(second.errorClass, "rate_limited");
  release();
  assert.equal((await first).ok, true);
});
