import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AssistantCommandConfirmations, ASSISTANT_CONFIRMATION_TTL_MS } from "./assistant-command-confirmations.js";

test("confirmation binds exact connection, arguments, grant and target, expires, and consumes transactionally", () => {
  const db = new DatabaseSync(":memory:");
  try {
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
