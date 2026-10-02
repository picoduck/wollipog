import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";

test("upgrade defaults to separation, persists opt-in, and leaves unrelated Projects intact", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-memory-db-"));
  const path = join(root, "db.sqlite");
  try {
    let db = ControlPlaneDb.open(path);
    const project = db.createProject({ name: "Existing Project" });
    const other = db.createProject({ name: "Other Project" });
    db.close();
    const old = new DatabaseSync(path); old.exec("DROP TABLE project_memory_settings"); old.close();
    db = ControlPlaneDb.open(path);
    assert.equal(db.getProject(project.id)?.memorySharing, "separate");
    db.updateProject(project.id, { memorySharing: "shared" });
    db.updateProject(project.id, { name: "Renamed" });
    assert.throws(() => db.updateProject(project.id, { memorySharing: "invalid" as never }), /invalid/);
    db.close();
    db = ControlPlaneDb.open(path);
    assert.equal(db.getProject(project.id)?.memorySharing, "shared");
    assert.equal(db.getProject(other.id)?.memorySharing, "separate");
    assert.equal(db.getProject(project.id)?.name, "Renamed");
    db.updateProject(project.id, { memorySharing: "separate" });
    assert.equal(db.getProject(project.id)?.memorySharing, "separate"); db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("transport stamps the current project policy outside immutable receipt payloads and gates older runners", () => {
  let protocolVersion = 195; let sharing: "shared" | "separate" = "shared";
  const db = { getRunner: () => ({ protocolVersion }), getSession: () => ({ runnerId: "r", projectId: "p" }),
    projectMemorySharing: () => sharing } as unknown as ControlPlaneDb;
  const sent: string[] = [];
  const hub = new Hub(db); hub.attachRunner("r", { send: (data) => sent.push(data) });
  const command = { type: "prompt_session" as const, sessionId: "s", text: "continue" };
  const message = { type: "durable_session_command" as const, requestId: "request", commandId: "command", executionId: "exec",
    payloadDigest: "unchanged", expiresAt: 1000, command };
  hub.sendToRunner("r", message);
  assert.deepEqual(JSON.parse(sent.at(-1)!).projectMemory, { projectId: "p", sharing: "shared" });
  sharing = "separate"; hub.sendToRunner("r", message);
  assert.deepEqual(JSON.parse(sent.at(-1)!).projectMemory, { projectId: "p", sharing: "separate" });
  assert.deepEqual(JSON.parse(sent.at(-1)!).command, command);
  assert.equal(message.payloadDigest, "unchanged"); assert.ok(!("projectMemory" in message));
  protocolVersion = 194; hub.sendToRunner("r", message);
  assert.ok(!("projectMemory" in JSON.parse(sent.at(-1)!)));
});
