import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  attachModelProbeLifecycle,
  claudeModelProbeOptions,
  claudeModels,
  CODEX_DISCOVERY_CLIENT_INFO,
  collectClaudeModelsFromProcess,
  collectCodexAppServerModels,
  createAgentModelDiscoverer,
  parseClaudeModels,
  parseCodexAppServerModels,
  parseCodexConfigModel,
  parseCodexModels,
  queryClaudeModels,
} from "./models.js";
import type { AgentProcess } from "../spawn.js";
import type { AgentDefinition } from "@wollipog/protocol";

const CACHE = JSON.stringify({
  models: [
    {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      description: "Frontier model",
      visibility: "list",
      context_window: 272000,
      input_modalities: ["text", "image"],
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }],
    },
    {
      slug: "gpt-5.4",
      display_name: "GPT-5.4",
      visibility: "list",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
    },
    { slug: "internal-x", display_name: "Internal", visibility: "hide" },
  ],
});

test("parseCodexModels: list-visible models with per-model effort; marks the configured default", () => {
  const models = parseCodexModels(CACHE, "gpt-5.4");
  assert.deepEqual(
    models.map((m) => m.id),
    ["gpt-5.5", "gpt-5.4"], // the "hide" model is excluded
  );
  const g55 = models.find((m) => m.id === "gpt-5.5")!;
  assert.equal(g55.displayName, "GPT-5.5");
  assert.equal(g55.description, "Frontier model");
  assert.deepEqual(g55.efforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(g55.defaultEffort, "medium");
  assert.equal(g55.contextWindow, 272000); // read straight from the codex cache
  assert.deepEqual(g55.inputModalities, ["text", "image"]);
  assert.equal(models.find((m) => m.id === "gpt-5.4")!.contextWindow, undefined); // absent in cache → undefined
  assert.equal(g55.default, false);
  assert.equal(models.find((m) => m.id === "gpt-5.4")!.default, true); // matches configured
});

test("parseCodexModels: falls back to the first model when configured is absent; bad json → []", () => {
  const models = parseCodexModels(CACHE, "does-not-exist");
  assert.equal(models[0]!.id, "gpt-5.5");
  assert.equal(models[0]!.default, true);
  assert.deepEqual(parseCodexModels("not json at all"), []);
});

test("parseCodexConfigModel: top-level model only, ignores [table].model", () => {
  assert.equal(parseCodexConfigModel('model = "gpt-5.5"\nmodel_reasoning_effort = "xhigh"\n[foo]\nmodel = "x"'), "gpt-5.5");
  assert.equal(parseCodexConfigModel('[foo]\nmodel = "x"'), null);
  assert.equal(parseCodexConfigModel("no model here"), null);
});

const LIVE_PAGE = {
  data: [
    {
      id: "gpt-live",
      model: "gpt-live",
      displayName: "GPT Live",
      description: "Live model",
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast" },
        { reasoningEffort: "high", description: "Deep" },
      ],
      inputModalities: ["text", "image"],
    },
    {
      id: "internal-review",
      model: "internal-review",
      displayName: "Internal",
      description: "Hidden model",
      hidden: true,
      isDefault: false,
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }],
      inputModalities: ["text"],
    },
  ],
};

test("Codex app-server discovery identifies itself as Wollipog discovery", () => {
  assert.deepEqual(CODEX_DISCOVERY_CLIENT_INFO, {
    name: "wollipog-discovery",
    version: "0.8.0",
  });
});

test("parseCodexAppServerModels: preserves defaults, hidden state, efforts, and modalities", () => {
  const models = parseCodexAppServerModels(LIVE_PAGE);
  assert.deepEqual(models.map((model) => model.id), ["gpt-live", "internal-review"]);
  assert.deepEqual(models[0], {
    id: "gpt-live",
    displayName: "GPT Live",
    description: "Live model",
    default: true,
    hidden: false,
    efforts: ["low", "high"],
    defaultEffort: "medium",
    inputModalities: ["text", "image"],
  });
  assert.equal(models[1]!.hidden, true);
  assert.deepEqual(models[1]!.inputModalities, ["text"]);
});

test("collectCodexAppServerModels follows pagination, dedupes ids, and rejects cursor loops", async () => {
  const calls: Array<{ cursor?: string }> = [];
  const models = await collectCodexAppServerModels(async (params) => {
    calls.push(params);
    return params.cursor
      ? { data: [{ ...LIVE_PAGE.data[0], id: "page-two", model: "page-two", isDefault: false }], nextCursor: null }
      : { ...LIVE_PAGE, nextCursor: "next" };
  });
  assert.deepEqual(calls.map((call) => call.cursor), [undefined, "next"]);
  assert.deepEqual(models.map((model) => model.id), ["gpt-live", "internal-review", "page-two"]);
  await assert.rejects(
    () => collectCodexAppServerModels(async () => ({ data: [], nextCursor: "same" })),
    /repeated pagination cursor/,
  );
  let page = 0;
  await assert.rejects(
    () => collectCodexAppServerModels(async () => ({ data: [], nextCursor: `page-${++page}` })),
    /exceeded 20 pages/,
  );
});

test("model probe lifecycle turns a child spawn error into a disposed RPC transport", () => {
  const child = new EventEmitter();
  const reasons: string[] = [];
  attachModelProbeLifecycle(child as AgentProcess, { dispose: (reason) => void reasons.push(reason) });
  assert.doesNotThrow(() => child.emit("error", new Error("spawn codex ENOENT")));
  assert.deepEqual(reasons, ["codex app-server model probe spawn failed: spawn codex ENOENT"]);
});

test("app-server discovery caches per version/context, refreshes, and only falls back for method-not-found", async () => {
  const agent = {
    id: "codex-app",
    name: "Codex",
    command: "codex",
    args: [],
    env: {},
    driver: "codex-app-server" as const,
    context: { kind: "native" as const },
    version: "0.144.1",
  };
  let queries = 0;
  let fallbacks = 0;
  const discover = createAgentModelDiscoverer({
    queryAppServer: async () => {
      queries += 1;
      return parseCodexAppServerModels(LIVE_PAGE);
    },
    fallback: async () => {
      fallbacks += 1;
      return [{ id: "cached" }];
    },
  });
  assert.deepEqual(await discover({ ...agent, available: false }), { models: [] });
  assert.equal(queries, 0, "an unavailable compatibility row never spawns app-server");
  assert.equal((await discover(agent)).source, "live");
  await discover(agent);
  assert.equal(queries, 1, "same resolved version/context is cached");
  await discover(agent, { refresh: true });
  assert.equal(queries, 2, "Rediscover bypasses the cache");
  assert.equal(fallbacks, 0);

  const unavailable = createAgentModelDiscoverer({
    queryAppServer: async () => Promise.reject({ code: -32601, message: "method not found" }),
    fallback: async () => [{ id: "cached" }],
  });
  assert.deepEqual(await unavailable(agent), { models: [{ id: "cached" }], source: "cached" });

  let invalidFallbacks = 0;
  const broken = createAgentModelDiscoverer({
    queryAppServer: async () => Promise.reject(new Error("transport timeout")),
    fallback: async () => {
      invalidFallbacks += 1;
      return [{ id: "must-not-use" }];
    },
  });
  assert.deepEqual(await broken(agent), { models: [] });
  assert.equal(invalidFallbacks, 0, "working-method failures never masquerade as cached metadata");

  let flakyQueries = 0;
  const flaky = createAgentModelDiscoverer({
    queryAppServer: async () => {
      flakyQueries += 1;
      if (flakyQueries === 1) throw new Error("cold start timeout");
      return [{ id: "fresh", default: true }];
    },
    fallback: async () => [{ id: "must-not-use" }],
  });
  assert.deepEqual(await flaky(agent), { models: [] });
  assert.deepEqual(await flaky(agent), { models: [{ id: "fresh", default: true }], source: "live" });

  let refreshQueries = 0;
  const refresh = createAgentModelDiscoverer({
    queryAppServer: async () => {
      refreshQueries += 1;
      if (refreshQueries === 2) throw new Error("refresh timeout");
      return [{ id: "stable", default: true }];
    },
    fallback: async () => [],
  });
  const stable = await refresh(agent);
  assert.deepEqual(await refresh(agent, { refresh: true }), stable, "failed refresh retains the last good metadata");
  assert.equal(refreshQueries, 2);
});

test("parseClaudeModels: live metadata drives versioned labels, effort, context, and defaults", () => {
  const models = parseClaudeModels({
    models: [
      {
        value: "default",
        resolvedModel: "claude-opus-5[1m]",
        displayName: "Default (recommended)",
        description: "Opus 5 with 1M context · Best for everyday, complex tasks",
        supportedEffortLevels: ["low", "high", "max"],
      },
      {
        value: "opus[1m]",
        resolvedModel: "claude-opus-5[1m]",
        displayName: "Opus (1M context)",
        description: "Opus 5 with 1M context",
      },
      {
        value: "haiku",
        resolvedModel: "claude-haiku-4-5-20251001",
        displayName: "Haiku",
        description: "Haiku 4.5 · Fastest for quick answers",
      },
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5",
        displayName: "Sonnet 5",
        description: "Sonnet 5 - Efficient for routine tasks",
      },
      { value: "", displayName: "invalid" },
    ],
  });
  assert.deepEqual(
    models.filter((model) => !model.hidden).map((model) => model.id),
    ["default", "opus[1m]", "haiku", "sonnet"],
  );
  assert.equal(models[0]!.displayName, "Default (Opus 5)");
  assert.equal(models[0]!.default, true);
  assert.deepEqual(models[0]!.efforts, ["low", "high", "max"]);
  assert.equal(models[0]!.contextWindow, 1_000_000);
  assert.equal(models[1]!.displayName, "Opus 5 (1M Context)");
  assert.equal(models[2]!.displayName, "Haiku 4.5");
  assert.equal(models[2]!.contextWindow, 200_000);
  assert.equal(models[3]!.contextWindow, 200_000);
  assert.equal(models.find((model) => model.id === "opus")?.hidden, true);
  assert.equal(models.find((model) => model.id === "fable")?.hidden, true);
  assert.deepEqual(parseClaudeModels({ models: "invalid" }), []);

  const datedAndDistinct = parseClaudeModels({
    models: [
      { value: "dated-opus", resolvedModel: "claude-opus-4-20250514", displayName: "Opus" },
      { value: "future-opus", resolvedModel: "claude-opus-5-20260701", displayName: "Opus" },
      { value: "opus-plan", resolvedModel: "claude-opus-5", displayName: "Opus Plan" },
      { value: "opus-fast", resolvedModel: "claude-opus-5", displayName: "Opus Fast" },
    ],
  });
  assert.equal(datedAndDistinct.find((model) => model.id === "dated-opus")?.displayName, "Opus 4");
  assert.equal(datedAndDistinct.find((model) => model.id === "future-opus")?.displayName, "Opus 5");
  assert.equal(datedAndDistinct.find((model) => model.id === "opus-plan")?.displayName, "Opus Plan");
  assert.equal(datedAndDistinct.find((model) => model.id === "opus-fast")?.displayName, "Opus Fast");
});

test("claudeModels: fallback aliases are version-neutral and mark the configured default", () => {
  const m = claudeModels("opus");
  assert.deepEqual(
    m.map((x) => x.id),
    ["default", "opus", "fable", "sonnet", "haiku"],
  );
  assert.equal(m.find((x) => x.id === "opus")!.default, true);
  assert.equal(m.find((x) => x.id === "default")!.default, false);
  assert.equal(m.find((x) => x.id === "opus")!.displayName, "Opus");
  assert.ok(m.every((model) => model.contextWindow === undefined));
  assert.doesNotMatch(m.map((x) => x.displayName).join(" "), /\d/);

  // no configured model → "default" alias is the default
  assert.equal(claudeModels().find((x) => x.id === "default")!.default, true);
});

test("claudeModelProbeOptions matches real-turn auth and no-prompt launch boundaries", () => {
  const native = claudeModelProbeOptions({
    id: "claude",
    name: "Claude",
    command: "claude",
    args: ["--debug"],
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
      ANTHROPIC_API_KEY: "api-secret",
      WOLLIPOG_CLAUDE_PERSISTENT: "0",
      WOLLIPOG_CLAUDE_PERSISTENT_IDLE_MS: "2000",
      WOLLIPOG_CLAUDE_PENDING_MAX_MS: "3000",
      MAM_CLAUDE_PERSISTENT: "1",
      MAM_CLAUDE_PERSISTENT_IDLE_MS: "1000",
      MAM_CLAUDE_PENDING_MAX_MS: "4000",
    },
    driver: "claude-code",
    context: { kind: "native" },
  });
  assert.deepEqual(native.scrubInheritedEnv, [
    "ANTHROPIC_API_KEY",
    "WOLLIPOG_CLAUDE_PERSISTENT",
    "WOLLIPOG_CLAUDE_PERSISTENT_IDLE_MS",
    "WOLLIPOG_CLAUDE_PENDING_MAX_MS",
    "MAM_CLAUDE_PERSISTENT",
    "MAM_CLAUDE_PERSISTENT_IDLE_MS",
    "MAM_CLAUDE_PENDING_MAX_MS",
  ]);
  assert.deepEqual(native.args, [
    "--debug", "-p", "--input-format", "stream-json", "--output-format", "stream-json",
    "--verbose", "--permission-mode", "plan", "--no-session-persistence",
  ]);
  assert.deepEqual(native.env, { CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret" });

  const wsl = claudeModelProbeOptions({
    id: "claude-wsl",
    name: "Claude WSL",
    command: "claude",
    args: [],
    env: {},
    driver: "claude-code",
    context: { kind: "wsl", distro: "Ubuntu" },
  });
  assert.equal(wsl.cwd, "/");
});

function fakeAgentProcess(): AgentProcess {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 12345,
  }) as unknown as AgentProcess;
}

test("Claude model response collector flushes a split final line and ignores foreign request ids", async () => {
  const child = fakeAgentProcess();
  const requestId = "wanted";
  const result = collectClaudeModelsFromProcess(child, requestId);
  child.stdout.write(`${JSON.stringify({ response: { request_id: "foreign", subtype: "success", response: {} } })}\n`);
  const response = JSON.stringify({
    response: {
      request_id: requestId,
      subtype: "success",
      response: { models: [{ value: "default", displayName: "Default" }] },
    },
  });
  child.stdout.write(response.slice(0, 17));
  child.stdout.write(response.slice(17));
  child.emit("close", 0, null);
  assert.equal((await result)[0]?.id, "default");
});

test("Claude model query rejects close-before-response and kills on close and timeout", async () => {
  const agent = {
    id: "claude-query",
    name: "Claude",
    command: "claude",
    args: [],
    env: {},
    driver: "claude-code",
    context: { kind: "native" },
  } as AgentDefinition;
  const closed = fakeAgentProcess();
  let kills = 0;
  const closedQuery = queryClaudeModels(agent, {
    spawn: () => closed,
    kill: () => { kills += 1; },
    requestId: "closed",
    timeoutMs: 100,
  });
  closed.emit("close", 1, null);
  await assert.rejects(closedQuery, /exited before initialization/);
  assert.equal(kills, 1);

  const timedOut = fakeAgentProcess();
  await assert.rejects(queryClaudeModels(agent, {
    spawn: () => timedOut,
    kill: () => { kills += 1; },
    requestId: "timeout",
    timeoutMs: 5,
  }), /timed out/);
  assert.equal(kills, 2);
});

const PROBE_CAPABLE_CLAUDE = {
  status: "ready" as const,
  installedVersion: "2.1.220",
  effortLevels: ["low"],
  permissionModes: ["acceptEdits", "plan"],
  streamJsonInput: true,
  streamJsonImages: true,
  controlProtocol: true,
  forkSession: true,
  replayUserMessages: true,
  auth: { status: "authenticated" as const, billingSource: "subscription" as const },
};

test("claude discovery caches live metadata and retains it when refresh fails", async () => {
  const agent = {
    id: "claude",
    name: "Claude",
    command: "claude",
    args: [],
    env: {},
    driver: "claude-code" as const,
    context: { kind: "native" as const },
    version: "2.1.220",
    claudeCode: PROBE_CAPABLE_CLAUDE,
  };
  let queries = 0;
  const discover = createAgentModelDiscoverer({
    queryAppServer: async () => [],
    queryClaude: async () => {
      queries += 1;
      if (queries === 2) throw new Error("refresh failed");
      return [{ id: "default", displayName: "Default (Opus 5)", default: true }];
    },
    fallback: async () => claudeModels(),
  });
  const live = await discover(agent);
  assert.equal(live.source, "live");
  assert.equal(live.models[0]!.displayName, "Default (Opus 5)");
  assert.deepEqual(await discover(agent), live);
  assert.equal(queries, 1, "same resolved launch uses the cache");
  assert.deepEqual(await discover(agent, { refresh: true }), live);
  assert.equal(queries, 2);
});

test("claude discovery retries an uncached transient first-probe failure", async () => {
  const agent = {
    id: "claude-retry",
    name: "Claude",
    command: "claude",
    args: [],
    env: {},
    driver: "claude-code" as const,
    context: { kind: "native" as const },
    version: "2.1.220",
    claudeCode: PROBE_CAPABLE_CLAUDE,
  };
  let queries = 0;
  const discover = createAgentModelDiscoverer({
    queryAppServer: async () => [],
    queryClaude: async () => {
      queries += 1;
      if (queries === 1) throw new Error("cold start timeout");
      return [{ id: "default", displayName: "Default (Opus 5)", default: true }];
    },
    fallback: async () => claudeModels(),
  });
  assert.equal((await discover(agent)).source, undefined);
  assert.equal((await discover(agent)).source, "live");
  assert.equal(queries, 2);
});

test("claude discovery skips a probe whose required control flags are known unavailable", async () => {
  const agent = {
    id: "claude-legacy",
    name: "Claude",
    command: "claude",
    args: [],
    env: {},
    driver: "claude-code",
    context: { kind: "native" },
    version: "1.0.0",
    claudeCode: {
      status: "ready",
      installedVersion: "1.0.0",
      effortLevels: [],
      permissionModes: ["acceptEdits", "dontAsk", "plan"],
      streamJsonInput: true,
      streamJsonImages: false,
      controlProtocol: false,
      forkSession: false,
      replayUserMessages: false,
      auth: { status: "unknown", billingSource: "unknown" },
    },
  } as AgentDefinition;
  let queries = 0;
  const discover = createAgentModelDiscoverer({
    queryAppServer: async () => [],
    queryClaude: async () => { queries += 1; return []; },
    fallback: async () => claudeModels(),
  });
  assert.equal((await discover(agent)).source, undefined);
  assert.equal((await discover(agent, { refresh: true })).source, undefined);
  assert.equal(queries, 0);
});

test("claude discovery negatively caches three cold probe failures until explicit refresh", async () => {
  const agent = {
    id: "claude-broken",
    name: "Claude",
    command: "claude",
    args: [],
    env: {},
    driver: "claude-code" as const,
    context: { kind: "native" as const },
    version: "2.1.220",
    claudeCode: PROBE_CAPABLE_CLAUDE,
  };
  let queries = 0;
  const discover = createAgentModelDiscoverer({
    queryAppServer: async () => [],
    queryClaude: async () => { queries += 1; throw new Error("broken control response"); },
    fallback: async () => claudeModels(),
  });
  await discover(agent);
  await discover(agent);
  await discover(agent);
  await discover(agent);
  assert.equal(queries, 3);
  await discover(agent, { refresh: true });
  assert.equal(queries, 4);
});
