import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { AgentCapabilities, SessionConfig, SessionEventPayload } from "@wollipog/protocol";
import { AcpClient, isAgentAuthRequiredError } from "./acp.js";
import { negotiateAcpInitialize } from "./acp-contract.js";
import { AcpDriver } from "./drivers/acp-driver.js";
import type { DriverOptions } from "./drivers/driver.js";

const fixtures = new URL("./fixtures/acp/", import.meta.url);

test("ACP chunk messageId survives normalization and omission preserves legacy payloads", () => {
  const events: SessionEventPayload[] = [];
  const client = new AcpClient(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
      cwd: process.cwd(),
      env: {},
    },
    { onEvent: (event) => events.push(event), onStderr: () => undefined, onExit: () => undefined },
  );
  try {
    // Drive the audited normalization boundary directly; no provider process output is trusted.
    (client as any).sessionId = "boundary-test";
    (client as any).handleUpdate({
      sessionId: "boundary-test",
      update: { sessionUpdate: "agent_message_chunk", messageId: "acp-message", content: { type: "text", text: "Hello" } },
    });
    (client as any).handleUpdate({
      sessionId: "boundary-test",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Legacy" } },
    });
    (client as any).handleUpdate({
      sessionId: "boundary-test",
      update: { sessionUpdate: "agent_message_chunk", messageId: 17, content: { type: "text", text: "Malformed message id" } },
    });
    (client as any).handleUpdate({
      sessionId: "boundary-test",
      update: { sessionUpdate: "agent_thought_chunk", messageId: { nested: true }, content: { type: "text", text: "Malformed thought id" } },
    });
    assert.deepEqual(events, [
      { kind: "agent_message", text: "Hello", messageId: "acp-message" },
      { kind: "agent_thought", text: "Legacy" },
      { kind: "agent_message", text: "Malformed message id" },
      { kind: "agent_thought", text: "Malformed thought id" },
    ]);
  } finally {
    client.dispose();
  }
});

test("real Claude Agent 0.58.1 initialize fixture conforms with stable/preview separation", async () => {
  const frame = await fixture("claude-agent-acp-0.58.1.initialize.json");
  const got = negotiateAcpInitialize(frame.result);
  assert.deepEqual(got.agentInfo, {
    name: "@agentclientprotocol/claude-agent-acp",
    title: "Claude Agent",
    version: "0.58.1",
  });
  assert.equal(got.stable.loadSession, true);
  assert.equal(got.stable.sessionList, true);
  assert.equal(got.stable.sessionResume, true);
  assert.equal(got.stable.sessionClose, true);
  assert.equal(got.stable.logout, true);
  assert.deepEqual(got.authMethods, []);
  assert.deepEqual(got.experimentalAdvertised, ["session-fork"]);
});

test("real Gemini CLI 0.50.0 initialize fixture degrades omitted stable capabilities", async () => {
  const frame = await fixture("gemini-cli-0.50.0.initialize.json");
  const got = negotiateAcpInitialize(frame.result);
  assert.deepEqual(got.agentInfo, {
    name: "gemini-cli",
    title: "Gemini CLI",
    version: "0.50.0",
  });
  assert.equal(got.stable.loadSession, true);
  assert.equal(got.stable.promptImage, true);
  assert.equal(got.stable.promptAudio, true);
  assert.equal(got.stable.sessionList, false);
  assert.equal(got.stable.sessionResume, false);
  assert.equal(got.stable.sessionClose, false);
  assert.equal(got.stable.logout, false);
  assert.deepEqual(got.experimentalAdvertised, []);
  assert.deepEqual(got.authMethods, [
    { id: "oauth-personal", name: "Log in with Google", description: "Log in with your Google account" },
    { id: "gemini-api-key", name: "Gemini API key", description: "Use an API key with Gemini Developer API" },
    { id: "vertex-ai", name: "Vertex AI", description: "Use an API key with Vertex AI GenAI API" },
    { id: "gateway", name: "AI API Gateway", description: "Use a custom AI API Gateway" },
  ]);
  assert.equal("_meta" in (got.authMethods[1] as unknown as Record<string, unknown>), false);
});

test("session new, resume, and load forward resolved stdio/HTTP/SSE MCP plus granted directories", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wollipog-acp-context-"));
  const extra = join(cwd, "shared");
  const expected = {
    mcpServers: [
      { name: "local", command: process.execPath, args: ["server.mjs"], env: [{ name: "TOKEN", value: "resolved-secret" }] },
      { type: "http", name: "http", url: "https://mcp.example/rpc", headers: [{ name: "Authorization", value: "Bearer secret" }] },
      { type: "sse", name: "sse", url: "https://mcp.example/events", headers: [] },
    ],
    additionalDirectories: [extra],
  };
  const makeClient = (lifecycle = "") => new AcpClient(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
      cwd,
      env: {
        WOLLIPOG_MOCK_MCP_CONTEXT: "1",
        WOLLIPOG_MOCK_SESSION_LIFECYCLE: lifecycle,
        WOLLIPOG_MOCK_EXPECT_CONTEXT: JSON.stringify(expected),
        LOCAL_TOKEN: "resolved-secret",
        HTTP_AUTH: "Bearer secret",
      },
      sessionContext: {
        mcpServers: [
          { type: "stdio", name: "local", command: process.execPath, args: ["server.mjs"], env: { TOKEN: { fromEnv: "LOCAL_TOKEN" } } },
          { type: "http", name: "http", url: "https://mcp.example/rpc", headers: { Authorization: { fromEnv: "HTTP_AUTH" } } },
          { type: "sse", name: "sse", url: "https://mcp.example/events" },
        ],
        additionalDirectories: [extra],
      },
    },
    { onEvent: () => undefined, onStderr: () => undefined, onExit: () => undefined },
  );
  const fresh = makeClient();
  const resumed = makeClient("resume");
  const loaded = makeClient("load");
  try {
    await fresh.initialize();
    assert.match(await fresh.newSession(cwd), /^mock_/);
    await resumed.initialize();
    assert.equal(await resumed.resumeSession("persisted", cwd), "persisted");
    await loaded.initialize();
    assert.equal(await loaded.resumeSession("loaded", cwd), "loaded");
  } finally {
    fresh.dispose();
    resumed.dispose();
    loaded.dispose();
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("additional directories fail locally when the agent omits the stable capability", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wollipog-acp-context-gate-"));
  const client = new AcpClient(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
      cwd,
      env: {},
      sessionContext: { additionalDirectories: [join(cwd, "shared")] },
    },
    { onEvent: () => undefined, onStderr: () => undefined, onExit: () => undefined },
  );
  try {
    await client.initialize();
    await assert.rejects(client.newSession(cwd), /does not advertise additional-directory support/);
  } finally {
    client.dispose();
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("auth-required session creation retries agent-hosted sign-in without leaking method IDs or errors", async () => {
  const events: SessionEventPayload[] = [];
  const stderr: string[] = [];
  const cwd = await mkdtemp(join(tmpdir(), "wollipog-acp-auth-"));
  let authRequests = 0;
  let client: AcpClient;
  client = new AcpClient(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
      cwd,
      env: { WOLLIPOG_MOCK_AUTH_REQUIRED: "1" },
    },
    {
      onEvent: (event) => {
        events.push(event);
        if (event.kind !== "permission_request" || event.purpose !== "authentication") return;
        authRequests += 1;
        assert.equal(event.options.some((option) => /mock-(browser|device)/.test(option.optionId)), false);
        assert.equal(event.options.slice(0, -1).every((option) => option.kind === "allow_once"), true);
        assert.equal(event.options.at(-1)?.kind, "reject_once");
        const selected = authRequests === 1 ? event.options[0] : event.options[1];
        client.resolvePermission(event.requestId, selected?.optionId ?? null);
      },
      onStderr: (text) => stderr.push(text),
      onExit: () => undefined,
    },
  );

  try {
    await client.initialize();
    assert.match(await client.newSession(cwd), /^mock_/);
    assert.equal(authRequests, 2);
    const authEvents = events.filter(
      (event): event is Extract<SessionEventPayload, { kind: "permission_request" }> =>
        event.kind === "permission_request" && event.purpose === "authentication",
    );
    assert.match(authEvents[0]?.title ?? "", /^Sign in to /);
    assert.equal(authEvents[1]?.title, "Sign-in failed. Choose a method to retry.");
    assert.doesNotMatch(JSON.stringify(events), /fake-secret-sentinel|mock-browser-broken|mock-device-good/);
    assert.doesNotMatch(stderr.join("\n"), /fake-secret-sentinel/);
  } finally {
    client.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("authentication can be cancelled inline without invoking an agent method", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wollipog-acp-auth-cancel-"));
  let client: AcpClient;
  client = new AcpClient(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
      cwd,
      env: { WOLLIPOG_MOCK_AUTH_REQUIRED: "1" },
    },
    {
      onEvent: (event) => {
        if (event.kind !== "permission_request" || event.purpose !== "authentication") return;
        const cancel = event.options.find((option) => option.kind === "reject_once");
        client.resolvePermission(event.requestId, cancel?.optionId ?? null);
      },
      onStderr: () => undefined,
      onExit: () => undefined,
    },
  );
  try {
    await client.initialize();
    await assert.rejects(client.newSession(cwd), /authentication was cancelled/);
  } finally {
    client.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("capability-gated logout refreshes readiness and makes the next session authenticate", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wollipog-acp-logout-"));
  const statuses: string[] = [];
  const authCapabilities: Array<Record<string, boolean>> = [];
  let authRequest = 0;
  let client: AcpClient;
  client = new AcpClient(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
      cwd,
      env: { WOLLIPOG_MOCK_AUTH_REQUIRED: "1" },
    },
    {
      onEvent: (event) => {
        if (event.kind !== "permission_request" || event.purpose !== "authentication") return;
        authRequest += 1;
        const option = authRequest === 1
          ? event.options.find((candidate) => candidate.name === "Device sign-in")
          : event.options.find((candidate) => candidate.kind === "reject_once");
        client.resolvePermission(event.requestId, option?.optionId ?? null);
      },
      onAuthStatus: (status) => statuses.push(status),
      onAcpCapabilities: (capabilities) => authCapabilities.push(capabilities),
      onStderr: () => undefined,
      onExit: () => undefined,
    },
  );
  try {
    await client.initialize();
    assert.equal(client.negotiatedCapabilities()?.stable.logout, true);
    assert.deepEqual(authCapabilities, [{
      logout: true,
      loadSession: false,
      sessionList: false,
      sessionDelete: false,
      sessionResume: false,
      sessionClose: false,
    }]);
    assert.match(await client.newSession(cwd), /^mock_/);
    await client.logout();
    assert.deepEqual(statuses, ["authenticated", "unauthenticated"]);
    await assert.rejects(client.newSession(cwd), /authentication was cancelled/);
    assert.equal(authRequest, 2);
  } finally {
    client.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("logout is rejected locally when the agent did not advertise the capability", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wollipog-acp-logout-unsupported-"));
  const client = new AcpClient(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
      cwd,
      env: {},
    },
    { onEvent: () => undefined, onStderr: () => undefined, onExit: () => undefined },
  );
  try {
    await client.initialize();
    await assert.rejects(client.logout(), /does not advertise logout support/);
  } finally {
    client.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("logout failures preserve authenticated readiness and never expose provider details", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wollipog-acp-logout-failure-"));
  const statuses: string[] = [];
  const stderr: string[] = [];
  let client: AcpClient;
  client = new AcpClient(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
      cwd,
      env: { WOLLIPOG_MOCK_AUTH_REQUIRED: "1", WOLLIPOG_MOCK_LOGOUT_FAIL: "1" },
    },
    {
      onEvent: (event) => {
        if (event.kind !== "permission_request" || event.purpose !== "authentication") return;
        const method = event.options.find((candidate) => candidate.name === "Device sign-in");
        client.resolvePermission(event.requestId, method?.optionId ?? null);
      },
      onAuthStatus: (status) => statuses.push(status),
      onStderr: (text) => stderr.push(text),
      onExit: () => undefined,
    },
  );
  try {
    await client.initialize();
    await client.newSession(cwd);
    await assert.rejects(client.logout(), /^Error: ACP agent logout failed$/);
    assert.deepEqual(statuses, ["authenticated"]);
    assert.doesNotMatch(stderr.join("\n"), /fake-logout-secret-sentinel/);
  } finally {
    client.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    // Windows taskkill can release the mock's cwd slowly under the full suite's process load.
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("session resume is preferred over load and stable close releases the active session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wollipog-acp-resume-"));
  const events: SessionEventPayload[] = [];
  const client = new AcpClient(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
      cwd,
      env: { WOLLIPOG_MOCK_SESSION_LIFECYCLE: "resume" },
    },
    { onEvent: (event) => events.push(event), onStderr: () => undefined, onExit: () => undefined },
  );
  try {
    await client.initialize();
    assert.equal(client.negotiatedCapabilities()?.stable.sessionResume, true);
    assert.equal(client.negotiatedCapabilities()?.stable.loadSession, true);
    assert.equal(await client.resumeSession("existing-resume", cwd), "existing-resume");
    assert.equal(events.some((event) => event.kind === "agent_message"), false, "resume never replays history");
    await client.closeSession();
  } finally {
    client.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("session load is a replay-suppressed fallback when stable resume is unavailable", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wollipog-acp-load-"));
  const events: SessionEventPayload[] = [];
  const states: Array<{ capabilities: AgentCapabilities; config: SessionConfig }> = [];
  const usages: Array<{ contextTokensUsed: number; contextWindow: number; costUsd?: number }> = [];
  const client = new AcpClient(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
      cwd,
      env: { WOLLIPOG_MOCK_SESSION_LIFECYCLE: "load", WOLLIPOG_MOCK_LOAD_STATE_UPDATES: "1" },
      initialCommands: [{ name: "persisted", source: "builtin" }],
    },
    {
      onEvent: (event) => events.push(event),
      onStderr: () => undefined,
      onExit: () => undefined,
      onAcpSessionState: (state) => states.push(state),
      onAcpUsage: (usage) => usages.push(usage),
    },
  );
  try {
    await client.initialize();
    assert.equal(client.negotiatedCapabilities()?.stable.sessionResume, false);
    assert.equal(client.negotiatedCapabilities()?.stable.loadSession, true);
    assert.equal(await client.resumeSession("existing-load", cwd), "existing-load");
    assert.doesNotMatch(JSON.stringify(events), /historical-load-replay/);
    assert.deepEqual(states.at(-1)?.capabilities.slashCommands.map((command) => command.name), ["loaded"]);
    assert.deepEqual(usages, [{ contextTokensUsed: 77, contextWindow: 1_000 }]);
    await client.closeSession();
  } finally {
    client.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("stable session list follows bounded pagination and drops provider metadata", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wollipog-acp-list-"));
  const client = new AcpClient(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
      cwd,
      env: { WOLLIPOG_MOCK_SESSION_LIST: "1", WOLLIPOG_MOCK_SESSION_LIST_IDS: "listed-a,listed-b" },
    },
    { onEvent: () => undefined, onStderr: () => undefined, onExit: () => undefined },
  );
  try {
    await client.initialize();
    const sessions = await client.listSessions();
    assert.deepEqual(sessions.map((session) => session.sessionId), ["listed-a", "listed-b"]);
    assert.equal(sessions[0]!.cwd, cwd);
    assert.doesNotMatch(JSON.stringify(sessions), /fake-list-(meta|response)-secret-sentinel/);
  } finally {
    client.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("session list fails locally when unsupported and genericizes provider failures", async () => {
  for (const env of [{}, { WOLLIPOG_MOCK_SESSION_LIST: "1", WOLLIPOG_MOCK_SESSION_LIST_FAIL: "1" }]) {
    const cwd = await mkdtemp(join(tmpdir(), "wollipog-acp-list-fail-"));
    const stderr: string[] = [];
    const client = new AcpClient(
      {
        command: process.execPath,
        args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
        cwd,
        env,
      },
      { onEvent: () => undefined, onStderr: (text) => stderr.push(text), onExit: () => undefined },
    );
    try {
      await client.initialize();
      await assert.rejects(
        client.listSessions(),
        env.WOLLIPOG_MOCK_SESSION_LIST ? /^Error: ACP session list failed$/ : /does not advertise session list support/,
      );
      assert.doesNotMatch(stderr.join("\n"), /fake-list-secret-sentinel/);
    } finally {
      client.dispose();
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }
});

test("stable ACP controls map live modes/config/commands and dispatch atomically", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wollipog-acp-controls-"));
  const events: SessionEventPayload[] = [];
  const states: Array<{ capabilities: AgentCapabilities; config: SessionConfig }> = [];
  const client = new AcpClient(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
      cwd,
      env: {
        WOLLIPOG_MOCK_SESSION_CONTROLS: "1",
        WOLLIPOG_MOCK_STALE_MODE_UPDATE: "1",
        WOLLIPOG_MOCK_FOREIGN_SESSION_UPDATE: "1",
        WOLLIPOG_MOCK_EARLY_SESSION_UPDATE: "1",
      },
    },
    {
      onEvent: (event) => events.push(event),
      onStderr: () => undefined,
      onExit: () => undefined,
      onAcpSessionState: (state) => states.push(state),
    },
  );
  try {
    await client.initialize();
    await client.newSession(cwd);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(states.at(-1)!.config, {
      model: "mock-fast",
      effort: "medium",
      permissionMode: "default",
    });
    assert.deepEqual(states.at(-1)!.capabilities.slashCommands.map((command) => command.name), ["review"]);

    await client.setConfig({ model: "mock-smart", effort: "high", permissionMode: "plan" });
    assert.deepEqual(states.at(-1)!.config, {
      model: "mock-smart",
      effort: "high",
      permissionMode: "plan",
    });
    await client.prompt("focus", [], "review");
    assert.match(
      events.filter((event) => event.kind === "agent_thought").map((event) => event.kind === "agent_thought" ? event.text : "").join("\n"),
      /\/review focus/,
    );
    await assert.rejects(client.prompt("", [], "not-offered"), /command is not available/);
  } finally {
    client.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("ACP session/cancel settles an active mock-agent turn as cancelled", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wollipog-acp-turn-interrupt-"));
  const events: SessionEventPayload[] = [];
  const client = new AcpClient(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
      cwd,
      env: {},
    },
    { onEvent: (event) => events.push(event), onStderr: () => undefined, onExit: () => undefined },
  );
  try {
    await client.initialize();
    await client.newSession(cwd);
    const turn = client.prompt("cancel this ACP turn");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    client.cancel();
    assert.equal(await turn, "cancelled");
    assert.equal(events.some((event) => event.kind === "error"), false);
  } finally {
    client.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("ACP control failures are generic and never run a turn under the wrong config", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wollipog-acp-controls-fail-"));
  const stderr: string[] = [];
  const client = new AcpClient(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
      cwd,
      env: { WOLLIPOG_MOCK_SESSION_CONTROLS: "1", WOLLIPOG_MOCK_CONFIG_FAIL: "1" },
    },
    { onEvent: () => undefined, onStderr: (text) => stderr.push(text), onExit: () => undefined },
  );
  try {
    await client.initialize();
    await client.newSession(cwd);
    await assert.rejects(client.setConfig({ model: "mock-smart" }), /^Error: ACP session configuration update failed$/);
    assert.doesNotMatch(stderr.join("\n"), /fake-config-secret-sentinel/);
  } finally {
    client.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("ACP driver resume tolerates persisted controls omitted by the resumed session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wollipog-acp-controls-resume-"));
  const stderr: string[] = [];
  const states: Array<{ capabilities: AgentCapabilities; config: SessionConfig }> = [];
  const driver = new AcpDriver(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
      cwd,
      env: { WOLLIPOG_MOCK_SESSION_CONTROLS: "1", WOLLIPOG_MOCK_SESSION_LIFECYCLE: "resume" },
      context: { kind: "native" },
      resumeId: "persisted-acp-session",
      config: { model: "mock-smart", effort: "high", permissionMode: "plan" },
      capabilities: {
        models: [],
        effortLevels: [],
        slashCommands: [{ name: "review", source: "builtin" }],
        supportsImages: true,
        supportsApprovals: true,
      },
    },
    {
      onEvent: () => undefined,
      onStderr: (text) => stderr.push(text),
      onExit: () => undefined,
      onAcpSessionState: (state) => states.push(state),
    },
  );
  try {
    await driver.initialize();
    assert.equal(await driver.newSession(cwd), "persisted-acp-session");
    assert.equal(driver.agentSessionId(), "persisted-acp-session");
    assert.deepEqual(states.at(-1)?.capabilities.slashCommands.map((command) => command.name), ["review"]);
    assert.equal(await driver.prompt("resumed turn"), "end_turn");
    assert.doesNotMatch(stderr.join("\n"), /session controls changed|secret/i);
  } finally {
    driver.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("ACP structured commands are driver-bound, single-use, and attachment-free", async () => {
  const firstCwd = await mkdtemp(join(tmpdir(), "wollipog-acp-command-first-"));
  const secondCwd = await mkdtemp(join(tmpdir(), "wollipog-acp-command-second-"));
  const events: SessionEventPayload[] = [];
  const opts = (cwd: string): DriverOptions => ({
    command: process.execPath,
    args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
    cwd,
    env: { WOLLIPOG_MOCK_SESSION_CONTROLS: "1" },
    context: { kind: "native" },
    config: {},
  });
  const first = new AcpDriver(opts(firstCwd), {
    onEvent: (event) => events.push(event),
    onStderr: () => undefined,
    onExit: () => undefined,
  });
  const second = new AcpDriver(opts(secondCwd), {
    onEvent: () => undefined,
    onStderr: () => undefined,
    onExit: () => undefined,
  });
  try {
    await first.initialize();
    await first.newSession(firstCwd);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const prepared = first.prepareCommand({
      commandName: "review",
      argumentText: "focus on storage",
      executionMode: "structured",
    });
    assert.equal(await first.invokeCommand(prepared), "end_turn");
    assert.match(
      events.filter((event) => event.kind === "agent_thought")
        .map((event) => event.kind === "agent_thought" ? event.text : "")
        .join("\n"),
      /\/review focus on storage/,
    );
    assert.throws(() => first.invokeCommand(prepared), /not prepared/);
    assert.throws(() => second.invokeCommand(prepared), /not prepared/);
    assert.throws(() => first.prepareCommand({
      commandName: "review",
      argumentText: "",
      executionMode: "passthrough",
    }), /does not support passthrough/);
    assert.throws(() => first.prepareCommand({
      commandName: "bad command",
      argumentText: "",
      executionMode: "structured",
    }), /invalid.*command name/i);
  } finally {
    first.dispose();
    second.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await rm(firstCwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    await rm(secondCwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("stable ACP usage and session title updates expose only normalized fields", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wollipog-acp-runtime-metadata-"));
  const usages: Array<{ contextTokensUsed: number; contextWindow: number; costUsd?: number }> = [];
  const titles: Array<string | null> = [];
  const client = new AcpClient(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
      cwd,
      env: { WOLLIPOG_MOCK_RUNTIME_METADATA: "1" },
    },
    {
      onEvent: () => undefined,
      onStderr: () => undefined,
      onExit: () => undefined,
      onAcpUsage: (usage) => usages.push(usage),
      onAcpSessionInfo: (info) => {
        if ("title" in info) titles.push(info.title ?? null);
        assert.equal(info.providerUpdatedAt, "2026-07-11T00:00:00.000Z");
      },
    },
  );
  try {
    await client.initialize();
    await client.newSession(cwd);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(usages, [{ contextTokensUsed: 12_345, contextWindow: 200_000, costUsd: 1.25 }]);
    assert.deepEqual(titles, ["Provider title"]);
    assert.doesNotMatch(JSON.stringify({ usages, titles }), /secret|_meta|updatedAt/);
  } finally {
    client.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("ACP driver launch keeps live controls when restoration is rejected", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wollipog-acp-controls-restore-fail-"));
  const stderr: string[] = [];
  const driver = new AcpDriver(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
      cwd,
      env: { WOLLIPOG_MOCK_SESSION_CONTROLS: "1", WOLLIPOG_MOCK_CONFIG_FAIL: "1" },
      context: { kind: "native" },
      config: { model: "mock-smart", effort: "high", permissionMode: "plan" },
    },
    { onEvent: () => undefined, onStderr: (text) => stderr.push(text), onExit: () => undefined },
  );
  try {
    await driver.initialize();
    assert.match(await driver.newSession(cwd), /^mock_/);
    assert.match(stderr.join("\n"), /ACP session controls changed; using the agent-reported values/);
    assert.doesNotMatch(stderr.join("\n"), /fake-config-secret-sentinel/);
    assert.equal(await driver.prompt("live controls turn"), "end_turn");
  } finally {
    driver.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("ACP accepts autonomous config updates after a successful response without an echo", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wollipog-acp-controls-autonomous-"));
  const states: Array<{ capabilities: AgentCapabilities; config: SessionConfig }> = [];
  const client = new AcpClient(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
      cwd,
      env: {
        WOLLIPOG_MOCK_SESSION_CONTROLS: "1",
        WOLLIPOG_MOCK_OMIT_CONFIG_CONFIRMATION: "1",
        WOLLIPOG_MOCK_AUTONOMOUS_CONFIG_UPDATE: "1",
      },
    },
    {
      onEvent: () => undefined,
      onStderr: () => undefined,
      onExit: () => undefined,
      onAcpSessionState: (state) => states.push(state),
    },
  );
  try {
    await client.initialize();
    await client.newSession(cwd);
    await client.setConfig({ model: "mock-smart" });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(states.at(-1)?.config.model, "mock-fast");
  } finally {
    client.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("session resume and close fail locally when the agent omitted their capabilities", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wollipog-acp-lifecycle-unsupported-"));
  const client = new AcpClient(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
      cwd,
      env: {},
    },
    { onEvent: () => undefined, onStderr: () => undefined, onExit: () => undefined },
  );
  try {
    await client.initialize();
    await assert.rejects(client.resumeSession("existing", cwd), /does not advertise session resume or load/);
    await client.newSession(cwd);
    assert.equal(await client.closeSession(), false);
  } finally {
    client.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("resume and load failures are generic and never expose provider details", async () => {
  for (const [mode, expected] of [["resume-fail", /ACP session resume failed/], ["load-fail", /ACP session load failed/]] as const) {
    const cwd = await mkdtemp(join(tmpdir(), `wollipog-acp-${mode}-`));
    const events: SessionEventPayload[] = [];
    const stderr: string[] = [];
    const client = new AcpClient(
      {
        command: process.execPath,
        args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
        cwd,
        env: { WOLLIPOG_MOCK_SESSION_LIFECYCLE: mode },
      },
      { onEvent: (event) => events.push(event), onStderr: (text) => stderr.push(text), onExit: () => undefined },
    );
    try {
      await client.initialize();
      await assert.rejects(client.resumeSession("existing", cwd), expected);
      assert.doesNotMatch(JSON.stringify(events) + stderr.join("\n"), /fake-(resume|load)-secret-sentinel/);
    } finally {
      client.dispose();
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }
});

test("a closed agent transport is not misreported as authentication required", async () => {
  const events: SessionEventPayload[] = [];
  const cwd = await mkdtemp(join(tmpdir(), "wollipog-acp-auth-exit-"));
  const client = new AcpClient(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
      cwd,
      env: { WOLLIPOG_MOCK_AUTH_REQUIRED: "1", WOLLIPOG_MOCK_EXIT_AFTER_INITIALIZE: "1" },
    },
    { onEvent: (event) => events.push(event), onStderr: () => undefined, onExit: () => undefined },
  );
  try {
    await client.initialize();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await assert.rejects(
      client.newSession(cwd),
      (error: unknown) => {
        if (typeof error !== "object" || error === null || isAgentAuthRequiredError(error)) return false;
        const transport = error as { message?: unknown; transportFailure?: unknown };
        return transport.transportFailure === true ||
          /agent process exited|connection closed/.test(String(transport.message));
      },
    );
    assert.equal(events.some((event) => event.kind === "permission_request"), false);
  } finally {
    client.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("locally synthesized transport errors never classify as ACP auth_required", () => {
  assert.equal(isAgentAuthRequiredError({ code: -32000, message: "authentication required" }), true);
  assert.equal(
    isAgentAuthRequiredError({ code: -32000, message: "transport failed: EPIPE", transportFailure: true }),
    false,
  );
  assert.equal(isAgentAuthRequiredError({ code: -32603, message: "server error" }), false);
});

test("auth_required without advertised stable methods fails instead of parking an empty card", async () => {
  const events: SessionEventPayload[] = [];
  const cwd = await mkdtemp(join(tmpdir(), "wollipog-acp-auth-empty-"));
  const client = new AcpClient(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
      cwd,
      env: { WOLLIPOG_MOCK_AUTH_REQUIRED: "1", WOLLIPOG_MOCK_OMIT_AUTH_METHODS: "1" },
    },
    { onEvent: (event) => events.push(event), onStderr: () => undefined, onExit: () => undefined },
  );
  try {
    await client.initialize();
    await assert.rejects(
      client.newSession(cwd),
      (error: unknown) =>
        typeof error === "object" && error !== null && (error as { code?: unknown }).code === -32000,
    );
    assert.equal(events.some((event) => event.kind === "permission_request"), false);
  } finally {
    client.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("mock ACP agent completes initialize/new/prompt/permission/update transcript", async () => {
  const events: SessionEventPayload[] = [];
  const stderr: string[] = [];
  const cwd = await mkdtemp(join(tmpdir(), "wollipog-acp-conformance-"));
  let client: AcpClient;
  client = new AcpClient(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
      cwd,
      env: {},
    },
    {
      onEvent: (event) => {
        events.push(event);
        if (event.kind === "permission_request") {
          const allow = event.options.find((option) => option.kind?.startsWith("allow"));
          setImmediate(() => client.resolvePermission(event.requestId, allow?.optionId ?? null));
        }
      },
      onStderr: (text) => stderr.push(text),
      onExit: () => undefined,
    },
  );

  try {
    await client.initialize();
    assert.equal(client.negotiatedCapabilities()?.agentInfo?.name, "mock-acp-agent");
    assert.equal(client.negotiatedCapabilities()?.stable.promptImage, true);
    assert.equal(client.negotiatedCapabilities()?.stable.sessionList, false);
    assert.deepEqual(client.negotiatedCapabilities()?.experimentalAdvertised, []);
    assert.match(await client.newSession(cwd), /^mock_/);
    assert.equal(await client.prompt("approve the stable transcript"), "end_turn");
    const kinds = events.map((event) => event.kind);
    for (const expected of ["agent_thought", "plan", "agent_message", "permission_request", "tool_call", "tool_call_update", "file_edit"]) {
      assert.ok(kinds.includes(expected as SessionEventPayload["kind"]), `missing ${expected}`);
    }
    assert.deepEqual(stderr, ["[mock-acp-agent] ready"]);
  } finally {
    client.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("mock ACP agent maps a referenced terminal once and suppresses agent-embedded duplicates", async () => {
  for (const embedded of [false, true]) {
    const events: SessionEventPayload[] = [];
    const cwd = await mkdtemp(join(tmpdir(), `wollipog-acp-terminal-${embedded ? "embedded" : "referenced"}-`));
    const client = new AcpClient(
      {
        command: process.execPath,
        args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
        cwd,
        env: embedded ? { WOLLIPOG_MOCK_TERMINAL_EMBED: "1" } : { WOLLIPOG_MOCK_TERMINAL: "1" },
      },
      { onEvent: (event) => events.push(event), onStderr: () => undefined, onExit: () => undefined },
    );
    try {
      await client.initialize();
      await client.newSession(cwd);
      assert.equal(await client.prompt("exercise terminal services"), "end_turn");
      const commandOutput = events
        .filter((event): event is Extract<SessionEventPayload, { kind: "command_output" }> => event.kind === "command_output")
        .map((event) => event.text)
        .join("");
      assert.equal(commandOutput, embedded ? "" : "mock-terminal-ok");
      const toolText = events
        .filter((event) => event.kind === "tool_call_update")
        .map((event) => event.text ?? "")
        .join("\n");
      assert.equal(toolText.includes("mock-terminal-ok"), embedded);
      const snapshots = (client as unknown as { terminalEventOutput: Map<string, unknown> }).terminalEventOutput;
      assert.equal(snapshots.size, 0, "terminal release prunes normalized-output cursors");
    } finally {
      client.dispose();
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});

async function fixture(name: string): Promise<{ result: unknown }> {
  return JSON.parse(await readFile(new URL(name, fixtures), "utf8")) as { result: unknown };
}
