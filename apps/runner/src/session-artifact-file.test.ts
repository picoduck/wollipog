import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_PROMPT_IMAGE_BYTES } from "@wollipog/protocol";
import { readImageFileForAttach, sniffImageMediaType } from "./session-artifact-file.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pixels")]);

test("the media type comes from the content and unknown content is not an image", () => {
  assert.equal(sniffImageMediaType(PNG), "image/png");
  assert.equal(sniffImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), "image/jpeg");
  assert.equal(sniffImageMediaType(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(sniffImageMediaType(Buffer.from("GIF87a....")), "image/gif");
  assert.equal(sniffImageMediaType(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")])), "image/webp");
  assert.equal(sniffImageMediaType(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt ")])), null,
    "a RIFF container that is not WebP is not an image");
  assert.equal(sniffImageMediaType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
  assert.equal(sniffImageMediaType(Buffer.from([0x89, 0x50])), null, "a truncated signature does not match");
  assert.equal(sniffImageMediaType(Buffer.alloc(0)), null);
});

test("an image file is read with its content-derived type, exact size, and digest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-file-"));
  try {
    // Named .txt on purpose: the name must not decide the type.
    const file = join(dir, "capture.txt");
    writeFileSync(file, PNG);
    const read = await readImageFileForAttach(file);
    assert.ok(read.ok, read.ok ? "" : read.error);
    assert.equal(read.mediaType, "image/png");
    assert.equal(read.sizeBytes, PNG.length);
    assert.equal(read.sha256, createHash("sha256").update(PNG).digest("hex"));
    assert.ok(read.bytes.equals(PNG));

    // Creating a symbolic link needs a privilege that Windows CI accounts do not hold.
    if (process.platform !== "win32") {
      const link = join(dir, "link.png");
      symlinkSync(file, link);
      assert.ok((await readImageFileForAttach(link)).ok, "a symbolic link to a regular file reads the file");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every unusable file fails with a specific message and yields no bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-file-"));
  try {
    const cases: Array<[string, string, RegExp]> = [];
    cases.push(["relative", "capture.png", /absolute file path is required/u]);
    cases.push(["missing", join(dir, "absent.png"), /file not found/u]);
    cases.push(["under a file", join(dir, "empty.png", "nested.png"), /file not found/u]);

    mkdirSync(join(dir, "folder.png"));
    cases.push(["directory", join(dir, "folder.png"), /not a regular file/u]);

    writeFileSync(join(dir, "empty.png"), "");
    cases.push(["empty", join(dir, "empty.png"), /file is empty/u]);

    writeFileSync(join(dir, "notes.png"), "this is text wearing a .png name");
    cases.push(["wrong content", join(dir, "notes.png"), /not a PNG, JPEG, GIF, or WebP image/u]);

    // Sparse, so the limit is exercised without writing 8 MiB; it must be refused from its size
    // alone, before any read.
    writeFileSync(join(dir, "huge.png"), PNG);
    truncateSync(join(dir, "huge.png"), MAX_PROMPT_IMAGE_BYTES + 1);
    cases.push(["oversized", join(dir, "huge.png"), new RegExp(`at most ${MAX_PROMPT_IMAGE_BYTES} bytes`, "u")]);

    for (const [label, path, expected] of cases) {
      const read = await readImageFileForAttach(path);
      assert.equal(read.ok, false, label);
      assert.match(read.ok ? "" : read.error, expected, label);
      assert.equal("bytes" in read, false, `${label}: a failure carries no content`);
    }

    writeFileSync(join(dir, "exact.png"), PNG);
    truncateSync(join(dir, "exact.png"), MAX_PROMPT_IMAGE_BYTES);
    assert.ok((await readImageFileForAttach(join(dir, "exact.png"))).ok, "exactly the limit is accepted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
