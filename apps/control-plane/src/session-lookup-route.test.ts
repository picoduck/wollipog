import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import type { RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";
import { registerSessionLookupRoute } from "./session-lookup-route.js";

const runner: RunnerMetadata = {
  runnerId: "lookup-runner",
  hostname: "host",
  os: "linux",
  version: "1",
  agents: [],
  workspaces: [{ id: "lookup-workspace", name: "Workspace", path: "/repo" }],
};

test("session lookup validates ids and fails closed outside the authorized scope", async (t) => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner, 1, 55);
  db.createSession({
    id: "archived/session",
    runnerId: runner.runnerId,
    agentId: null,
    workspaceId: runner.workspaces[0]!.id,
    title: "Archived session",
    useWorktree: false,
    driver: "acp",
    config: {},
    now: 2,
  });
  db.setSessionArchived("archived/session", true, 3);

  const identity = db.localIdentityContext();
  const owner: HumanPrincipal = { kind: "human", actorId: identity.userId, ...identity };
  const foreign: HumanPrincipal = {
    ...owner,
    actorId: "foreign-user",
    userId: "foreign-user",
    organizationId: "foreign-org",
    organizationName: "Foreign",
    localBootstrap: false,
  };
  const app = Fastify();
  registerSessionLookupRoute(app, {
    db,
    requestPrincipal: (req) => req.headers.authorization === "Bearer owner"
      ? owner
      : req.headers.authorization === "Bearer foreign" ? foreign : null,
  });
  await app.ready();
  t.after(async () => { await app.close(); db.close(); });

  for (const id of ["", "   ", "x".repeat(257)]) {
    const response = await app.inject({ method: "GET", url: `/api/sessions/lookup/by-id?id=${encodeURIComponent(id)}` });
    assert.equal(response.statusCode, 400);
  }
  assert.equal((await app.inject({
    method: "GET", url: "/api/sessions/lookup/by-id?id=archived%2Fsession",
  })).statusCode, 404);
  assert.equal((await app.inject({
    method: "GET", url: "/api/sessions/lookup/by-id?id=archived%2Fsession",
    headers: { authorization: "Bearer foreign" },
  })).statusCode, 404);
  assert.equal((await app.inject({
    method: "GET", url: "/api/sessions/lookup/by-id?id=missing",
    headers: { authorization: "Bearer owner" },
  })).statusCode, 404);

  const authorized = await app.inject({
    method: "GET", url: "/api/sessions/lookup/by-id?id=archived%2Fsession",
    headers: { authorization: "Bearer owner" },
  });
  assert.equal(authorized.statusCode, 200);
  assert.equal(authorized.json().session.id, "archived/session");
  assert.equal(authorized.json().session.archived, true);
});
