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
  let protocolVersion = 201;
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
  protocolVersion = 200; hub.sendToRunner("r", start); hub.sendToRunner("r", durable);
  assert.ok(!("artifactUploads" in JSON.parse(sent.at(-2)!).spec));
  assert.ok(!("artifactUploads" in JSON.parse(sent.at(-1)!)));
});

test("reconnect shares one retained-session scan and preserves both metadata streams and owner preferences", () => {
  const sessions = [
    { id: "automatic", runnerId: "current", projectId: "p", status: "completed", archived: true },
    { id: "external", runnerId: "current", projectId: null, status: "idle", archived: false },
    { id: "unowned", runnerId: "current", projectId: null, status: "completed", archived: true },
    { id: "older", runnerId: "older", projectId: null, status: "idle", archived: false },
  ];
  let scans = 0;
  let automatic = "wollipog_automatic";
  const db = {
    listSessions: (options: { includeArchived?: boolean }) => { assert.equal(options.includeArchived, true); scans++; return sessions; },
    getRunner: (id: string) => ({ protocolVersion: id === "older" ? 200 : 201 }),
    sessionOwnerUser: (id: string) => id === "unowned" ? null : { userId: id === "external" ? "second" : "first" },
    artifactUploadPreference: (id?: string) => id === "first" ? automatic : id === "second" ? "external_hosting" : "manual",
    projectMemorySharing: () => "shared",
  } as unknown as ControlPlaneDb;
  const sent: string[] = [];
  const hub = new Hub(db);
  hub.attachRunner("current", { send: (data) => sent.push(data) });
  hub.attachRunner("older", { send: (data) => sent.push(data) });
  scans = 0;
  hub.syncProjectMemory(undefined, "current");
  assert.equal(scans, 1, "reconnect must hydrate retained sessions only once");
  const frames = sent.map((data) => JSON.parse(data));
  assert.deepEqual(frames.filter((m) => m.type === "set_session_artifact_uploads").map((m) => [m.sessionId, m.preference]),
    [["automatic", "wollipog_automatic"], ["external", "external_hosting"], ["unowned", "manual"]]);
  assert.deepEqual(frames.filter((m) => m.type === "set_session_project_memory").map((m) => [m.sessionId, m.projectMemory]),
    [["automatic", { projectId: "p", sharing: "shared" }], ["external", { projectId: null, sharing: "separate" }],
      ["unowned", { projectId: null, sharing: "separate" }]]);

  sent.length = 0;
  hub.syncProjectMemory("p", "current");
  const filtered = sent.map((data) => JSON.parse(data));
  assert.equal(filtered.filter((m) => m.type === "set_session_artifact_uploads").length, 3,
    "runner preferences remain complete when project memory is filtered");
  assert.deepEqual(filtered.filter((m) => m.type === "set_session_project_memory").map((m) => m.sessionId), ["automatic"]);

  automatic = "manual";
  sent.length = 0;
  hub.syncProjectMemory(undefined, "current");
  assert.equal(JSON.parse(sent[0]!).preference, "manual", "reconnect explicitly clears a previously automatic preference");
  sent.length = 0;
  hub.syncArtifactUploads("first");
  assert.deepEqual(sent.map((data) => JSON.parse(data)),
    [{ type: "set_session_artifact_uploads", sessionId: "automatic", preference: "manual" }], "save sync is owner-scoped and gates older peers");
  sent.length = 0;
  hub.syncProjectMemory(undefined, "older");
  assert.deepEqual(sent.map((data) => JSON.parse(data)),
    [{ type: "set_session_project_memory", sessionId: "older", projectMemory: { projectId: null, sharing: "separate" } }]);
});
