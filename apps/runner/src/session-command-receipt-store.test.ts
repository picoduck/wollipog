import assert from "node:assert/strict";

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { InvokeSessionCommandMessage } from "@wollipog/protocol";
import {
  SessionCommandReceiptStore,
  sessionCommandInvocationPayloadDigest,
} from "./session-command-receipt-store.js";

function message(overrides: Partial<InvokeSessionCommandMessage> = {}): InvokeSessionCommandMessage {
  const envelope: InvokeSessionCommandMessage = {
    type: "invoke_session_command",
    requestId: "req_1",
    invocationId: "inv_1",
    submissionId: "sub_1",
    payloadDigest: "",
    expiresAt: 10_000,
    sessionId: "session_1",
    providerCommandId: "provider_1",
    catalogRevision: "catalog_1",
    expectedExecutionMode: "passthrough",
    argumentText: "release candidate",
    ...overrides,
  };
  envelope.payloadDigest = overrides.payloadDigest ?? sessionCommandInvocationPayloadDigest(envelope);
  return envelope;
}

test("an invocation deduplicates by id and digest but a changed payload fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-command-dedupe-"));
  try {
    const store = new SessionCommandReceiptStore(root, { ownerId: "runner-a", now: () => 1 });
    const first = store.claim(message());
    assert.equal(first.kind, "new");
    if (first.kind !== "new") return;
    assert.equal(first.handle.queued().state, "queued");

    const duplicate = store.claim(message({ requestId: "req_2" }));
    assert.equal(duplicate.kind, "duplicate");
    assert.equal(duplicate.receipt.requestId, "req_2", "the response belongs to the retry request");
    assert.equal(duplicate.receipt.state, "queued");
    assert.equal(duplicate.receipt.duplicate, true);

    const conflict = store.claim(message({ argumentText: "different" }));
    assert.equal(conflict.kind, "conflict");
    assert.equal(conflict.receipt.code, "COMMAND_ID_CONFLICT");
    assert.equal(store.read("inv_1")?.state, "queued");

    const wrongSession = message({ sessionId: "session_2" });
    const ownershipConflict = store.claim(wrongSession);
    assert.equal(ownershipConflict.kind, "conflict");
    assert.equal(ownershipConflict.receipt.code, "COMMAND_ID_CONFLICT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const state of ["accepted", "queued", "started"] as const) {
  test(`a live foreign owner preserves ${state} work without handing out a second handle`, () => {
    const root = mkdtempSync(join(tmpdir(), "wollipog-session-command-live-owner-"));
    let now = 1;
    try {
      const first = new SessionCommandReceiptStore(root, {
        ownerId: "runner-a", now: () => now, ownerStaleMs: 10,
      });
      const claimed = first.claim(message());
      assert.equal(claimed.kind, "new");
      if (claimed.kind !== "new") return assert.fail("initial invocation was not claimed");
      if (state === "queued") claimed.handle.queued();
      if (state === "started") claimed.handle.started(42);
      const digest = createHash("sha256").update("inv_1", "utf8").digest("hex");
      const record = join(root, digest.slice(0, 2), `${digest}.json`);
      const before = readFileSync(record, "utf8");

      now = 2;
      const second = new SessionCommandReceiptStore(root, {
        ownerId: "runner-b", now: () => now, ownerStaleMs: 10,
      });
      const duplicate = second.claim(message());
      assert.equal(duplicate.kind, "duplicate");
      assert.equal("handle" in duplicate, false, "a live foreign owner cannot be given a second execution handle");
      if (duplicate.kind !== "duplicate") return assert.fail("live foreign ownership was not respected");
      assert.equal(duplicate.receipt.state, state);
      const after = readFileSync(record, "utf8");
      assert.equal(after, before, "the live owner's on-disk receipt remains unchanged");
      const persisted = JSON.parse(after) as { ownerId: string; state: string };
      assert.equal(persisted.ownerId, "runner-a");
      assert.equal(persisted.state, state);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("queued work is durably reclaimable after restart but started work becomes uncertain", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-command-restart-"));
  let now = 1;
  try {
    const first = new SessionCommandReceiptStore(root, {
      ownerId: "runner-a", now: () => now, ownerStaleMs: 10,
    });
    const claimed = first.claim(message());
    assert.equal(claimed.kind, "new");
    if (claimed.kind !== "new") return;
    assert.equal(claimed.handle.queued().state, "queued");

    now = 20;
    const restarted = new SessionCommandReceiptStore(root, {
      ownerId: "runner-b", now: () => now, ownerStaleMs: 10,
    });
    const queuedRecovery = restarted.staleRecoveries();
    assert.equal(queuedRecovery.length, 1);
    assert.equal(queuedRecovery[0]?.state, "queued");
    assert.deepEqual(queuedRecovery[0]?.message, message());
    const reclaimed = restarted.claim({ ...queuedRecovery[0]!.message, requestId: "req_2" });
    assert.equal(reclaimed.kind, "reclaimed");
    if (reclaimed.kind !== "reclaimed") return;
    assert.equal(reclaimed.receipt.state, "accepted");
    assert.equal(reclaimed.receipt.requestId, "req_2");
    assert.equal(reclaimed.handle.started(42).state, "started");

    now = 40;
    const afterSubmissionRestart = new SessionCommandReceiptStore(root, {
      ownerId: "runner-c", now: () => now, ownerStaleMs: 10,
    });
    const startedRecovery = afterSubmissionRestart.staleRecoveries();
    assert.equal(startedRecovery.length, 1);
    assert.equal(startedRecovery[0]?.state, "started");
    const uncertain = afterSubmissionRestart.claim({ ...startedRecovery[0]!.message, requestId: "req_3" });
    assert.equal(uncertain.kind, "duplicate");
    assert.equal(uncertain.receipt.state, "uncertain");
    assert.equal(uncertain.receipt.userEventSeq, 42);
    assert.equal(uncertain.receipt.requestId, "req_3");

    const replay = afterSubmissionRestart.recentUpdates();
    assert.equal(replay.length, 1);
    assert.equal(replay[0]?.state, "uncertain");
    assert.equal(replay[0]?.userEventSeq, 42);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("completed and rejected terminal receipts survive restart and are immutable", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-command-terminal-"));
  let now = 1;
  try {
    const store = new SessionCommandReceiptStore(root, {
      ownerId: "runner-a", now: () => now, ownerStaleMs: 10,
    });
    const completedClaim = store.claim(message());
    assert.equal(completedClaim.kind, "new");
    if (completedClaim.kind !== "new") return;
    completedClaim.handle.started(7);
    assert.equal(completedClaim.handle.completed().state, "completed");
    assert.throws(() => completedClaim.handle.completed(), /invalid session command transition/);
    assert.throws(() => completedClaim.handle.failed("too late"), /invalid session command transition/);

    const rejectedClaim = store.claim(message({ invocationId: "inv_2", requestId: "req_2" }));
    assert.equal(rejectedClaim.kind, "new");
    if (rejectedClaim.kind !== "new") return;
    assert.equal(rejectedClaim.handle.failed("unavailable", "COMMAND_UNAVAILABLE").state, "rejected");

    now = 20;
    const restarted = new SessionCommandReceiptStore(root, {
      ownerId: "runner-b", now: () => now, ownerStaleMs: 10,
    });
    assert.equal(restarted.claim(message({ requestId: "req_3" })).receipt.state, "completed");
    assert.equal(
      restarted.claim(message({ invocationId: "inv_2", requestId: "req_4" })).receipt.state,
      "rejected",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manual-command capacity is bounded per dedicated journal and duplicates still succeed", () => {
  const rootA = mkdtempSync(join(tmpdir(), "wollipog-session-command-capacity-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "wollipog-session-command-capacity-b-"));
  try {
    const firstJournal = new SessionCommandReceiptStore(rootA, {
      ownerId: "runner-a", now: () => 1, maxReceipts: 1,
    });
    assert.equal(firstJournal.claim(message()).kind, "new");
    assert.equal(firstJournal.claim(message({ requestId: "req_retry" })).kind, "duplicate");
    const full = firstJournal.claim(message({ invocationId: "inv_2", requestId: "req_2" }));
    assert.equal(full.kind, "conflict");
    assert.equal(full.receipt.code, "RECEIPT_STORE_FULL");
    assert.equal(full.receipt.revision, 1);

    const independentJournal = new SessionCommandReceiptStore(rootB, {
      ownerId: "runner-a", now: () => 1, maxReceipts: 1,
    });
    assert.equal(
      independentJournal.claim(message({ invocationId: "inv_2", requestId: "req_2" })).kind,
      "new",
      "capacity belongs to the caller-provided receipt root",
    );
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("receipts of every state remain dedupe-visible through expiry and prune only afterward", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-command-expiry-"));
  let now = 1;
  try {
    const store = new SessionCommandReceiptStore(root, { ownerId: "runner-a", now: () => now });
    const active = store.claim(message({ expiresAt: 100 }));
    assert.equal(active.kind, "new");
    if (active.kind !== "new") return;
    assert.equal(active.handle.queued().state, "queued");
    assert.equal(store.prune(99), 0);
    assert.equal(store.prune(100), 0);
    assert.equal(store.recentUpdates(100).length, 1);
    assert.equal(store.prune(101), 1);
    assert.equal(store.read("inv_1"), null);
    assert.equal(store.recentUpdates(101).length, 0);

    now = 102;
    const expired = store.claim(message({ invocationId: "inv_expired", requestId: "req_expired", expiresAt: 101 }));
    assert.equal(expired.kind, "conflict");
    assert.equal(expired.receipt.code, "COMMAND_EXPIRED");
    assert.equal(expired.receipt.revision, 1);
    assert.equal(store.read("inv_expired"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed envelopes and mismatched digests fail closed without creating a receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-command-invalid-"));
  try {
    const store = new SessionCommandReceiptStore(root, { ownerId: "runner-a", now: () => 1 });
    const malformed = { ...message(), expectedExecutionMode: "magic" } as never;
    assert.doesNotThrow(() => store.claim(malformed));
    assert.equal(store.claim(malformed).kind, "conflict");
    assert.equal(store.claim(malformed).receipt.revision, 1);
    assert.equal(store.read("inv_1"), null);

    const mismatch = store.claim(message({ payloadDigest: "a".repeat(64) }));
    assert.equal(mismatch.kind, "conflict");
    assert.equal(mismatch.receipt.code, "INVALID_COMMAND");
    assert.equal(mismatch.receipt.revision, 1);
    assert.equal(store.read("inv_1"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("periodic recovery and expiry use the startup metadata index instead of rescanning bulk history", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-command-index-"));
  let now = 1;
  try {
    for (let index = 0; index < 100; index += 1) {
      const envelope = message({
        requestId: `req_bulk_${index}`,
        invocationId: `inv_bulk_${index}`,
        submissionId: `sub_bulk_${index}`,
        expiresAt: 50,
      });
      const digest = createHash("sha256").update(envelope.invocationId, "utf8").digest("hex");
      const directory = join(root, digest.slice(0, 2));
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${digest}.json`), JSON.stringify({
        version: 2,
        requestId: envelope.requestId,
        invocationId: envelope.invocationId,
        submissionId: envelope.submissionId,
        sessionId: envelope.sessionId,
        payloadDigest: envelope.payloadDigest,
        state: "completed",
        revision: 2,
        ownerId: "runner-a",
        createdAt: 1,
        updatedAt: 1,
        expiresAt: envelope.expiresAt,
        providerCommandId: envelope.providerCommandId,
        catalogRevision: envelope.catalogRevision,
        expectedExecutionMode: envelope.expectedExecutionMode,
        argumentText: envelope.argumentText,
      }), "utf8");
    }

    const store = new SessionCommandReceiptStore(root, {
      ownerId: "runner-b", now: () => now, maxReceipts: 500,
    });
    const scanCount = () => (store as unknown as { fullRecordScans: number }).fullRecordScans;
    assert.equal(scanCount(), 1, "construction performs the one journal inventory scan");

    now = 51;
    assert.deepEqual(store.staleRecoveries(), []);
    assert.equal(store.prune(now, 25), 25, "the live timer may bound synchronous deletion work");
    assert.equal(scanCount(), 1, "recovery and expiry pruning do not enumerate journal shards");
    assert.equal(store.prune(), 75);
    assert.equal(store.prune(), 0);
    assert.equal(scanCount(), 1, "repeated timer work remains index-only");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const staleCallback of ["completed", "failed", "uncertain", "queued", "started"] as const) {
  for (const activeState of ["accepted", "queued", "started"] as const) {
    for (const check of ["retry", "recovery sweep"] as const) {
      test(`stale ${staleCallback} cleanup preserves ${activeState} ownership during ${check}`, (t) => {
        const root = mkdtempSync(join(tmpdir(), "wollipog-session-command-stale-handle-"));
        try {
          const store = new SessionCommandReceiptStore(root, { ownerId: "runner-a", now: () => 1 });
          const envelope = message();
          const first = store.claim(envelope);
          if (first.kind !== "new") return assert.fail("invocation was not claimed");
          first.handle.queued();
          const callback = () => {
            if (staleCallback === "failed") return first.handle.failed("stale failure");
            if (staleCallback === "uncertain") return first.handle.uncertain("stale uncertainty");
            return first.handle[staleCallback]();
          };
          // Fail before publication: the handle must release its own marker so queued work can recover.
          const fault = t.mock.method(store as any, "writeAtomic", () => { throw new Error("synthetic write failure"); });
          assert.throws(callback, /synthetic write failure/u);
          fault.mock.restore();
          assert.deepEqual(store.staleRecoveries(), [{ message: envelope, state: "queued" }]);
          const retry = store.claim(envelope);
          if (retry.kind !== "reclaimed") return assert.fail("failed persistence did not release ownership");
          if (activeState === "queued") retry.handle.queued();
          if (activeState === "started") retry.handle.started(42);
          const digest = createHash("sha256").update(envelope.invocationId, "utf8").digest("hex");
          const file = join(root, digest.slice(0, 2), `${digest}.json`);
          const before = readFileSync(file, "utf8");
          const receiptBefore = retry.handle.current;
          assert.throws(callback, /changed concurrently/u);
          assert.equal(readFileSync(file, "utf8"), before, "stale callbacks leave the exact receipt intact");
          if (check === "retry") {
            const duplicate = store.claim(envelope);
            assert.equal(duplicate.kind, "duplicate", "the newer handle must retain its marker");
            if (duplicate.kind !== "duplicate") return assert.fail("active work was reclaimed");
            assert.deepEqual(duplicate.receipt, { ...receiptBefore, duplicate: true });
          } else {
            assert.deepEqual(store.staleRecoveries(), [], "locally active work cannot enter recovery");
          }
          assert.equal(readFileSync(file, "utf8"), before, "retry and recovery leave the receipt intact");
          retry.handle.completed();
          assert.equal(store.claim(envelope).kind, "duplicate");
          assert.deepEqual(store.staleRecoveries(), []);
          assert.equal(
            (store as unknown as { activeHandles: { has(id: string): boolean } }).activeHandles.has(envelope.invocationId),
            false,
            "successful terminal cleanup releases its own marker",
          );
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
}

test("paced reconnect receipts re-read revisions and expiry without executing work", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-paced-receipts-"));
  let now = 1;
  try {
    const store = new SessionCommandReceiptStore(root, { ownerId: "owner-a", now: () => now });
    const claimed = store.claim(message());
    assert.equal(claimed.kind, "new");
    if (claimed.kind !== "new") return;
    const [id] = store.recentUpdateIds();
    assert.ok(id);
    assert.deepEqual(store.recentUpdate(id), store.recentUpdates()[0]);
    claimed.handle.queued();
    assert.equal(store.recentUpdate(id)?.state, "queued");
    const live = claimed.handle.completed();
    assert.equal(store.recentUpdate(id)?.revision, live.revision);
    assert.equal(store.recentUpdate(id)?.state, "completed");
    assert.equal(store.claim(message()).kind, "duplicate", "reading never executes the command");
    now = 10_000;
    assert.equal(store.recentUpdate(id)?.state, "completed", "inclusive dedupe horizon");
    now++;
    assert.equal(store.recentUpdate(id), null, "expiry during an ACK wait is rechecked");
    assert.deepEqual(store.recentUpdateIds(), []);
    assert.equal(store.recentUpdate("missing"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});