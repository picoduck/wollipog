import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AssistantCommandConfirmations, ASSISTANT_CONFIRMATION_TTL_MS, type AssistantConfirmationBinding } from "./assistant-command-confirmations.js";
import { AssistantConnections, assistantCallContext } from "./assistant-connections.js";
import { AssistantOwnerConfirmations } from "./assistant-owner-confirmations.js";

test("confirmation binds exact connection, arguments, grant and target, expires, and consumes transactionally", () => {
  const db = new DatabaseSync(":memory:");
  try {
    AssistantConnections.install(db);
    AssistantCommandConfirmations.install(db);
    const store = new AssistantCommandConfirmations(db);
    const binding = {connectionId: "connection", operation: "session_stop", grantRevision: 1, argumentsDigest: "args", targetDigest: "target"};
    const first = store.issue(binding, 100);
    assert.throws(() => store.consume(first.confirmationId, {...binding, connectionId: "other"}, 101));
    assert.throws(() => store.consume(first.confirmationId, {...binding, operation: "session_archive"}, 101));
    assert.throws(() => store.consume(first.confirmationId, {...binding, grantRevision: 2}, 101));
    assert.throws(() => store.consume(first.confirmationId, {...binding, argumentsDigest: "other"}, 101));
    assert.throws(() => store.consume(first.confirmationId, {...binding, targetDigest: "other"}, 101));
    db.exec("SAVEPOINT receipt");
    store.consume(first.confirmationId, binding, 101);
    db.exec("ROLLBACK TO receipt; RELEASE receipt");
    store.consume(first.confirmationId, binding, 102);
    assert.throws(() => store.consume(first.confirmationId, binding, 103));
    const second = store.issue(binding, 200);
    assert.throws(() => store.consume(second.confirmationId, binding, 200 + ASSISTANT_CONFIRMATION_TTL_MS));
    for (let i = 0; i < 110; i++) store.issue(binding, 300 + i);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM assistant_command_confirmations").get() as {n: number}).n, 100);
  } finally {db.close();}
});

test("a thread connection's preview asks its owner and only the approved run spends it, inside the reservation", () => {
  const db = new DatabaseSync(":memory:");
  try {
    AssistantConnections.install(db);
    AssistantCommandConfirmations.install(db);
    AssistantOwnerConfirmations.install(db);
    db.exec(`CREATE TABLE assistant_command_receipts (connection_id TEXT, command_id TEXT, operation TEXT, digest TEXT, receipt_json TEXT);
      CREATE TABLE sessions (id TEXT, title TEXT);`);
    db.prepare("INSERT INTO assistant_connections (id,name,owner_user_id,organization_id,grant_json,revision,token_hash,revoked,thread_id,expires_at) VALUES ('thread-connection','T','u','o','{}',1,'h',0,'thr_1',0)").run();
    const owner = new AssistantOwnerConfirmations(db), store = new AssistantCommandConfirmations(db, owner);
    const binding = {connectionId: "thread-connection", operation: "session_stop", grantRevision: 1, argumentsDigest: "args", targetDigest: "target"};
    const request = {commandId: "stop-1", args: {commandId: "stop-1", sessionId: "s"}, target: {kind: "session", id: "s"}};
    const preview = store.preview(binding, request, {recovery: "repeat with confirmationId"});
    assert.equal(preview.ownerConfirmationRequired, true);
    assert.equal(preview.confirmationId, undefined);
    assert.doesNotMatch(String(preview.recovery), /repeat with confirmationId/);
    assert.throws(() => store.issue(binding), /only after your owner approves/);
    const [pending] = owner.pendingForThread("thr_1");
    assert.throws(() => store.consume(pending!.id, binding), /only after your owner approves/);
    const run = (connectionId: string, spent: AssistantConfirmationBinding) =>
      assistantCallContext.run({connectionId, ownerConfirmationId: pending!.id}, () => store.consume("x", spent));
    // Not approved yet: even the control plane's run cannot spend it.
    assert.throws(() => run(binding.connectionId, binding), /no longer matches/);
    assert.equal(owner.approve(pending!.id, {userId: "u", organizationId: "o"} as never), true);
    // Another connection's run, or a different binding, cannot spend it either.
    assert.throws(() => run("other", binding), /only after your owner approves/);
    assert.throws(() => run(binding.connectionId, {...binding, targetDigest: "moved"}), /no longer matches/);
    // A reservation that rolls back leaves the approval unspent; the next one spends it once.
    db.exec("SAVEPOINT receipt");
    run(binding.connectionId, binding);
    db.exec("ROLLBACK TO receipt; RELEASE receipt");
    assert.equal(owner.get(pending!.id)?.status, "approved");
    run(binding.connectionId, binding);
    assert.equal(owner.get(pending!.id)?.status, "executed");
    assert.throws(() => run(binding.connectionId, binding), /no longer matches/);
  } finally {db.close();}
});
