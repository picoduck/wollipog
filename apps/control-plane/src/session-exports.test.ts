import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { hashToken } from "./auth.js";
import type { HumanPrincipal } from "./identity.js";
import { buildAuthorizedSessionTranscriptExport, buildSessionTranscriptExport } from "./session-exports.js";

const runner: RunnerMetadata = {
  runnerId: "runner-1",
  hostname: "host",
  os: "windows",
  version: "1",
  agents: [],
  workspaces: [{ id: "workspace-1", name: "Workspace", path: String.raw`C:\repos\private` }],
};

function database(): ControlPlaneDb {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner, 1, 51);
  db.createSession({
    id: "session-1",
    runnerId: "runner-1",
    agentId: null,
    workspaceId: "workspace-1",
    title: "Export me",
    useWorktree: true,
    driver: "acp",
    config: {},
    now: 1,
  });
  return db;
}

test("JSON and Markdown exports derive from the same least-data projection and safe headers", () => {
  const db = database();
  db.appendEvent("session-1", {
    kind: "user_message",
    text: String.raw`Read C:\repos\private\secret.ts`,
    images: [{ mimeType: "image/png", data: "SU1BR0VfTEVBSw==" }],
  }, 2);
  db.appendEvent("session-1", { kind: "tool_call", toolCallId: "tool-secret", title: "Read", status: "completed" }, 3);
  db.appendEvent("session-1", { kind: "agent_message", text: "Authorization: Bear" }, 4);
  db.appendEvent("session-1", { kind: "agent_message", text: "er credential-value" }, 5);

  const json = buildSessionTranscriptExport(db, "session-1", "json");
  const markdown = buildSessionTranscriptExport(db, "session-1", "markdown");
  assert.equal(json.ok, true);
  assert.equal(markdown.ok, true);
  if (!json.ok || !markdown.ok) return;
  assert.deepEqual(json.projection, markdown.projection);
  assert.deepEqual(JSON.parse(json.body.toString("utf8")), json.projection);
  assert.match(markdown.body.toString("utf8"), /Operationally redacted transcript export/);
  for (const body of [json.body.toString("utf8"), markdown.body.toString("utf8")]) {
    assert.ok(!body.includes("IMAGE_LEAK"));
    assert.ok(!body.includes("tool-secret"));
    assert.ok(!body.includes(String.raw`C:\repos\private`));
    assert.ok(!body.includes("credential-value"));
  }
  assert.equal(json.headers["cache-control"], "private, no-store");
  assert.equal(json.headers["x-content-type-options"], "nosniff");
  assert.equal(json.headers["content-length"], String(json.body.byteLength));
  assert.equal(markdown.headers["content-security-policy"], "sandbox");
  assert.match(json.headers["content-disposition"]!, /^attachment; filename="[A-Za-z0-9.-]+"$/);
});

test("bounded JSON exports preserve provider message boundaries", () => {
  const db = database();
  db.appendEvent("session-1", { kind: "agent_message", text: "first ", messageId: "m1" }, 2);
  db.appendEvent("session-1", { kind: "agent_message", text: "message", messageId: "m1" }, 3);
  db.appendEvent("session-1", { kind: "agent_message", text: "second", messageId: "m2" }, 4);

  const result = buildSessionTranscriptExport(db, "session-1", "json");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.projection.messages, [
    { role: "assistant", text: "first message" },
    { role: "assistant", text: "second" },
  ]);
});

test("empty and active sessions export the current cache without runner hydration", () => {
  const db = database();
  const result = buildSessionTranscriptExport(db, "session-1", "json");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(JSON.parse(result.body.toString("utf8")), {
    schemaVersion: 1,
    source: "control-plane-cache",
    completeness: "possibly-partial",
    messages: [],
  });
  assert.equal(result.throughSeq, 0);
});

test("preflight bounds reject source events and raw payload bytes without truncation", () => {
  const db = database();
  db.appendEvent("session-1", { kind: "user_message", text: "one" }, 2);
  db.appendEvent("session-1", { kind: "user_message", text: "two" }, 3);
  const count = buildSessionTranscriptExport(db, "session-1", "json", { maxEvents: 1 });
  assert.deepEqual(count, {
    ok: false,
    status: 413,
    error: "transcript snapshot contains 2 events; maximum is 1",
    code: "event_limit",
  });

  const bytes = buildSessionTranscriptExport(db, "session-1", "json", { maxSourceBytes: 1 });
  assert.equal(bytes.ok, false);
  if (bytes.ok) return;
  assert.equal(bytes.status, 413);
  assert.equal(bytes.code, "source_byte_limit");
});

test("projected UTF-8 bytes are bounded and unknown sessions are hidden", () => {
  const db = database();
  db.appendEvent("session-1", { kind: "user_message", text: "ééé" }, 2);
  const bytes = buildSessionTranscriptExport(db, "session-1", "json", { maxUtf8Bytes: 5 });
  assert.equal(bytes.ok, false);
  if (!bytes.ok) assert.equal(bytes.code, "byte_limit");
  assert.deepEqual(buildSessionTranscriptExport(db, "missing", "json"), {
    ok: false,
    status: 404,
    error: "session not found",
    code: "not_found",
  });
  assert.ok(Buffer.byteLength("ééé", "utf8") > 5);
});

test("authorized exports honor owner/admin/user/team scope and deny before event reads", () => {
  const db = database();
  db.appendEvent("session-1", { kind: "user_message", text: "scoped" }, 2);
  const local = db.localIdentityContext();
  for (const [userId, role] of [["operator", "operator"], ["viewer", "viewer"], ["admin", "admin"]] as const) {
    db.createIdentityMember({ userId, displayName: userId, organizationId: local.organizationId, role, now: 10 });
  }
  const principal = (userId: string, role: HumanPrincipal["role"]): HumanPrincipal => ({
    kind: "human",
    actorId: userId,
    userId,
    userName: userId,
    organizationId: local.organizationId,
    organizationName: local.organizationName,
    role,
    deviceId: `device-${userId}`,
    localBootstrap: false,
  });
  const owner = principal(local.userId, "owner");
  const operator = principal("operator", "operator");
  const viewer = principal("viewer", "viewer");
  const admin = principal("admin", "admin");
  assert.equal(db.setResourceScope({
    resource: "session",
    resourceId: "session-1",
    scope: { organizationId: local.organizationId, owner: { kind: "user", userId: "operator" } },
    now: 11,
  }), true);
  assert.equal(buildAuthorizedSessionTranscriptExport(db, owner, "session-1", "json").ok, true);
  assert.equal(buildAuthorizedSessionTranscriptExport(db, admin, "session-1", "json").ok, true);
  assert.equal(buildAuthorizedSessionTranscriptExport(db, operator, "session-1", "json").ok, true);

  let reads = 0;
  const originalRead = db.listTranscriptEventsThrough.bind(db);
  db.listTranscriptEventsThrough = (...args) => {
    reads += 1;
    return originalRead(...args);
  };
  assert.deepEqual(buildAuthorizedSessionTranscriptExport(db, viewer, "session-1", "json"), {
    ok: false, status: 404, error: "session not found", code: "not_found",
  });
  assert.equal(reads, 0);
  assert.equal(buildAuthorizedSessionTranscriptExport(db, {
    ...viewer, organizationId: "another-org", organizationName: "Another",
  }, "session-1", "json").ok, false);

  const team = db.createIdentityTeam({
    teamId: "team-readers",
    organizationId: local.organizationId,
    name: "Readers",
    memberUserIds: ["viewer"],
    now: 12,
  });
  assert.equal(db.setResourceScope({
    resource: "session",
    resourceId: "session-1",
    scope: { organizationId: local.organizationId, owner: { kind: "team", teamId: team.teamId } },
    now: 13,
  }), true);
  assert.equal(buildAuthorizedSessionTranscriptExport(db, viewer, "session-1", "markdown").ok, true);

  db.createDevice({
    id: "viewer-device", name: "viewer", tokenHash: hashToken("viewer-export-token"),
    userId: "viewer", organizationId: local.organizationId, now: 14,
  });
  db.updateIdentityMember({
    organizationId: local.organizationId, userId: "viewer", displayName: "viewer",
    role: "viewer", status: "suspended", now: 15,
  });
  assert.equal(db.deviceByTokenHash(hashToken("viewer-export-token")), null, "suspension fails authentication before export");
});

test("corrupted duplicated event metadata is rejected instead of reclassified", () => {
  for (const corrupt of [
    { columnKind: "user_message", payload: { kind: "permission_request", text: "MUST_NOT_EXPORT" } },
    { columnKind: "agent_message", payload: { kind: "agent_message", text: "MUST_NOT_EXPORT", final: "yes" } },
  ]) {
    const db = database();
    db.appendEvent("session-1", { kind: "user_message", text: "original" }, 2);
    const sqlite = (db as unknown as { db: DatabaseSync }).db;
    sqlite.prepare("UPDATE session_events SET kind=?, payload=? WHERE session_id=?")
      .run(corrupt.columnKind, JSON.stringify(corrupt.payload), "session-1");
    const result = buildSessionTranscriptExport(db, "session-1", "json");
    assert.deepEqual(result, {
      ok: false, status: 422, error: "transcript source contains an invalid event", code: "invalid_source",
    });
  }
});
