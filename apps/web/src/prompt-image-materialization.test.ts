import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import type { PromptImageReference } from "@wollipog/protocol";
import { materializePromptImages } from "./prompt-image-materialization.js";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

const bytes = new TextEncoder().encode("image");
const reference: PromptImageReference = {
  artifactId: "artifact-image",
  mimeType: "image/png",
  sizeBytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};

test("prompt image materialization leaves inline images self-contained", async () => {
  const inline = { mimeType: "image/png", data: "aW1hZ2U=" };
  let exports = 0;
  const result = await materializePromptImages([inline], async () => {
    exports += 1;
    throw new Error("unexpected export");
  });
  assert.deepEqual(result, [inline]);
  assert.notEqual(result[0], inline);
  assert.equal(exports, 0);
});

test("prompt image materialization verifies and embeds prepared artifact bytes", async () => {
  const result = await materializePromptImages(
    [reference],
    async () => new Blob([bytes], { type: "image/png; charset=binary" }),
  );
  assert.deepEqual(result, [{ mimeType: "image/png", data: "aW1hZ2U=" }]);
});

test("prompt image materialization rejects retained artifact integrity mismatches", async () => {
  await assert.rejects(
    () => materializePromptImages(
      [{ ...reference, sizeBytes: bytes.byteLength + 1 }],
      async () => new Blob([bytes], { type: "image/png" }),
    ),
    /length does not match/,
  );
  await assert.rejects(
    () => materializePromptImages(
      [{ ...reference, sha256: "0".repeat(64) }],
      async () => new Blob([bytes], { type: "image/png" }),
    ),
    /digest does not match/,
  );
  await assert.rejects(
    () => materializePromptImages(
      [reference],
      async () => new Blob([bytes], { type: "image/jpeg" }),
    ),
    /MIME type does not match/,
  );
});

test("prompt image materialization explains secure-context requirements", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
  try {
    await assert.rejects(
      () => materializePromptImages(
        [reference],
        async () => new Blob([bytes], { type: "image/png" }),
      ),
      /require HTTPS or localhost/,
    );
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
});
