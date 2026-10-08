import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { precompressEmittedAssets, shouldPrecompress, writeSidecars } from "./precompressed-assets.js";

const SOURCE = Buffer.from(`console.log(${JSON.stringify("hello ".repeat(2000))});`);

function tempOutDir(t: { after: (fn: () => void) => void }): string {
  const out = mkdtempSync(join(tmpdir(), "wollipog-precompress-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  mkdirSync(join(out, "assets"), { recursive: true });
  return out;
}

test("only text assets under assets/ are compressed", () => {
  assert.equal(shouldPrecompress("assets/index-B0_CIkYt.js", 2_888_775), true);
  assert.equal(shouldPrecompress("assets/index-CRxzTP61.css", 362_528), true);
  // Stable names keep no sidecar: one could outlive a rebuild of the file it was made from.
  assert.equal(shouldPrecompress("sw.js", 10_000), false);
  assert.equal(shouldPrecompress("index.html", 10_000), false);
  assert.equal(shouldPrecompress("manifest.webmanifest", 10_000), false);
  // Already compressed formats, and files too small to be worth a second copy.
  assert.equal(shouldPrecompress("assets/WollipogJetBrainsMonoNerd-Regular-Bq4ZObyS.woff2", 383_272), false);
  assert.equal(shouldPrecompress("assets/tiny-AbCdEf12.js", 200), false);
});

test("sidecars decode to exactly the file they sit beside", async (t) => {
  const out = tempOutDir(t);
  const path = join(out, "assets", "index-B0_CIkYt.js");
  writeFileSync(path, SOURCE);
  await writeSidecars(path, SOURCE, 5);
  assert.ok(brotliDecompressSync(readFileSync(`${path}.br`)).equals(SOURCE));
  assert.ok(gunzipSync(readFileSync(`${path}.gz`)).equals(SOURCE));
  assert.ok(readFileSync(`${path}.br`).length < SOURCE.length);
  assert.deepEqual(readdirSync(join(out, "assets")).filter((name) => name.endsWith(".tmp")), [],
    "no temporary file is left behind");
});

test("REGRESSION: a sidecar that does not match the file is replaced, a matching one is kept", async (t) => {
  const out = tempOutDir(t);
  const path = join(out, "assets", "index-B0_CIkYt.js");
  writeFileSync(path, SOURCE);
  // An older build left a brotli sidecar of different bytes under this name; the gzip one matches.
  writeFileSync(`${path}.br`, brotliCompressSync(Buffer.from("stale")));
  writeFileSync(`${path}.gz`, gzipSync(SOURCE));
  const keptAt = statSync(`${path}.gz`).mtimeMs;
  await precompressEmittedAssets(out, ["assets/index-B0_CIkYt.js"], 5);
  assert.ok(brotliDecompressSync(readFileSync(`${path}.br`)).equals(SOURCE), "the stale sidecar must be rewritten");
  assert.equal(statSync(`${path}.gz`).mtimeMs, keptAt, "a matching sidecar is left alone");
});

test("a corrupt sidecar is replaced rather than trusted", async (t) => {
  const out = tempOutDir(t);
  const path = join(out, "assets", "index-B0_CIkYt.js");
  writeFileSync(path, SOURCE);
  writeFileSync(`${path}.br`, "not brotli");
  writeFileSync(`${path}.gz`, "not gzip");
  await precompressEmittedAssets(out, ["assets/index-B0_CIkYt.js"], 5);
  assert.ok(brotliDecompressSync(readFileSync(`${path}.br`)).equals(SOURCE));
  assert.ok(gunzipSync(readFileSync(`${path}.gz`)).equals(SOURCE));
});

test("files that are not compressed lose any sidecar an earlier build left", async (t) => {
  const out = tempOutDir(t);
  writeFileSync(join(out, "sw.js"), SOURCE);
  writeFileSync(join(out, "assets", "tiny-AbCdEf12.js"), "1");
  writeFileSync(join(out, "assets", "tiny-AbCdEf12.js.br"), brotliCompressSync("stale"));
  writeFileSync(join(out, "assets", "tiny-AbCdEf12.js.gz"), gzipSync("stale"));
  await precompressEmittedAssets(out, ["sw.js", "assets/tiny-AbCdEf12.js"], 5);
  assert.equal(existsSync(join(out, "sw.js.br")), false, "stable names are never compressed");
  assert.equal(existsSync(join(out, "sw.js.gz")), false);
  assert.equal(existsSync(join(out, "assets", "tiny-AbCdEf12.js.br")), false);
  assert.equal(existsSync(join(out, "assets", "tiny-AbCdEf12.js.gz")), false);
});

test("a sidecar that would not be smaller is not written", async (t) => {
  const out = tempOutDir(t);
  const path = join(out, "assets", "noise-AbCdEf12.js");
  // Incompressible bytes: every encoding would add overhead.
  const noise = randomBytes(4096);
  writeFileSync(path, noise);
  writeFileSync(`${path}.gz`, gzipSync(Buffer.from("stale")));
  await writeSidecars(path, noise, 5);
  assert.equal(existsSync(`${path}.br`), false);
  assert.equal(existsSync(`${path}.gz`), false, "a stale sidecar under that name is removed");
});
