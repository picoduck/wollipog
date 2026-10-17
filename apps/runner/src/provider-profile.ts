import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { join } from "node:path";

/**
 * A provider profile's stable host-local identity (#3239). The marker lives inside the provider
 * HOME, next to (never inside) its `provider-home-leases-v1` journal, so the identity travels with
 * the directory rather than with a Machine, runner, or control plane. The lease worker reads it
 * before any journal I/O and refuses a control plane that the marker does not grant.
 */
export const PROVIDER_PROFILE_DIRECTORY = ".agent-manager";
export const PROVIDER_PROFILE_MARKER = "profile-v1.json";
export const PROVIDER_PROFILE_LIMITS = { markerBytes: 4_096, grants: 16 } as const;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MARKER_KEYS = ["createdAt", "grants", "kind", "profileId", "provider", "version"];
const GRANT_KEYS = ["controlPlaneInstanceId", "grantId", "grantedAt"];

export interface ProviderProfileGrant {
  controlPlaneInstanceId: string;
  grantId: string;
  grantedAt: string;
}

export interface ProviderProfileMarker {
  version: 1;
  kind: "wollipog-provider-profile";
  profileId: string;
  provider: "claude" | "codex";
  createdAt: string;
  grants: ProviderProfileGrant[];
}

/** `ancestry` means `.agent-manager` itself is unsafe; `marker` means the marker file is. */
export type ProviderProfileRead =
  | { state: "absent" }
  | { state: "present"; marker: ProviderProfileMarker }
  | { state: "unverifiable"; cause: "ancestry" | "marker" };

/** What the caller knows about the control plane and the session/account binding for one acquire. */
export interface ProviderProfileAccess {
  /** The profile id recorded by the account or session; absent for unbound (legacy) homes. */
  expectedId?: string;
  controlPlaneSupportsProfiles: boolean;
  /** Profiles this control plane currently holds an unrevoked grant for. */
  activeProfileIds: string[];
}

export type ProviderProfileDenial =
  | "profile_unsupported_control_plane"
  | "profile_unverifiable"
  | "profile_not_granted"
  | "profile_changed";

export type ProviderProfileDecision =
  | { allowed: true; profileId?: string }
  | { allowed: false; reason: ProviderProfileDenial };

/** Older callers send no profile context; they keep today's behaviour for marker-less homes. */
export const LEGACY_PROFILE_ACCESS: ProviderProfileAccess = Object.freeze({
  controlPlaneSupportsProfiles: false, activeProfileIds: Object.freeze([]) as unknown as string[],
});

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, index) => key === keys[index]);
}

function isoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 32) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** Strict structural validation. Unknown versions, kinds, and keys are all refused. */
export function validProviderProfileMarker(value: unknown): value is ProviderProfileMarker {
  if (!plainObject(value) || !exactKeys(value, MARKER_KEYS)) return false;
  if (value.version !== 1 || value.kind !== "wollipog-provider-profile") return false;
  if (typeof value.profileId !== "string" || !UUID_V4.test(value.profileId)) return false;
  if (value.provider !== "claude" && value.provider !== "codex") return false;
  if (!isoTimestamp(value.createdAt)) return false;
  if (!Array.isArray(value.grants) || value.grants.length > PROVIDER_PROFILE_LIMITS.grants) return false;
  const instances = new Set<string>();
  for (const grant of value.grants as unknown[]) {
    if (!plainObject(grant) || !exactKeys(grant, GRANT_KEYS)) return false;
    if (typeof grant.controlPlaneInstanceId !== "string" || !UUID.test(grant.controlPlaneInstanceId)) return false;
    if (typeof grant.grantId !== "string" || !UUID.test(grant.grantId) || !isoTimestamp(grant.grantedAt)) return false;
    if (instances.has(grant.controlPlaneInstanceId)) return false;
    instances.add(grant.controlPlaneInstanceId);
  }
  return true;
}

function serialize(marker: ProviderProfileMarker): Buffer {
  if (!validProviderProfileMarker(marker)) throw new Error("provider profile marker is invalid");
  // Fixed key order: the bytes depend only on the marker's values.
  const canonical = {
    version: marker.version, kind: marker.kind, profileId: marker.profileId, provider: marker.provider,
    createdAt: marker.createdAt,
    grants: marker.grants.map(({ controlPlaneInstanceId, grantId, grantedAt }) => ({ controlPlaneInstanceId, grantId, grantedAt })),
  };
  const bytes = Buffer.from(`${JSON.stringify(canonical)}\n`);
  if (bytes.length > PROVIDER_PROFILE_LIMITS.markerBytes) throw new Error("provider profile marker exceeds its byte limit");
  return bytes;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function sameNode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export interface ProviderProfileReadOptions {
  /** Test seam: the platform whose verification rules apply. */
  platform?: NodeJS.Platform;
  /** When set, a marker for a different provider is unverifiable rather than present. */
  provider?: "claude" | "codex";
}

/**
 * Read `<home>/.agent-manager/profile-v1.json` without following links. `home` must already be
 * canonical. Anything this reader cannot prove — a linked or substituted directory, a symlinked,
 * hard-linked, oversized, foreign-owned or group/world-writable file, a concurrent change, or an
 * unknown format — is `unverifiable`, never `absent`.
 */
export function readProviderProfileMarker(home: string, options: ProviderProfileReadOptions = {}): ProviderProfileRead {
  const platform = options.platform ?? process.platform;
  const directory = join(home, PROVIDER_PROFILE_DIRECTORY);
  const path = join(directory, PROVIDER_PROFILE_MARKER);
  let parent: BigIntStats;
  try { parent = lstatSync(directory, { bigint: true }); } catch (error) {
    return errorCode(error) === "ENOENT" ? { state: "absent" } : { state: "unverifiable", cause: "ancestry" };
  }
  if (!parent.isDirectory() || parent.isSymbolicLink()) return { state: "unverifiable", cause: "ancestry" };
  let named: BigIntStats;
  try { named = lstatSync(path, { bigint: true }); } catch (error) {
    return errorCode(error) === "ENOENT" ? { state: "absent" } : { state: "unverifiable", cause: "marker" };
  }
  const unverifiable = { state: "unverifiable", cause: "marker" } as const;
  // Windows has no O_NOFOLLOW and no POSIX owner/mode: a present marker there cannot be proved.
  const noFollow = constants.O_NOFOLLOW;
  if (platform === "win32" || noFollow === undefined || typeof process.getuid !== "function") return unverifiable;
  if (!named.isFile() || named.isSymbolicLink()) return unverifiable;
  let bytes: Buffer;
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | noFollow); } catch { return unverifiable; }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(PROVIDER_PROFILE_LIMITS.markerBytes) || stat.nlink !== 1n || !sameNode(named, stat) ||
        stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o022n) !== 0n) return unverifiable;
    const buffer = Buffer.alloc(Number(stat.size) + 1);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    const after = lstatSync(path, { bigint: true });
    const parentAfter = lstatSync(directory, { bigint: true });
    if (count !== Number(stat.size) || !sameNode(after, stat) || after.ctimeNs !== stat.ctimeNs || after.size !== stat.size ||
        !sameNode(parentAfter, parent) || !parentAfter.isDirectory() || parentAfter.isSymbolicLink()) return unverifiable;
    bytes = buffer.subarray(0, count);
  } catch { return unverifiable; } finally { closeSync(fd); }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return unverifiable; }
  if (!validProviderProfileMarker(value)) return unverifiable;
  if (options.provider && value.provider !== options.provider) return unverifiable;
  return { state: "present", marker: value };
}

/**
 * Atomically replace the marker: exclusive 0600 temporary, fsync, rename, directory fsync. Only the
 * lease worker may call this, and only while it holds this HOME's lease.
 */
export function writeProviderProfileMarker(home: string, marker: ProviderProfileMarker, options: Pick<ProviderProfileReadOptions, "platform"> = {}): void {
  if ((options.platform ?? process.platform) === "win32" || constants.O_NOFOLLOW === undefined) {
    throw new Error("provider profile markers are not supported on this platform");
  }
  const bytes = serialize(marker);
  const directory = join(home, PROVIDER_PROFILE_DIRECTORY);
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) {
    if (errorCode(error) !== "EEXIST") throw new Error("provider profile directory is unavailable");
  }
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("provider profile directory is unsafe");
  const temporary = join(directory, `.profile-v1.${randomUUID()}.tmp`);
  let fd: number | undefined;
  let committed = false;
  try {
    fd = openSync(temporary, "wx", 0o600);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, join(directory, PROVIDER_PROFILE_MARKER));
    committed = true;
    const directoryFd = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | constants.O_NOFOLLOW);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } catch (error) {
    if (!committed) throw new Error("provider profile marker update failed", { cause: error });
    // The rename already committed; directory fsync is a best-effort durability barrier.
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!committed) rmSync(temporary, { force: true });
  }
}

/**
 * The pre-acquisition decision, in order:
 * 1. no marker and no recorded id: allow (today's behaviour);
 * 2. no marker but a recorded id: `profile_changed`;
 * 3. unreadable, unsafe, or newer-format marker: `profile_unverifiable`;
 * 4. marker id differs from the recorded id: `profile_changed`;
 * 5. marker present but the control plane does not negotiate profiles: `profile_unsupported_control_plane`;
 * 6. no grant for this control plane, or the profile is not active there: `profile_not_granted`.
 */
export function decideProviderProfileAccess(
  read: ProviderProfileRead,
  access: ProviderProfileAccess | undefined,
  controlPlaneInstanceId: string | undefined,
): ProviderProfileDecision {
  const context = access ?? LEGACY_PROFILE_ACCESS;
  if (read.state === "absent") return context.expectedId === undefined ? { allowed: true } : { allowed: false, reason: "profile_changed" };
  if (read.state === "unverifiable") return { allowed: false, reason: "profile_unverifiable" };
  const { marker } = read;
  if (context.expectedId !== undefined && context.expectedId !== marker.profileId) return { allowed: false, reason: "profile_changed" };
  if (!context.controlPlaneSupportsProfiles) return { allowed: false, reason: "profile_unsupported_control_plane" };
  const instance = controlPlaneInstanceId?.toLowerCase();
  if (!instance || !marker.grants.some((grant) => grant.controlPlaneInstanceId === instance) ||
      !context.activeProfileIds.includes(marker.profileId)) return { allowed: false, reason: "profile_not_granted" };
  return { allowed: true, profileId: marker.profileId };
}

/** Validation shared by the worker frame and the runner config. */
export function isProviderProfileId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}
