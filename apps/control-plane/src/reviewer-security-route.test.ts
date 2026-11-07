import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { LOCAL_OWNER_USER_ID, PERSONAL_ORGANIZATION_ID, type HumanPrincipal } from "./identity.js";
import { registerReviewerSecurityRoutes } from "./reviewer-security-route.js";

test("only a machine's human manager can save reviewer policy; revisions, downgrade, and reconnect state are preserved", async () => {
  const db = ControlPlaneDb.open(":memory:");
  const app = Fastify();
  const principal: HumanPrincipal = { kind: "human", actorId: LOCAL_OWNER_USER_ID, userId: LOCAL_OWNER_USER_ID,
    userName: "Owner", organizationId: PERSONAL_ORGANIZATION_ID, organizationName: "Personal", role: "owner",
    deviceId: null, localBootstrap: true };
  const metadata = { runnerId: "r", hostname: "host", os: "linux" as const, version: "test",
    agents: [], workspaces: [], protocolVersion: PROTOCOL_VERSION };
  db.registerRunner(metadata, 1, PROTOCOL_VERSION);
  const sent: unknown[] = [];
  registerReviewerSecurityRoutes(app, db, {
    sendToRunner: (_id, message) => { sent.push(message); return true; },
    runnerChanged: () => {}, boxChanged: () => {},
  }, request => request.headers["x-agent"] ? { kind: "agent", actorId: "agent", organizationId: PERSONAL_ORGANIZATION_ID,
    delegatedScope: db.runnerScope("r")! } : request.headers["x-denied"] ? null : request.headers["x-other-org"]
    ? { ...principal, organizationId: "other" } : principal);
  const put = (payload: unknown, headers = {}) => app.inject({ method: "PUT", url: "/api/runners/r/reviewer-security", payload: payload as object, headers });
  try {
    assert.deepEqual(db.machineReviewerSecurity("r"), { policy: "strict", revision: 0 });
    const payload = { policy: "personal_machine", expectedRevision: 0 };
    assert.equal((await put(payload, { "x-agent": "1" })).statusCode, 403);
    assert.equal((await put(payload, { "x-denied": "1" })).statusCode, 403);
    assert.equal((await put(payload, { "x-other-org": "1" })).statusCode, 403);
    assert.equal((await put({ ...payload, policy: "anything" })).statusCode, 400);
    assert.equal((await put({ ...payload, expectedRevision: -1 })).statusCode, 400);
    assert.equal((await put(payload)).statusCode, 200);
    assert.deepEqual(sent, [{ type: "configure_reviewer_security", policy: "personal_machine", revision: 1 }]);
    assert.equal((await put(payload)).statusCode, 409);
    db.setMachineDisplayName("r", "Host");
    db.setMachineDisplayName("r", "");
    assert.deepEqual(db.machineReviewerSecurity("r"), { policy: "personal_machine", revision: 1 });
    db.registerRunner(metadata, 2, PROTOCOL_VERSION);
    assert.deepEqual(db.getRunner("r")?.reviewerSecurity, { policy: "personal_machine", revision: 1 });
    db.registerRunner(metadata, 3, 324);
    assert.equal((await put({ policy: "strict", expectedRevision: 1 })).statusCode, 409);
    assert.equal(db.getRunner("r")?.reviewerSecurity, undefined);
  } finally { await app.close(); db.close(); }
});
