import assert from "node:assert/strict";
import test from "node:test";
import type { QueuedPromptView } from "@wollipog/protocol";
import type { KeyValueStorage } from "./instance-storage.js";
import {
  QUEUED_EDIT_RECOVERY_MAX_AGE_MS,
  QUEUED_EDIT_RECOVERY_MAX_BYTES,
  QUEUED_EDIT_RECOVERY_MAX_ENTRIES,
  clearAllDurableQueuedEditRecoveries,
  clearDurableQueuedEditRecoveriesForAccount,
  clearDurableQueuedEditRecovery,
  clearRuntimeQueuedEditRecovery,
  loadDurableQueuedEditRecovery,
  loadRuntimeQueuedEditRecovery,
  parseQueuedPromptEditRecovery,
  queuedEditRecoveryAccountKey,
  reconcileQueuedEditRecovery,
  saveDurableQueuedEditRecovery,
  storeRuntimeQueuedEditRecovery,
  type QueuedEditRecoveryScope,
  type QueuedPromptEditRecovery,
} from "./queued-edit-recovery.js";

const unchanged: QueuedPromptView = {
  id: "queue-1",
  text: "Original",
  liveQueueObserved: true,
  editable: true,
  editRevision: "revision-1",
};

class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, string>();
  setCalls = 0;
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) {
    this.setCalls += 1;
    this.values.set(key, value);
  }
  removeItem(key: string) { this.values.delete(key); }
}

const accountA = queuedEditRecoveryAccountKey("org-1", "user-a");
const accountB = queuedEditRecoveryAccountKey("org-1", "user-b");
const recovery: QueuedPromptEditRecovery = {
  edit: {
    promptId: "queue-1",
    text: "Original queued text",
    images: [{ mimeType: "image/png", data: "b3JpZ2luYWw=" }],
    editRevision: "revision-1",
    submissionId: "submission-1",
    submissionFingerprint: "fingerprint-1",
    displacedDraft: {
      text: "Ordinary draft",
      images: [{ mimeType: "image/jpeg", data: "ZHJhZnQ=" }],
    },
  },
  draft: {
    text: "Revised queued text",
    images: [{ mimeType: "image/webp", data: "cmV2aXNlZA==" }],
  },
  error: "Queued message edit was not confirmed.",
};

function scope(
  sessionId = "session-1",
  accountKey = accountA,
  instanceScope = "instance-1",
): QueuedEditRecoveryScope {
  return { sessionId, accountKey, instanceScope };
}

test("an unchanged live target keeps the recovered edit retryable", () => {
  assert.deepEqual(
    reconcileQueuedEditRecovery("queue-1", "revision-1", [unchanged], true),
    { status: "retryable" },
  );
});

test("a changed target revision cannot be overwritten by recovered content", () => {
  const result = reconcileQueuedEditRecovery(
    "queue-1",
    "revision-1",
    [{ ...unchanged, editRevision: "revision-2" }],
    true,
  );
  assert.equal(result.status, "stale");
  assert.match("reason" in result ? result.reason : "", /changed elsewhere/i);
});

test("promotion, cancellation, and consumption all retire the missing edit target", () => {
  for (const transition of ["promotion", "cancellation", "consumption"]) {
    const result = reconcileQueuedEditRecovery("queue-1", "revision-1", [], true);
    assert.equal(result.status, "stale", transition);
    assert.match("reason" in result ? result.reason : "", /no longer waiting/i, transition);
  }
});

test("an immutable projection cannot accept a recovered edit", () => {
  const result = reconcileQueuedEditRecovery(
    "queue-1",
    "revision-1",
    [{ ...unchanged, editable: false, editDisabledReason: "This turn is already starting." }],
    true,
  );
  assert.deepEqual(result, { status: "stale", reason: "This turn is already starting." });
});

test("an in-flight steering transition cannot race a recovered edit retry", () => {
  const result = reconcileQueuedEditRecovery(
    "queue-1",
    "revision-1",
    [{ ...unchanged, steeringState: "promoting" }],
    true,
  );
  assert.deepEqual(result, {
    status: "stale",
    reason: "Resolve steering before editing this queued message.",
  });
});

test("an explicit edit-disabled reason fails closed even if editable is true", () => {
  const result = reconcileQueuedEditRecovery(
    "queue-1",
    "revision-1",
    [{ ...unchanged, editDisabledReason: "This queued message is being consumed." }],
    true,
  );
  assert.deepEqual(result, {
    status: "stale",
    reason: "This queued message is being consumed.",
  });
});

test("offline and incomplete projections preserve recovery while authority is unavailable", () => {
  for (const queued of [undefined, [], [unchanged]]) {
    const result = reconcileQueuedEditRecovery("queue-1", "revision-1", queued, false);
    assert.equal(result.status, "checking");
    assert.match("reason" in result ? result.reason : "", /authoritative queue/i);
  }
});

test("a different entry cannot inherit recovery through matching content or position", () => {
  const result = reconcileQueuedEditRecovery(
    "queue-1",
    "revision-1",
    [{ ...unchanged, id: "queue-2" }],
    true,
  );
  assert.equal(result.status, "stale");
});

test("durable recovery round-trips exact retry, attachment, and displaced-draft state", () => {
  const storage = new MemoryStorage();
  assert.equal(saveDurableQueuedEditRecovery(scope(), recovery, storage, 1_000), true);
  const writesBeforeLoad = storage.setCalls;
  const restored = loadDurableQueuedEditRecovery(scope(), storage, 2_000);
  assert.deepEqual(restored, recovery);
  assert.notEqual(restored, recovery);
  assert.notEqual(restored?.draft.images, recovery.draft.images);
  assert.equal(storage.setCalls, writesBeforeLoad, "a clean recovery read must not rewrite storage");
});

test("durable recovery is isolated by account, instance, and Session", () => {
  const storage = new MemoryStorage();
  saveDurableQueuedEditRecovery(scope(), recovery, storage, 1_000);
  assert.equal(loadDurableQueuedEditRecovery(scope("session-1", accountB), storage, 2_000), undefined);
  assert.equal(loadDurableQueuedEditRecovery(scope("session-2"), storage, 2_000), undefined);
  assert.equal(loadDurableQueuedEditRecovery(scope("session-1", accountA, "instance-2"), storage, 2_000), undefined);
  assert.deepEqual(loadDurableQueuedEditRecovery(scope(), storage, 2_000), recovery);
});

test("page-lifetime recovery also requires the exact authenticated account", () => {
  storeRuntimeQueuedEditRecovery("instance-1\u0000session-1", accountA, recovery);
  assert.equal(loadRuntimeQueuedEditRecovery("instance-1\u0000session-1", accountB), undefined);
  assert.deepEqual(loadRuntimeQueuedEditRecovery("instance-1\u0000session-1", accountA), recovery);
  clearRuntimeQueuedEditRecovery("instance-1\u0000session-1");
});

test("success, explicit dismissal, account change, and instance removal clear durable recovery", () => {
  const storage = new MemoryStorage();
  saveDurableQueuedEditRecovery(scope(), recovery, storage, 1_000);
  assert.equal(clearDurableQueuedEditRecovery(scope(), storage, 2_000), true);
  assert.equal(loadDurableQueuedEditRecovery(scope(), storage, 2_000), undefined);

  saveDurableQueuedEditRecovery(scope(), recovery, storage, 3_000);
  saveDurableQueuedEditRecovery(scope("session-b", accountB), recovery, storage, 3_000);
  assert.equal(clearDurableQueuedEditRecoveriesForAccount("instance-1", accountA, storage, 4_000), true);
  assert.equal(loadDurableQueuedEditRecovery(scope(), storage, 4_000), undefined);
  assert.ok(loadDurableQueuedEditRecovery(scope("session-b", accountB), storage, 4_000));

  clearAllDurableQueuedEditRecoveries("instance-1", storage);
  assert.equal(loadDurableQueuedEditRecovery(scope("session-b", accountB), storage, 4_000), undefined);
});

test("durable recovery expires safely and remains count bounded", () => {
  const storage = new MemoryStorage();
  saveDurableQueuedEditRecovery(scope("expired"), recovery, storage, 1_000);
  assert.equal(
    loadDurableQueuedEditRecovery(scope("expired"), storage, 1_000 + QUEUED_EDIT_RECOVERY_MAX_AGE_MS),
    undefined,
  );

  for (let index = 0; index <= QUEUED_EDIT_RECOVERY_MAX_ENTRIES; index += 1) {
    assert.equal(saveDurableQueuedEditRecovery(scope(`session-${index}`), recovery, storage, 10_000 + index), true);
  }
  assert.equal(loadDurableQueuedEditRecovery(scope("session-0"), storage, 20_000), undefined);
  assert.ok(loadDurableQueuedEditRecovery(scope(`session-${QUEUED_EDIT_RECOVERY_MAX_ENTRIES}`), storage, 20_000));
});

test("count eviction always retains the entry being saved after the clock moves backward", () => {
  const storage = new MemoryStorage();
  for (let index = 0; index < QUEUED_EDIT_RECOVERY_MAX_ENTRIES; index += 1) {
    assert.equal(saveDurableQueuedEditRecovery(
      scope(`future-${index}`),
      recovery,
      storage,
      10_000 + index,
    ), true);
  }
  assert.equal(saveDurableQueuedEditRecovery(scope("current"), recovery, storage, 1_000), true);
  assert.deepEqual(loadDurableQueuedEditRecovery(scope("current"), storage, 2_000), recovery);
});

test("oversize and unavailable storage fail without touching an ordinary draft", () => {
  const storage = new MemoryStorage();
  storage.setItem("ordinary-draft", "keep me");
  assert.equal(saveDurableQueuedEditRecovery(scope(), recovery, storage, 500), true);
  const oversized = {
    ...recovery,
    draft: { ...recovery.draft, text: "x".repeat(QUEUED_EDIT_RECOVERY_MAX_BYTES) },
  };
  assert.equal(saveDurableQueuedEditRecovery(scope(), oversized, storage, 1_000), false);
  assert.deepEqual(loadDurableQueuedEditRecovery(scope(), storage, 2_000), recovery,
    "an oversized update must leave the last safely persisted recovery intact");
  assert.equal(storage.getItem("ordinary-draft"), "keep me");

  const blocked: KeyValueStorage = {
    getItem: (key) => storage.getItem(key),
    setItem: () => { throw new Error("quota denied"); },
    removeItem: () => { throw new Error("storage denied"); },
  };
  assert.equal(saveDurableQueuedEditRecovery(scope(), recovery, blocked, 3_000), false);
  assert.equal(storage.getItem("ordinary-draft"), "keep me");
});

test("malformed persisted recovery is rejected before it reaches the composer", () => {
  assert.equal(parseQueuedPromptEditRecovery({ ...recovery, draft: { text: "unsafe", images: [{}] } }), null);
  assert.equal(parseQueuedPromptEditRecovery({ ...recovery, edit: { ...recovery.edit, promptId: "" } }), null);
});
