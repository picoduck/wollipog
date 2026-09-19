import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CODEX_APP_SERVER_IMAGE_MIME_TYPES,
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGE_TOTAL_BASE64_BYTES,
  MAX_PROMPT_IMAGES,
  WORKSPACE_REFERENCE_MIME_TYPE,
  validatePromptImageInputs,
  validatePromptImages,
  validateWorkspaceReference,
  type PromptImage,
  type WorkspaceReference,
} from "./index.js";

const png = (bytes = 3): PromptImage => ({ mimeType: "image/png", data: Buffer.alloc(bytes).toString("base64") });
const workspaceReference = (overrides: Partial<WorkspaceReference> = {}): WorkspaceReference => ({
  artifactId: "workspace:123",
  mimeType: WORKSPACE_REFERENCE_MIME_TYPE,
  sizeBytes: 0,
  sha256: "a".repeat(64),
  referenceVersion: 1,
  kind: "lines",
  path: "src/index.ts",
  rootFingerprint: "b".repeat(64),
  targetFingerprint: "a".repeat(64),
  startLine: 4,
  endLine: 8,
  ...overrides,
});

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

test("workspace references share the attachment envelope without consuming image limits", () => {
  const references = Array.from({ length: 7 }, (_, index) => workspaceReference({ artifactId: `workspace:${index}` }));
  assert.deepEqual(validatePromptImageInputs([...references, png()]), { ok: true });
  assert.deepEqual(validateWorkspaceReference(workspaceReference()), { ok: true, value: workspaceReference() });
});

test("prepared prompt image references share the aggregate base64 budget", () => {
  const referenceBytes = MAX_PROMPT_IMAGE_BYTES;
  const count = Math.floor(
    MAX_PROMPT_IMAGE_TOTAL_BASE64_BYTES / (Math.ceil(referenceBytes / 3) * 4),
  ) + 1;
  const references = Array.from({ length: count }, (_, index) => ({
    artifactId: `artifact-${index}`,
    mimeType: "image/png",
    sizeBytes: referenceBytes,
    sha256: "a".repeat(64),
  }));
  assert.ok(count <= MAX_PROMPT_IMAGES);
  assert.match(validatePromptImageInputs(references).error!, /combined image payload/);
});

/** The error of a validation expected to fail. Fails the test plainly if the validation succeeded,
 * rather than passing `undefined` on to `assert.match`. */
function rejection<T>(result: { ok: true; value: T } | { ok: false; error: string }): string {
  if (result.ok) assert.fail(`expected validation to fail, but it accepted ${JSON.stringify(result.value)}`);
  return result.error;
}

test("workspace references reject traversal, incomplete ranges, and unbound diffs", () => {
  assert.match(rejection(validateWorkspaceReference(workspaceReference({ path: "../secret" }))), /invalid identity or range/);
  assert.match(rejection(validateWorkspaceReference(workspaceReference({ endLine: undefined }))), /invalid identity or range/);
  assert.match(rejection(validateWorkspaceReference(workspaceReference({
    kind: "diff", side: "left", diffHash: undefined, diffScope: "uncommitted",
  }))), /invalid identity or range/);
});
