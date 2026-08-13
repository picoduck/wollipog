import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fetchPromptImageReference } from "./prompt-image-fetch.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function reference(overrides: Record<string, unknown> = {}) {
  return {
    artifactId: "art_image",
    mimeType: "image/png",
    sizeBytes: PNG.byteLength,
    sha256: createHash("sha256").update(PNG).digest("hex"),
    ...overrides,
  } as never;
}

test("runner fetches exact prompt image bytes with its current credential and no redirects", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-prompt-image-"));
  try {
    const tokenFile = join(root, "credential");
    writeFileSync(tokenFile, "opaque-first-token", { mode: 0o600 });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(PNG, { headers: { "content-type": "image/png", "content-length": String(PNG.length) } });
    }) as typeof fetch;
    const image = await fetchPromptImageReference({
      controlPlaneUrl: "ws://127.0.0.1:4317/runner",
      runnerId: "runner one",
      tokenFile,
      fetchImpl,
    }, "session/one", reference());
    assert.equal(image.data, PNG.toString("base64"));
    assert.match(calls[0]!.url, /runner%20one\/sessions\/session%2Fone\/artifacts\/art_image$/);
    assert.equal(calls[0]!.init?.redirect, "error");
    assert.equal((calls[0]!.init?.headers as Record<string, string>).authorization, "Bearer opaque-first-token");

    writeFileSync(tokenFile, "opaque-rotated-token", { mode: 0o600 });
    await fetchPromptImageReference({ controlPlaneUrl: "ws://localhost:4317/runner", runnerId: "r", tokenFile, fetchImpl }, "s", reference());
    assert.equal((calls[1]!.init?.headers as Record<string, string>).authorization, "Bearer opaque-rotated-token");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner rejects prompt image MIME, length, and digest mismatches", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-prompt-image-bad-"));
  try {
    const tokenFile = join(root, "credential");
    writeFileSync(tokenFile, "opaque-runner-token");
    const response = (body: Buffer, mime = "image/png", length = body.length) =>
      (async () => new Response(body, { headers: { "content-type": mime, "content-length": String(length) } })) as typeof fetch;
    await assert.rejects(
      fetchPromptImageReference({ controlPlaneUrl: "ws://localhost/runner", runnerId: "r", tokenFile, fetchImpl: response(PNG, "image/jpeg") }, "s", reference()),
      /MIME type/,
    );
    await assert.rejects(
      fetchPromptImageReference({ controlPlaneUrl: "ws://localhost/runner", runnerId: "r", tokenFile, fetchImpl: response(PNG, "image/png", PNG.length + 1) }, "s", reference()),
      /content length/,
    );
    const corrupt = Buffer.from(PNG); corrupt[corrupt.length - 1] ^= 0xff;
    await assert.rejects(
      fetchPromptImageReference({ controlPlaneUrl: "ws://localhost/runner", runnerId: "r", tokenFile, fetchImpl: response(corrupt) }, "s", reference()),
      /digest/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
