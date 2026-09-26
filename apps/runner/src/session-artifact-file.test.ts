import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_PROMPT_IMAGE_BYTES, MAX_SESSION_VIDEO_BYTES } from "@wollipog/protocol";
import { readImageFileForAttach, readMediaFileForAttach, sniffImageMediaType, sniffVideoMediaType } from "./session-artifact-file.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pixels")]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84]), Buffer.from("webm"), Buffer.alloc(8)]);

test("video sniffing reads the bounded EBML DocType and preserves MP4 recognition", () => {
  const signature = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
  const docType = (value: string) => Buffer.concat([Buffer.from([0x42, 0x82, 0x80 | value.length]), Buffer.from(value)]);
  const header = (...elements: Buffer[]) => {
    const content = Buffer.concat(elements);
    assert.ok(content.length < 127);
    return Buffer.concat([signature, Buffer.from([0x80 | content.length]), content]);
  };
  const version = Buffer.from([0x42, 0x86, 0x81, 0x01]);
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)]);
  assert.equal(sniffVideoMediaType(mp4), "video/mp4");
  assert.equal(sniffVideoMediaType(WEBM), "video/webm");
  assert.equal(sniffVideoMediaType(header(version, docType("webm"))), "video/webm",
    "DocType may follow another header element");
  assert.equal(sniffVideoMediaType(header(Buffer.from([0x42, 0x82, 0x86]), Buffer.from("webm\0x"))), "video/webm",
    "a null terminator may follow the WebM DocType");

  const rejected: Array<[string, Buffer]> = [
    ["Matroska with trailing decoy", Buffer.concat([header(docType("matroska")), Buffer.from("webm")])],
    ["WebM text in another element", header(Buffer.from([0xec, 0x84]), Buffer.from("webm"))],
    ["missing DocType with trailing decoy", Buffer.concat([header(version), Buffer.from("webm")])],
    ["non-null DocType suffix", header(docType("webmx"))],
    ["invalid DocType bytes with decoy", Buffer.concat([
      header(Buffer.from([0x42, 0x82, 0x84, 0xf7, 0xe5, 0xe2, 0xed])), Buffer.from("webm"),
    ])],
    ["duplicate DocTypes", header(docType("webm"), docType("matroska"))],
    ["unknown header size", Buffer.concat([signature, Buffer.from([0xff]), docType("webm")])],
    ["truncated header", Buffer.concat([signature, Buffer.from([0x89]), docType("webm")])],
    ["out-of-bounds DocType", Buffer.concat([signature, Buffer.from([0x87, 0x42, 0x82, 0x85]), Buffer.from("webm")])],
    ["invalid child ID", Buffer.concat([signature, Buffer.from([0x87, 0x00]), docType("webm")])],
    ["unknown child size", Buffer.concat([signature, Buffer.from([0x86, 0xec, 0xff]), Buffer.from("webm")])],
  ];
  for (const [name, bytes] of rejected) assert.equal(sniffVideoMediaType(bytes), null, name);

  const size2 = (size: number) => Buffer.from([0x40 | (size >> 8), size & 0xff]);
  const bounded = Buffer.concat([
    signature, size2(4090), Buffer.from([0xec]), size2(4080), Buffer.alloc(4080), docType("webm"),
  ]);
  assert.equal(bounded.length, 4096);
  assert.equal(sniffVideoMediaType(bounded), "video/webm", "DocType at the scan limit is valid");
  assert.equal(sniffVideoMediaType(Buffer.concat([signature, size2(4091), bounded.subarray(6), Buffer.alloc(1)])), null,
    "a header beyond the scan limit is rejected");
});

test("video attachment reads a content-typed bounded file without trusting its extension", async () => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-video-"));
  try {
    const file = join(dir, "clip.txt");
    writeFileSync(file, WEBM);
    const found = await readMediaFileForAttach(file);
    assert.equal(found.ok, true);
    if (found.ok) assert.deepEqual({ kind: found.kind, mediaType: found.mediaType, sizeBytes: found.sizeBytes },
      { kind: "video", mediaType: "video/webm", sizeBytes: WEBM.length });
    assert.equal((await readImageFileForAttach(file)).ok, false);
    writeFileSync(file, Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x8b, 0x42, 0x82, 0x88]), Buffer.from("matroska"), Buffer.from("webm"),
    ]));
    const mislabeled = await readMediaFileForAttach(file);
    assert.equal(mislabeled.ok, false, "a Matroska file with decoy WebM text is not attached as video/webm");
    truncateSync(file, MAX_SESSION_VIDEO_BYTES + 1);
    const oversized = await readMediaFileForAttach(file);
    assert.match(oversized.ok ? "" : oversized.error, /at most 33554432 bytes/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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

test("a file that changes size after it was checked is refused without an unbounded read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-file-"));
  try {
    // Grows far past the limit between the size check and the read. A whole-file read would size
    // its buffer from the new length; the bounded read takes one byte more than it checked.
    const growing = join(dir, "growing.png");
    writeFileSync(growing, PNG);
    const grown = await readImageFileForAttach(growing, () => truncateSync(growing, MAX_PROMPT_IMAGE_BYTES * 4));
    assert.equal(grown.ok, false);
    assert.match(grown.ok ? "" : grown.error, /changed size while it was being read/u);

    const appended = join(dir, "appended.png");
    writeFileSync(appended, PNG);
    const longer = await readImageFileForAttach(appended, () => appendFileSync(appended, "x"));
    assert.match(longer.ok ? "" : longer.error, /changed size/u, "even one extra byte is a different file");

    const shrinking = join(dir, "shrinking.png");
    writeFileSync(shrinking, PNG);
    const shorter = await readImageFileForAttach(shrinking, () => truncateSync(shrinking, 9));
    assert.match(shorter.ok ? "" : shorter.error, /changed size/u, "a half-written capture is not evidence");

    assert.ok((await readImageFileForAttach(appended, () => {})).ok, "an untouched file still reads");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
