import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CODEX_APP_SERVER_IMAGE_MIME_TYPES,
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGES,
  validatePromptImages,
  type PromptImage,
} from "./index.js";

const png = (bytes = 3): PromptImage => ({ mimeType: "image/png", data: Buffer.alloc(bytes).toString("base64") });

test("prompt image validation accepts PNG, JPEG, and WebP", () => {
  for (const mimeType of ["image/png", "image/jpeg", "image/webp"]) {
    assert.deepEqual(validatePromptImages([{ ...png(), mimeType }]), { ok: true });
  }
});

test("broad driver compatibility keeps GIF/JPG while app-server uses its verified subset", () => {
  assert.deepEqual(validatePromptImages([{ ...png(), mimeType: "image/gif" }]), { ok: true });
  assert.deepEqual(validatePromptImages([{ ...png(), mimeType: "image/jpg" }]), { ok: true });
  assert.match(
    validatePromptImages([{ ...png(), mimeType: "image/gif" }], CODEX_APP_SERVER_IMAGE_MIME_TYPES).error!,
    /unsupported MIME/,
  );
});

test("prompt image validation rejects MIME, count, malformed base64, and per-file overflow", () => {
  assert.match(validatePromptImages([{ ...png(), mimeType: "image/svg+xml" }]).error!, /unsupported MIME/);
  assert.match(validatePromptImages(Array.from({ length: MAX_PROMPT_IMAGES + 1 }, () => png())).error!, /at most/);
  assert.match(validatePromptImages([{ mimeType: "image/png", data: "not-base64" }]).error!, /valid base64/);
  assert.match(validatePromptImages([png(MAX_PROMPT_IMAGE_BYTES + 1)]).error!, /exceeds/);
  const sevenMiB = png(7 * 1024 * 1024);
  assert.match(validatePromptImages([sevenMiB, sevenMiB, sevenMiB, sevenMiB]).error!, /combined image payload/);
});
