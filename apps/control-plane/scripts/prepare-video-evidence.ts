/** Explicit local files only. Never uploads, calls a model, or changes a running service. */
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PACED_VIDEO_PREPARATION_PROFILE, prepareVideoEvidence } from "../src/video-evidence-preparation.js";

const { values } = parseArgs({ options: {
  source: { type: "string" }, output: { type: "string" }, "verify-directory": { type: "string" },
  "media-type": { type: "string" },
} });
if (!values.source || Boolean(values.output) === Boolean(values["verify-directory"]) ||
    !["video/webm", "video/mp4"].includes(values["media-type"] ?? "")) {
  throw new Error("Usage: --source <local-file> --output <new-directory>|--verify-directory <package> --media-type video/webm|video/mp4");
}
const sourcePath = resolve(values.source);
const outputPath = resolve(values.output ?? values["verify-directory"]!);
async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > limit) {
      throw new Error("Input must be a nonempty regular file within its byte limit.");
    }
    // A fixed allocation and bounded read prevent a growing file from bypassing preflight.
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error("Input changed during read.");
      offset += bytesRead;
    }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("Input changed during read.");
    }
    return bytes;
  } finally { await file.close(); }
}
const source = await boundedFile(sourcePath, PACED_VIDEO_PREPARATION_PROFILE.sourceBytes);

let result = await prepareVideoEvidence(source, values["media-type"] as "video/webm" | "video/mp4");
// Busy capacity is the sole retryable failure: at most two retries, never a partial decode retry
// disguised as complete evidence. Each queued attempt has its own two-second admission deadline.
for (let retry = 0; !result.ok && result.retryable && retry < 2; retry++) {
  await new Promise((done) => setTimeout(done, 100 * (retry + 1)));
  result = await prepareVideoEvidence(source, values["media-type"] as "video/webm" | "video/mp4");
}
if (!result.ok) {
  console.log(JSON.stringify(result));
  process.exitCode = 1;
} else {
  const filename = (index: number) => `frame-${String(index).padStart(4, "0")}.png`;
  const report = { ok: true, purpose: result.manifest.purpose,
    sourceSha256: result.manifest.sourceSha256, manifestSha256: result.manifestSha256,
    frames: result.manifest.frames.length, segments: result.manifest.segments.length,
    durationUs: result.manifest.durationUs, deliveryValidated: false, productionEnabled: false };
  if (values["verify-directory"]) {
    // Re-derive from the source, never trust frame paths or coverage in a caller-authored manifest.
    // This proves current local byte integrity only; it does not create a durable review grant.
    const manifest = await boundedFile(join(outputPath, "manifest.json"), 512 * 1024);
    if (createHash("sha256").update(manifest).digest("hex") !== result.manifestSha256) {
      throw new Error("Manifest differs from complete independent source derivation.");
    }
    const expectedNames = ["manifest.json", ...result.manifest.frames.map((frame) => filename(frame.index))].sort();
    if (JSON.stringify((await readdir(outputPath)).sort()) !== JSON.stringify(expectedNames)) {
      throw new Error("Package file list differs from the complete source sequence.");
    }
    for (const frame of result.manifest.frames) {
      const bytes = await boundedFile(join(outputPath, filename(frame.index)), PACED_VIDEO_PREPARATION_PROFILE.frameBytes);
      if (bytes.length !== frame.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== frame.sha256) {
        throw new Error("Package frame differs from independent source derivation.");
      }
    }
    console.log(JSON.stringify({ ...report, localDerivationVerified: true }));
  } else {
    // Exclusive creation: never overwrite an existing evidence package or a symlink. On a failed
    // write remove only the directory this invocation created. Completed output is private.
    await mkdir(outputPath, { mode: 0o700 });
    try {
      for (const [index, bytes] of result.images.entries()) {
        await writeFile(join(outputPath, filename(index)), bytes,
          { mode: 0o600, flag: "wx" });
      }
      await writeFile(join(outputPath, "manifest.json"), JSON.stringify(result.manifest), { mode: 0o600, flag: "wx" });
      console.log(JSON.stringify(report));
    } catch (error) {
      await rm(outputPath, { recursive: true, force: true });
      throw error;
    }
  }
}
