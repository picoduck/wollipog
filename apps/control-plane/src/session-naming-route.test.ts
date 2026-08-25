import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";
import { ControlPlaneDb } from "./db.js";
import { registerSessionNamingRoutes } from "./session-naming-route.js";
import { SessionNamingSettings } from "./session-naming-settings.js";

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
