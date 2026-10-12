/** Offline preparation only. Neither this manifest nor local output is a delivery receipt,
 * a quality verdict, or authority to enable delegated video review. No runtime imports this file. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { videoBytesMatchMime } from "./workflow-artifacts.js";

export const PACED_VIDEO_PREPARATION_PROFILE = Object.freeze({
  id: "paced-silent-video-preparation-v1",
  sourceBytes: 32 * 1024 * 1024,
  durationUs: 30_000_000,
  frames: 900,
  minimumWidth: 960,
  minimumHeight: 540,
  width: 1280,
  height: 720,
  minimumFrameIntervalUs: 33_000,
  frameBytes: 2 * 1024 * 1024,
  totalFrameBytes: 128 * 1024 * 1024,
  segmentFrames: 120,
  segmentDurationUs: 4_000_000,
  wallTimeMs: 20_000,
  cpuSeconds: 15,
});
const PROFILE = PACED_VIDEO_PREPARATION_PROFILE;
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

export interface PreparedVideoFrame {
  index: number;
  ptsUs: number;
  durationUs: number;
  sha256: string;
  sizeBytes: number;
}
export interface VideoPreparationManifest {
  schemaVersion: 1;
  purpose: "offline_preparation_only";
  profile: typeof PROFILE.id;
  sourceSha256: string;
  sourceSizeBytes: number;
  sourceMediaType: "video/webm" | "video/mp4";
  width: number;
  height: number;
  durationUs: number;
  frames: PreparedVideoFrame[];
  /** Contiguous partitions of the original frame sequence, not transcoded or sampled clips. */
  segments: Array<{ index: number; firstFrame: number; frameCount: number; startUs: number; endUs: number }>;
}
export type VideoPreparationFailureCode = "source_limit" | "unsupported_media" | "decoder_busy" |
  "decoder_unavailable" | "decode_limit" | "unsupported_streams" | "recapture_resolution" |
  "recapture_timing" | "split_capture" | "recapture_frame_size" | "integrity";
export type VideoPreparationResult =
  | { ok: true; manifest: VideoPreparationManifest; manifestSha256: string; images: Buffer[] }
  | { ok: false; code: VideoPreparationFailureCode; reason: string; retryable: boolean };
const failure = (code: VideoPreparationFailureCode, reason: string): VideoPreparationResult =>
  ({ ok: false, code, reason, retryable: code === "decoder_busy" });

// Two active jobs and two queued jobs, with a two-second queue deadline. Slots are handed
// directly to the next waiter, so a new arrival cannot steal a released slot.
let active = 0;
const waiters: Array<{ grant: () => void }> = [];
async function acquire(): Promise<boolean> {
  if (active < 2) { active++; return true; }
  if (waiters.length >= 2) return false;
  return new Promise((resolve) => {
    const waiter = { grant: () => { clearTimeout(timer); resolve(true); } };
    const timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index !== -1) waiters.splice(index, 1);
      resolve(false);
    }, 2_000);
    waiters.push(waiter);
  });
}
function release(): void {
  const next = waiters.shift();
  if (next) next.grant(); else active--;
}

/** Fixed tools and arguments, no shell, no network, no host session directories or secrets.
 * Both tools receive only a read-only source. No decoder output is written to the host. */
async function isolated(input: string, tool: "ffmpeg" | "ffprobe", args: string[], limit: number)
  : Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/prlimit", [
      `--cpu=${PROFILE.cpuSeconds}`, "--as=1073741824", `--fsize=${PROFILE.frameBytes}`,
      "--", "/usr/bin/bwrap", "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin",
      "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
      "--ro-bind", "/etc/alternatives", "/etc/alternatives",
      "--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache",
      "--ro-bind", input, "/input", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
      "--clearenv", "--unshare-all", "--new-session", "--die-with-parent",
      "--", `/usr/bin/${tool}`, ...args,
    ], { stdio: ["ignore", "pipe", "pipe"], env: {}, windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let errors = 0;
    let invalid = false;
    let settled = false;
    const abort = () => { invalid = true; child.kill("SIGKILL"); };
    const timer = setTimeout(abort, PROFILE.wallTimeMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) abort(); else if (!invalid) chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.length; if (errors > 128 * 1024) abort(); });
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok && !invalid ? Buffer.concat(chunks, size) : null);
    };
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
  });
}

export async function videoPreparationDecoderAvailable(): Promise<boolean> {
  return process.platform === "linux" &&
    await isolated("/dev/null", "ffprobe", ["-version"], 8192) !== null;
}

type Probe = {
  streams?: Array<{ codec_type?: unknown; codec_name?: unknown; width?: unknown; height?: unknown }>;
  frames?: Array<{ media_type?: unknown; pts_time?: unknown; pkt_pts_time?: unknown; duration_time?: unknown;
    pkt_duration_time?: unknown; width?: unknown; height?: unknown }>;
};
function timestamp(raw: unknown): number | null {
  // Require an explicit decimal timestamp rather than coercing missing/null metadata to zero.
  if (typeof raw !== "string" || !/^\d+(?:\.\d{1,6})?$/u.test(raw)) return null;
  const value = Number(raw) * 1_000_000;
  return Number.isSafeInteger(Math.round(value)) && Math.abs(value - Math.round(value)) < 0.01
    ? Math.round(value) : null;
}

/** FFmpeg 4.x calls the explicit source PTS pkt_pts_time; 5+ calls it pts_time.
 * Never substitute an inferred best-effort timestamp or accept conflicting identities. */
export function videoPresentationTimeUs(frame: { pts_time?: unknown; pkt_pts_time?: unknown }): number | null {
  if (frame.pts_time !== undefined && frame.pkt_pts_time !== undefined) {
    const current = timestamp(frame.pts_time);
    return current !== null && current === timestamp(frame.pkt_pts_time) ? current : null;
  }
  return timestamp(frame.pts_time ?? frame.pkt_pts_time);
}

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export function videoPreparationImagesFromPipe(bytes: Buffer, width: number, height: number)
  : { ok: true; images: Buffer[] } | { ok: false; code: "integrity" | "recapture_frame_size" } {
  const images: Buffer[] = [];
  let start = 0;
  while (start < bytes.length) {
    if (images.length >= PROFILE.frames || !bytes.subarray(start, start + 8).equals(PNG) ||
        bytes.length - start < 33 || bytes.readUInt32BE(start + 8) !== 13 ||
        bytes.toString("ascii", start + 12, start + 16) !== "IHDR" ||
        bytes.readUInt32BE(start + 16) !== width || bytes.readUInt32BE(start + 20) !== height) return { ok: false, code: "integrity" };
    let offset = start + 8;
    let complete = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (offset + length + 12 > bytes.length) return { ok: false, code: "integrity" };
      if (length > PROFILE.frameBytes || offset + length + 12 - start > PROFILE.frameBytes) {
        return { ok: false, code: "recapture_frame_size" };
      }
      offset += length + 12;
      if (type === "IEND") { if (length !== 0) return { ok: false, code: "integrity" }; complete = true; break; }
    }
    if (!complete) return { ok: false, code: "integrity" };
    images.push(bytes.subarray(start, offset));
    start = offset;
  }
  return { ok: true, images };
}

/** Derive a complete sequence from the source, preserving every source frame at its native
 * dimensions. FFmpeg converts decoded colour planes to RGB for lossless PNG encoding. It never rescales,
 * samples, strips audio, changes playback speed, or claims to repair an unreadable capture. */
export async function prepareVideoEvidence(source: Buffer, mediaType: "video/webm" | "video/mp4")
  : Promise<VideoPreparationResult> {
  if (!source.length || source.length > PROFILE.sourceBytes) {
    return failure("source_limit", "Split or recapture the original recording below 32 MiB.");
  }
  if (!(mediaType === "video/webm" || mediaType === "video/mp4") || !videoBytesMatchMime(mediaType, source)) {
    return failure("unsupported_media", "Use a verified WebM or MP4 recording.");
  }
  // Snapshot the input before waiting: callers cannot mutate the content during derivation.
  // At most four admitted snapshots exist. Refuse excess waiters before allocating another copy.
  if (active >= 2 && waiters.length >= 2) return failure("decoder_busy", "The preparation queue is full.");
  const snapshot = Buffer.from(source);
  if (!await acquire()) return failure("decoder_busy", "The preparation queue deadline expired.");
  let root: string | undefined;
  try {
    if (!await videoPreparationDecoderAvailable()) {
      return failure("decoder_unavailable", "An isolated decoder is unavailable; retain human review.");
    }
    root = await mkdtemp(join(tmpdir(), "wollipog-video-preparation-"));
    const input = join(root, "source");
    await writeFile(input, snapshot, { mode: 0o400, flag: "wx" });
    const metadata = await isolated(input, "ffprobe", [
      "-v", "error", "-show_streams", "-show_frames", "-show_entries",
      "stream=codec_type,codec_name,width,height:frame=media_type,pts_time,pkt_pts_time,duration_time,pkt_duration_time,width,height",
      "-of", "json", "/input",
    ], 512 * 1024);
    if (!metadata) return failure("decode_limit", "Complete inspection exceeded the isolated decoder limits.");
    let probe: Probe;
    try { probe = JSON.parse(metadata.toString("utf8")) as Probe; } catch {
      return failure("integrity", "The decoder returned invalid metadata.");
    }
    if (!Array.isArray(probe.streams) || probe.streams.length !== 1 ||
        probe.streams[0]?.codec_type !== "video" ||
        !["vp8", "vp9", "h264"].includes(String(probe.streams[0]?.codec_name))) {
      return failure("unsupported_streams", "Use one silent VP8, VP9, or H.264 stream; audio and extra streams need recapture.");
    }
    const { width, height } = probe.streams[0]!;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
        Number(width) < PROFILE.minimumWidth || Number(height) < PROFILE.minimumHeight ||
        Number(width) > PROFILE.width || Number(height) > PROFILE.height) {
      return failure("recapture_resolution", "Recapture at readable native dimensions between 960×540 and 1280×720.");
    }
    if (!Array.isArray(probe.frames) || probe.frames.length < 2 || probe.frames.length > PROFILE.frames) {
      return failure("split_capture", "Split the original scenario into clips of at most 900 source frames.");
    }
    const pts = probe.frames.map(videoPresentationTimeUs);
    const lastDuration = timestamp(probe.frames.at(-1)!.duration_time ?? probe.frames.at(-1)!.pkt_duration_time);
    if (lastDuration === null || lastDuration <= 0 || pts.some((time, index) => time === null ||
        (index === 0 ? time !== 0 : time - pts[index - 1]! < PROFILE.minimumFrameIntervalUs)) ||
        probe.frames.some((frame) => frame.media_type !== "video" || frame.width !== width || frame.height !== height)) {
      return failure("recapture_timing", "Recapture with explicit ordered timestamps starting at zero, at no more than 30 fps.");
    }
    const durationUs = pts.at(-1)! + lastDuration;
    if (durationUs > PROFILE.durationUs) return failure("split_capture", "Split the original scenario into clips of at most 30 seconds.");
    const durations = pts.map((time, index) => index + 1 < pts.length ? pts[index + 1]! - time! : lastDuration);
    if (durations.some((duration) => duration > PROFILE.segmentDurationUs)) {
      return failure("recapture_timing", "A source frame hold exceeds the four-second preparation segment bound.");
    }
    const pipe = await isolated(input, "ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-err_detect", "explode",
      "-threads", "1", "-i", "/input", "-map", "0:v:0", "-vsync", "0",
      "-frames:v", String(PROFILE.frames + 1), "-threads", "1",
      "-f", "image2pipe", "-vcodec", "png", "pipe:1",
    ], PROFILE.totalFrameBytes);
    if (!pipe) return failure("decode_limit", "Complete PNG conversion exceeded the decoder time or byte limits; split or recapture.");
    const parsed = videoPreparationImagesFromPipe(pipe, Number(width), Number(height));
    if (!parsed.ok && parsed.code === "recapture_frame_size") {
      return failure("recapture_frame_size", "A complete native PNG frame exceeds 2 MiB; recapture simpler content within the readable profile. Splitting duration cannot reduce a single frame, and sampling or downscaling is not permitted.");
    }
    if (!parsed.ok || parsed.images.length !== probe.frames.length) {
      return failure("integrity", "Decoded images do not match every source frame and its native dimensions.");
    }
    const images = parsed.images;
    const frames = images.map((bytes, index) => ({
      index, ptsUs: pts[index]!, durationUs: durations[index]!, sha256: sha256(bytes), sizeBytes: bytes.length,
    }));
    const segments: VideoPreparationManifest["segments"] = [];
    for (let first = 0; first < frames.length;) {
      let end = first;
      while (end < frames.length && end - first < PROFILE.segmentFrames &&
          frames[end]!.ptsUs + frames[end]!.durationUs - frames[first]!.ptsUs <= PROFILE.segmentDurationUs) end++;
      segments.push({ index: segments.length, firstFrame: first, frameCount: end - first,
        startUs: frames[first]!.ptsUs, endUs: frames[end - 1]!.ptsUs + frames[end - 1]!.durationUs });
      first = end;
    }
    const manifest: VideoPreparationManifest = {
      schemaVersion: 1, purpose: "offline_preparation_only", profile: PROFILE.id,
      sourceSha256: sha256(snapshot), sourceSizeBytes: snapshot.length, sourceMediaType: mediaType,
      width: Number(width), height: Number(height), durationUs, frames, segments,
    };
    return { ok: true, manifest, manifestSha256: sha256(JSON.stringify(manifest)), images };
  } catch {
    return failure("decode_limit", "Preparation could not complete safely; no partial sequence is reviewable.");
  } finally {
    try { if (root) await rm(root, { recursive: true, force: true }); } finally { release(); }
  }
}
