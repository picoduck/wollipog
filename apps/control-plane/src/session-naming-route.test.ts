import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";
import type { ControlPlaneToRunner, RunnerView } from "@wollipog/protocol";
import type { Hub } from "./hub.js";
import { ControlPlaneDb } from "./db.js";
import { registerSessionNamingRoutes } from "./session-naming-route.js";
import { SessionTitleGenerationError } from "./session-title-generator.js";
import {
  sanitizeSessionNamingRunnerResult,
  sanitizeSessionNamingCustomModelResult,
  SessionNamingModeUnavailableError,
  SessionNamingSettings,
} from "./session-naming-settings.js";

function customDigest(endpoint: string, model: string, timeoutMs: number): string {
  return createHash("sha256").update(`${endpoint}\0${model}\0${timeoutMs}`).digest("hex");
}

function human(role: HumanPrincipal["role"]): HumanPrincipal {
  return {
    kind: "human",
    actorId: `${role}-user`,
    userId: `${role}-user`,
    userName: role,
    organizationId: "org_personal",
    organizationName: "Personal",
    role,
    deviceId: `${role}-device`,
    localBootstrap: false,
  };
}

test("session naming settings preserve env behavior, redact credentials, and require admin writes", async () => {
  const db = ControlPlaneDb.open(":memory:");
  const settings = new SessionNamingSettings(db, {
    WOLLIPOG_TITLE_MODEL_URL: "https://operator:password@models.example/v1/chat/completions?api_key=query-secret#fragment",
    WOLLIPOG_TITLE_MODEL: "small-title-model",
    WOLLIPOG_TITLE_MODEL_API_KEY: "bearer-secret",
    WOLLIPOG_TITLE_MODEL_TIMEOUT_MS: "750",
  });
  const principals = new Map<string, AuthPrincipal>([
    ["viewer", human("viewer")],
    ["operator", human("operator")],
    ["admin", human("admin")],
    ["agent", {
      kind: "agent",
      actorId: "agent",
      organizationId: "org_personal",
      delegatedScope: { organizationId: "org_personal", owner: { kind: "organization", organizationId: "org_personal" } },
    }],
  ]);
  const app = Fastify();
  registerSessionNamingRoutes(app, settings, (request) => {
    const token = request.headers.authorization?.replace(/^Bearer /, "");
    return token ? principals.get(token) ?? null : null;
  });

  assert.equal((await app.inject({ method: "GET", url: "/api/session-naming" })).statusCode, 403);
  assert.equal((await app.inject({
    method: "GET", url: "/api/session-naming", headers: { authorization: "Bearer agent" },
  })).statusCode, 403);

  const inheritedResponse = await app.inject({
    method: "GET", url: "/api/session-naming", headers: { authorization: "Bearer viewer" },
  });
  assert.equal(inheritedResponse.statusCode, 200);
  const inherited = inheritedResponse.json();
  assert.equal(inherited.mode, "custom_model_endpoint");
  assert.equal(inherited.effectiveMode, "custom_model_endpoint");
  assert.equal(inherited.source, "environment");
  assert.equal(inherited.canManage, false);
  assert.equal(inherited.customModel.endpointOrigin, "https://models.example");
  assert.equal(inherited.customModel.apiKeyConfigured, true);
  for (const secret of ["operator", "password", "query-secret", "fragment", "bearer-secret"]) {
    assert.equal(inheritedResponse.body.includes(secret), false, `response must redact ${secret}`);
  }

  for (const token of ["viewer", "operator", "agent"]) {
    assert.equal((await app.inject({
      method: "PUT",
      url: "/api/session-naming",
      headers: { authorization: `Bearer ${token}` },
      payload: { mode: "prompt_text_only" },
    })).statusCode, 403);
  }
  const promptOnly = await app.inject({
    method: "PUT",
    url: "/api/session-naming",
    headers: { authorization: "Bearer admin" },
    payload: { mode: "prompt_text_only" },
  });
  assert.equal(promptOnly.statusCode, 200);
  assert.equal(promptOnly.json().effectiveMode, "prompt_text_only");
  assert.equal(db.getSessionNamingPreference("org_personal")?.mode, "prompt_text_only");

  const custom = await app.inject({
    method: "PUT",
    url: "/api/session-naming",
    headers: { authorization: "Bearer admin" },
    payload: { mode: "custom_model_endpoint" },
  });
  assert.equal(custom.statusCode, 200);
  assert.equal(custom.json().effectiveMode, "custom_model_endpoint");
  assert.equal((await app.inject({
    method: "PUT",
    url: "/api/session-naming",
    headers: { authorization: "Bearer admin" },
    payload: { mode: "session_agent_account" },
  })).statusCode, 409);
  assert.equal((await app.inject({
    method: "PUT",
    url: "/api/session-naming",
    headers: { authorization: "Bearer admin" },
    payload: { mode: "unknown" },
  })).statusCode, 400);

  await app.close();
  db.close();
});

test("custom mode fails closed when legacy endpoint configuration disappears", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.setSessionNamingPreference("org_personal", "custom_model_endpoint", 1);
  const settings = new SessionNamingSettings(db, {});
  const view = settings.view("org_personal", true);
  assert.equal(view.mode, "custom_model_endpoint");
  assert.equal(view.effectiveMode, "prompt_text_only");
  assert.equal(view.modes.custom_model_endpoint.available, false);
  db.close();
});

test("session naming routes sanitize load and unexpected update failures", async () => {
  const admin = human("admin");
  let failure: "load" | "unavailable" | "update" = "load";
  const settings = {
    view() {
      if (failure === "load") throw new Error("database path and query detail");
      throw new Error("unexpected view call");
    },
    setMode() {
      if (failure === "unavailable") {
        throw new SessionNamingModeUnavailableError("the requested naming mode is unavailable");
      }
      throw new Error("database path and query detail");
    },
  } as unknown as SessionNamingSettings;
  const app = Fastify();
  registerSessionNamingRoutes(app, settings, () => admin);

  const load = await app.inject({ method: "GET", url: "/api/session-naming" });
  assert.equal(load.statusCode, 500);
  assert.deepEqual(load.json(), { error: "could not load session naming settings" });
  assert.equal(load.body.includes("database path"), false);

  failure = "unavailable";
  const unavailable = await app.inject({
    method: "PUT",
    url: "/api/session-naming",
    payload: { mode: "session_agent_account" },
  });
  assert.equal(unavailable.statusCode, 409);
  assert.deepEqual(unavailable.json(), { error: "the requested naming mode is unavailable" });

  failure = "update";
  const update = await app.inject({
    method: "PUT",
    url: "/api/session-naming",
    payload: { mode: "prompt_text_only" },
  });
  assert.equal(update.statusCode, 500);
  assert.deepEqual(update.json(), { error: "could not update session naming settings" });
  assert.equal(update.body.includes("database path"), false);

  await app.close();
});

test("runtime eligibility does not construct the public settings projection", () => {
  let preferenceReads = 0;
  const db = {
    sessionScope: () => ({ organizationId: "org_personal" }),
    getSessionNamingPreference: () => {
      preferenceReads += 1;
      return { mode: "custom_model_endpoint" as const, updatedAt: 1 };
    },
    getSessionNamingCustomModel: () => null,
  } as unknown as ControlPlaneDb;
  const settings = new SessionNamingSettings(db, {
    WOLLIPOG_TITLE_MODEL_URL: "https://models.example/v1/chat/completions",
    WOLLIPOG_TITLE_MODEL: "small-title-model",
  });
  settings.view = () => { throw new Error("public projection must not run"); };

  assert.equal(settings.enabledForSession("session-one"), true);
  assert.equal(preferenceReads, 1);
});

test("runner-account mode is capability-gated, reports only billing boundaries, and targets the session runner", async () => {
  let preference: { mode: "session_agent_account"; updatedAt: number } | null = null;
  let protocolVersion = 93;
  let claudeNaming = true;
  const runner = (): RunnerView => ({
    runnerId: "runner-one",
    hostname: "machine-one",
    os: "linux",
    version: "test",
    status: "online",
    connectedAt: 1,
    lastSeen: 1,
    protocolVersion,
    workspaces: [],
    agents: [{
      id: "claude-code",
      name: "Claude Code",
      command: "claude",
      args: [],
      env: {},
      driver: "claude-code",
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
        sessionNaming: claudeNaming,
        auth: { status: "authenticated", billingSource: "subscription" },
      },
    }],
  });
  const db = {
    sessionScope: () => ({ organizationId: "org_personal" }),
    runnerScope: () => ({ organizationId: "org_personal" }),
    getSessionNamingPreference: () => preference,
    getSessionNamingCustomModel: () => null,
    setSessionNamingPreference: (_organizationId: string, mode: "session_agent_account", updatedAt: number) => {
      preference = { mode, updatedAt };
    },
    listRunners: () => [runner()],
    getRunner: () => runner(),
    getSession: () => ({ id: "session-one", runnerId: "runner-one", agentId: "claude-code", driver: "claude-code" }),
  } as unknown as ControlPlaneDb;
  const sent: Array<{ runnerId: string; message: ControlPlaneToRunner; timeoutMs: number }> = [];
  const hub = {
    requestFromRunner: async (runnerId: string, _requestId: string, message: ControlPlaneToRunner, timeoutMs: number) => {
      sent.push({ runnerId, message, timeoutMs });
      return {
        type: "generate_session_title_result" as const,
        requestId: "ignored-by-test",
        ok: true,
        title: "Runner Account Naming",
        provider: "claude" as const,
        billingSource: "subscription" as const,
      };
    },
  } as unknown as Pick<Hub, "requestFromRunner">;
  const settings = new SessionNamingSettings(db, {}, hub);

  const available = settings.view("org_personal", true);
  assert.equal(available.modes.session_agent_account.available, true);
  assert.deepEqual(available.sessionAgentAccounts, [{
    provider: "claude", billingSource: "subscription", machineCount: 1,
  }]);
  assert.equal(JSON.stringify(available.sessionAgentAccounts).includes("machine-one"), false);
  settings.setMode("org_personal", "session_agent_account", 10);
  assert.equal(settings.enabledForSession("session-one"), true);

  const title = await settings.generator({
    sessionId: "session-one",
    messages: [{ role: "user", text: "Name this session" }],
    signal: new AbortController().signal,
  });
  assert.equal(title, "Runner Account Naming");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.runnerId, "runner-one");
  assert.equal(sent[0]?.message.type, "generate_session_title");
  if (sent[0]?.message.type === "generate_session_title") {
    assert.equal(sent[0].message.sessionId, "session-one");
    assert.deepEqual(sent[0].message.messages, [{ role: "user", text: "Name this session" }]);
  }

  protocolVersion = 92;
  const mixedVersion = settings.view("org_personal", true);
  assert.equal(mixedVersion.effectiveMode, "prompt_text_only");
  assert.equal(mixedVersion.modes.session_agent_account.available, false);
  assert.match(mixedVersion.modes.session_agent_account.reason ?? "", /current runner/);
  protocolVersion = 93;
  claudeNaming = false;
  const unsupportedClaude = settings.view("org_personal", true);
  assert.equal(unsupportedClaude.modes.session_agent_account.available, false);
});

test("harness labels stay concise alone and distinguish native and multiple WSL contexts on collision", () => {
  const codex = (
    id: string,
    context: { kind: "native" } | { kind: "wsl"; distro: string },
  ): RunnerView["agents"][number] => ({
    id,
    name: context.kind === "wsl" ? `Codex (WSL: ${context.distro})` : "Codex",
    command: "codex",
    args: [],
    env: {},
    driver: "codex-app-server",
    context,
    source: "discovered",
    available: true,
    authStatus: "authenticated",
    codexBillingSource: "provider_account",
    codexAppServer: { status: "supported", appServerAvailable: true, sessionNaming: true },
    capabilities: {
      models: [{ id: "luna", displayName: "Luna", efforts: ["low"] }],
      effortLevels: ["low"],
      slashCommands: [],
      supportsImages: false,
      supportsApprovals: true,
    },
  });
  let agents = [codex("codex-native", { kind: "native" })];
  const runner = (): RunnerView => ({
    runnerId: "runner-contexts",
    displayName: "Context Machine",
    hostname: "context-host",
    os: "windows",
    version: "test",
    status: "online",
    connectedAt: 1,
    lastSeen: 1,
    protocolVersion: 95,
    workspaces: [],
    agents,
  });
  const db = {
    sessionScope: () => ({ organizationId: "org_personal" }),
    runnerScope: () => ({ organizationId: "org_personal" }),
    listRunners: () => [runner()],
    getRunner: () => runner(),
    getSessionNamingPreference: () => null,
    getSessionNamingHarnessTarget: () => null,
    getSessionNamingCustomModel: () => null,
  } as unknown as ControlPlaneDb;
  const hub = { requestFromRunner: async () => { throw new Error("not called"); } } as unknown as Pick<Hub, "requestFromRunner">;
  const settings = new SessionNamingSettings(db, {}, hub);

  assert.deepEqual(settings.view("org_personal", true).harnessMachines?.[0]?.harnesses.map((item) => item.name),
    ["Codex App Server"], "a native-only choice stays concise");
  agents = [codex("codex-wsl-Ubuntu", { kind: "wsl", distro: "Ubuntu" })];
  assert.deepEqual(settings.view("org_personal", true).harnessMachines?.[0]?.harnesses.map((item) => item.name),
    ["Codex App Server"], "a WSL-only choice stays concise");
  agents = [
    codex("codex-native", { kind: "native" }),
    codex("codex-wsl-Debian", { kind: "wsl", distro: "Debian" }),
    codex("codex-wsl-Ubuntu", { kind: "wsl", distro: "Ubuntu" }),
  ];
  assert.deepEqual(settings.view("org_personal", true).harnessMachines?.[0]?.harnesses.map((item) => item.name), [
    "Codex App Server (Native)",
    "Codex App Server (WSL: Debian)",
    "Codex App Server (WSL: Ubuntu)",
  ]);
  agents = [
    codex("codex-wsl-control", { kind: "wsl", distro: "Ubuntu\ninvalid" }),
    codex("codex-wsl-whitespace", { kind: "wsl", distro: "   " }),
    codex("codex-wsl-bidi", { kind: "wsl", distro: "\u202Elatest" }),
  ];
  assert.deepEqual(settings.view("org_personal", true).harnessMachines ?? [], [],
    "an invalid advertised WSL context is not selectable");
});

test("explicit harness naming persists capability-backed identifiers, executes on that runner, and fails closed on drift", async () => {
  type Target = {
    runnerId: string;
    agentId: string;
    driver: "codex-app-server";
    context?: { kind: "native" } | { kind: "wsl"; distro: string };
    provider?: "codex" | "claude";
    billingSource?: "provider_account" | "api" | "unknown";
    model: string;
    effort: string;
    updatedAt: number;
  };
  let target: Target | null = null;
  let preference: { mode: "session_agent_account"; updatedAt: number } | null = null;
  let efforts = ["low", "medium"];
  let advertisedBillingSource: "provider_account" | "api" | "unknown" = "provider_account";
  let resultBillingSource: "provider_account" | "api" | "unknown" = "provider_account";
  let resultProvider: "codex" | "claude" = "codex";
  let advertisedContext: { kind: "native" } | { kind: "wsl"; distro: string } = { kind: "native" };
  let advertisedSessionNaming = true;
  let advertisedAuthStatus: "authenticated" | "unauthenticated" = "authenticated";
  let runnerOrganizationId = "org_personal";
  let runnerProtocolVersion = 95;
  const runner = (): RunnerView => ({
    runnerId: "runner-naming",
    displayName: "Naming Machine",
    hostname: "naming-host",
    os: "linux",
    version: "test",
    status: "online",
    connectedAt: 1,
    lastSeen: 1,
    protocolVersion: runnerProtocolVersion,
    workspaces: [],
    agents: [{
      id: "codex-app-server",
      name: "Codex",
      command: "codex",
      args: [],
      env: {},
      driver: "codex-app-server",
      context: advertisedContext,
      source: "discovered",
      available: true,
      authStatus: advertisedAuthStatus,
      codexBillingSource: advertisedBillingSource,
      codexAppServer: { status: "supported", appServerAvailable: true, sessionNaming: advertisedSessionNaming },
      capabilities: {
        models: [{ id: "luna", displayName: "Luna", efforts }],
        effortLevels: efforts,
        slashCommands: [],
        supportsImages: false,
        supportsApprovals: true,
      },
    }, {
      id: "codex-app-server-wsl-Ubuntu",
      name: "Codex (WSL: Ubuntu)",
      command: "codex",
      args: [],
      env: {},
      driver: "codex-app-server",
      context: { kind: "wsl", distro: "Ubuntu" },
      source: "discovered",
      available: true,
      authStatus: "authenticated",
      codexBillingSource: "provider_account",
      codexAppServer: { status: "supported", appServerAvailable: true, sessionNaming: true },
      capabilities: {
        models: [{ id: "luna", displayName: "Luna", efforts }],
        effortLevels: efforts,
        slashCommands: [],
        supportsImages: false,
        supportsApprovals: true,
      },
    }, {
      id: "team-api-naming",
      name: "Team API Naming",
      command: "codex",
      args: [],
      env: {},
      driver: "codex-app-server",
      source: "config",
      available: true,
      authStatus: "authenticated",
      codexBillingSource: "api",
      codexAppServer: { status: "supported", appServerAvailable: true, sessionNaming: true },
      capabilities: {
        models: [{ id: "luna", displayName: "Luna", efforts }],
        effortLevels: efforts,
        slashCommands: [],
        supportsImages: false,
        supportsApprovals: true,
      },
    }],
  });
  const db = {
    sessionScope: () => ({ organizationId: "org_personal" }),
    runnerScope: () => ({ organizationId: runnerOrganizationId }),
    listRunners: () => [runner()],
    getRunner: () => runner(),
    getSession: () => ({ id: "session-other", runnerId: "runner-other", agentId: "claude-code", driver: "claude-code" }),
    getSessionNamingPreference: () => preference,
    getSessionNamingHarnessTarget: () => target,
    configureSessionNamingHarnessTarget: (
      _organizationId: string,
      value: Omit<Target, "updatedAt">,
      updatedAt: number,
    ) => {
      target = { ...value, updatedAt };
      preference = { mode: "session_agent_account", updatedAt };
      return updatedAt;
    },
    getSessionNamingCustomModel: () => null,
  } as unknown as ControlPlaneDb;
  const sent: Array<{ runnerId: string; message: ControlPlaneToRunner }> = [];
  const hub = {
    requestFromRunner: async (runnerId: string, _requestId: string, message: ControlPlaneToRunner) => {
      sent.push({ runnerId, message });
      return {
        type: "generate_session_title_result" as const,
        requestId: "request",
        ok: true,
        title: "Explicit Harness Naming",
        provider: resultProvider,
        billingSource: resultBillingSource,
      };
    },
  } as unknown as Pick<Hub, "requestFromRunner">;
  const settings = new SessionNamingSettings(db, {}, hub);
  const app = Fastify();
  registerSessionNamingRoutes(app, settings, (request) =>
    request.headers.authorization === "Bearer admin" ? human("admin") : human("viewer"));

  const viewer = await app.inject({
    method: "PUT",
    url: "/api/session-naming/harness",
    headers: { authorization: "Bearer viewer" },
    payload: { runnerId: "runner-naming", agentId: "codex-app-server", driver: "codex-app-server", model: "luna", effort: "low" },
  });
  assert.equal(viewer.statusCode, 403);
  const saved = await app.inject({
    method: "PUT",
    url: "/api/session-naming/harness",
    headers: { authorization: "Bearer admin" },
    payload: { runnerId: "runner-naming", agentId: "codex-app-server", driver: "codex-app-server", model: "luna", effort: "low" },
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(target && {
    runnerId: target.runnerId, agentId: target.agentId, driver: target.driver, context: target.context,
    provider: target.provider, billingSource: target.billingSource, model: target.model, effort: target.effort,
  }, {
    runnerId: "runner-naming", agentId: "codex-app-server", driver: "codex-app-server",
    context: { kind: "native" }, provider: "codex", billingSource: "provider_account", model: "luna", effort: "low",
  });
  assert.deepEqual(saved.json().harnessMachines[0].harnesses[0].models, [{ id: "luna", displayName: "Luna", efforts: ["low", "medium"] }]);
  assert.deepEqual({
    provider: saved.json().harnessMachines[0].harnesses[0].provider,
    billingSource: saved.json().harnessMachines[0].harnesses[0].billingSource,
  }, { provider: "codex", billingSource: "provider_account" });
  assert.equal(saved.json().harnessMachines[0].harnesses[0].name, "Codex App Server (Native)");
  assert.deepEqual(saved.json().harnessMachines[0].harnesses[0].context, { kind: "native" });
  assert.equal(saved.json().harnessTarget.harnessName, "Codex App Server (Native)");
  assert.deepEqual(saved.json().harnessTarget.context, { kind: "native" });
  assert.equal(saved.json().harnessTarget.provider, "codex");
  assert.equal(saved.json().harnessTarget.billingSource, "provider_account");
  assert.deepEqual(saved.json().harnessMachines[0].harnesses.map((candidate: { name: string }) => candidate.name),
    ["Codex App Server (Native)", "Codex App Server (WSL: Ubuntu)", "Team API Naming"],
    "native, WSL, and custom harnesses remain distinguishable");
  assert.equal(saved.json().harnessTarget.available, true);

  const confirmedTarget = target;
  if (target) {
    const { provider: _provider, billingSource: _billingSource, ...legacyTarget } = target;
    target = legacyTarget;
  }
  const migrated = settings.view("org_personal", true);
  assert.equal(migrated.effectiveMode, "prompt_text_only");
  assert.match(migrated.harnessTarget?.reason ?? "", /confirm its provider and billing source/);
  target = confirmedTarget;

  assert.equal(await settings.generator({
    sessionId: "session-other",
    messages: [{ role: "user", text: "Name this" }],
    signal: new AbortController().signal,
  }), "Explicit Harness Naming");
  assert.equal(sent[0]?.runnerId, "runner-naming");
  assert.equal(sent[0]?.message.type, "generate_session_title");
  if (sent[0]?.message.type === "generate_session_title") {
    assert.deepEqual(sent[0].message.target, {
      agentId: "codex-app-server", driver: "codex-app-server", model: "luna", effort: "low",
    });
  }

  advertisedSessionNaming = false;
  const harnessCapabilityDrift = settings.view("org_personal", true);
  assert.match(harnessCapabilityDrift.harnessTarget?.reason ?? "", /no longer supports session naming/);
  await assert.rejects(settings.generator({
    sessionId: "session-other",
    messages: [{ role: "user", text: "Name this" }],
    signal: new AbortController().signal,
  }), (error: unknown) => error instanceof SessionTitleGenerationError &&
    error.code === "harness_unavailable" && error.phase === "preflight");
  advertisedSessionNaming = true;

  advertisedAuthStatus = "unauthenticated";
  const authenticationDrift = settings.view("org_personal", true);
  assert.match(authenticationDrift.harnessTarget?.reason ?? "", /no longer authenticated/);
  await assert.rejects(settings.generator({
    sessionId: "session-other",
    messages: [{ role: "user", text: "Name this" }],
    signal: new AbortController().signal,
  }), (error: unknown) => error instanceof SessionTitleGenerationError &&
    error.code === "account_unavailable" && error.phase === "preflight");
  advertisedAuthStatus = "authenticated";

  resultBillingSource = "api";
  await assert.rejects(settings.generator({
    sessionId: "session-other",
    messages: [{ role: "user", text: "Name this" }],
    signal: new AbortController().signal,
  }), (error: unknown) => error instanceof SessionTitleGenerationError &&
    error.code === "account_unavailable" && error.phase === "preflight");
  resultBillingSource = "provider_account";

  advertisedBillingSource = "api";
  const billingDrift = settings.view("org_personal", true);
  assert.equal(billingDrift.effectiveMode, "prompt_text_only");
  assert.equal(billingDrift.harnessTarget?.available, false);
  assert.match(billingDrift.harnessTarget?.reason ?? "", /billing source changed from Provider Account to API/);
  const requestsBeforeDriftedGeneration = sent.length;
  await assert.rejects(settings.generator({
    sessionId: "session-other",
    messages: [{ role: "user", text: "Name this" }],
    signal: new AbortController().signal,
  }), (error: unknown) => error instanceof SessionTitleGenerationError &&
    error.code === "account_unavailable" && error.phase === "preflight");
  assert.equal(sent.length, requestsBeforeDriftedGeneration, "advertised boundary drift fails before runner invocation");
  advertisedBillingSource = "unknown";
  assert.match(settings.view("org_personal", true).harnessTarget?.reason ?? "", /Provider Account to Unknown/);
  advertisedBillingSource = "provider_account";

  resultProvider = "claude";
  await assert.rejects(settings.generator({
    sessionId: "session-other",
    messages: [{ role: "user", text: "Name this" }],
    signal: new AbortController().signal,
  }), (error: unknown) => error instanceof SessionTitleGenerationError &&
    error.code === "account_unavailable" && error.phase === "preflight");
  resultProvider = "codex";

  if (target) target = { ...target, provider: "claude" };
  const providerDrift = settings.view("org_personal", true);
  assert.equal(providerDrift.harnessTarget?.available, false);
  assert.match(providerDrift.harnessTarget?.reason ?? "", /different provider/);
  if (target) target = { ...target, provider: "codex" };

  advertisedContext = { kind: "wsl", distro: "Debian" };
  const contextDrift = settings.view("org_personal", true);
  assert.equal(contextDrift.harnessTarget?.available, false);
  assert.match(contextDrift.harnessTarget?.reason ?? "", /execution context changed/);
  await assert.rejects(settings.generator({
    sessionId: "session-other",
    messages: [{ role: "user", text: "Name this" }],
    signal: new AbortController().signal,
  }), (error: unknown) => error instanceof SessionTitleGenerationError &&
    error.code === "harness_unavailable" && error.phase === "preflight");
  advertisedContext = { kind: "native" };

  efforts = ["medium"];
  const drifted = settings.view("org_personal", true);
  assert.equal(drifted.effectiveMode, "prompt_text_only");
  assert.equal(drifted.harnessTarget?.available, false);
  assert.match(drifted.harnessTarget?.reason ?? "", /reasoning effort/);
  assert.equal(settings.enabledForSession("session-other"), true,
    "a saved target reaches typed preflight without substituting another effort or provider");
  await assert.rejects(settings.generator({
    sessionId: "session-other",
    messages: [{ role: "user", text: "Name this" }],
    signal: new AbortController().signal,
  }), (error: unknown) => error instanceof SessionTitleGenerationError &&
    error.code === "model_unavailable" && error.phase === "preflight");

  efforts = ["low", "medium"];
  runnerProtocolVersion = 94;
  const outdated = settings.view("org_personal", true);
  assert.match(outdated.harnessTarget?.reason ?? "", /Update the selected Machine runner/);
  await assert.rejects(settings.generator({
    sessionId: "session-other",
    messages: [{ role: "user", text: "Name this" }],
    signal: new AbortController().signal,
  }), (error: unknown) => error instanceof SessionTitleGenerationError &&
    error.code === "runner_outdated" && error.phase === "preflight");
  runnerProtocolVersion = 95;

  const advertisedTarget = target;
  if (target) target = { ...target, agentId: "missing-harness" };
  const missingHarness = settings.view("org_personal", true);
  assert.match(missingHarness.harnessTarget?.reason ?? "", /no longer advertised/);
  await assert.rejects(settings.generator({
    sessionId: "session-other",
    messages: [{ role: "user", text: "Name this" }],
    signal: new AbortController().signal,
  }), (error: unknown) => error instanceof SessionTitleGenerationError &&
    error.code === "harness_unavailable" && error.phase === "preflight");
  target = advertisedTarget;

  runnerOrganizationId = "org_other";
  const reassigned = settings.view("org_personal", true);
  assert.equal(reassigned.harnessTarget?.available, false);
  assert.match(reassigned.harnessTarget?.reason ?? "", /no longer available/);
  assert.equal(reassigned.harnessTarget?.machineName, "runner-naming");
  assert.equal(reassigned.harnessTarget?.harnessName, "Codex App Server (Native) · codex-app-server");
  assert.equal(reassigned.harnessTarget?.modelName, "luna");
  assert.equal(JSON.stringify(reassigned).includes("Naming Machine"), false,
    "a Machine reassigned outside the organization cannot leak its current display metadata");
  target = null;
  assert.equal(settings.enabledForSession("session-other"), false,
    "an implicit target cannot bypass the organization-scoped effective-mode check after reassignment");
  await app.close();
});

test("session naming preference migration preserves legacy choices and admits runner-account mode", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-naming-mode-migration-"));
  const path = join(root, "control-plane.sqlite");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE session_naming_preferences (
        organization_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('prompt_text_only','custom_model_endpoint')),
        updated_at INTEGER NOT NULL
      );
      INSERT INTO session_naming_preferences VALUES ('org_personal', 'prompt_text_only', 7);
    `);
    legacy.close();

    const db = ControlPlaneDb.open(path);
    assert.deepEqual(db.getSessionNamingPreference("org_personal"), {
      mode: "prompt_text_only", updatedAt: 7,
    });
    db.setSessionNamingPreference("org_personal", "session_agent_account", 8);
    assert.deepEqual(db.getSessionNamingPreference("org_personal"), {
      mode: "session_agent_account", updatedAt: 8,
    });
    assert.equal(db.getSessionNamingHarnessTarget("org_personal"), null,
      "an existing runner-account preference keeps follow-session behavior until explicitly configured");
    db.setSessionNamingHarnessTarget("org_personal", {
      runnerId: "runner-one",
      agentId: "codex-app-server",
      driver: "codex-app-server",
      model: "luna",
      effort: "low",
    }, 9);
    assert.deepEqual(db.getSessionNamingHarnessTarget("org_personal"), {
      runnerId: "runner-one",
      agentId: "codex-app-server",
      driver: "codex-app-server",
      model: "luna",
      effort: "low",
      updatedAt: 9,
    });
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy explicit targets migrate unconfirmed and can be atomically confirmed", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-naming-target-migration-"));
  const path = join(root, "control-plane.sqlite");
  let db: ControlPlaneDb | undefined;
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE session_naming_harness_targets (
        organization_id TEXT PRIMARY KEY,
        runner_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        driver TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO session_naming_harness_targets VALUES
        ('org_personal', 'runner-one', 'codex-app-server', 'codex-app-server', 'luna', 'low', 7);
    `);
    legacy.close();

    db = ControlPlaneDb.open(path);
    assert.deepEqual(db.getSessionNamingHarnessTarget("org_personal"), {
      runnerId: "runner-one",
      agentId: "codex-app-server",
      driver: "codex-app-server",
      model: "luna",
      effort: "low",
      updatedAt: 7,
    }, "an upgraded target has no silently inferred context or account boundary");

    const revision = db.configureSessionNamingHarnessTarget("org_personal", {
      runnerId: "runner-one",
      agentId: "codex-app-server",
      driver: "codex-app-server",
      context: { kind: "wsl", distro: "Ubuntu" },
      provider: "codex",
      billingSource: "subscription",
      model: "luna",
      effort: "low",
    }, 8);
    assert.equal(revision, 8);
    assert.deepEqual(db.getSessionNamingHarnessTarget("org_personal"), {
      runnerId: "runner-one",
      agentId: "codex-app-server",
      driver: "codex-app-server",
      context: { kind: "wsl", distro: "Ubuntu" },
      provider: "codex",
      billingSource: "subscription",
      model: "luna",
      effort: "low",
      updatedAt: 8,
    });
    assert.deepEqual(db.getSessionNamingPreference("org_personal"), {
      mode: "session_agent_account",
      updatedAt: 8,
    });
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit target and active mode roll back together when the second write fails", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    db.configureSessionNamingHarnessTarget("org_personal", {
      runnerId: "runner-one",
      agentId: "codex-app-server",
      driver: "codex-app-server",
      context: { kind: "native" },
      provider: "codex",
      billingSource: "provider_account",
      model: "luna",
      effort: "low",
    }, 10);
    const originalTarget = db.getSessionNamingHarnessTarget("org_personal");
    const originalPreference = db.getSessionNamingPreference("org_personal");
    db.raw().exec(`
      CREATE TRIGGER reject_session_naming_preference_update
      BEFORE UPDATE ON session_naming_preferences
      BEGIN
        SELECT RAISE(ABORT, 'forced preference failure');
      END;
    `);

    assert.throws(() => db.configureSessionNamingHarnessTarget("org_personal", {
      runnerId: "runner-two",
      agentId: "claude-code",
      driver: "claude-code",
      context: { kind: "wsl", distro: "Debian" },
      provider: "claude",
      billingSource: "subscription",
      model: "sonnet",
      effort: "high",
    }, 11), /forced preference failure/);
    assert.deepEqual(db.getSessionNamingHarnessTarget("org_personal"), originalTarget);
    assert.deepEqual(db.getSessionNamingPreference("org_personal"), originalPreference);
  } finally {
    db.close();
  }
});

test("runner naming result validation strips extra fields and rejects secret-bearing statuses", () => {
  assert.deepEqual(sanitizeSessionNamingRunnerResult({
    type: "generate_session_title_result",
    requestId: "request-one",
    ok: true,
    title: "Safe Title",
    provider: "codex",
    billingSource: "provider_account",
    code: "provider_failed",
    internal: "token=secret",
  } as never), {
    type: "generate_session_title_result",
    requestId: "request-one",
    ok: true,
    title: "Safe Title",
    provider: "codex",
    billingSource: "provider_account",
  });
  assert.deepEqual(sanitizeSessionNamingRunnerResult({
    type: "generate_session_title_result",
    requestId: "request-model-drift",
    ok: false,
    code: "model_unavailable",
    phase: "preflight",
  }), {
    type: "generate_session_title_result",
    requestId: "request-model-drift",
    ok: false,
    code: "model_unavailable",
    phase: "preflight",
  });
  for (const code of ["session_unavailable", "provider_unsupported"] as const) {
    assert.deepEqual(sanitizeSessionNamingRunnerResult({
      type: "generate_session_title_result",
      requestId: `request-legacy-${code}`,
      ok: false,
      code,
      phase: "preflight",
    }), {
      type: "generate_session_title_result",
      requestId: `request-legacy-${code}`,
      ok: false,
      code,
      phase: "preflight",
    }, "a newer control plane continues accepting older-runner fallback codes");
  }
  assert.deepEqual(sanitizeSessionNamingRunnerResult({
    type: "generate_session_title_result",
    requestId: "request-two",
    ok: false,
    code: "timed_out",
    phase: "turn_start",
    title: "should be removed",
  }), {
    type: "generate_session_title_result",
    requestId: "request-two",
    ok: false,
    code: "timed_out",
    phase: "turn_start",
  });
  assert.equal(sanitizeSessionNamingRunnerResult({
    type: "generate_session_title_result",
    requestId: "request-three",
    ok: false,
    code: "token=provider-secret",
  } as never), null);
  assert.equal(sanitizeSessionNamingRunnerResult({
    type: "generate_session_title_result",
    requestId: "request-invalid-phase",
    ok: false,
    code: "provider_failed",
    phase: "path=/private/repo",
  } as never), null);
  assert.equal(sanitizeSessionNamingRunnerResult({
    type: "generate_session_title_result",
    requestId: "request-four",
    ok: true,
    title: "one\ntwo",
    provider: "claude",
    billingSource: "subscription",
  }), null);
});

test("runner-local custom model routes relay keys once, persist only metadata, and enforce admin authority", async () => {
  type Saved = {
    runnerId: string;
    endpoint: string;
    model: string;
    timeoutMs: number;
    runnerConfigured: boolean;
    apiKeyConfigured: boolean;
    updatedAt: number;
  };
  let saved: Saved | null = null;
  let preference: { mode: "prompt_text_only" | "custom_model_endpoint"; updatedAt: number } | null = null;
  let protocolVersion = 94;
  const runner = (): RunnerView => ({
    runnerId: "runner-custom",
    displayName: "Naming Machine",
    hostname: "naming-host",
    os: "linux",
    version: "test",
    status: "online",
    connectedAt: 1,
    lastSeen: 1,
    protocolVersion,
    workspaces: [],
    agents: [],
  });
  const db = {
    sessionScope: () => ({ organizationId: "org_personal" }),
    runnerScope: () => ({ organizationId: "org_personal" }),
    listRunners: () => [runner()],
    getRunner: () => runner(),
    getSessionNamingPreference: () => preference,
    setSessionNamingPreference: (
      _organizationId: string,
      mode: "prompt_text_only" | "custom_model_endpoint",
      updatedAt: number,
    ) => {
      preference = { mode, updatedAt };
    },
    getSessionNamingCustomModel: () => saved,
    setSessionNamingCustomModel: (_organizationId: string, value: Omit<Saved, "updatedAt">, updatedAt: number) => {
      saved = { ...value, updatedAt };
    },
    reconcileSessionNamingCustomModelRunnerStatus: (
      _runnerId: string,
      runnerConfigured: boolean,
      apiKeyConfigured: boolean,
      updatedAt: number,
    ) => {
      if (!saved) return false;
      saved = { ...saved, runnerConfigured, apiKeyConfigured, updatedAt };
      return true;
    },
  } as unknown as ControlPlaneDb;
  const sent: ControlPlaneToRunner[] = [];
  const hub = {
    requestFromRunner: async (_runnerId: string, requestId: string, message: ControlPlaneToRunner) => {
      sent.push(message);
      if (message.type === "configure_session_naming_custom_model") {
        return {
          type: "session_naming_custom_model_result" as const,
          requestId,
          operation: "configure" as const,
          ok: true,
          status: {
            configured: true,
            apiKeyConfigured: message.apiKey !== undefined || saved?.apiKeyConfigured === true,
            configDigest: customDigest(message.endpoint, message.model, message.timeoutMs),
          },
        };
      }
      if (message.type === "delete_session_naming_custom_model_key") {
        return {
          type: "session_naming_custom_model_result" as const,
          requestId,
          operation: "delete_api_key" as const,
          ok: true,
          status: {
            configured: true,
            apiKeyConfigured: false,
            configDigest: customDigest(saved!.endpoint, saved!.model, saved!.timeoutMs),
          },
        };
      }
      if (message.type === "generate_session_title") {
        return {
          type: "generate_session_title_result" as const,
          requestId,
          ok: true,
          title: "Runner Custom Naming",
          provider: "custom" as const,
          billingSource: "api" as const,
        };
      }
      return {
        type: "session_naming_custom_model_result" as const,
        requestId,
        operation: "test" as const,
        ok: false,
        code: "authentication_failed" as const,
        internal: "provider-secret-diagnostic",
      };
    },
  } as unknown as Pick<Hub, "requestFromRunner">;
  const settings = new SessionNamingSettings(db, {}, hub);
  const app = Fastify();
  registerSessionNamingRoutes(app, settings, (request) =>
    request.headers.authorization === "Bearer admin" ? human("admin") : human("viewer"));

  for (const request of [
    { method: "PUT", url: "/api/session-naming/custom-model", payload: {} },
    { method: "POST", url: "/api/session-naming/custom-model/api-key", payload: { apiKey: "secret" } },
    { method: "DELETE", url: "/api/session-naming/custom-model/api-key" },
    { method: "POST", url: "/api/session-naming/custom-model/test" },
  ]) {
    assert.equal((await app.inject({ ...request, headers: { authorization: "Bearer viewer" } })).statusCode, 403);
  }

  const invalid = await app.inject({
    method: "PUT",
    url: "/api/session-naming/custom-model",
    headers: { authorization: "Bearer admin" },
    payload: {
      runnerId: "runner-custom",
      endpoint: "https://models.example/v1?key=query-secret",
      model: "title-model",
      timeoutMs: 900,
      apiKey: "write-only-sentinel",
    },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.includes("query-secret"), false);
  assert.equal(invalid.body.includes("write-only-sentinel"), false);
  assert.equal(sent.length, 0);

  const configured = await app.inject({
    method: "PUT",
    url: "/api/session-naming/custom-model",
    headers: { authorization: "Bearer admin" },
    payload: {
      runnerId: "runner-custom",
      endpoint: "https://models.example/v1/chat/completions",
      model: "title-model",
      timeoutMs: 900,
      apiKey: "write-only-sentinel",
    },
  });
  assert.equal(configured.statusCode, 200);
  assert.equal(configured.body.includes("write-only-sentinel"), false);
  assert.equal(configured.json().customModel.configurationSource, "runner");
  assert.equal(configured.json().customModel.endpointOrigin, "https://models.example");
  assert.equal(JSON.stringify(saved).includes("write-only-sentinel"), false);
  assert.equal(sent[0]?.type, "configure_session_naming_custom_model");
  if (sent[0]?.type === "configure_session_naming_custom_model") {
    assert.equal(sent[0].apiKey, "write-only-sentinel");
  }
  assert.equal(await settings.generator({
    sessionId: "session-custom",
    messages: [{ role: "user", text: "Name through the selected Machine" }],
    signal: new AbortController().signal,
  }), "Runner Custom Naming");
  const generation = sent.find((message) => message.type === "generate_session_title");
  assert.equal(generation?.type, "generate_session_title");
  if (generation?.type === "generate_session_title") {
    assert.equal(generation.mode, "custom_model_endpoint");
    assert.equal(generation.sessionId, "session-custom");
  }

  const savedBeforeRejectedEdit = { ...saved! };
  const sentBeforeRejectedEdit = sent.length;
  const rejectedRetainedKeyEdit = await app.inject({
    method: "PUT",
    url: "/api/session-naming/custom-model",
    headers: { authorization: "Bearer admin" },
    payload: {
      runnerId: "runner-custom",
      endpoint: "http://models.internal/v1/chat/completions",
      model: "title-model",
      timeoutMs: 900,
    },
  });
  assert.equal(rejectedRetainedKeyEdit.statusCode, 400);
  assert.deepEqual(saved, savedBeforeRejectedEdit, "prevalidation preserves the working secret-free configuration");
  assert.equal(sent.length, sentBeforeRejectedEdit, "an unsafe retained-key edit never reaches the runner");

  preference = { mode: "prompt_text_only", updatedAt: Date.now() };
  const replaced = await app.inject({
    method: "POST",
    url: "/api/session-naming/custom-model/api-key",
    headers: { authorization: "Bearer admin" },
    payload: { apiKey: "replacement-sentinel" },
  });
  assert.equal(replaced.statusCode, 200);
  assert.equal(replaced.body.includes("replacement-sentinel"), false);
  assert.equal(replaced.json().mode, "prompt_text_only", "rotating a key does not activate custom naming");
  assert.equal(preference.mode, "prompt_text_only");
  assert.equal(sent.filter((message) => message.type === "configure_session_naming_custom_model").length, 2);

  const tested = await app.inject({
    method: "POST",
    url: "/api/session-naming/custom-model/test",
    headers: { authorization: "Bearer admin" },
  });
  assert.deepEqual(tested.json(), { ok: false, status: "authentication_failed" });
  assert.equal(tested.body.includes("provider-secret-diagnostic"), false);

  const deleted = await app.inject({
    method: "DELETE",
    url: "/api/session-naming/custom-model/api-key",
    headers: { authorization: "Bearer admin" },
  });
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.json().customModel.apiKeyConfigured, false);

  protocolVersion = 93;
  const unavailable = await app.inject({
    method: "PUT",
    url: "/api/session-naming/custom-model",
    headers: { authorization: "Bearer admin" },
    payload: {
      runnerId: "runner-custom",
      endpoint: "https://models.example/v1/chat/completions",
      model: "title-model",
      timeoutMs: 900,
    },
  });
  assert.equal(unavailable.statusCode, 409);
  await app.close();
});

test("custom model result sanitizer strips runner diagnostics and rejects malformed readiness", () => {
  assert.deepEqual(sanitizeSessionNamingCustomModelResult({
    type: "session_naming_custom_model_result",
    requestId: "config-1",
    operation: "configure",
    ok: true,
    status: { configured: true, apiKeyConfigured: true, configDigest: "a".repeat(64) },
    internal: "secret-path-and-token",
  } as never, "configure"), {
    type: "session_naming_custom_model_result",
    requestId: "config-1",
    operation: "configure",
    ok: true,
    status: { configured: true, apiKeyConfigured: true, configDigest: "a".repeat(64) },
  });
  assert.equal(sanitizeSessionNamingCustomModelResult({
    type: "session_naming_custom_model_result",
    requestId: "config-2",
    operation: "configure",
    ok: true,
    status: { configured: true, apiKeyConfigured: true, configDigest: "secret" },
  }, "configure"), null);
});

test("runner custom model metadata survives control-plane restart and registration reconciliation fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-naming-custom-restart-"));
  const path = join(root, "control-plane.sqlite");
  const config = {
    runnerId: "runner-restart",
    endpoint: "https://models.example/v1/chat/completions",
    model: "title-model",
    timeoutMs: 700,
    runnerConfigured: true,
    apiKeyConfigured: true,
  };
  try {
    let db = ControlPlaneDb.open(path);
    db.registerRunner({
      runnerId: config.runnerId,
      hostname: "restart-machine",
      os: "linux",
      version: "test",
      agents: [],
      workspaces: [],
    }, 1, 94);
    db.setSessionNamingCustomModel("org_personal", config, 2);
    db.setSessionNamingPreference("org_personal", "custom_model_endpoint", 3);
    db.close();

    db = ControlPlaneDb.open(path);
    const hub = { requestFromRunner: async () => { throw new Error("not used"); } } as unknown as Pick<Hub, "requestFromRunner">;
    const settings = new SessionNamingSettings(db, {}, hub);
    assert.equal(settings.view("org_personal", true).effectiveMode, "custom_model_endpoint");

    settings.reconcileRunnerCustomModelStatus(config.runnerId, {
      configured: true,
      apiKeyConfigured: true,
      configDigest: "0".repeat(64),
    }, 4);
    assert.equal(settings.view("org_personal", true).effectiveMode, "prompt_text_only");
    assert.deepEqual(db.getSessionNamingCustomModel("org_personal"), {
      ...config,
      runnerConfigured: false,
      apiKeyConfigured: false,
      updatedAt: 4,
    });

    settings.reconcileRunnerCustomModelStatus(config.runnerId, {
      configured: true,
      apiKeyConfigured: false,
      configDigest: customDigest(config.endpoint, config.model, config.timeoutMs),
    }, 5);
    assert.equal(settings.view("org_personal", true).effectiveMode, "custom_model_endpoint");
    assert.equal(db.getSessionNamingCustomModel("org_personal")?.apiKeyConfigured, false);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one-time custom model API keys never enter the control-plane SQLite file", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-naming-key-redaction-"));
  const path = join(root, "control-plane.sqlite");
  const endpoint = "https://models.example/v1/chat/completions";
  try {
    const db = ControlPlaneDb.open(path);
    db.registerRunner({
      runnerId: "runner-key-redaction",
      hostname: "key-machine",
      os: "linux",
      version: "test",
      agents: [],
      workspaces: [],
    }, 1, 94);
    const hub = {
      requestFromRunner: async (_runnerId: string, requestId: string, message: ControlPlaneToRunner) => {
        assert.equal(message.type, "configure_session_naming_custom_model");
        return {
          type: "session_naming_custom_model_result" as const,
          requestId,
          operation: "configure" as const,
          ok: true,
          status: {
            configured: true,
            apiKeyConfigured: true,
            configDigest: customDigest(endpoint, "title-model", 800),
          },
        };
      },
    } as unknown as Pick<Hub, "requestFromRunner">;
    const settings = new SessionNamingSettings(db, {}, hub);
    await settings.configureCustomModel("org_personal", {
      runnerId: "runner-key-redaction",
      endpoint,
      model: "title-model",
      timeoutMs: 800,
      apiKey: "sqlite-secret-sentinel",
    }, 2);
    db.close();
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      assert.equal(readFileSync(join(root, entry.name)).includes(Buffer.from("sqlite-secret-sentinel")), false, entry.name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
