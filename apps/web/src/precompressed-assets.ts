/**
 * Build-time compression of the hashed assets the control plane serves (#2767).
 *
 * The control plane serves `assets/` with `@fastify/static`'s `preCompressed` option: a request
 * that accepts brotli or gzip gets `<file>.br` or `<file>.gz` when one exists beside the file, and
 * the file itself otherwise. Compressing once here costs a few seconds per build instead of CPU on
 * every request, and needs nothing beyond `node:zlib`.
 *
 * Only `assets/` is compressed. Its names carry a content hash, so a sidecar can never describe a
 * different version of its file: a changed file gets a new name and new sidecars. Stable names
 * (`sw.js`, the manifest) are never compressed, so no sidecar can outlive a rebuild of them.
 */

import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, brotliDecompress, constants, gunzip, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const unbrotli = promisify(brotliDecompress);
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** The sidecar names `@fastify/static` looks for, one per encoding it can serve. */
export const SIDECAR_EXTENSIONS = [".br", ".gz"] as const;
/** Text formats worth compressing; images and fonts (`.woff2`) are compressed already. */
const COMPRESSIBLE = /\.(?:css|js|json|mjs|svg|txt|wasm)$/;
/** Below this, the saved bytes do not repay a second file and a response-header round of work. */
const MIN_BYTES = 1024;

/** Should this emitted file (a path relative to the output directory) get sidecars? */
export function shouldPrecompress(fileName: string, size: number): boolean {
  return fileName.startsWith("assets/") && COMPRESSIBLE.test(fileName) && size >= MIN_BYTES;
}

/** Does the sidecar at `target` already decode to exactly `source`? */
async function sidecarMatches(target: string, source: Buffer, decode: (data: Buffer) => Promise<Buffer>): Promise<boolean> {
  try {
    return source.equals(await decode(await readFile(target)));
  } catch {
    return false; // absent or unreadable: write a fresh one
  }
}

/**
 * Write `<path>.br` and `<path>.gz` for `source`, each atomically (a temporary name, then a
 * rename), so a server reading during a watched rebuild sees either no sidecar or a complete one.
 * A sidecar that already decodes to `source` is kept, which spares a watched rebuild from
 * recompressing (and replacing, possibly mid-response) every unchanged chunk; any other existing
 * sidecar is replaced. A sidecar that would not be smaller than the file is removed instead.
 */
export async function writeSidecars(path: string, source: Buffer, brotliQuality: number): Promise<void> {
  const encodings: Array<[string, () => Promise<Buffer>, (data: Buffer) => Promise<Buffer>]> = [
    // gzip first: it takes milliseconds, so a client that cannot use brotli (Chromium over plain
    // HTTP advertises only gzip) is served compressed while the slower brotli pass still runs.
    [".gz", () => gzipAsync(source, { level: 9 }), (data) => gunzipAsync(data)],
    [".br", () => brotli(source, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: brotliQuality,
        [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
      },
    }), (data) => unbrotli(data)],
  ];
  for (const [extension, compress, decode] of encodings) {
    const target = `${path}${extension}`;
    if (await sidecarMatches(target, source, decode)) continue;
    const compressed = await compress();
    if (compressed.length >= source.length) {
      await rm(target, { force: true });
      continue;
    }
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, compressed);
    await rename(temporary, target);
  }
}

/**
 * Compress every eligible file a build just wrote. Each existing sidecar is checked against the
 * file's current bytes rather than trusted by name, so a watched build stays consistent even if
 * an earlier run was interrupted or a file was rewritten in place.
 */
export async function precompressEmittedAssets(
  outDir: string,
  fileNames: readonly string[],
  brotliQuality: number,
): Promise<void> {
  await Promise.all(fileNames.filter((name) => name.startsWith("assets/")).map(async (fileName) => {
    const path = join(outDir, fileName);
    const source = await readFile(path);
    if (shouldPrecompress(fileName, source.length)) {
      await writeSidecars(path, source, brotliQuality);
    } else {
      // The server would otherwise serve whatever sidecar an earlier build left under this name.
      await Promise.all(SIDECAR_EXTENSIONS.map((extension) => rm(`${path}${extension}`, { force: true })));
    }
  }));
}
