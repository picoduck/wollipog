/** Operator preparation only: creates fresh synthetic clips and a separate private oracle.
 * It makes no provider call, upload, receipt, verdict, grant, or production-validation claim. */
import { execFile } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { prepareVideoEvidence } from "../src/video-evidence-preparation.js";
import { decodeShortSilentWebm } from "../src/video-frame-decode.js";

const run = promisify(execFile);
const hash = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--capture-dir" || args[2] !== "--private-oracle-dir") {
  throw new Error("Use --capture-dir <new absolute directory> --private-oracle-dir <separate new absolute directory>.");
}
const captureRoot = args[1]!;
const oracleRoot = args[3]!;
const nested = (a: string, b: string) => {
  const r = relative(a, b);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
if (![captureRoot, oracleRoot].every(isAbsolute) || nested(captureRoot, oracleRoot) || nested(oracleRoot, captureRoot)) {
  throw new Error("Capture and oracle directories must be absolute and separate; neither may contain the other.");
}
for (const path of [captureRoot, oracleRoot]) {
  // Existing parent symlinks could silently place the oracle into reviewer scope.
  if (await realpath(dirname(path)) !== resolve(dirname(path))) throw new Error("Use real parent directories without symlinks.");
}
const created: string[] = [];
try {
  for (const path of [captureRoot, oracleRoot]) { await mkdir(path, { mode: 0o700 }); created.push(path); }
  const oracle: Array<Record<string, unknown>> = [];
  const captures: Array<Record<string, unknown>> = [];
  for (const profile of [
    { id: "candidate", width: 640, height: 360, fps: 4, duration: 4, frameCount: 16 },
    { id: "paced", width: 1280, height: 720, fps: 30, duration: 12, frameCount: 360 },
    { id: "maximum", width: 1280, height: 720, fps: 30, duration: 30, frameCount: 900 },
  ]) {
    const selected = new Set<number>();
    while (selected.size < 3) selected.add(randomInt(1, profile.frameCount - 1));
    const transients = [...selected].sort((a, b) => a - b).map((index) => ({
      index, color: ["red", "green", "blue", "yellow", "magenta"][randomInt(5)]!,
      x: randomInt(0, Math.floor(profile.width / 2)),
      y: randomInt(0, Math.floor(profile.height / 2)), width: 128, height: 96,
    }));
    const filter = transients.map((t) => "drawbox=x=" + t.x + ":y=" + t.y + ":w=" + t.width +
      ":h=" + t.height + ":color=" + t.color + ":t=fill:enable='eq(n," + t.index + ")'").join(",");
    const path = resolve(captureRoot, profile.id + ".webm");
    await run("/usr/bin/ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-n",
      "-f", "lavfi", "-i", "testsrc=size=" + profile.width + "x" + profile.height +
      ":rate=" + profile.fps + ":duration=" + profile.duration, "-vf", filter,
      "-an", "-threads", "1", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8",
      "-crf", "30", "-b:v", "0", path], { timeout: 90_000, maxBuffer: 128 * 1024, env: {} });
    await chmod(path, 0o600);
    const bytes = await readFile(path);
    // Timings in the oracle come from actual encoded source derivation, never n/fps guesses.
    let times: Array<{ index: number; ptsUs: number }>;
    let manifestSha256: string;
    if (profile.id === "candidate") {
      const decoded = await decodeShortSilentWebm(bytes);
      if (!decoded.ok) throw new Error("Candidate cannot be derived: " + decoded.reason);
      times = decoded.frames.map((f) => ({ index: f.index, ptsUs: f.ptsMs * 1000 }));
      manifestSha256 = hash(JSON.stringify(decoded.frames.map(({ bytes: _bytes, ...frame }) => frame)));
    } else {
      const prepared = await prepareVideoEvidence(bytes, "video/webm");
      if (!prepared.ok) throw new Error(profile.id + " cannot satisfy complete preparation: " + prepared.code + ": " + prepared.reason);
      times = prepared.manifest.frames;
      manifestSha256 = prepared.manifestSha256;
    }
    if (times.length !== profile.frameCount) throw new Error("Synthetic source frame count does not match complete derivation.");
    oracle.push({ profile: profile.id, sourceSha256: hash(bytes),
      transients: transients.map((t) => ({ ...t, ptsUs: times[t.index]!.ptsUs })) });
    captures.push({ profile: profile.id, path, sourceSha256: hash(bytes), sizeBytes: bytes.length,
      frameCount: times.length, manifestSha256 });
  }
  const oracleText = JSON.stringify({ schemaVersion: 1, purpose: "private_blind_validation_oracle", oracle });
  await writeFile(resolve(oracleRoot, "oracle.json"), oracleText, { mode: 0o600, flag: "wx" });
  const metadata = { schemaVersion: 1, purpose: "operator_prepared_synthetic_challenge", contentProfile: "bounded_synthetic_test_pattern_not_universal_content", captures,
    oracleCommitmentSha256: hash(oracleText), deliveryValidated: false, productionEnabled: false,
    instruction: "Review every source frame in presentation order. Report each transient colored overlay, its geometry, exact source presentation time and any observed defects. No private oracle is supplied." };
  await writeFile(resolve(captureRoot, "challenge.json"), JSON.stringify(metadata, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  // Metadata only. Do not print oracle bytes or include its path in reviewer prompts/transcripts.
  process.stdout.write(JSON.stringify(metadata) + "\n");
} catch (error) {
  for (const path of created.reverse()) await rm(path, { recursive: true, force: true });
  throw error;
}
