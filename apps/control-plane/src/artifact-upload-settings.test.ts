import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import type { AuthPrincipal } from "./identity.js";
import { registerArtifactUploadSettingsRoutes } from "./artifact-upload-settings-route.js";

test("new and upgraded installations default Manual and persist only an explicit preference", () => {
  const root = mkdtempSync(join(tmpdir(), "artifact-upload-settings-"));
  const path = join(root, "db.sqlite");
  try {
    let db = ControlPlaneDb.open(path);
    const user = db.localIdentityContext().userId;
    assert.equal(db.artifactUploadPreference(user), "manual");
    db.close();
    const old = new DatabaseSync(path); old.exec("DROP TABLE artifact_upload_settings"); old.close();
    db = ControlPlaneDb.open(path);
    assert.equal(db.artifactUploadPreference(user), "manual");
    assert.equal(db.artifactUploadPreference(undefined), "manual");
    db.setArtifactUploadPreference(user, "external_hosting"); db.close();
    db = ControlPlaneDb.open(path);
    assert.equal(db.artifactUploadPreference(user), "external_hosting");
    db.setArtifactUploadPreference(user, "wollipog_automatic");
    assert.equal(db.artifactUploadPreference(user), "wollipog_automatic");
    assert.throws(() => db.setArtifactUploadPreference(user, "anything" as never), /invalid/);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only a human saves an exact preference and existing sessions are refreshed", async () => {
  const db = ControlPlaneDb.open(":memory:");
  const local = db.localIdentityContext();
  let principal: AuthPrincipal | null = { kind: "human", actorId: local.userId, userId: local.userId,
    userName: local.userName, organizationId: local.organizationId, organizationName: local.organizationName,
    role: "viewer", deviceId: "d", localBootstrap: false };
  const synced: string[] = [];
  const app = Fastify();
  registerArtifactUploadSettingsRoutes(app, db, { syncArtifactUploads: (id: string) => synced.push(id) } as unknown as Hub, () => principal);
  try {
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/artifact-upload-settings" })).json(), { preference: "manual" });
    for (const preference of ["wollipog_automatic", "external_hosting", "manual"]) {
      const response = await app.inject({ method: "PUT", url: "/api/artifact-upload-settings", payload: { preference } });
      assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), { preference });
      assert.match(response.headers["cache-control"] as string, /private/);
    }
    assert.deepEqual(synced, [local.userId, local.userId, local.userId]);
    for (const payload of [{ preference: "bad" }, { preference: "manual", extra: true }, []]) {
      assert.equal((await app.inject({ method: "PUT", url: "/api/artifact-upload-settings", payload })).statusCode, 400);
    }
    principal = null;
    assert.equal((await app.inject({ method: "GET", url: "/api/artifact-upload-settings" })).statusCode, 403);
    assert.equal((await app.inject({ method: "PUT", url: "/api/artifact-upload-settings", payload: { preference: "wollipog_automatic" } })).statusCode, 403);
    assert.equal(db.artifactUploadPreference(local.userId), "manual");
  } finally { await app.close(); db.close(); }
});

test("creation, restart and durable turns use the owner's current preference with old-peer gating", () => {
  let protocolVersion = 198;
  let preference = "manual";
  const db = { getRunner: () => ({ protocolVersion }), getSession: () => ({ runnerId: "r", projectId: null }),
    projectMemorySharing: () => "separate", sessionOwnerUser: () => ({ userId: "owner" }),
    artifactUploadPreference: (userId: string) => { assert.equal(userId, "owner"); return preference; } } as unknown as ControlPlaneDb;
  const sent: string[] = [];
  const hub = new Hub(db); hub.attachRunner("r", { send: (data) => sent.push(data) });
  const start = { type: "start_session" as const, spec: { sessionId: "s", workspaceId: null, workspacePath: "/workspace", agentId: "a", command: "codex", args: [], env: {}, useWorktree: false } };
  hub.sendToRunner("r", start);
  assert.equal(JSON.parse(sent.at(-1)!).spec.artifactUploads, "manual");
  preference = "external_hosting"; hub.sendToRunner("r", start);
  assert.equal(JSON.parse(sent.at(-1)!).spec.artifactUploads, "external_hosting");
  assert.ok(!("artifactUploads" in start.spec), "transport must not mutate stored start command");
  const command = { type: "prompt_session" as const, sessionId: "s", text: "continue" };
  const durable = { type: "durable_session_command" as const, requestId: "r", commandId: "c", executionId: "e", expiresAt: 1000, payloadDigest: "pinned", command };
  preference = "wollipog_automatic"; hub.sendToRunner("r", durable);
  const message = JSON.parse(sent.at(-1)!);
  assert.equal(message.artifactUploads, "wollipog_automatic"); assert.deepEqual(message.command, command);
  assert.equal(message.payloadDigest, "pinned"); assert.ok(!("artifactUploads" in durable));
  protocolVersion = 197; hub.sendToRunner("r", start); hub.sendToRunner("r", durable);
  assert.ok(!("artifactUploads" in JSON.parse(sent.at(-2)!).spec));
  assert.ok(!("artifactUploads" in JSON.parse(sent.at(-1)!)));
});
