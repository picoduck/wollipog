import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { AssistantCommandReceipts, assistantRequestDigest } from "./assistant-command-receipts.js";

test("durable reservation deduplicates, binds operation/content and atomically associates work", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    AssistantCommandReceipts.install(sql);
    sql.exec("CREATE TABLE origins (command_id TEXT PRIMARY KEY)");
    const store = new AssistantCommandReceipts(sql);
    const request = { controlPlaneId: "cp", connectionId: "connection", operationId: "event:1", operation: "session_launch", argumentsDigest: assistantRequestDigest({ b: 2, a: 1 }), grantRevision: 1, target: {kind: "project", id: "p", projectId: "p"} };
    assert.equal(request.argumentsDigest, assistantRequestDigest({a: 1, b: 2}));
    assert.throws(() => store.reserve(request, () => { sql.prepare("INSERT INTO origins VALUES (?)").run("event:1"); throw new Error("rollback"); }));
    assert.equal(store.get("connection", "event:1"), null);
    assert.equal(sql.prepare("SELECT * FROM origins").all().length, 0);
    assert.equal(store.reserve(request, () => { sql.prepare("INSERT INTO origins VALUES (?)").run("event:1"); }).created, true);
    assert.equal(new AssistantCommandReceipts(sql).reserve(request, () => assert.fail("duplicate association")).created, false);
    assert.throws(() => store.reserve({...request, operation: "session_prompt"}), /different operation/);
    assert.throws(() => store.reserve({...request, argumentsDigest: "changed"}), /different operation or request/);
    assert.equal(store.reserve({...request, connectionId: "second"}).created, true);
    const settled = store.settle("connection", "event:1", "uncertain", "session-id");
    assert.equal(settled.resultReference, "session-id");
    assert.equal(store.reserve(request).receipt.status, "uncertain");
    assert.equal(store.settle("connection", "event:1", "succeeded").status, "uncertain");
  } finally { sql.close(); }
});

test("request digest uses locale-independent code-unit key order", () => {
  const expected = createHash("sha256").update('{"aB":2,"a_b":1,"ab":3}').digest("hex");
  assert.equal(assistantRequestDigest({ab: 3, a_b: 1, aB: 2}), expected);
});

test("a process interruption leaves its reservation durable after SQLite reopen, without replay permission", () => {
  const directory = mkdtempSync(join(tmpdir(), "assistant-receipts-"));
  const path = join(directory, "receipts.sqlite");
  let db = new DatabaseSync(path);
  try {
    AssistantCommandReceipts.install(db);
    const input = {controlPlaneId: "cp", connectionId: "connection", operationId: "interrupted", operation: "session_launch",
      argumentsDigest: assistantRequestDigest({locationId: "location"}), grantRevision: 2, target: {kind: "project", id: "project", projectId: "project"}};
    new AssistantCommandReceipts(db).reserve(input);
    db.close();
    db = new DatabaseSync(path);
    const recovered = new AssistantCommandReceipts(db).reserve(input);
    assert.equal(recovered.created, false);
    assert.equal(recovered.receipt.status, "accepted");
    assert.equal(recovered.receipt.grantRevision, 2);
  } finally {db.close(); rmSync(directory, {recursive: true});}
});
