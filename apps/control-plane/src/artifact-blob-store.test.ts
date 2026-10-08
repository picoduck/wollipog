import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ArtifactBlobIntegrityError,
  FileArtifactBlobStore,
  artifactBlobFilePath,
  artifactBlobSha256,
} from "./artifact-blob-store.js";

test("filesystem artifact blobs are exact, content-addressed, deduplicated, and traversal-safe", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-artifact-blobs-"));
  try {
    const store = new FileArtifactBlobStore(root);
    const bytes = Buffer.from("same immutable bytes\n", "utf8");
    const key = artifactBlobSha256(bytes);
    store.put(key, bytes);
    store.put(key, Buffer.from(bytes));

    const path = artifactBlobFilePath(root, key);
    assert.equal(existsSync(path), true);
    assert.deepEqual(store.read(key, bytes.byteLength), bytes);
    assert.throws(() => store.read(key, bytes.byteLength + 1), ArtifactBlobIntegrityError);
    assert.throws(() => store.put("../outside", bytes), ArtifactBlobIntegrityError);
    assert.equal(existsSync(join(root, "outside")), false);

    writeFileSync(path, Buffer.from("tampered", "utf8"));
    assert.throws(() => store.read(key, bytes.byteLength), ArtifactBlobIntegrityError);
    assert.equal(store.delete(key), true);
    assert.throws(() => store.read(key, bytes.byteLength), /missing/);

    mkdirSync(path);
    assert.throws(() => store.read(key, bytes.byteLength), /regular file/);
    assert.throws(() => store.delete(key), /regular file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable puts publish verified content only after the pre-publication hook", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-artifact-blobs-durable-"));
  try {
    const store = new FileArtifactBlobStore(root);
    const bytes = Buffer.from("durable immutable bytes\n", "utf8");
    const key = artifactBlobSha256(bytes);
    const path = artifactBlobFilePath(root, key);
    let hookRan = false;
    await store.putDurable(key, bytes, async () => {
      hookRan = true;
      assert.equal(existsSync(path), false, "the hook runs before the content path exists");
    });
    assert.equal(hookRan, true);
    assert.deepEqual(store.read(key, bytes.byteLength), bytes);
    await store.putDurable(key, Buffer.from(bytes), async () => assert.fail("an existing blob is adopted, not rewritten"));
    assert.deepEqual(readdirSync(dirname(path)), [key], "no temporary file remains");

    await assert.rejects(store.putDurable("../outside", bytes), ArtifactBlobIntegrityError);
    await assert.rejects(store.putDurable(artifactBlobSha256(Buffer.from("other")), bytes), /digest/);

    const failing = Buffer.from("hook failure leaves nothing behind", "utf8");
    const failingKey = artifactBlobSha256(failing);
    await assert.rejects(store.putDurable(failingKey, failing, async () => { throw new Error("pending row not durable"); }),
      /pending row not durable/);
    assert.equal(existsSync(artifactBlobFilePath(root, failingKey)), false);
    assert.deepEqual(readdirSync(dirname(artifactBlobFilePath(root, failingKey))), [], "the temporary file is removed");

    writeFileSync(path, Buffer.from("tampered", "utf8"));
    await assert.rejects(store.putDurable(key, bytes), ArtifactBlobIntegrityError,
      "a corrupt existing blob is never adopted as durable content");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
