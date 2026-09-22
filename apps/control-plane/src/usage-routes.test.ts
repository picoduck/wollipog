import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import { PROTOCOL_VERSION, type ControlPlaneToRunner } from "@wollipog/protocol";
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
    "/api/usage?granularity=month",
  ]) {
    assert.equal((await app.inject({ method: "GET", url, headers: { authorization: "Bearer owner" } })).statusCode, 400);
  }
  const weekly = await app.inject({
    method: "GET", url: "/api/usage?days=30&granularity=week", headers: { authorization: "Bearer owner" },
  });
  assert.equal(weekly.statusCode, 200);
  assert.equal(weekly.json<{ granularity: string }>().granularity, "week");
  db.raw().prepare(
    `INSERT INTO usage_daily
       (bucket_ts, organization_id, owner_kind, owner_id, runner_id, workspace_id, agent_id, driver, model,
        input_tokens, output_tokens, cost_microusd)
     VALUES (?, 'org_personal', 'organization', 'org_personal', 'rolled-runner', '', '', 'acp', '', 1, 0, 1)`,
  ).run(Math.floor(Date.now() / 86_400_000) * 86_400_000);
  const legacyDefault = await app.inject({
    method: "GET", url: "/api/usage?days=7", headers: { authorization: "Bearer owner" },
  });
  assert.equal(legacyDefault.statusCode, 200, "a legacy request without granularity keeps the complete-result fallback");
  assert.equal(legacyDefault.json<{ granularity: string }>().granularity, "day");
  const unavailableHour = await app.inject({
    method: "GET", url: "/api/usage?days=7&granularity=hour", headers: { authorization: "Bearer owner" },
  });
  assert.equal(unavailableHour.statusCode, 400);
  assert.equal(unavailableHour.json<{ code: string }>().code, "USAGE_HOURLY_DATA_UNAVAILABLE");
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

test("subscription usage routes are human-scoped and refresh only visible current online runners", async () => {
  const db = ControlPlaneDb.open(":memory:");
  const agent = {
    id: "codex", name: "Codex", command: "codex", args: [], env: {},
    driver: "codex-app-server" as const, context: { kind: "native" as const },
    codexAppServer: { status: "supported" as const, appServerAvailable: true, transport: "stdio" as const,
      contractFingerprint: "test" },
  };
  const register = (runnerId: string, protocolVersion: number, userId: string) => db.registerRunner({
    runnerId, hostname: runnerId, os: "linux", version: "1", agents: [agent], workspaces: [],
    ...(runnerId === "current" ? {
      providerAccounts: [{ id: "work", label: "Work", provider: "codex" as const, authStatus: "authenticated" as const }],
    } : {}),
  }, Date.now(), protocolVersion, {
    organizationId: "org_personal", owner: { kind: "user", userId },
  });
  register("current", PROTOCOL_VERSION, "operator-user");
  register("old", 77, "operator-user");
  register("foreign-private", PROTOCOL_VERSION, "someone-else");
  const sent: Array<{ runnerId: string; message: ControlPlaneToRunner; timeoutMs: number }> = [];
  const sourceId = createHash("sha256").update(JSON.stringify({
    runnerId: "current", provider: "codex", providerAccountId: "work",
  })).digest("hex").slice(0, 32);
  const app = Fastify();
  registerUsageRoutes(app, db, (request) => {
    const token = request.headers.authorization?.replace(/^Bearer /, "");
    if (token === "operator") return human("operator");
    if (token === "agent") return {
      kind: "agent", actorId: "agent", organizationId: "org_personal",
      delegatedScope: { organizationId: "org_personal", owner: { kind: "user", userId: "operator-user" } },
    };
    return null;
  }, {
    requestFromRunner: async (runnerId, _requestId, message, timeoutMs) => {
      sent.push({ runnerId, message, timeoutMs });
      const snapshot = {
        sourceId, runnerId, agentId: "codex", provider: "codex" as const, state: "available" as const,
        providerAccountId: "work", accountLabel: "Work",
        fetchedAt: Date.now(), buckets: [{ id: "codex:primary", label: "Five-Hour Window", usedPercent: 20 }],
      };
      db.upsertSubscriptionUsageSnapshot(snapshot);
      return { type: "subscription_usage_refresh_result", requestId: message.requestId!, ok: true, snapshots: [snapshot] };
    },
  });

  for (const url of ["/api/usage/subscriptions", "/api/usage/subscriptions/refresh"]) {
    assert.equal((await app.inject({ method: url.endsWith("refresh") ? "POST" : "GET", url })).statusCode, 403);
    assert.equal((await app.inject({
      method: url.endsWith("refresh") ? "POST" : "GET", url, headers: { authorization: "Bearer agent" },
    })).statusCode, 403);
  }
  const response = await app.inject({
    method: "POST", url: "/api/usage/subscriptions/refresh", headers: { authorization: "Bearer operator" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.runnerId, "current", "old-protocol and inaccessible runners are not contacted");
  assert.equal(sent[0]?.message.type, "refresh_subscription_usage");
  assert.equal(sent[0]?.timeoutMs, 10_000);
  assert.equal(response.json().sources[0].state, "available");
  assert.deepEqual(response.json().refresh, { attempted: 1, failed: 0 });

  const targeted = await app.inject({
    method: "POST",
    url: "/api/usage/subscriptions/refresh",
    headers: { authorization: "Bearer operator" },
    payload: { runnerId: "current", providerAccountId: "work" },
  });
  assert.equal(targeted.statusCode, 200);
  assert.equal(sent.length, 2);
  assert.equal(sent[1]?.runnerId, "current");
  assert.equal(sent[1]?.message.type, "refresh_subscription_usage");
  assert.equal(sent[1]?.message.type === "refresh_subscription_usage"
    ? sent[1].message.providerAccountId : undefined, "work");
  assert.equal((await app.inject({
    method: "POST",
    url: "/api/usage/subscriptions/refresh",
    headers: { authorization: "Bearer operator" },
    payload: { runnerId: "current", providerAccountId: "missing" },
  })).statusCode, 404);
  assert.equal((await app.inject({
    method: "POST",
    url: "/api/usage/subscriptions/refresh",
    headers: { authorization: "Bearer operator" },
    payload: { runnerId: "current" },
  })).statusCode, 400);
  await app.close();
  db.close();
});

test("a partial Claude account config retains the legacy Codex refresh deadline", async () => {
  const db = ControlPlaneDb.open(":memory:");
  const codexAgent = (id: string) => ({
    id, name: id, command: "codex", args: [], env: {},
    driver: "codex-app-server" as const, context: { kind: "native" as const },
    codexAppServer: { status: "supported" as const, appServerAvailable: true, transport: "stdio" as const,
      contractFingerprint: "test" },
  });
  db.registerRunner({
    runnerId: "partial", hostname: "partial", os: "linux", version: "1",
    agents: [codexAgent("codex-a"), codexAgent("codex-b")], workspaces: [],
    providerAccounts: [
      { id: "claude-work", label: "Claude Work", provider: "claude", authStatus: "authenticated" },
    ],
  }, Date.now(), PROTOCOL_VERSION, {
    organizationId: "org_personal", owner: { kind: "user", userId: "operator-user" },
  });
  let timeoutMs = 0;
  const app = Fastify();
  registerUsageRoutes(app, db, () => human("operator"), {
    requestFromRunner: async (_runnerId, requestId, _message, timeout) => {
      timeoutMs = timeout;
      return { type: "subscription_usage_refresh_result", requestId, ok: true, snapshots: [] };
    },
  });
  const response = await app.inject({ method: "POST", url: "/api/usage/subscriptions/refresh" });
  assert.equal(response.statusCode, 200);
  assert.equal(timeoutMs, 18_000, "two legacy Codex sources retain two sequential probe budgets");
  await app.close();
  db.close();
});

test("refresh deadlines include configured and unmapped legacy Codex sources", async () => {
  const db = ControlPlaneDb.open(":memory:");
  const codexAgent = (id: string, context: { kind: "native" } | { kind: "wsl"; distro: string }) => ({
    id, name: id, command: "codex", args: [], env: {},
    driver: "codex-app-server" as const, context,
    codexAppServer: { status: "supported" as const, appServerAvailable: true, transport: "stdio" as const,
      contractFingerprint: "test" },
  });
  db.registerRunner({
    runnerId: "mixed", hostname: "mixed", os: "windows", version: "1",
    agents: [
      codexAgent("codex-native", { kind: "native" }),
      codexAgent("codex-wsl", { kind: "wsl", distro: "Ubuntu" }),
    ],
    workspaces: [],
    providerAccounts: [
      { id: "work", label: "Work", provider: "codex", authStatus: "authenticated" },
    ],
  }, Date.now(), PROTOCOL_VERSION, {
    organizationId: "org_personal", owner: { kind: "user", userId: "operator-user" },
  });
  let timeoutMs = 0;
  const app = Fastify();
  registerUsageRoutes(app, db, () => human("operator"), {
    requestFromRunner: async (_runnerId, requestId, _message, timeout) => {
      timeoutMs = timeout;
      return { type: "subscription_usage_refresh_result", requestId, ok: true, snapshots: [] };
    },
  });
  const response = await app.inject({ method: "POST", url: "/api/usage/subscriptions/refresh" });
  assert.equal(response.statusCode, 200);
  assert.equal(timeoutMs, 18_000, "one account plus one unmapped WSL source receive two probe budgets");
  await app.close();
  db.close();
});

test("usage responses carry rate-table status and members can force a bounded pricing refresh", async () => {
  const db = ControlPlaneDb.open(":memory:");
  const principals = new Map<string, AuthPrincipal>([["viewer", human("viewer")]]);
  let refreshes = 0;
  const pricing = {
    status: () => ({ status: "cached" as const, source: "https://rates.example/prices.json", fetchedAt: 123, knownModels: 2 }),
    ensure: async (force?: boolean) => {
      assert.equal(force, true);
      refreshes += 1;
      return { status: "fresh" as const, source: "https://rates.example/prices.json", fetchedAt: 456, knownModels: 3 };
    },
  };
  const app = Fastify();
  registerUsageRoutes(app, db, (request) => {
    const header = request.headers.authorization;
    return typeof header === "string" ? principals.get(header.replace(/^Bearer /, "")) ?? null : null;
  }, undefined, pricing);

  const usage = await app.inject({ method: "GET", url: "/api/usage", headers: { authorization: "Bearer viewer" } });
  assert.equal(usage.statusCode, 200);
  assert.deepEqual(usage.json().pricing, pricing.status());
  assert.deepEqual(usage.json().byModel, []);

  assert.equal((await app.inject({ method: "POST", url: "/api/usage/pricing/refresh" })).statusCode, 403);
  const refreshed = await app.inject({ method: "POST", url: "/api/usage/pricing/refresh", headers: { authorization: "Bearer viewer" } });
  assert.equal(refreshed.statusCode, 200);
  assert.equal(refreshed.json().pricing.knownModels, 3);
  assert.equal(refreshes, 1);

  const bare = Fastify();
  registerUsageRoutes(bare, db, () => human("viewer"));
  assert.equal((await bare.inject({ method: "GET", url: "/api/usage" })).json().pricing, undefined);
  assert.equal((await bare.inject({ method: "POST", url: "/api/usage/pricing/refresh" })).statusCode, 503);
});

test("the daily budget is readable by members, writable by admins, and per-user windows are scoped by role", async () => {
  const db = ControlPlaneDb.open(":memory:");
  const principals = new Map<string, AuthPrincipal>([["viewer", human("viewer")], ["admin", human("admin")]]);
  const app = Fastify();
  registerUsageRoutes(app, db, (request) => {
    const header = request.headers.authorization;
    return typeof header === "string" ? principals.get(header.replace(/^Bearer /, "")) ?? null : null;
  });
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  assert.equal((await app.inject({ method: "GET", url: "/api/usage/daily-budget" })).statusCode, 403);
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/usage/daily-budget", headers: auth("viewer") })).json(), {
    dailyBudget: { perUserUsd: null, updatedAt: null },
  });
  assert.equal((await app.inject({ method: "PUT", url: "/api/usage/daily-budget", headers: auth("viewer"), payload: { perUserUsd: 20 } })).statusCode, 403);
  assert.equal((await app.inject({ method: "PUT", url: "/api/usage/daily-budget", headers: auth("admin"), payload: { perUserUsd: -1 } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PUT", url: "/api/usage/daily-budget", headers: auth("admin"), payload: { perUserUsd: "20" } })).statusCode, 400);
  const saved = await app.inject({ method: "PUT", url: "/api/usage/daily-budget", headers: auth("admin"), payload: { perUserUsd: 20.004 } });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().dailyBudget.perUserUsd, 20);
  assert.equal((await app.inject({ method: "PUT", url: "/api/usage/daily-budget", headers: auth("admin"), payload: { perUserUsd: null } })).json().dailyBudget.perUserUsd, null);

  const bucket = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  for (const user of ["viewer-user", "admin-user"]) {
    db.raw().prepare(
      `INSERT INTO usage_hourly
         (bucket_ts, organization_id, owner_kind, owner_id, runner_id, workspace_id, agent_id, driver, model, input_tokens, output_tokens, cost_microusd)
       VALUES (?, 'org_personal', 'user', ?, 'r', '', 'a', 'claude-code', '', 1, 1, 2500000)`,
    ).run(bucket, user);
  }
  const mine = (await app.inject({ method: "GET", url: "/api/usage/users", headers: auth("viewer") })).json().users;
  assert.deepEqual(mine.map((row: { userId: string; todayUsd: number }) => [row.userId, row.todayUsd]), [["viewer-user", 2.5]], "a member sees only their own row");
  const everyone = (await app.inject({ method: "GET", url: "/api/usage/users", headers: auth("admin") })).json().users;
  assert.deepEqual(everyone.map((row: { userId: string }) => row.userId).sort(), ["admin-user", "viewer-user"]);
});

test("daily budgets cannot be armed over an active user-owned Agent TUI", async () => {
  let persisted = false;
  const db = {
    hasUserOwnedActiveAgentTui: () => true,
    setUsageDailyBudget: () => { persisted = true; },
  } as unknown as ControlPlaneDb;
  const app = Fastify();
  registerUsageRoutes(app, db, () => human("admin"));
  const response = await app.inject({
    method: "PUT",
    url: "/api/usage/daily-budget",
    payload: { perUserUsd: 20 },
  });
  assert.equal(response.statusCode, 409);
  assert.match(response.json().error, /Close every Agent TUI/);
  assert.equal(persisted, false);
});
