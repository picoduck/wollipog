import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { ControlPlaneDb } from "./db.js";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";
import { registerUsageRoutes } from "./usage-routes.js";

function human(role: HumanPrincipal["role"], organizationId = "org_personal"): HumanPrincipal {
  return {
    kind: "human",
    actorId: `${role}-user`,
    userId: `${role}-user`,
    userName: role,
    organizationId,
    organizationName: organizationId,
    role,
    deviceId: `${role}-device`,
    localBootstrap: false,
  };
}

test("usage routes enforce human scope, retention roles, strict inputs, and content-free output", async () => {
  const db = ControlPlaneDb.open(":memory:");
  const principals = new Map<string, AuthPrincipal>([
    ["viewer", human("viewer")],
    ["operator", human("operator")],
    ["admin", human("admin")],
    ["owner", human("owner")],
    ["foreign-admin", human("admin", "org_foreign")],
    ["scoped-agent", {
      kind: "agent", actorId: "agent-1", organizationId: "org_personal",
      delegatedScope: { organizationId: "org_personal", owner: { kind: "user", userId: "viewer-user" } },
    }],
    ["org-agent", {
      kind: "agent", actorId: "agent-2", organizationId: "org_personal",
      delegatedScope: { organizationId: "org_personal", owner: { kind: "organization", organizationId: "org_personal" } },
    }],
  ]);
  const app = Fastify();
  registerUsageRoutes(app, db, (request) => {
    const header = request.headers.authorization;
    return typeof header === "string" ? principals.get(header.replace(/^Bearer /, "")) ?? null : null;
  });
  db.raw().prepare(
    `INSERT INTO usage_hourly
       (bucket_ts, organization_id, owner_kind, owner_id, runner_id, workspace_id, agent_id, driver, model,
        input_tokens, output_tokens, cost_microusd)
     VALUES (?, 'org_personal', 'organization', 'org_personal', 'safe-runner', '', 'safe-agent', 'acp', '', 2, 1, 3)`,
  ).run(Math.floor(Date.now() / 3_600_000) * 3_600_000);

  assert.equal((await app.inject({ method: "GET", url: "/api/usage" })).statusCode, 403);
  for (const token of ["scoped-agent", "org-agent"]) {
    assert.equal((await app.inject({ method: "GET", url: "/api/usage", headers: { authorization: `Bearer ${token}` } })).statusCode, 403);
  }
  for (const token of ["viewer", "operator", "admin", "owner"]) {
    assert.equal((await app.inject({ method: "GET", url: "/api/usage", headers: { authorization: `Bearer ${token}` } })).statusCode, 200);
  }
  for (const token of ["viewer", "operator", "scoped-agent", "org-agent"]) {
    assert.equal((await app.inject({
      method: "PUT", url: "/api/usage/retention", headers: { authorization: `Bearer ${token}` },
      payload: { hourlyDays: 7, dailyDays: 30 },
    })).statusCode, 403);
  }
  for (const token of ["admin", "owner"]) {
    assert.equal((await app.inject({
      method: "PUT", url: "/api/usage/retention", headers: { authorization: `Bearer ${token}` },
      payload: { hourlyDays: 7, dailyDays: 30 },
    })).statusCode, 200);
  }
  assert.equal((await app.inject({
    method: "PUT", url: "/api/usage/retention", headers: { authorization: "Bearer owner" },
    payload: { hourlyDays: "7", dailyDays: 30 },
  })).statusCode, 400);
  assert.equal((await app.inject({
    method: "PUT", url: "/api/usage/retention", headers: { authorization: "Bearer foreign-admin" },
    payload: { hourlyDays: 2, dailyDays: 30 },
  })).statusCode, 200);
  assert.equal(db.getUsageRetentionPolicy("org_personal").hourlyDays, 7);
  assert.equal(db.getUsageRetentionPolicy("org_foreign").hourlyDays, 2, "retention writes stay in the principal organization");

  for (const url of [
    "/api/usage?days=7.5",
    "/api/usage?days=7&days=8",
    `/api/usage?runnerId=${"x".repeat(257)}`,
    "/api/usage?granularity=week",
  ]) {
    assert.equal((await app.inject({ method: "GET", url, headers: { authorization: "Bearer owner" } })).statusCode, 400);
  }
  const response = await app.inject({ method: "GET", url: "/api/usage?days=7", headers: { authorization: "Bearer owner" } });
  const body = response.json<Record<string, unknown>>();
  const forbiddenKeys = new Set(["sessionId", "prompt", "path", "toolInput", "eventBody", "environment", "auth"]);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      assert.equal(forbiddenKeys.has(key), false, `forbidden response key: ${key}`);
      visit(nested);
    }
  };
  visit(body);
  assert.equal(JSON.stringify(body).includes("Bearer owner"), false);
  assert.equal(body.privacy, "content-free aggregates only; no session ids, prompts, paths, tool inputs, event bodies, environment values, or auth data");

  await app.close();
  db.close();
});
