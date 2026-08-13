import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
