import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { registerBoxLegacyAdoptionRoute } from "./box-legacy-adoption-route.js";
import { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";

function principal(organizationId: string, role: HumanPrincipal["role"] = "owner"): HumanPrincipal {
  return {
    kind: "human",
    actorId: `user-${organizationId}`,
    userId: `user-${organizationId}`,
    userName: "Test User",
    organizationId,
    organizationName: organizationId,
    role,
    deviceId: null,
    localBootstrap: false,
  };
}

function organizationScope(organizationId: string) {
  return {
    organizationId,
    owner: { kind: "organization" as const, organizationId },
  };
}

test("legacy adoption route binds owner authority to the requested box's exact runner scope", async () => {
  const db = ControlPlaneDb.open(":memory:");
  db.createBox({
    boxId: "box-org-a",
    runnerId: "runner-org-a",
    sshTarget: "org-a@example",
    sshPort: 22,
    workspaces: [],
    autoReconnect: false,
    runnerDataDir: null,
    scope: organizationScope("org-a"),
    now: 1,
  });
  db.createBox({
    boxId: "box-org-b",
    runnerId: "runner-org-b",
    sshTarget: "org-b@example",
    sshPort: 22,
    workspaces: [],
    autoReconnect: false,
    runnerDataDir: null,
    scope: organizationScope("org-b"),
    now: 1,
  });
  const calls: string[] = [];
  const app = Fastify();
  registerBoxLegacyAdoptionRoute(app, {
    db,
    orchestrator: {
      authorizeLegacyDataAdoption: async (boxId) => {
        calls.push(boxId);
        return "started";
      },
    },
    requestHuman: (req) => principal(String(req.headers["x-test-org"] ?? "org-a"),
      req.headers["x-test-role"] === "member" ? "member" : "owner"),
  });
  await app.ready();
  const payload = { acknowledgeAllLegacyRunnersStopped: true };
  try {
    const authorized = await app.inject({
      method: "POST",
      url: "/api/boxes/box-org-a/adopt-legacy-data-dir",
      payload,
    });
    assert.equal(authorized.statusCode, 200);
    assert.deepEqual(calls, ["box-org-a"]);

    db.createBox({
      boxId: "box-org-b-sibling",
      runnerId: "runner-org-b-sibling",
      sshTarget: "org-a@example",
      sshPort: 22,
      workspaces: [],
      autoReconnect: false,
      runnerDataDir: null,
      scope: organizationScope("org-b"),
      now: 2,
    });
    const hiddenSibling = await app.inject({
      method: "POST",
      url: "/api/boxes/box-org-a/adopt-legacy-data-dir",
      payload,
    });
    assert.equal(hiddenSibling.statusCode, 409);
    assert.equal(hiddenSibling.json().code, "LEGACY_SSH_ACCOUNT_SCOPE_CONFLICT");
    assert.deepEqual(calls, ["box-org-a"], "a hidden sibling prevents cross-organization account fencing");

    const foreignOrganization = await app.inject({
      method: "POST",
      url: "/api/boxes/box-org-b/adopt-legacy-data-dir",
      headers: { "x-test-org": "org-a" },
      payload,
    });
    assert.equal(foreignOrganization.statusCode, 404);
    assert.deepEqual(foreignOrganization.json(), { error: "box not found" });

    const wrongRunnerScope = await app.inject({
      method: "POST",
      url: "/api/boxes/box-org-a/adopt-legacy-data-dir",
      headers: { "x-test-org": "org-b" },
      payload,
    });
    assert.equal(wrongRunnerScope.statusCode, 404);
    assert.deepEqual(wrongRunnerScope.json(), { error: "box not found" });

    const nonAdministrator = await app.inject({
      method: "POST",
      url: "/api/boxes/box-org-a/adopt-legacy-data-dir",
      headers: { "x-test-role": "member" },
      payload,
    });
    assert.equal(nonAdministrator.statusCode, 403);
    assert.deepEqual(calls, ["box-org-a"], "no wrong-box, wrong-runner, or wrong-role request reaches orchestration");
  } finally {
    await app.close();
    db.close();
  }
});

test("legacy adoption route returns a bounded account-level conflict for duplicate adoption", async () => {
  const db = ControlPlaneDb.open(":memory:");
  db.createBox({
    boxId: "box-duplicate",
    runnerId: "runner-duplicate",
    sshTarget: "owner@example",
    sshPort: 22,
    workspaces: [],
    autoReconnect: false,
    runnerDataDir: null,
    scope: organizationScope("org-a"),
    now: 1,
  });
  const app = Fastify();
  registerBoxLegacyAdoptionRoute(app, {
    db,
    orchestrator: { authorizeLegacyDataAdoption: async () => "account_already_adopted" },
    requestHuman: () => principal("org-a"),
  });
  await app.ready();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/boxes/box-duplicate/adopt-legacy-data-dir",
      payload: { acknowledgeAllLegacyRunnersStopped: true },
    });
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.json(), {
      error: "this SSH account's legacy data was already adopted; use the normal owner-aware runner launch",
      code: "LEGACY_SSH_ACCOUNT_ALREADY_ADOPTED",
    });
  } finally {
    await app.close();
    db.close();
  }
});
