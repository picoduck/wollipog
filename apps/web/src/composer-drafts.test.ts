import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  composerDraftMatches,
  deleteComposerDraft,
  deleteComposerDraftIfMatches,
  discardComposerDraft,
  consumeComposerDraftHandoff,
  loadComposerDraft,
  parseComposerDraft,
  reserveComposerDraftSnapshot,
  saveComposerDraft,
  stageComposerDraftHandoff,
} from "./composer-drafts.js";
import { instanceStorageKey } from "./instance-storage.js";

const backing = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => void backing.set(key, value),
  removeItem: (key: string) => void backing.delete(key),
};

beforeEach(() => backing.clear());

test("parseComposerDraft accepts text and image attachments", () => {
  const draft = parseComposerDraft({ text: "finish this", images: [{ mimeType: "image/png", data: "abc" }], updatedAt: 42 });
  assert.deepEqual(draft, { text: "finish this", images: [{ mimeType: "image/png", data: "abc" }], updatedAt: 42 });
});

test("parseComposerDraft rejects corrupt persisted values", () => {
  assert.equal(parseComposerDraft(null), null);
  assert.equal(parseComposerDraft({ text: 4, images: [] }), null);
  assert.equal(parseComposerDraft({ text: "x", images: [{ mimeType: "text/plain", data: "abc" }] }), null);
  assert.equal(parseComposerDraft({ text: "x", images: "bad" }), null);
  assert.deepEqual(parseComposerDraft({ text: "x", images: [], updatedAt: null }), { text: "x", images: [], updatedAt: 0 });
});

test("localStorage fallback saves, loads, and deletes text with image attachments", async () => {
  const images = [{ mimeType: "image/png", data: "abc" }];
  await saveComposerDraft("s1", "finish this", images);
  const loaded = await loadComposerDraft("s1");
  assert.equal(loaded?.text, "finish this");
  assert.deepEqual(loaded?.images, images);
  assert.equal(typeof loaded?.updatedAt, "number");

  await deleteComposerDraft("s1");
  assert.equal(await loadComposerDraft("s1"), null);
});

test("a reserved command draft retains its stable retry submission coordinates", async () => {
  const commandSubmission = {
    submissionId: "web_submission_1",
    providerCommandId: "provider-command-1",
    catalogRevision: "catalog-revision-1",
    argumentText: "focus on storage",
  };
  await reserveComposerDraftSnapshot(
    "command-retry",
    "/review focus on storage",
    [],
    "local",
    commandSubmission,
  );
  assert.deepEqual((await loadComposerDraft("command-retry"))?.commandSubmission, commandSubmission);
  assert.equal(parseComposerDraft({
    text: "/review",
    images: [],
    updatedAt: 1,
    commandSubmission: { ...commandSubmission, catalogRevision: "" },
  })?.commandSubmission, undefined);
});

test("saving an empty draft removes its fallback record", async () => {
  await saveComposerDraft("s2", "temporary", []);
  await saveComposerDraft("s2", "", []);
  assert.equal(await loadComposerDraft("s2"), null);
});

test("conditional deletion consumes only the exact submitted draft snapshot", async () => {
  const submittedImages = [{ mimeType: "image/png", data: "submitted" }];
  assert.equal(composerDraftMatches({ text: "submitted", images: submittedImages }, "submitted", submittedImages), true);
  await saveComposerDraft("conditional", "submitted", submittedImages);
  assert.equal(await deleteComposerDraftIfMatches("conditional", "submitted", submittedImages), true);
  assert.equal(await loadComposerDraft("conditional"), null);
});

test("conditional deletion preserves a newer edit and its attachments", async () => {
  const submittedImages = [{ mimeType: "image/png", data: "submitted" }];
  const newerImages = [{ mimeType: "image/png", data: "newer" }];
  await saveComposerDraft("conditional-newer", "newer edit", newerImages);
  assert.equal(await deleteComposerDraftIfMatches("conditional-newer", "submitted", submittedImages), false);
  const loaded = await loadComposerDraft("conditional-newer");
  assert.equal(loaded?.text, "newer edit");
  assert.deepEqual(loaded?.images, newerImages);
  assert.equal(typeof loaded?.revision, "string");
});

test("revision-scoped deletion preserves a newer identical draft", async () => {
  const images = [{ mimeType: "image/png", data: "same" }];
  const reserved = await reserveComposerDraftSnapshot("identical-newer", "same text", images);
  await saveComposerDraft("identical-newer", "same text", images);
  const newer = await loadComposerDraft("identical-newer");
  assert.notEqual(newer?.revision, reserved.revision);
  assert.equal(
    await deleteComposerDraftIfMatches(
      "identical-newer",
      reserved.text,
      reserved.images,
      "local",
      reserved.revision,
    ),
    false,
  );
  assert.equal((await loadComposerDraft("identical-newer"))?.revision, newer?.revision);
});

test("a fork-target draft preserves edited text and attachments without changing the source draft", async () => {
  const sourceImages = [{ mimeType: "image/png", data: "source-image" }];
  await saveComposerDraft("source", "source draft", []);
  await saveComposerDraft("fork", "edited historical prompt", sourceImages);

  assert.deepEqual(
    { text: (await loadComposerDraft("source"))?.text, images: (await loadComposerDraft("source"))?.images },
    { text: "source draft", images: [] },
  );
  assert.deepEqual(
    { text: (await loadComposerDraft("fork"))?.text, images: (await loadComposerDraft("fork"))?.images },
    { text: "edited historical prompt", images: sourceImages },
  );
});

test("a staged fork handoff survives denied browser storage and is consumed once", async () => {
  const storage = globalThis.localStorage;
  (globalThis as { localStorage: Storage }).localStorage = {
    ...storage,
    getItem: () => null,
    setItem: () => { throw new Error("storage denied"); },
    removeItem: () => {},
  } as Storage;
  try {
    const images = [{ mimeType: "image/png", data: "edited-image" }];
    stageComposerDraftHandoff("denied-fork", "edited prompt", images);
    await saveComposerDraft("denied-fork", "edited prompt", images);
    const cancelledMountLoad = await loadComposerDraft("denied-fork");
    const loaded = await loadComposerDraft("denied-fork");
    assert.equal(loaded, cancelledMountLoad, "a StrictMode throwaway load does not consume the handoff");
    assert.equal(loaded?.text, "edited prompt");
    assert.deepEqual(loaded?.images, images);
    assert.equal(typeof loaded?.updatedAt, "number");
    consumeComposerDraftHandoff("denied-fork", loaded!);
    assert.equal(await loadComposerDraft("denied-fork"), null, "the memory handoff is one-shot");
  } finally {
    (globalThis as { localStorage: Storage }).localStorage = storage;
  }
});

test("permanent discard wins over late saves for a deleted session", async () => {
  await saveComposerDraft("s3", "private draft", [{ mimeType: "image/png", data: "secret" }]);
  await discardComposerDraft("s3");
  await saveComposerDraft("s3", "late unmount flush", [{ mimeType: "image/png", data: "secret" }]);
  assert.equal(await loadComposerDraft("s3"), null);
});

test("permanent discard also rejects a later submission reservation", async () => {
  await discardComposerDraft("reserved-after-delete");
  await reserveComposerDraftSnapshot("reserved-after-delete", "must not return", [
    { mimeType: "image/png", data: "secret" },
  ]);
  assert.equal(await loadComposerDraft("reserved-after-delete"), null);
});

test("identical session ids keep drafts and deletion isolated by instance", async () => {
  await saveComposerDraft("same-id", "local draft", [], "local");
  await saveComposerDraft("same-id", "alpha draft", [], "remote-alpha");
  await saveComposerDraft("same-id", "beta draft", [], "remote-beta");

  assert.equal((await loadComposerDraft("same-id", "local"))?.text, "local draft");
  assert.equal((await loadComposerDraft("same-id", "remote-alpha"))?.text, "alpha draft");
  assert.equal((await loadComposerDraft("same-id", "remote-beta"))?.text, "beta draft");

  await discardComposerDraft("same-id", "remote-alpha");
  assert.equal(await loadComposerDraft("same-id", "remote-alpha"), null);
  assert.equal((await loadComposerDraft("same-id", "local"))?.text, "local draft");
  assert.equal((await loadComposerDraft("same-id", "remote-beta"))?.text, "beta draft");
});

test("legacy fallback drafts migrate only into Local", async () => {
  const legacyLogicalKey = "mam.composer.draft.legacy-draft";
  const currentLogicalKey = "wollipog.composer.draft.legacy-draft";
  backing.set(legacyLogicalKey, JSON.stringify({ text: "legacy", images: [], updatedAt: 1 }));

  assert.equal(await loadComposerDraft("legacy-draft", "remote-alpha"), null);
  assert.equal((await loadComposerDraft("legacy-draft", "local"))?.text, "legacy");
  assert.equal(backing.has(legacyLogicalKey), true, "copy-forward keeps the rollback value");
  assert.equal(backing.has(instanceStorageKey(currentLogicalKey, "local")), true);
});

test("memory handoffs with identical session ids remain instance scoped", async () => {
  stageComposerDraftHandoff("same-handoff", "alpha", [], "remote-alpha");
  stageComposerDraftHandoff("same-handoff", "beta", [], "remote-beta");
  const alpha = await loadComposerDraft("same-handoff", "remote-alpha");
  const beta = await loadComposerDraft("same-handoff", "remote-beta");
  assert.equal(alpha?.text, "alpha");
  assert.equal(beta?.text, "beta");
  consumeComposerDraftHandoff("same-handoff", alpha!, "remote-alpha");
  assert.equal(await loadComposerDraft("same-handoff", "remote-alpha"), null);
  assert.equal((await loadComposerDraft("same-handoff", "remote-beta"))?.text, "beta");
});
