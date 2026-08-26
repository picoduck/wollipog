import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";
import type { ControlPlaneToRunner, RunnerView } from "@wollipog/protocol";
import type { Hub } from "./hub.js";
import { ControlPlaneDb } from "./db.js";
import { registerSessionNamingRoutes } from "./session-naming-route.js";
import {
  sanitizeSessionNamingRunnerResult,
  SessionNamingModeUnavailableError,
  SessionNamingSettings,
} from "./session-naming-settings.js";

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
        auth: { status: "authenticated", billingSource: "subscription" },
      },
    }],
  });
  const db = {
    sessionScope: () => ({ organizationId: "org_personal" }),
    runnerScope: () => ({ organizationId: "org_personal" }),
    getSessionNamingPreference: () => preference,
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
  assert.equal(JSON.stringify(available).includes("machine-one"), false);
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
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
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
    requestId: "request-two",
    ok: false,
    code: "timed_out",
    title: "should be removed",
  }), {
    type: "generate_session_title_result",
    requestId: "request-two",
    ok: false,
    code: "timed_out",
  });
  assert.equal(sanitizeSessionNamingRunnerResult({
    type: "generate_session_title_result",
    requestId: "request-three",
    ok: false,
    code: "token=provider-secret",
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
