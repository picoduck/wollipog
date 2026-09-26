/** Bounded, trusted derivation of every presentation frame in a supported short WebM clip.
 * No child-authored frame or pathname enters this worker. The control plane supplies the exact
 * stored artifact bytes; bubblewrap gives the decoder one read-only input and one empty output.
 * Unsupported installations fail closed to human review. */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { videoBytesMatchMime } from "./workflow-artifacts.js";

export const SHORT_VIDEO_PROFILE = {
  sourceBytes: 8 * 1024 * 1024,
  durationMs: 4_000,
  frames: 16,
  width: 640,
  height: 360,
  frameBytes: 1 * 1024 * 1024,
  totalFrameBytes: 8 * 1024 * 1024,
  minimumFrameIntervalMs: 250,
  wallTimeMs: 5_000,
} as const;

export interface DecodedVideoFrame {
  index: number;
  ptsMs: number;
  sha256: string;
  bytes: Buffer;
}

export type VideoFrameDecodeResult =
  | { ok: true; sourceSha256: string; frames: DecodedVideoFrame[] }
  | { ok: false; reason: string };

const BWRAP = "/usr/bin/bwrap";
const PRLIMIT = "/usr/bin/prlimit";
const FFMPEG = "/usr/bin/ffmpeg";
const FFPROBE = "/usr/bin/ffprobe";
const DECODER_OUTPUT_LIMIT = 128 * 1024;
const MAX_CONCURRENT_DECODES = 2;
let activeDecodes = 0;

export async function shortVideoDecoderAvailable(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    await Promise.all([BWRAP, PRLIMIT, FFMPEG, FFPROBE,
      "/etc/alternatives", "/etc/ld.so.cache"].map((path) => access(path, constants.R_OK)));
    // Installed binaries alone do not prove this service may create the required isolated
    // namespace. Some hosts disable unprivileged user namespaces while shipping bubblewrap.
    return (await runIsolated("/dev/null", FFPROBE, ["-version"], 4096)).ok;
  } catch {
    return false;
  }
}

function isolatedArgs(inputPath: string, tool: string, args: string[]): string[] {
  return [
    "--cpu=3", "--as=1073741824", `--fsize=${SHORT_VIDEO_PROFILE.frameBytes}`,
    "--", BWRAP,
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64",
    "--ro-bind", "/etc/alternatives", "/etc/alternatives",
    "--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache",
    "--ro-bind", inputPath, "/input.webm",
    "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
    "--clearenv", "--unshare-all", "--new-session", "--die-with-parent",
    "--", tool, ...args,
  ];
}

async function runIsolated(
  inputPath: string,
  tool: string,
  args: string[],
  outputLimit: number,
): Promise<{ ok: true; stdout: Buffer } | { ok: false }> {
  return new Promise((resolve) => {
    const child = spawn(PRLIMIT, isolatedArgs(inputPath, tool, args), {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: {},
    });
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), SHORT_VIDEO_PROFILE.wallTimeMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > outputLimit) {
        overflow = true;
        child.kill("SIGKILL");
      } else chunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > DECODER_OUTPUT_LIMIT) {
        overflow = true;
        child.kill("SIGKILL");
      }
    });
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok && !overflow ? { ok: true, stdout: Buffer.concat(chunks, stdoutBytes) } : { ok: false });
    };
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
  });
}

type ProbeStream = { codec_type?: unknown; codec_name?: unknown; width?: unknown; height?: unknown };
type ProbeFrame = { media_type?: unknown; best_effort_timestamp_time?: unknown;
  duration_time?: unknown; pkt_duration_time?: unknown };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `image2pipe` emits concatenated PNG files. This parser only separates complete images; the
 * isolated decoder is the sole source of their bytes. Bounds apply before each slice is kept. */
function splitPngStream(stream: Buffer): Buffer[] | null {
  const result: Buffer[] = [];
  let offset = 0;
  while (offset < stream.length) {
    if (result.length >= SHORT_VIDEO_PROFILE.frames + 1 ||
        !stream.subarray(offset, offset + 8).equals(PNG_SIGNATURE)) return null;
    let end = offset + 8;
    let foundEnd = false;
    while (end + 12 <= stream.length && end - offset <= SHORT_VIDEO_PROFILE.frameBytes) {
      const length = stream.readUInt32BE(end);
      const type = stream.subarray(end + 4, end + 8).toString("ascii");
      if (length > SHORT_VIDEO_PROFILE.frameBytes || end + length + 12 > stream.length) return null;
      end += length + 12;
      if (type === "IEND") { foundEnd = true; break; }
    }
    if (!foundEnd || end - offset > SHORT_VIDEO_PROFILE.frameBytes) return null;
    result.push(stream.subarray(offset, end));
    offset = end;
  }
  return result;
}

/** Decode all source presentation frames. Any unsupported, ambiguous, or resource-bound result
 * is an ordinary human fallback; never turn a partial set into a reviewable manifest. */
export async function decodeShortSilentWebm(source: Buffer): Promise<VideoFrameDecodeResult> {
  const unsupported = (reason: string): VideoFrameDecodeResult => ({ ok: false, reason });
  if (!source.length || source.length > SHORT_VIDEO_PROFILE.sourceBytes) {
    return unsupported("Video exceeds the supported short-review size limit.");
  }
  if (!videoBytesMatchMime("video/webm", source)) {
    return unsupported("Only WebM video is supported for delegated review.");
  }
  if (activeDecodes >= MAX_CONCURRENT_DECODES) {
    return unsupported("The bounded video decoder is busy; this review needs a human.");
  }
  activeDecodes++;
  try {
    if (!await shortVideoDecoderAvailable()) {
      return unsupported("An isolated video decoder is unavailable on this server.");
    }
    const root = await mkdtemp(join(tmpdir(), "wollipog-video-review-"));
    const inputPath = join(root, "input.webm");
    try {
      await writeFile(inputPath, source, { mode: 0o400, flag: "wx" });
      const probe = await runIsolated(inputPath, FFPROBE, [
        "-v", "error", "-show_streams", "-show_frames",
        "-show_entries", "stream=codec_type,codec_name,width,height:frame=media_type,best_effort_timestamp_time,duration_time,pkt_duration_time",
        "-of", "json", "/input.webm",
      ], DECODER_OUTPUT_LIMIT);
      if (!probe.ok) return unsupported("The video could not be completely inspected within the review limits.");
      let streams: ProbeStream[];
      let frames: ProbeFrame[];
      try {
        const parsed = JSON.parse(probe.stdout.toString("utf8")) as { streams?: ProbeStream[]; frames?: ProbeFrame[] };
        streams = parsed.streams ?? [];
        frames = parsed.frames ?? [];
      } catch {
        return unsupported("The video decoder returned invalid frame metadata.");
      }
      if (streams.length !== 1 || streams[0]?.codec_type !== "video" ||
          streams[0]?.codec_name !== "vp9" ||
          !Number.isSafeInteger(streams[0]?.width) || !Number.isSafeInteger(streams[0]?.height) ||
          Number(streams[0]?.width) < 1 || Number(streams[0]?.width) > SHORT_VIDEO_PROFILE.width ||
          Number(streams[0]?.height) < 1 || Number(streams[0]?.height) > SHORT_VIDEO_PROFILE.height) {
        return unsupported("Only silent, short WebM/VP9 video within the review dimensions is supported.");
      }
      if (frames.length < 2 || frames.length > SHORT_VIDEO_PROFILE.frames ||
          frames.some((frame) => frame.media_type !== "video")) {
        return unsupported("The video has an unsupported number or type of frames.");
      }
      const rawPts = frames.map((frame) => Number(frame.best_effort_timestamp_time) * 1000);
      // The profile represents timestamps in whole milliseconds. Reject sub-ms timing instead of
      // silently shifting motion; rounding only removes binary floating-point representation noise.
      const pts = rawPts.map(Math.round);
      const durations = frames.map((frame) => Number(frame.duration_time ?? frame.pkt_duration_time) * 1000);
      if (pts.some((value, index) => !Number.isFinite(value) || value < 0 ||
          Math.abs(rawPts[index]! - value) > 0.01 ||
          value > SHORT_VIDEO_PROFILE.durationMs ||
          (index === 0 ? value !== 0 : value - pts[index - 1]! < SHORT_VIDEO_PROFILE.minimumFrameIntervalMs)) ||
          durations.some((value) => !Number.isFinite(value) || value < 0) ||
          pts.at(-1)! + durations.at(-1)! > SHORT_VIDEO_PROFILE.durationMs) {
        return unsupported("The video has unsupported or ambiguous frame timing.");
      }
      const decoded = await runIsolated(inputPath, FFMPEG, [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-err_detect", "explode",
        "-threads", "1",
        "-i", "/input.webm", "-map", "0:v:0", "-vsync", "0",
        "-frames:v", String(SHORT_VIDEO_PROFILE.frames + 1),
        "-f", "image2pipe", "-vcodec", "png", "pipe:1",
      ], SHORT_VIDEO_PROFILE.totalFrameBytes + SHORT_VIDEO_PROFILE.frameBytes);
      if (!decoded.ok) return unsupported("The video could not be completely decoded within the review limits.");
      const images = splitPngStream(decoded.stdout);
      if (!images || images.length !== frames.length) {
        return unsupported("The decoded frames do not match the complete source frame list.");
      }
      let totalBytes = 0;
      const result: DecodedVideoFrame[] = [];
      for (const [index, bytes] of images.entries()) {
        totalBytes += bytes.length;
        if (!bytes.length || bytes.length > SHORT_VIDEO_PROFILE.frameBytes ||
            totalBytes > SHORT_VIDEO_PROFILE.totalFrameBytes ||
            !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
          return unsupported("Decoded frames exceed the review byte limits or are not PNG images.");
        }
        result.push({ index, ptsMs: pts[index]!, sha256: createHash("sha256").update(bytes).digest("hex"), bytes });
      }
      return { ok: true, sourceSha256: createHash("sha256").update(source).digest("hex"), frames: result };
    } catch {
      return unsupported("The isolated video decoder could not complete safely.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    activeDecodes--;
  }
}
