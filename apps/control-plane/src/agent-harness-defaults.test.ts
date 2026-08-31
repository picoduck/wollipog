import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { PROTOCOL_VERSION, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";
import {
  AgentHarnessDefaultsSettings,
  agentHarnessIdentityKey,
  parseAgentHarnessDefaultConfig,
  parseAgentHarnessIdentity,
} from "./agent-harness-defaults.js";
import { registerAgentHarnessDefaultsRoutes } from "./agent-harness-defaults-route.js";

function runner(runnerId: string, models: string[], permissionModes: string[]): RunnerMetadata {
  return {
    runnerId,
    hostname: runnerId === "runner-a" ? "Laptop" : "Desktop",
    os: "linux",
    version: "1.0.0",
    workspaces: [{ id: "workspace", name: "Workspace", path: "/workspace" }],
    agents: [{
      id: "codex",
      name: "Codex App Server",
      command: "/secret/path/codex",
      args: ["app-server"],
      env: { SECRET: "must-not-project" },
      driver: "codex-app-server",
      context: { kind: "native" },
      capabilities: {
        models: models.map((id, index) => ({
          id,
          displayName: id[0]!.toUpperCase() + id.slice(1),
          default: index === 0,
          efforts: id === "luna" ? ["low", "high"] : ["high"],
        })),
        effortLevels: ["low", "high"],
        permissionModes,
        slashCommands: [],
        supportsImages: true,
        supportsApprovals: true,
      },
    }],
  };
}

function localHuman(db: ControlPlaneDb, role: HumanPrincipal["role"] = "viewer"): HumanPrincipal {
  const local = db.localIdentityContext();
  return {
    kind: "human",
    actorId: local.userId,
    userId: local.userId,
    userName: local.userName,
    organizationId: local.organizationId,
    organizationName: local.organizationName,
    role,
    deviceId: "device",
    localBootstrap: false,
  };
}

test("Agent Harness defaults aggregate installations, preserve drift, and remain per user", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner("runner-a", ["sol", "luna"], ["auto-review", "full-access"]), 1, PROTOCOL_VERSION);
  db.registerRunner(runner("runner-b", ["sol"], ["auto-review"]), 2, PROTOCOL_VERSION);
  const settings = new AgentHarnessDefaultsSettings(db);
  const principal = localHuman(db);
  const initial = settings.view(principal);
  assert.equal(initial.defaults.length, 1);
  assert.equal(initial.defaults[0]?.installations.length, 2);
  assert.equal(JSON.stringify(initial).includes("must-not-project"), false);
  assert.equal(JSON.stringify(initial).includes("/secret/path"), false);

  const updated = settings.update(principal, {
    agentId: "codex",
    driver: "codex-app-server",
    context: { kind: "native" },
    config: { model: "luna", effort: "low", permissionMode: "full-access" },
  }, 10);
  assert.deepEqual(updated.defaults[0]?.preference, {
    model: "luna", effort: "low", permissionMode: "full-access",
  });
  assert.equal(updated.defaults[0]?.compatibleInstallations, 1);

  db.raw().prepare("INSERT INTO identity_users VALUES (?, ?, 'active', ?, ?)")
    .run("other-user", "Other User", 3, 3);
  db.raw().prepare("INSERT INTO identity_memberships VALUES (?, ?, 'viewer', ?, ?)")
    .run(principal.organizationId, "other-user", 3, 3);
  const other: HumanPrincipal = { ...principal, actorId: "other-user", userId: "other-user", userName: "Other User" };
  assert.equal(settings.view(other).defaults[0]?.preference, undefined,
    "one user's preference must never project into another user's view");
  settings.update(other, {
    agentId: "codex", driver: "codex-app-server", context: { kind: "native" },
    config: { model: "sol", effort: "high", permissionMode: "auto-review" },
  }, 9);
  assert.deepEqual(db.getAgentHarnessDefault("other-user", {
    agentId: "codex", driver: "codex-app-server", context: { kind: "native" },
  })?.config, { model: "sol", effort: "high", permissionMode: "auto-review" });
  assert.deepEqual(db.getAgentHarnessDefault(principal.userId, {
    agentId: "codex", driver: "codex-app-server", context: { kind: "native" },
  })?.config, { model: "luna", effort: "low", permissionMode: "full-access" });

  db.updateRunnerAgents("runner-a", runner("runner-a", ["sol"], ["auto-review"]).agents, 11);
  const drifted = settings.view(principal);
  assert.equal(drifted.defaults[0]?.compatibleInstallations, 0);
  assert.deepEqual(drifted.defaults[0]?.preference, {
    model: "luna", effort: "low", permissionMode: "full-access",
  }, "discovery drift must not silently rewrite the saved preference");

  assert.throws(() => settings.update(principal, {
    agentId: "codex",
    driver: "codex-app-server",
    context: { kind: "native" },
    config: { model: "luna", effort: "low", permissionMode: "full-access" },
  }), /not supported/);
  assert.equal(settings.delete(principal, {
    agentId: "codex", driver: "codex-app-server", context: { kind: "native" },
  }).defaults[0]?.preference, undefined);
});

test("Agent Harness default parsing rejects ambiguous identities and free-form empty config", () => {
  assert.equal(parseAgentHarnessIdentity({ agentId: "codex", driver: "unknown", context: { kind: "native" } }), null);
  assert.equal(parseAgentHarnessIdentity({ agentId: "codex", driver: "codex", context: { kind: "wsl", distro: "" } }), null);
  assert.equal(parseAgentHarnessDefaultConfig({}), null);
  assert.equal(parseAgentHarnessDefaultConfig({ model: " luna " }), null);
  const identity = parseAgentHarnessIdentity({
    agentId: "codex", driver: "codex-app-server", context: { kind: "wsl", distro: "Ubuntu" },
  });
  assert.ok(identity);
  assert.equal(agentHarnessIdentityKey(identity), '["codex","codex-app-server","wsl","Ubuntu"]');
});

test("Agent Harness default routes require a human and let each authenticated user manage only their own rows", async () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner("runner-a", ["sol", "luna"], ["auto-review", "full-access"]), 1, PROTOCOL_VERSION);
  const human = localHuman(db, "viewer");
  const principals = new Map<string, AuthPrincipal>([
    ["human", human],
    ["agent", {
      kind: "agent",
      actorId: "agent",
      organizationId: human.organizationId,
      delegatedScope: { organizationId: human.organizationId, owner: { kind: "organization", organizationId: human.organizationId } },
    }],
  ]);
  const app = Fastify();
  registerAgentHarnessDefaultsRoutes(app, new AgentHarnessDefaultsSettings(db), (request) =>
    principals.get(request.headers.authorization?.replace(/^Bearer /, "") ?? "") ?? null);

  assert.equal((await app.inject({ method: "GET", url: "/api/agent-harness-defaults" })).statusCode, 403);
  assert.equal((await app.inject({
    method: "GET", url: "/api/agent-harness-defaults", headers: { authorization: "Bearer agent" },
  })).statusCode, 403);
  const saved = await app.inject({
    method: "PUT",
    url: "/api/agent-harness-defaults",
    headers: { authorization: "Bearer human" },
    payload: {
      agentId: "codex", driver: "codex-app-server", context: { kind: "native" },
      config: { model: "luna", effort: "low", permissionMode: "full-access" },
    },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.headers["cache-control"], "private, no-store");
  assert.equal(saved.json().defaults[0].preference.permissionMode, "full-access");
  assert.equal((await app.inject({
    method: "PUT", url: "/api/agent-harness-defaults", headers: { authorization: "Bearer human" },
    payload: { agentId: "codex", driver: "codex-app-server", context: { kind: "native" }, config: {} },
  })).statusCode, 400);
  assert.equal((await app.inject({
    method: "DELETE", url: "/api/agent-harness-defaults", headers: { authorization: "Bearer human" },
    payload: { agentId: "codex", driver: "codex-app-server", context: { kind: "native" } },
  })).statusCode, 200);
  assert.equal(db.listAgentHarnessDefaults(human.userId).length, 0);
  await app.close();
});
