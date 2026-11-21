/** Managed Google Antigravity install (protocol v404, Refs #4780).
 *
 * Google publishes the CLI through an installer script that reads a per-platform JSON manifest
 * (`{version, url, sha512}`) and downloads a gzipped tar holding one `antigravity` binary. Wollipog
 * follows the same chain without running the script:
 *
 * 1. Fetch `https://antigravity.google/cli/install.sh` as text, with no redirect off that origin,
 *    and record its SHA-256. Read the manifest service it names (`DOWNLOAD_BASE_URL`), which must be
 *    an HTTPS origin on `run.app`, and confirm the script still reads
 *    `$DOWNLOAD_BASE_URL/manifests/$platform.json` and extracts the `antigravity` member.
 * 2. Fetch this platform's manifest from that service. Its archive must be HTTPS on
 *    `storage.googleapis.com`, and its SHA-512 must be 128 hex digits.
 * 3. Download the archive into a private staging folder, bounded in size and time, and compare its
 *    SHA-512 with the manifest's before reading it.
 * 4. Extract only the single regular `antigravity` member. Links, devices, absolute or `..` paths,
 *    duplicates and anything else unexpected refuse the whole archive.
 *
 * Validation and activation live in `antigravity-setup.ts`. Activation renames the staged folder to
 * a generation and swaps the `current` symlink atomically, keeping exactly one `previous`
 * generation. Any failure leaves `current` untouched. Nothing here touches the runner user's HOME,
 * shell profiles or PATH. */

import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream, createWriteStream, existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync,
  type WriteStream,
} from "node:fs";
import { chmod, mkdir, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import {
  ANTIGRAVITY_MANAGED_INSTALL_SOURCE,
  antigravityReleaseUrlAllowed,
  validAntigravityManagedRelease,
  type AntigravityInstallFailure,
  type AntigravityInstallStage,
  type AntigravityManagedRelease,
} from "@wollipog/protocol";

export class AntigravityInstallError extends Error {
  constructor(readonly failure: AntigravityInstallFailure, message: string) {
    super(message);
  }
}

const INSTALLER_LIMIT = 256 * 1024;
const MANIFEST_LIMIT = 64 * 1024;
export const ANTIGRAVITY_ARCHIVE_LIMIT = 512 * 1024 * 1024;
export const ANTIGRAVITY_BINARY_LIMIT = 1024 * 1024 * 1024;
/** Everything the archive may expand to, skipped members included: a bound on gzip bombs. */
const EXPANDED_LIMIT = 2 * ANTIGRAVITY_BINARY_LIMIT;
const HEADER_DATA_LIMIT = 64 * 1024;
const MAX_REDIRECTS = 3;
const RELEASE_VERSION = /^[0-9A-Za-z.+_-]{1,64}$/u;

/** The member Google's archive holds, and the name the installer gives it. */
export const ANTIGRAVITY_ARCHIVE_MEMBER = "antigravity";
export const ANTIGRAVITY_EXECUTABLE_NAME = "agy";

// ---------------------------------------------------------------------------------------------
// Platform

/** Google's release platform for this machine, exactly as the installer names it: `darwin_<arch>`,
 * `linux_<arch>` or `linux_<arch>_musl`, with `amd64` or `arm64`. Null when Google publishes none,
 * or when Wollipog's setup does not cover it (Windows, Android). */
export function antigravityReleasePlatform(input: { platform: NodeJS.Platform; arch: string; musl: boolean }): string | null {
  const arch = input.arch === "x64" ? "amd64" : input.arch === "arm64" ? "arm64" : null;
  if (!arch) return null;
  if (input.platform === "darwin") return `darwin_${arch}`;
  if (input.platform === "linux") return input.musl ? `linux_${arch}_musl` : `linux_${arch}`;
  return null;
}

/** Mirrors the installer's musl detection: its two loader paths, else what `ldd /bin/ls` reports.
 * Instead of running `ldd`, the runner asks its own Node process which C library it runs on, which
 * is the same answer for the binaries of this machine. */
export function detectAntigravityMusl(
  fileExists: (path: string) => boolean = existsSync,
  glibcRuntime: () => string | undefined = defaultGlibcRuntime,
): boolean {
  if (fileExists("/lib/libc.musl-x86_64.so.1") || fileExists("/lib/libc.musl-aarch64.so.1")) return true;
  return glibcRuntime() === undefined;
}

function defaultGlibcRuntime(): string | undefined {
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown } } | undefined;
    const version = report?.header?.glibcVersionRuntime;
    return typeof version === "string" ? version : undefined;
  } catch {
    // Unknown is treated as glibc: the musl build would not run on a glibc machine either way,
    // and validation refuses a binary that does not run.
    return "unknown";
  }
}

// ---------------------------------------------------------------------------------------------
// Installer script and manifest

const BASE_URL_LINE = /^[ \t]*DOWNLOAD_BASE_URL="([^"\n]*)"[ \t]*$/gmu;
const MANIFEST_URL_LINE = /^[ \t]*MANIFEST_URL="\$DOWNLOAD_BASE_URL\/manifests\/\$platform\.json"[ \t]*$/mu;
const MEMBER_EXTRACT_LINE = /tar -xzf "\$staging_payload" -C "\$STAGING_DIR" antigravity(?:[ \t]|$)/mu;

/** The manifest service Google's installer script names. The script is only read: it must assign
 * `DOWNLOAD_BASE_URL` exactly once, to a bare HTTPS origin on `run.app`, read the manifest from
 * `$DOWNLOAD_BASE_URL/manifests/$platform.json` and extract the `antigravity` member. Anything else
 * is a layout Wollipog does not recognize. */
export function parseAntigravityInstaller(text: string): { manifestBase: string } {
  const assignments = [...text.matchAll(BASE_URL_LINE)];
  const base = assignments.length === 1 ? assignments[0]?.[1] : undefined;
  if (!base || !MANIFEST_URL_LINE.test(text) || !MEMBER_EXTRACT_LINE.test(text) ||
      !antigravityReleaseUrlAllowed(base, { suffix: ANTIGRAVITY_MANAGED_INSTALL_SOURCE.manifestHostSuffix })) {
    throw new AntigravityInstallError("installer_not_recognized", "Google's installer script has a layout Wollipog doesn't recognize.");
  }
  const url = new URL(base);
  // A bare origin: the script appends the manifest path itself.
  if (`${url.protocol}//${url.host}` !== base) {
    throw new AntigravityInstallError("installer_not_recognized", "Google's installer names a manifest address Wollipog doesn't recognize.");
  }
  return { manifestBase: base };
}

export interface AntigravityManifest {
  version: string;
  archiveUrl: string;
  archiveSha512: string;
}

/** Google's per-platform manifest: `version`, an HTTPS `.tar.gz` `url` on storage.googleapis.com
 * and a 128-digit hex `sha512`. Other keys are ignored; a missing or malformed one refuses it. */
export function parseAntigravityManifest(text: string): AntigravityManifest {
  let value: unknown;
  try { value = JSON.parse(text); } catch { value = undefined; }
  const manifest = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const version = manifest?.version;
  const url = manifest?.url;
  const sha512 = manifest?.sha512;
  if (typeof version !== "string" || !RELEASE_VERSION.test(version) ||
      !antigravityReleaseUrlAllowed(url, { exact: ANTIGRAVITY_MANAGED_INSTALL_SOURCE.archiveHost }) ||
      !new URL(url).pathname.endsWith(".tar.gz") ||
      typeof sha512 !== "string" || !/^[0-9a-fA-F]{128}$/u.test(sha512)) {
    throw new AntigravityInstallError("installer_not_recognized", "Google's release manifest has a shape Wollipog doesn't recognize.");
  }
  return { version, archiveUrl: url, archiveSha512: sha512.toLowerCase() };
}

// ---------------------------------------------------------------------------------------------
// Pinned HTTPS

export type AntigravityFetch = (input: URL, init: { redirect: "manual"; signal: AbortSignal }) => Promise<Response>;

export interface AntigravityDownloadOptions {
  fetch: AntigravityFetch;
  timeoutMs: number;
  /** Aborts the download early, for example on runner shutdown. */
  signal?: AbortSignal;
}

/** A response from `url`, following redirects only within its own origin. */
async function fetchPinned(url: string, options: AntigravityDownloadOptions & { deadline: AbortSignal }): Promise<Response> {
  let current = new URL(url);
  const origin = current.origin;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      response = await options.fetch(current, { redirect: "manual", signal: options.deadline });
    } catch (error) {
      throw networkError(error, options.deadline);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      let next: URL;
      try { next = new URL(location ?? "", current); } catch { next = new URL("about:blank"); }
      if (!location || next.origin !== origin) {
        throw new AntigravityInstallError("redirect_refused", `A download from ${origin} was redirected to another address.`);
      }
      current = next;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new AntigravityInstallError("download_failed", `A download from ${origin} failed with HTTP ${response.status}.`);
    }
    return response;
  }
  throw new AntigravityInstallError("redirect_refused", `A download from ${origin} redirected too many times.`);
}

function deadlineSignal(options: AntigravityDownloadOptions): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new AntigravityInstallError("timed_out", "A download didn't finish in time.")), options.timeoutMs);
  timer.unref?.();
  const forward = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forward();
  options.signal?.addEventListener("abort", forward, { once: true });
  return {
    signal: controller.signal,
    clear: () => { clearTimeout(timer); options.signal?.removeEventListener("abort", forward); },
  };
}

function networkError(error: unknown, deadline: AbortSignal): AntigravityInstallError {
  if (error instanceof AntigravityInstallError) return error;
  if (deadline.aborted && deadline.reason instanceof AntigravityInstallError) return deadline.reason;
  return new AntigravityInstallError("download_failed", "A download failed before it finished.");
}

/** A small text download: the installer script or a manifest. */
async function fetchText(url: string, limit: number, options: AntigravityDownloadOptions): Promise<string> {
  const deadline = deadlineSignal(options);
  try {
    const response = await fetchPinned(url, { ...options, deadline: deadline.signal });
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>)) {
        size += (chunk as Buffer).length;
        if (size > limit) throw new AntigravityInstallError("download_failed", "A download was larger than Wollipog accepts.");
        chunks.push(chunk as Buffer);
      }
    } catch (error) {
      throw networkError(error, deadline.signal);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    deadline.clear();
  }
}

/** Download the archive to `file` (created, never overwritten) and return its SHA-512 in hex. */
export async function downloadAntigravityArchive(
  url: string,
  file: string,
  options: AntigravityDownloadOptions & { maxBytes?: number },
): Promise<string> {
  const limit = options.maxBytes ?? ANTIGRAVITY_ARCHIVE_LIMIT;
  const deadline = deadlineSignal(options);
  let out: WriteStream | undefined;
  try {
    const response = await fetchPinned(url, { ...options, deadline: deadline.signal });
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) {
      await response.body?.cancel().catch(() => {});
      throw new AntigravityInstallError("download_failed", "Google's release archive is larger than Wollipog accepts.");
    }
    const hash = createHash("sha512");
    out = createWriteStream(file, { flags: "wx", mode: 0o600 });
    const opened = out;
    const failed = new Promise<never>((_, reject) => opened.once("error", () =>
      reject(new AntigravityInstallError("activation_failed", "The release archive couldn't be written."))));
    failed.catch(() => {});
    let size = 0;
    try {
      for await (const chunk of Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>)) {
        const bytes = chunk as Buffer;
        size += bytes.length;
        if (size > limit) throw new AntigravityInstallError("download_failed", "Google's release archive is larger than Wollipog accepts.");
        hash.update(bytes);
        if (!opened.write(bytes)) await Promise.race([new Promise((resolve) => opened.once("drain", resolve)), failed]);
      }
    } catch (error) {
      throw networkError(error, deadline.signal);
    }
    await Promise.race([closed(opened, "The release archive couldn't be written."), failed]);
    return hash.digest("hex");
  } finally {
    deadline.clear();
    if (out && !out.closed) out.destroy();
  }
}

/** End a file stream and wait until its bytes are written; a write or open error refuses. */
function closed(stream: WriteStream, message: string): Promise<void> {
  return new Promise<void>((resolve, reject) => stream.end((error?: Error | null) => {
    if (error || stream.errored) reject(new AntigravityInstallError("activation_failed", message));
    else resolve();
  }));
}

export interface AntigravityReleaseSource extends AntigravityManifest {
  installerSha256: string;
  manifestUrl: string;
}

/** Read Google's installer and this platform's manifest: the release to install, with provenance. */
export async function resolveAntigravityRelease(
  platform: string,
  options: AntigravityDownloadOptions & { onStage?: (stage: AntigravityInstallStage) => void },
): Promise<AntigravityReleaseSource> {
  options.onStage?.("fetching_installer");
  const installer = await fetchText(ANTIGRAVITY_MANAGED_INSTALL_SOURCE.installerUrl, INSTALLER_LIMIT, options);
  const installerSha256 = createHash("sha256").update(installer, "utf8").digest("hex");
  const { manifestBase } = parseAntigravityInstaller(installer);
  const manifestUrl = `${manifestBase}/manifests/${platform}.json`;
  options.onStage?.("fetching_manifest");
  const manifest = parseAntigravityManifest(await fetchText(manifestUrl, MANIFEST_LIMIT, options));
  return { ...manifest, installerSha256, manifestUrl };
}

// ---------------------------------------------------------------------------------------------
// Archive

/** Tar member types. Only regular files and directories are accepted; the target must be regular. */
const REGULAR = new Set(["0", "\0"]);
const DIRECTORY = "5";
const PAX_HEADER = "x";
const PAX_GLOBAL = "g";
const GNU_LONG_NAME = "L";

function cString(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
}

function octal(block: Buffer, start: number, length: number): number | undefined {
  const text = cString(block, start, length).trim();
  return /^[0-7]+$/u.test(text) ? Number.parseInt(text, 8) : undefined;
}

function checksumValid(block: Buffer): boolean {
  const stored = octal(block, 148, 8);
  if (stored === undefined) return false;
  let sum = 0;
  for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 0x20 : block[index] ?? 0;
  return sum === stored;
}

/** The member path, normalized, or undefined when it is absolute or climbs out with `..`. */
function safeMemberPath(raw: string): string | undefined {
  if (!raw || raw.startsWith("/") || raw.includes("\\")) return undefined;
  const parts = raw.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) return undefined;
  return parts.join("/");
}

function paxPath(data: Buffer): string | undefined {
  let path: string | undefined;
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const length = Number.parseInt(data.subarray(offset, space).toString("ascii"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > data.length) {
      throw new AntigravityInstallError("archive_invalid", "Google's release archive has a malformed header.");
    }
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0 && record.slice(0, equals) === "path") path = record.slice(equals + 1);
    offset += length;
  }
  return path;
}

function invalid(message: string): AntigravityInstallError {
  return new AntigravityInstallError("archive_invalid", message);
}

interface TarMember {
  remaining: number;
  padding: number;
  kind: "skip" | "target" | "pax" | "global" | "long_name";
  data: Buffer[];
}

/** Extract the single regular `antigravity` member of a gzipped tar to `destination` (created,
 * never overwritten), mode 0755. Refuses the archive on any link, device or other special member,
 * any absolute or `..` path, a duplicate or missing member, oversize content or a truncated tar. */
export async function extractAntigravityBinary(
  archive: string,
  destination: string,
  limits: { maxBinaryBytes?: number; maxExpandedBytes?: number } = {},
): Promise<void> {
  const maxBinary = limits.maxBinaryBytes ?? ANTIGRAVITY_BINARY_LIMIT;
  const maxExpanded = limits.maxExpandedBytes ?? EXPANDED_LIMIT;
  const input = createReadStream(archive);
  const gunzip = createGunzip();
  input.once("error", (error) => gunzip.destroy(error));
  input.pipe(gunzip);

  let buffer: Buffer = Buffer.alloc(0);
  let expanded = 0;
  let ended = false;
  // Zero bytes after the first end-of-archive block. A tar ends with two zero blocks, and record
  // padding may add more zeros; anything else after the first block refuses the archive.
  let trailing = 0;
  const trailer = (bytes: Buffer) => {
    if (bytes.some((byte) => byte !== 0)) throw invalid("Google's release archive has data after its end.");
    trailing += bytes.length;
  };
  let found = false;
  let pendingPath: string | undefined;
  // The member being read: its remaining bytes, its padding, and where they go.
  const state: { entry: TarMember | null } = { entry: null };
  let out: WriteStream | undefined;
  let outFailed: Promise<never> | undefined;

  const write = async (bytes: Buffer) => {
    if (!out || !outFailed) return;
    const target = out;
    if (!target.write(bytes)) await Promise.race([new Promise((resolve) => target.once("drain", resolve)), outFailed]);
  };

  const startMember = async (block: Buffer) => {
    if (!checksumValid(block)) throw invalid("Google's release archive has a damaged header.");
    const size = octal(block, 124, 12);
    if (size === undefined) throw invalid("Google's release archive has a member Wollipog can't read.");
    const type = String.fromCharCode(block[156] ?? 0);
    const padding = (512 - (size % 512)) % 512;
    if (type === PAX_HEADER || type === PAX_GLOBAL || type === GNU_LONG_NAME) {
      if (size > HEADER_DATA_LIMIT) throw invalid("Google's release archive has an oversized header.");
      state.entry = { remaining: size, padding, kind: type === PAX_HEADER ? "pax" : type === PAX_GLOBAL ? "global" : "long_name", data: [] };
      return;
    }
    const ustar = cString(block, 257, 6) === "ustar";
    const prefix = ustar ? cString(block, 345, 155) : "";
    const name = pendingPath ?? (prefix ? `${prefix}/${cString(block, 0, 100)}` : cString(block, 0, 100));
    pendingPath = undefined;
    const path = safeMemberPath(name);
    if (path === undefined) throw invalid("Google's release archive has a member outside its folder.");
    if (type === DIRECTORY) {
      if (size !== 0) throw invalid("Google's release archive has a malformed folder.");
      state.entry = null;
      return;
    }
    if (!REGULAR.has(type)) throw invalid("Google's release archive has a link, device or other special member.");
    if (path !== ANTIGRAVITY_ARCHIVE_MEMBER) {
      state.entry = { remaining: size, padding, kind: "skip", data: [] };
      return;
    }
    if (found) throw invalid("Google's release archive has more than one antigravity member.");
    if (size === 0 || size > maxBinary) throw invalid("Google's release archive has an antigravity member of an unexpected size.");
    found = true;
    out = createWriteStream(destination, { flags: "wx", mode: 0o700 });
    const opened = out;
    outFailed = new Promise<never>((_, reject) => opened.once("error", () =>
      reject(new AntigravityInstallError("activation_failed", "The Antigravity binary couldn't be written."))));
    outFailed.catch(() => {});
    state.entry = { remaining: size, padding, kind: "target", data: [] };
  };

  const finishMember = (finished: TarMember) => {
    const data = Buffer.concat(finished.data);
    if (finished.kind === "pax") pendingPath = paxPath(data) ?? pendingPath;
    else if (finished.kind === "long_name") pendingPath = cString(data, 0, data.length);
  };

  try {
    try {
      for await (const chunk of gunzip) {
        expanded += (chunk as Buffer).length;
        if (expanded > maxExpanded) throw invalid("Google's release archive expands beyond what Wollipog accepts.");
        if (ended) { trailer(chunk as Buffer); continue; }
        buffer = buffer.length ? Buffer.concat([buffer, chunk as Buffer]) : chunk as Buffer;
        for (;;) {
          const current = state.entry;
          if (current && current.remaining > 0) {
            if (buffer.length === 0) break;
            const take = Math.min(current.remaining, buffer.length);
            const bytes = buffer.subarray(0, take);
            buffer = buffer.subarray(take);
            current.remaining -= take;
            if (current.kind === "target") await write(Buffer.from(bytes));
            else if (current.kind !== "skip") current.data.push(Buffer.from(bytes));
            continue;
          }
          if (current) {
            if (buffer.length < current.padding) break;
            buffer = buffer.subarray(current.padding);
            finishMember(current);
            state.entry = null;
            continue;
          }
          if (buffer.length < 512) break;
          const block = buffer.subarray(0, 512);
          buffer = buffer.subarray(512);
          if (block.every((byte) => byte === 0)) {
            ended = true;
            trailer(buffer);
            buffer = Buffer.alloc(0);
            break;
          }
          await startMember(Buffer.from(block));
        }
      }
    } catch (error) {
      if (error instanceof AntigravityInstallError) throw error;
      throw invalid("Google's release archive couldn't be decompressed.");
    }
    if (!ended || trailing < 512 || state.entry || pendingPath !== undefined) throw invalid("Google's release archive is incomplete.");
    if (!found || !out || !outFailed) throw invalid("Google's release archive has no antigravity binary.");
    const target = out;
    await Promise.race([closed(target, "The Antigravity binary couldn't be written."), outFailed]);
    await chmod(destination, 0o755);
  } catch (error) {
    out?.destroy();
    await rm(destination, { force: true }).catch(() => {});
    throw error;
  } finally {
    input.destroy();
    gunzip.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// Generations

const GENERATION_ID = /^[0-9]{1,16}-[0-9a-f]{8}$/u;
const GENERATION_TARGET = /^generations\/[0-9]{1,16}-[0-9a-f]{8}$/u;
const RELEASE_RECORD = "release.json";
const PENDING_RECORD = "pending-activation.json";

interface PendingActivation {
  generation: string;
  replaced: { current?: string; previous?: string };
}

function validPending(value: unknown): value is PendingActivation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const replaced = record.replaced as Record<string, unknown> | undefined;
  const target = (candidate: unknown) => candidate === undefined || (typeof candidate === "string" && GENERATION_TARGET.test(candidate));
  return typeof record.generation === "string" && GENERATION_ID.test(record.generation) &&
    !!replaced && typeof replaced === "object" && !Array.isArray(replaced) &&
    Object.keys(replaced).every((key) => key === "current" || key === "previous") &&
    target(replaced.current) && target(replaced.previous);
}

export interface AntigravityGeneration {
  id: string;
  directory: string;
  release: AntigravityManagedRelease;
}

/** An activated generation and the pointer targets it replaced, kept until the new version proves
 * itself: `confirm` keeps it, and `rollback` restores the pointers exactly. */
export interface AntigravityActivation {
  generation: AntigravityGeneration;
  replaced: { current?: string; previous?: string };
}

/** The runner's managed copies under `<dataDir>/antigravity-managed`:
 *
 * - `generations/<id>/agy` and `generations/<id>/release.json`, one folder per activated release;
 * - `current` and `previous`, relative symlinks to a generation;
 * - `staging/`, the private working folder of the one running install.
 *
 * `current/agy` is the stable launch path: a swap changes what new launches run, while processes
 * already running keep the file they opened. */
export class AntigravityManagedStore {
  constructor(readonly root: string) {}

  /** The managed executable every launch uses. */
  executablePath(): string {
    return join(this.root, "current", ANTIGRAVITY_EXECUTABLE_NAME);
  }

  /** The generation a pointer names, when it and its files are intact. */
  read(pointer: "current" | "previous"): AntigravityGeneration | null {
    try {
      const target = readlinkSync(join(this.root, pointer));
      const id = /^generations\/([^/]+)$/u.exec(target)?.[1];
      if (!id || !GENERATION_ID.test(id)) return null;
      const directory = join(this.root, "generations", id);
      if (!lstatSync(join(directory, ANTIGRAVITY_EXECUTABLE_NAME)).isFile()) return null;
      const release: unknown = JSON.parse(readFileSync(join(directory, RELEASE_RECORD), "utf8"));
      return validAntigravityManagedRelease(release) ? { id, directory, release } : null;
    } catch {
      return null;
    }
  }

  /** A new private staging folder. Earlier leftovers (an install the runner didn't finish) are
   * removed first: only one install runs at a time. */
  async createStaging(now: number): Promise<{ id: string; directory: string; scratch: string }> {
    const staging = join(this.root, "staging");
    await rm(staging, { recursive: true, force: true });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const id = `${now}-${randomUUID().replace(/-/gu, "").slice(0, 8)}`;
    const directory = join(staging, id);
    const scratch = join(staging, `${id}-scratch`);
    await mkdir(directory, { mode: 0o700 });
    await mkdir(scratch, { mode: 0o700 });
    return { id, directory, scratch };
  }

  /** Make a validated staging folder the current generation, and the old current `previous`. Each
   * pointer is swapped by renaming a new symlink over it. `proceed` is asked before each pointer
   * changes (the runner may be stopping): a refusal undoes what changed and activates nothing.
   *
   * Before any pointer changes, a pending-activation record names what they pointed at. Until
   * `confirm` removes it, the activation is unverified: `recoverPending` (at runner start and before
   * each check) restores those pointers, so a runner that exits mid-verification never keeps an
   * unverified version. Nothing is removed until `confirm`. */
  async activate(
    staging: { id: string; directory: string },
    release: AntigravityManagedRelease,
    proceed: () => boolean = () => true,
  ): Promise<AntigravityActivation> {
    const stopped = () => new AntigravityInstallError("activation_failed", "The runner stopped before activation.");
    await writeFile(join(staging.directory, RELEASE_RECORD), `${JSON.stringify(release, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const generations = join(this.root, "generations");
    await mkdir(generations, { recursive: true, mode: 0o700 });
    if (!proceed()) throw stopped();
    const directory = join(generations, staging.id);
    await rename(staging.directory, directory);
    // An unfinished activation's record names the last working version: never replace it.
    if (existsSync(this.pendingPath())) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw new AntigravityInstallError("activation_failed", "An earlier activation is still pending.");
    }
    const replaced = { ...this.target("current"), ...this.target("previous") };
    const activation: AntigravityActivation = { generation: { id: staging.id, directory, release }, replaced };
    try {
      await this.writePending({ generation: staging.id, replaced });
      if (!proceed()) throw stopped();
      if (replaced.current) await this.swap("previous", replaced.current);
      if (!proceed()) throw stopped();
      await this.swap("current", `generations/${staging.id}`);
    } catch (error) {
      await this.rollback(activation).catch(() => {});
      throw error;
    }
    return activation;
  }

  /** Keep a verified activation: drop its pending record, then remove generations neither pointer
   * names (or that a launch still needs, see `keepInUse`), so one previous remains. */
  async confirm(): Promise<void> {
    await rm(this.pendingPath(), { force: true });
    // Removing older generations is best effort: a leftover is removed by the next confirm.
    await this.prune().catch(() => {});
  }

  /** Undo an activation: restore both pointers to what they named before, then remove the new
   * generation. With nothing before it, `current` is removed, so the PATH copy is used again. The
   * pending record is removed only once both pointers are restored, so a failed rollback is retried
   * by `recoverPending`. */
  async rollback(activation: AntigravityActivation): Promise<void> {
    for (const pointer of ["current", "previous"] as const) {
      const target = activation.replaced[pointer];
      if (target) await this.swap(pointer, target);
      else await rm(join(this.root, pointer), { force: true });
    }
    await rm(this.pendingPath(), { force: true });
    await this.prune();
  }

  /** Finish an activation that was never verified (the runner exited, or a rollback failed):
   * restore the pointers its pending record names and remove its generation. Synchronous, so the
   * runner can recover before it reads `current`. Returns whether a pending activation was found;
   * a record it can't parse, or a restore that fails, stays for the next attempt. */
  recoverPending(): { found: boolean; restored: boolean } {
    let record: unknown;
    try { record = JSON.parse(readFileSync(this.pendingPath(), "utf8")); } catch (error) {
      return { found: (error as NodeJS.ErrnoException).code !== "ENOENT", restored: false };
    }
    const pending = validPending(record) ? record : undefined;
    if (!pending) return { found: true, restored: false };
    try {
      for (const pointer of ["current", "previous"] as const) {
        const target = pending.replaced[pointer];
        if (target) this.swapSync(pointer, target);
        else rmSync(join(this.root, pointer), { force: true });
      }
      rmSync(this.pendingPath(), { force: true });
    } catch {
      return { found: true, restored: false };
    }
    // The pointers are restored: removing the rejected generation is best effort, and a leftover
    // is removed by the next confirm.
    try {
      const keep = new Set([pending.replaced.current, pending.replaced.previous]);
      if (!keep.has(`generations/${pending.generation}`)) {
        rmSync(join(this.root, "generations", pending.generation), { recursive: true, force: true });
      }
    } catch { /* best effort */ }
    return { found: true, restored: true };
  }

  /** The folder of the generation an uncommitted activation made current, or null with none
   * pending. A record that can't be read could name any generation, so the generations folder
   * itself is returned: nothing managed counts as committed until it is recovered. */
  pendingGeneration(): string | null {
    let record: unknown;
    try { record = JSON.parse(readFileSync(this.pendingPath(), "utf8")); } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : join(this.root, "generations");
    }
    return validPending(record) ? join(this.root, "generations", record.generation) : join(this.root, "generations");
  }

  private inUse: () => readonly string[] = () => [];

  private pendingPath(): string {
    return join(this.root, PENDING_RECORD);
  }

  private async writePending(pending: PendingActivation): Promise<void> {
    const temporary = join(this.root, `.${PENDING_RECORD}-${randomUUID()}`);
    await writeFile(temporary, `${JSON.stringify(pending)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, this.pendingPath());
  }

  private swapSync(pointer: "current" | "previous", target: string): void {
    const temporary = join(this.root, `.${pointer}-${randomUUID()}`);
    symlinkSync(target, temporary);
    try {
      renameSync(temporary, join(this.root, pointer));
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  async discardStaging(): Promise<void> {
    await rm(join(this.root, "staging"), { recursive: true, force: true }).catch(() => {});
  }

  private target(pointer: "current" | "previous"): { current?: string; previous?: string } {
    try { return { [pointer]: readlinkSync(join(this.root, pointer)) }; } catch { return {}; }
  }

  private async swap(pointer: "current" | "previous", target: string): Promise<void> {
    const temporary = join(this.root, `.${pointer}-${randomUUID()}`);
    await symlink(target, temporary);
    try {
      await rename(temporary, join(this.root, pointer));
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  /** Executables session launches still need (#4779): a launcher (bwrap, the cgroup helper) may
   * open one after the runner spawned it. No prune removes their generations; a later one does. */
  keepInUse(inUse: () => readonly string[]): void {
    this.inUse = inUse;
  }

  /** Remove generations neither pointer names nor a launch still needs. Best effort: a leftover is
   * retried next time. */
  private async prune(): Promise<void> {
    const inUse = this.inUse();
    const keep = new Set<string>();
    for (const pointer of ["current", "previous"] as const) {
      try { keep.add(readlinkSync(join(this.root, pointer))); } catch { /* absent */ }
    }
    const generations = join(this.root, "generations");
    for (const id of await readdir(generations).catch(() => [] as string[])) {
      if (keep.has(`generations/${id}`) || generationInUse(join(generations, id), inUse)) continue;
      await rm(join(generations, id), { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Whether a launch still needs an executable inside this generation folder. */
function generationInUse(directory: string, inUse: readonly string[]): boolean {
  if (!inUse.length) return false;
  let resolved = directory;
  try { resolved = realpathSync(directory); } catch { /* compared as named */ }
  return inUse.some((path) => path.startsWith(`${resolved}${sep}`) || path.startsWith(`${directory}${sep}`));
}
