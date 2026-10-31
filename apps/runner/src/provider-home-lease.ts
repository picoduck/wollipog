import type { ProviderHomeBlockingProcess } from "@wollipog/protocol";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir, hostname as systemHostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentContext, AgentDriverKind } from "@wollipog/protocol";
import { WSL_BWRAP_UNAVAILABLE_ERROR } from "./execution-isolation-policy.js";
import type { SpawnIsolation } from "./spawn.js";
import { readLeaseIoSnapshot, applyLeaseIoPlan, ensureLeaseIoAvailable, withLeaseIoOptions, LeaseIoError, type LeaseIoSnapshot, type LeaseIoEntry, type LeaseIoJob } from "./provider-home-lease-io.js";
import { LEASE_CHECKPOINT_LIMITS as LIMITS, type LeaseCheckpointProof, type LeaseRetirementEntry } from "./provider-home-lease-checkpoint.js";
import { LEASE_WORKER_ERRORS } from "./provider-home-lease-worker-protocol.js";
import { createProviderProfileMarker, decideProviderProfileAccess, isProviderProfileId, ProviderProfileChangeError, readProviderProfileMarker, retireProviderProfileMarker, writeProviderProfileMarker, type ProviderProfileAccess, type ProviderProfileChangeRefusal, type ProviderProfileDenial, type ProviderProfileGrant, type ProviderProfileMarker, type ProviderProfileRead } from "./provider-profile.js";
import { codexApiKeyRecord, ProviderCredentialImportRefusal, publishCodexCredential, readCodexCredentialSource, type CodexCredentialLayout } from "./provider-credential-import.js";
import { createManagedProviderProfileHome } from "./provider-profile-home.js";
import { currentBootTimeMs } from "./provider-home-lease-boot.js";
import { leaseContainmentGuidance, type LeaseContainmentEvidence } from "./provider-home-lease-containment.js";
import { currentLeaseProcessEvidence, isLeaseProcessEvidence, linuxLeaseProcessProbe, proveLeaseAbandoned, type LeaseAbandonmentProof, type LeaseProcessEvidence, type LeaseProcessProbe } from "./provider-home-lease-evidence.js";

const OWNER_HASH = /^[a-f0-9]{64}$/u;
const PROVIDER_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_RECORD_BYTES = 4_096;
const LEGACY_MARKER = "lease.json";
const GENESIS_MARKER = /^lease-([0-9a-f-]+)\.json$/u;
const RECOVERY_MARKER = "mutable-home.recovery.json";
const NEXT_MARKER = /^next-([0-9a-f-]+)\.json$/u;
const CHECKPOINT_PENDING = ".mutable-home.checkpoint.pending";
const FORMAT_GUARD = "protocol-v4.json";
const RETIREMENT_ALIAS = ".mutable-home.retired";
let physicalSnapshot: LeaseIoSnapshot | undefined;
const CHECKPOINT_SLOTS = [CHECKPOINT_PENDING, `${CHECKPOINT_PENDING}-2`];
let verificationWork: { records: number; bytes: number } | undefined;
let verificationObserver: ((work: { records: number; bytes: number }) => void) | undefined;
export function observeLeaseVerificationWorkForTest(observer?: typeof verificationObserver): void { verificationObserver = observer; }

function withVerificationBudget<T>(action: () => T): T {
  const previous = verificationWork;
  if (previous) return action();
  verificationWork = { records: 0, bytes: 0 };
  try { return action(); } finally { const completed = verificationWork; verificationWork = previous; if (completed) verificationObserver?.(completed); }
}

function spendVerificationWork(records: number, bytes: number): void {
  if (!verificationWork) return;
  verificationWork.records += records;
  verificationWork.bytes += bytes;
  if (verificationWork.records > LIMITS.verificationRecords || verificationWork.bytes > LIMITS.verificationBytes) {
    throw new Error("provider-home lease verification work limit exceeded; preserve all evidence");
  }
}

function remainingBudget() { return { records: LIMITS.verificationRecords - (verificationWork?.records ?? 0), bytes: LIMITS.verificationBytes - (verificationWork?.bytes ?? 0) }; }

function hashText(text: string): string {
  spendVerificationWork(0, Buffer.byteLength(text));
  return createHash("sha256").update(text).digest("hex");
}

interface ProviderHomeLeaseRecordV1 {
  version: 1;
  ownerHash: string;
  leaseId: string;
  pid: number;
  hostname: string;
  provider: string;
  createdAt: string;
}

interface ProviderHomeLeaseRecordV2 {
  /** v5 carries versioned containment evidence. Old readers reject the record itself, including
   * pre-lifecycle readers that ignored unknown `process` properties. v2 remains readable. */
  version: 2 | 5;
  state: "active" | "released";
  ownerHash: string;
  leaseId: string;
  previousLeaseId: string | null;
  previousRecordHash: string | null;
  /** Immutable digest of retained entries outside this record's successor chain. */
  recoveredEntriesHash?: string;
  pid: number;
  hostname: string;
  provider: string;
  createdAt: string;
  /** #3241: lifecycle evidence of the recording runner. Older readers ignore it. */
  process?: LeaseProcessEvidence;
  /** #3241: present only on an active record that took over another owner's abandoned active
   * lease. Older readers refuse that owner change as an unexpected transition. */
  recovery?: LeaseRecoveryNote;
}

/**
 * Why a successor was allowed to take over an unreleased lease. Either another owner proved the
 * lease abandoned and holds this control plane's profile grant (`profileId`), or an Owner or Admin
 * authorized succeeding that exact record (`authorized`, #3241 part 2), with the proof it rests on:
 * the record's own lifecycle evidence, or, for a record without evidence, a boot after it was written.
 */
type LeaseRecoveryNote =
  | { proof: LeaseAbandonmentProof; profileId?: string }
  | { proof: "authorized"; authorizationId: string; basis: LeaseAbandonmentProof | "booted_after"; profileId?: string };

/** An Owner or Admin's one-time authorization to succeed the unreleased record hashed `staleTipHash`. */
export interface LeaseRecoveryAuthorization {
  staleTipHash: string;
  authorizationId: string;
}

/** A boot this long after a record was written proves no process of that boot survives; the margin
 * absorbs small wall-clock adjustments between the old writer and this reader. */
const BOOT_PROOF_MARGIN_MS = 60_000;

function isLeaseRecoveryNote(value: unknown): value is LeaseRecoveryNote {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const note = value as Record<string, unknown>;
  if (note.proof === "authorized") {
    const profiled = Object.hasOwn(note, "profileId");
    return Object.keys(note).length === (profiled ? 4 : 3) &&
      typeof note.authorizationId === "string" && LEASE_ID.test(note.authorizationId) &&
      (note.basis === "reboot" || note.basis === "process_scan" || note.basis === "linux_cgroup" || note.basis === "linux_cgroup_unit_removed" || note.basis === "booted_after") &&
      (!profiled || isProviderProfileId(note.profileId));
  }
  const profiled = Object.hasOwn(note, "profileId");
  return Object.keys(note).length === (profiled ? 2 : 1) &&
    (note.proof === "reboot" || note.proof === "process_scan" || note.proof === "linux_cgroup" || note.proof === "linux_cgroup_unit_removed") && (!profiled || isProviderProfileId(note.profileId));
}

interface ProviderHomeLeaseRecordV4 extends Omit<ProviderHomeLeaseRecordV2, "version"> {
  version: 4;
  checkpoint: LeaseCheckpointProof;
}

type ProviderHomeLeaseRecord = ProviderHomeLeaseRecordV1 | ProviderHomeLeaseRecordV2 | ProviderHomeLeaseRecordV4;

function isJournalTransition(record: unknown): record is ProviderHomeLeaseRecordV2 {
  const version = (record as { version?: unknown } | undefined)?.version;
  return version === 2 || version === 5;
}

interface ReadLeaseRecord {
  record: ProviderHomeLeaseRecord;
  hash: string;
  raw: string;
}

interface LeaseChain {
  entries: string[];
  tip: ReadLeaseRecord;
  snapshotHash: string;
  external: boolean;
  transitions: number;
  anchor?: ReadLeaseRecord;
  retired: LeaseRetirementEntry[];
  evidence: Array<{ directory: "root" | "lock"; name: string; hash: string }>;
}

interface FailedInitialization {
  proof: ReadLeaseRecord;
  directory?: { dev: number; ino: number };
  snapshotHash: string;
}

export interface ProviderHomeLeaseOptions {
  helperDataDir?: string;
  pid?: number;
  hostname?: string;
  isProcessAlive?: (pid: number) => boolean;
  beforeMarkerWriteForTest?: () => void;
  beforeTransitionPublishForTest?: () => void;
  afterTransitionPublishForTest?: () => void;
  afterInitializationPublishForTest?: () => void;
  beforeInitializationMirrorForTest?: (mirror: string) => void;
  nativeCheckpointBarrierForTest?: { boundary: string; marker: string };
  onCheckpointFailureForTest?: (error: unknown) => void;
  disableCompactionForTest?: boolean;
  onDiagnostic?: (diagnostic: { event: "provider_home_checkpoint_unavailable" | "provider_home_release_unpublished" | "provider_home_boundary_recovered"; leaseId: string; message: string }) => void;
  /** The attested control-plane instance this registry acquires for; checked against profile grants. */
  controlPlaneInstanceId?: string;
  /** #3241: the marker every process this runner launches inherits. Without it records carry no
   * lifecycle evidence and can only be reclaimed by their own owner, as before. */
  runnerMarker?: string;
  /** Main-thread containment chosen before any lease or provider launch; never selected by the worker. */
  containment?: LeaseContainmentEvidence;
  /** Test seam for the process view; defaults to procfs on Linux and to none elsewhere. */
  processProbe?: LeaseProcessProbe | null;
  /** Test seam for the current boot time (epoch ms, null when unknown); see `currentBootTimeMs`. */
  bootTimeMs?: () => number | null;
}

/** What an Owner or Admin is shown before authorizing a recovery (#3241 part 2). */
export interface ProviderHomeLeaseInspection {
  /** `none`: no lease journal; `released`: free; `held`: held by this runner; `stale`: an unreleased
   * record of another runner process; `unverifiable`: the journal cannot be verified. */
  state: "none" | "released" | "held" | "stale" | "unverifiable";
  /** For `stale`: the exact record an authorization must name, and what it shows. */
  tipHash?: string;
  createdAt?: string;
  sameHost?: boolean;
  hasEvidence?: boolean;
  /** For `stale`: why an authorized recovery would be refused now, or null when it would proceed. */
  refusal?: ProviderHomeLeaseRefusalKind | null;
  blockingProcess?: ProviderHomeBlockingProcess;
}

function boundedEntries(path: string): string[] {
  const directory = opendirSync(path);
  const entries: string[] = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      if (entries.length === LIMITS.migrationEntries) throw new Error("provider-home lease scan limit exceeded");
      entries.push(entry.name);
    }
  } finally { directory.closeSync(); }
  return entries.sort();
}

export interface ProviderHomeLeaseRequest {
  driver: AgentDriverKind;
  command: string;
  context: AgentContext;
  env: Record<string, string>;
  isolation?: SpawnIsolation;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves death. EPERM means alive, and any other error (out-of-range or otherwise
    // unprobeable PID) is malformed state that must fail closed rather than authorize reclaim.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function providerKey(driver: AgentDriverKind, command: string): string {
  if (driver === "claude-code") return "claude";
  if (driver === "codex" || driver === "codex-app-server") return "codex";
  if (driver === "pi") return "pi";
  return `acp-${createHash("sha256").update(command).digest("hex").slice(0, 16)}`;
}

/** Ordinary bwrap redirects mutable transcripts; a protected managed worktree can instead keep
 * the real provider home writable, which still needs the same cross-runner lease as provider mode. */
export function providerLaunchNeedsSharedHomeLease(isolation?: SpawnIsolation): boolean {
  return (isolation?.backend !== "bwrap" || isolation.preservesProviderHome === true) &&
    isolation?.backend !== "wsl-bwrap" && isolation?.backend !== "container" &&
    isolation?.backend !== "cloud";
}

/** Pure launch selection. The asynchronous facade sends only this bounded target to its worker. */
export function providerHomeLeaseTarget(request: ProviderHomeLeaseRequest): { home: string; provider: string } | null {
  if (request.context.kind === "wsl" && request.isolation?.backend === "bwrap") throw new Error(WSL_BWRAP_UNAVAILABLE_ERROR);
  if (!providerLaunchNeedsSharedHomeLease(request.isolation)) return null;
  const provider = providerKey(request.driver, request.command);
  if (request.context.kind === "wsl") {
    throw new Error(`shared ${provider} provider home in WSL cannot be safely owner-leased; use a supported native, container, or cloud execution target`);
  }
  const home = provider === "claude" ? request.env.CLAUDE_CONFIG_DIR || request.env.HOME || homedir()
    : provider === "codex" ? request.env.CODEX_HOME || request.env.HOME || homedir()
      : request.env.HOME || homedir();
  return { home, provider };
}

function isBaseRecord(value: Record<string, unknown>): boolean {
  return typeof value.ownerHash === "string" && OWNER_HASH.test(value.ownerHash) &&
    typeof value.leaseId === "string" && LEASE_ID.test(value.leaseId) &&
    Number.isSafeInteger(value.pid) && (value.pid as number) > 0 && typeof value.hostname === "string" &&
    typeof value.provider === "string" && PROVIDER_KEY.test(value.provider) &&
    typeof value.createdAt === "string";
}

const snapshotIndexes = new WeakMap<LeaseIoSnapshot, Map<string, LeaseIoEntry>>();
function snapshotEntry(path: string): LeaseIoEntry | undefined {
  if (!physicalSnapshot) return undefined;
  let index = snapshotIndexes.get(physicalSnapshot);
  if (!index) { index = new Map(physicalSnapshot.entries.map((item) => [join(physicalSnapshot!.root, item.directory === "root" ? "" : "mutable-home.lock", item.name), item])); snapshotIndexes.set(physicalSnapshot, index); }
  const entry = index.get(path);
  if (!entry) throw Object.assign(new Error("lease entry absent"), { code: "ENOENT" });
  return entry;
}
function metadataStat(path: string): import("node:fs").Stats {
  if (!physicalSnapshot) return lstatSync(path);
  const isRoot = path === physicalSnapshot.root;
  const isLock = path === join(physicalSnapshot.root, "mutable-home.lock");
  const identity = isRoot ? physicalSnapshot.rootIdentity : isLock ? physicalSnapshot.lockIdentity : undefined;
  if (isLock && !identity) throw Object.assign(new Error("lock absent"), { code: "ENOENT" });
  if (identity) return { dev: identity.device, ino: identity.inode, isDirectory: () => true, isSymbolicLink: () => false } as unknown as import("node:fs").Stats;
  const entry = snapshotEntry(path)!;
  return { dev: entry.device, ino: entry.inode, size: entry.raw.length, mode: entry.mode, uid: entry.uid, nlink: entry.links,
    isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false } as unknown as import("node:fs").Stats;
}
function snapshotEntries(path: string): string[] {
  if (!physicalSnapshot) return boundedEntries(path);
  const root = path === physicalSnapshot.root;
  if (!root && !physicalSnapshot.lockIdentity) throw Object.assign(new Error("lock absent"), { code: "ENOENT" });
  return [...physicalSnapshot.entries.filter((entry) => entry.directory === (root ? "root" : "lock")).map((entry) => entry.name),
    ...(root && physicalSnapshot.lockIdentity ? ["mutable-home.lock"] : [])].sort();
}
function withSnapshot<T>(snapshot: LeaseIoSnapshot, action: () => T): T {
  const previous = physicalSnapshot; physicalSnapshot = snapshot;
  try { return action(); } finally { physicalSnapshot = previous; }
}
function capture(root: string): LeaseIoSnapshot {
  const result = readLeaseIoSnapshot(root, remainingBudget());
  spendVerificationWork(result.work.records, result.work.bytes);
  return result;
}
/** Publication staging has validated physical identity, but its bytes are mutable/non-authoritative. */
function publicationTemporary(entry: LeaseIoEntry): boolean {
  return entry.directory === "root" && /^\.provider-home-lease-[0-9a-f-]{36}\.tmp$/u.test(entry.name);
}

const decodedEntries = new WeakMap<LeaseIoEntry, ReadLeaseRecord>();
function readRecord(path: string): ReadLeaseRecord {
  const cachedEntry = physicalSnapshot ? snapshotEntry(path) : undefined;
  if (cachedEntry?.links === 3 && physicalSnapshot!.entries.filter((entry) => entry.device === cachedEntry.device && entry.inode === cachedEntry.inode && (entry.raw.equals(cachedEntry.raw) || publicationTemporary(entry))).length < 3) throw new Error("unproven lease metadata alias");
  if (cachedEntry && decodedEntries.has(cachedEntry)) return decodedEntries.get(cachedEntry)!;
  spendVerificationWork(1, 0);
  let bytes: Buffer;
  if (physicalSnapshot) bytes = snapshotEntry(path)!.raw;
  else {
    const named = lstatSync(path, { bigint: true });
    if (named.isSymbolicLink()) throw new Error("provider-home lease metadata is unsafe");
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.size > BigInt(LIMITS.checkpointBytes) || stat.nlink < 1n || stat.nlink > 3n || named.dev !== stat.dev || named.ino !== stat.ino) throw new Error("provider-home lease metadata is unsafe");
      const buffer = Buffer.alloc(Number(stat.size) + 1);
      const count = readSync(fd, buffer, 0, buffer.length, 0);
      const after = lstatSync(path, { bigint: true });
      if (count !== Number(stat.size) || after.dev !== stat.dev || after.ino !== stat.ino || after.ctimeNs !== stat.ctimeNs) throw new Error("provider-home lease metadata changed");
      bytes = buffer.subarray(0, count); spendVerificationWork(0, count);
    } finally { closeSync(fd); }
  }
  let value: Record<string, unknown>;
  try { value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; }
  catch { throw new Error("provider-home lease metadata is invalid"); }
  const validV1 = value.version === 1 && isBaseRecord(value);
  const validV2 = (isJournalTransition(value) || value.version === 4) && isBaseRecord(value) &&
    (value.state === "active" || value.state === "released") &&
    (value.previousLeaseId === null || typeof value.previousLeaseId === "string" && LEASE_ID.test(value.previousLeaseId)) &&
    (value.previousRecordHash === null || typeof value.previousRecordHash === "string" && OWNER_HASH.test(value.previousRecordHash));
  if (!validV1 && !validV2 || value.version !== 4 && bytes.length > MAX_RECORD_BYTES) throw new Error("provider-home lease metadata is invalid");
  // #3241 fields: evidence only on v2/v4 records, and a recovery note only on an active one.
  if ((value.process !== undefined && (validV1 || !isLeaseProcessEvidence(value.process))) ||
      (value.recovery !== undefined && (validV1 || value.state !== "active" || !isLeaseRecoveryNote(value.recovery)))) {
    throw new Error("provider-home lease metadata is invalid");
  }
  // New evidence may never masquerade as a v2 record an older binary might ignore.
  if ((value.version === 5 && (!isLeaseProcessEvidence(value.process) || value.process.version !== 2)) ||
      (value.version === 2 && isLeaseProcessEvidence(value.process) && value.process.version === 2)) {
    throw new Error("provider-home lease metadata is invalid");
  }
  const result = { record: value as unknown as ProviderHomeLeaseRecord, hash: hashText(bytes.toString("utf8")), raw: bytes.toString("utf8") };
  if (cachedEntry) decodedEntries.set(cachedEntry, result);
  return result;
}

function unexpectedEntries(lockDir: string): Error {
  return refusal(lockDir, "contains unexpected entries; refusing unsafe recovery");
}

/** Why a lease was refused, independent of the operator-facing text. `busy` is a lease whose
 * recorded process is alive; `foreign_owner` is a lease from another runner or control plane whose
 * recorded process is gone; `foreign_host` is a lease recorded on another host; `unverifiable` is
 * everything the registry cannot prove. The `profile_*` kinds are pre-acquisition provider-profile
 * refusals (#3239), decided before any lease journal I/O. `stale_tip_changed` and `no_reboot_proof`
 * refuse an authorized recovery (#3241): the lease is no longer the authorized record, or the host
 * has not booted since that record (without lifecycle evidence) was written. `recovery_unconfirmed`
 * is not a refusal: an authorized recovery failed after it may have been published. */
export type ProviderHomeLeaseRefusalKind = "busy" | "foreign_owner" | "foreign_host" | "unverifiable" | "stale_tip_changed" | "no_reboot_proof" |
  "holder_alive" | "boundary_survivor" | "process_survivor" | "boundary_unverifiable" | "process_uninspectable" | "process_uninspectable_not_delegated" |
  "recovery_unconfirmed" | ProviderProfileDenial | ProviderProfileChangeRefusal;

class ProviderHomeLeaseRefusal extends Error {
  constructor(readonly reason: string, message: string, readonly kind: ProviderHomeLeaseRefusalKind, options?: ErrorOptions, readonly blockingProcess?: ProviderHomeBlockingProcess) { super(message, options); }
}

/** The typed refusal kind, or null when `error` is not a registry refusal. */
export function providerHomeLeaseRefusalKind(error: unknown): ProviderHomeLeaseRefusalKind | null {
  if (error instanceof ProviderProfileChangeError) return error.code;
  return error instanceof ProviderHomeLeaseRefusal ? error.kind : null;
}

/** Sanitized observations are separate from the registry's private path-bearing Error text. */
export function providerHomeLeaseBlockingProcess(error: unknown): ProviderHomeBlockingProcess | undefined {
  return error instanceof ProviderHomeLeaseRefusal ? error.blockingProcess : undefined;
}

/** Marker changes take the lease without the grant check; see `changeProfileMarkerWhileHeld`. */
const PROFILE_CHANGE = Symbol("provider profile change");
type ProfileContext = ProviderProfileAccess | typeof PROFILE_CHANGE | undefined;

function refusal(
  lockDir: string,
  reason: string,
  restartAfterQuarantine = false,
  kind: ProviderHomeLeaseRefusalKind = "unverifiable",
  blockingProcess?: ProviderHomeBlockingProcess,
): Error {
  const recovery = restartAfterQuarantine
    ? "restart the runner before retrying; quarantine does not clear this registry's in-memory failed initialization reservations"
    : "retry";
  return new ProviderHomeLeaseRefusal(reason, `provider home lease directory ${lockDir} ${reason}; after proving no provider process or runner uses this HOME, manually quarantine the entire provider-home-leases-v1 directory (including mutable-home.lock, all lease-/next- records, and mutable-home.recovery.json) and ${recovery}; do not remove individual records`, kind, undefined, blockingProcess);
}

function staleTipChanged(lockDir: string): Error {
  return refusal(lockDir, "is no longer the stale lease that was authorized for recovery; inspect it again", false, "stale_tip_changed");
}

function verificationRefusal(lockDir: string, error: unknown, restartAfterQuarantine = false): Error {
  // Preserve the complete remedy once, and never put malformed record contents from a parser's
  // exception into operator-visible output.
  if (error instanceof LeaseIoError && error.kind === "busy") return new LeaseIoError("busy", `provider home lease directory ${lockDir} is already in use: checkpoint publication is in progress; preserve evidence and retry`);
  if (error instanceof LeaseIoError && error.kind === "unavailable") return error;
  return error instanceof ProviderHomeLeaseRefusal
    ? refusal(lockDir, error.reason, restartAfterQuarantine, error.kind, error.blockingProcess)
    : refusal(lockDir, "cannot be verified: metadata is unsafe or unreadable", restartAfterQuarantine);
}

function recordsHash(records: Array<{ name: string; hash: string }>): string {
  return hashText(JSON.stringify(records.map(({ name, hash }) => ({ name, hash }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
}

/** #3241: an active successor of an unreleased lease on the same host. Without an Owner/Admin
 * authorization it succeeds another owner's active lease that carried lifecycle evidence and was
 * proved abandoned. With one it may succeed any unreleased record of any owner: one without evidence
 * (including a v1 lease) on a later boot, one with evidence only on that evidence. */
function isRecoveryTransition(current: ReadLeaseRecord, next: ReadLeaseRecord): boolean {
  const note = isJournalTransition(next.record) && next.record.state === "active" ? next.record.recovery : undefined;
  if (!note || next.record.hostname !== current.record.hostname) return false;
  const unreleased = current.record.version === 1 || current.record.state === "active";
  const evidence = current.record.version !== 1 && current.record.process !== undefined;
  if (note.proof === "authorized") return unreleased && (note.basis === "booted_after" ? !evidence : evidence);
  return unreleased && evidence && (next.record.ownerHash === current.record.ownerHash || note.profileId !== undefined);
}

function validateTransition(current: ReadLeaseRecord, next: ReadLeaseRecord, lockDir: string): void {
  if (isJournalTransition(next.record) && next.record.recovery !== undefined) {
    if (!isRecoveryTransition(current, next) || next.record.previousLeaseId !== current.record.leaseId ||
        (next.record.previousRecordHash !== current.hash && (current.record.version !== 4 || next.record.previousRecordHash !== current.record.checkpoint.previousTipHash))) {
      throw unexpectedEntries(lockDir);
    }
    return;
  }
  if (!isJournalTransition(next.record) || next.record.previousLeaseId !== current.record.leaseId ||
      (next.record.previousRecordHash !== current.hash && (current.record.version !== 4 || next.record.previousRecordHash !== current.record.checkpoint.previousTipHash)) ||
      (next.record.state === "released" &&
        (current.record.version === 1 || current.record.state !== "active" ||
          next.record.ownerHash !== current.record.ownerHash || next.record.hostname !== current.record.hostname ||
          next.record.pid !== current.record.pid || next.record.provider !== current.record.provider)) ||
      (next.record.state === "active" && (current.record.version === 1 || current.record.state === "active") &&
        (next.record.ownerHash !== current.record.ownerHash || next.record.hostname !== current.record.hostname))) {
    throw unexpectedEntries(lockDir);
  }
}

function exactIdentity(device: unknown, inode: unknown): boolean {
  const decimal = /^(?:0|[1-9][0-9]{0,19})$/u;
  return typeof device === "string" && typeof inode === "string" && decimal.test(device) && decimal.test(inode) && inode !== "0" &&
    BigInt(device) <= 18_446_744_073_709_551_615n && BigInt(inode) <= 18_446_744_073_709_551_615n;
}
function checkpointHistory(proof: Omit<LeaseCheckpointProof, "historyHash">): string {
  return hashText(JSON.stringify([
    proof.previousHistoryHash, proof.previousAnchorHash, proof.previousTipHash, proof.guardHash, proof.guardDevice, proof.guardInode, proof.migration,
    proof.retired.map(({ directory, name, hash, device, inode }) => [directory, name, hash, device, inode]),
  ]));
}

function verifyCheckpoint(anchor: ReadLeaseRecord, lockDir: string): LeaseRetirementEntry[] {
  const record = anchor.record;
  if (record.version !== 4 || record.state !== "active" || record.previousLeaseId !== null ||
      record.previousRecordHash !== null || !OWNER_HASH.test(record.recoveredEntriesHash ?? "")) throw unexpectedEntries(lockDir);
  const proof = record.checkpoint;
  if (!proof || typeof proof.previousTip !== "string" || Buffer.byteLength(proof.previousTip) > MAX_RECORD_BYTES ||
      ![proof.previousTipHash, proof.previousAnchorHash, proof.previousHistoryHash, proof.historyHash, proof.guardHash]
        .every((hash) => typeof hash === "string" && OWNER_HASH.test(hash)) ||
      typeof proof.migration !== "boolean" || !exactIdentity(proof.guardDevice, proof.guardInode) ||
      !Array.isArray(proof.retired) || proof.retired.length > LIMITS.retirementEntries) throw unexpectedEntries(lockDir);
  const tip = JSON.parse(proof.previousTip) as ProviderHomeLeaseRecord;
  if (!isJournalTransition(tip) || tip.state !== "active" || !isBaseRecord(tip as unknown as Record<string, unknown>) ||
      hashText(proof.previousTip) !== proof.previousTipHash ||
      ["leaseId", "ownerHash", "pid", "hostname", "provider", "createdAt"].some((key) =>
        tip[key as keyof typeof tip] !== record[key as keyof typeof record])) throw unexpectedEntries(lockDir);
  const seen = new Set<string>();
  for (const entry of proof.retired) {
    const key = `${entry.directory}/${entry.name}`;
    const validName = entry.directory === "root" ? NEXT_MARKER.test(entry.name) || CHECKPOINT_SLOTS.includes(entry.name) || entry.name === RETIREMENT_ALIAS :
      entry.directory === "lock" && (NEXT_MARKER.test(entry.name) || GENESIS_MARKER.test(entry.name) ||
        entry.name === "checkpoint.json");
    if (!validName || seen.has(key) || !OWNER_HASH.test(entry.hash) ||
        (entry.directory === "root" && entry.name === `next-${record.leaseId}.json`) ||
        !exactIdentity(entry.device, entry.inode)) {
      throw unexpectedEntries(lockDir);
    }
    seen.add(key);
  }
  if (tip.previousLeaseId === null || !proof.retired.some((entry) => entry.directory === "root" &&
      entry.name === `next-${tip.previousLeaseId}.json` && entry.hash === proof.previousTipHash)) throw unexpectedEntries(lockDir);
  if (checkpointHistory(proof) !== proof.historyHash) throw unexpectedEntries(lockDir);
  return proof.retired;
}

/** Isolate proof validation in tests from later chain and filesystem refusal checks. */
export function verifyLeaseCheckpointForTest(raw: string): void {
  verifyCheckpoint({ record: JSON.parse(raw) as ProviderHomeLeaseRecord, raw, hash: hashText(raw) }, "test checkpoint");
}

function verifyRetired(root: string, lockDir: string, retired: LeaseRetirementEntry[]): Set<string> {
  const present = new Set<string>();
  for (const entry of retired) {
    const path = join(entry.directory === "root" ? root : lockDir, entry.name);
    let stat: import("node:fs").Stats;
    try { stat = metadataStat(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const hash = readRecord(path).hash;
    // This single fixed witness may hold a different source moved by the selected manifest.
    // It never supplies acquisition authority; every ordinary path keeps its named proof.
    const expected = entry.directory === "root" && entry.name === RETIREMENT_ALIAS
      ? retired.find(item => item.device === String(stat.dev) && item.inode === String(stat.ino) && item.hash === hash)
      : entry;
    if (!expected || String(stat.dev) !== expected.device || String(stat.ino) !== expected.inode || !stat.isFile() || stat.isSymbolicLink() ||
        hash !== expected.hash) throw unexpectedEntries(lockDir);
    const after = metadataStat(path);
    if (String(after.dev) !== expected.device || String(after.ino) !== expected.inode) throw unexpectedEntries(lockDir);
    present.add(`${entry.directory}/${entry.name}`);
  }
  return present;
}

/** Test selected retirement tuples without substituting unrelated chain errors. */
export function verifyLeaseRetirementForTest(snapshot: LeaseIoSnapshot, retired: LeaseRetirementEntry[]): void {
  withSnapshot(snapshot, () => { verifyRetired(snapshot.root, join(snapshot.root, "mutable-home.lock"), retired); });
}

function canonicalRootEntries(root: string, lockDir: string): string[] {
  const entries = snapshotEntries(root);
  for (const name of entries) {
    if (name === "mutable-home.lock") continue;
    const publicationTemp = /^\.provider-home-lease-[0-9a-f-]{36}\.tmp$/u.test(name);
    if (name !== RECOVERY_MARKER && !NEXT_MARKER.test(name) && !CHECKPOINT_SLOTS.includes(name) && name !== RETIREMENT_ALIAS && !publicationTemp) throw unexpectedEntries(lockDir);
    const stat = metadataStat(join(root, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > (publicationTemp ? MAX_RECORD_BYTES : LIMITS.checkpointBytes) ||
        stat.nlink < 1 || stat.nlink > 3 || (process.platform !== "win32" && (stat.mode & 0o022) !== 0) ||
        (process.getuid && stat.uid !== process.getuid())) throw unexpectedEntries(lockDir);
  }
  return entries;
}

/**
 * Resolve the immutable lease journal. A fixed successor pathname is the compare-and-swap: only
 * one process can publish the transition from a particular tip, and no record is ever removed.
 */
function readChain(lockDir: string): LeaseChain {
  const root = join(lockDir, "..");
  try { return withVerificationBudget(() => withSnapshot(capture(root), () => readChainAt(lockDir, root))); }
  catch (error) { throw verificationRefusal(lockDir, error); }
}

function readChainAt(lockDir: string, root: string): LeaseChain {
  let entries: string[] = [];
  try {
    const lockStat = metadataStat(lockDir);
    // A /proc descriptor path is intentionally a symlink to the directory we opened no-follow.
    if (!lockStat.isDirectory() && !/^\/proc\/self\/fd\/\d+$/u.test(lockDir)) throw unexpectedEntries(lockDir);
    entries = snapshotEntries(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const entrySet = new Set(entries);
  const verifiedMirrors = new Map<string, string>();
  const verifyMirror = (name: string, hash: string) => {
    if (!entrySet.has(name)) return;
    if (readRecord(join(lockDir, name)).hash !== hash) throw unexpectedEntries(lockDir);
    verifiedMirrors.set(name, hash);
  };
  let marker: string;
  let current: ReadLeaseRecord;
  let recovery: ReadLeaseRecord | undefined;
  try {
    recovery = readRecord(join(root, RECOVERY_MARKER));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (recovery) {
    // A v4 checkpoint copies its tip, which may be a recovery; a v2 anchor never succeeds anything.
    if ((!isJournalTransition(recovery.record) && recovery.record.version !== 4) || recovery.record.state !== "active" ||
        (isJournalTransition(recovery.record) && recovery.record.recovery !== undefined) ||
        recovery.record.previousLeaseId !== null || recovery.record.previousRecordHash !== null ||
        typeof recovery.record.recoveredEntriesHash !== "string" || !OWNER_HASH.test(recovery.record.recoveredEntriesHash)) {
      throw unexpectedEntries(lockDir);
    }
    current = recovery;
    marker = `lease-${current.record.leaseId}.json`;
    if (isJournalTransition(recovery.record)) verifyMirror(marker, current.hash);
  } else if (entries.length === 0) {
    throw refusal(lockDir, "is incomplete and has no ownership proof");
  } else if (entrySet.has(LEGACY_MARKER)) {
    marker = LEGACY_MARKER;
    current = readRecord(join(lockDir, marker));
    if (current.record.version !== 1) throw unexpectedEntries(lockDir);
  } else {
    const genesis = entries.filter((entry) => GENESIS_MARKER.test(entry));
    if (genesis.length !== 1) throw unexpectedEntries(lockDir);
    marker = genesis[0]!;
    current = readRecord(join(lockDir, marker));
    const match = GENESIS_MARKER.exec(marker);
    // A genesis is only ever published `active` (release appends a `next-*` record), so a released
    // genesis is fabricated or corrupted state — never an explicit handoff to trust.
    if (!isJournalTransition(current.record) || current.record.state !== "active" || current.record.recovery !== undefined ||
        current.record.previousLeaseId !== null ||
        current.record.previousRecordHash !== null || match?.[1] !== current.record.leaseId) {
      throw unexpectedEntries(lockDir);
    }
  }

  const consumed = new Set(recovery?.record.version !== 4 && entrySet.has(marker) ? [marker] : []);
  const retired = recovery?.record.version === 4 ? verifyCheckpoint(recovery, lockDir) : [];
  let guardHash: string | undefined;
  if (entrySet.has(FORMAT_GUARD)) {
    const guard = readRecord(join(lockDir, FORMAT_GUARD));
    if (guard.record.version !== 4 || JSON.parse(guard.raw).protocol !== "bounded-canonical-checkpoint" || JSON.parse(guard.raw).fenceBackend !== (process.platform === "win32" ? "lockfileex" : "flock")) throw unexpectedEntries(lockDir);
    guardHash = guard.hash;
    consumed.add(FORMAT_GUARD);
  }
  if (recovery?.record.version === 4) {
    const guard = snapshotEntry(join(lockDir, FORMAT_GUARD));
    if (guardHash !== recovery.record.checkpoint.guardHash || guard?.device !== recovery.record.checkpoint.guardDevice || guard?.inode !== recovery.record.checkpoint.guardInode) throw unexpectedEntries(lockDir);
  }
  const presentRetired = verifyRetired(root, lockDir, retired);
  if (snapshotEntries(root).includes(RETIREMENT_ALIAS)) {
    const alias = snapshotEntry(join(root, RETIREMENT_ALIAS))!;
    if (!retired.some((entry) => entry.device === alias.device && entry.inode === alias.inode && entry.hash === readRecord(join(root, RETIREMENT_ALIAS)).hash)) throw unexpectedEntries(lockDir);
  }
  const migrating = recovery?.record.version === 4 && recovery.record.checkpoint.migration && presentRetired.size > LIMITS.directoryEntries - LIMITS.hardTransitions;
  const cap = recovery?.record.version === 4 && !migrating ? LIMITS.directoryEntries : LIMITS.migrationEntries;
  if (snapshotEntries(root).length > cap || entries.length > cap) throw refusal(lockDir, "exceeds the negotiated metadata storage limit");
  const metadataBytes = physicalSnapshot?.entries.reduce((sum, entry) => sum + entry.raw.length, 0) ?? 0;
  if (metadataBytes > (cap === LIMITS.directoryEntries ? 10 : 40) * 1024 * 1024) throw refusal(lockDir, "exceeds the negotiated metadata byte limit");
  for (const entry of retired) if (entry.directory === "lock" && presentRetired.has(`lock/${entry.name}`)) consumed.add(entry.name);
  // Updated binaries publish the canonical chain outside the directory and leave in-lock
  // mirrors for inspection. A rollback binary must refuse this marker instead of acquiring
  // a lease while ignoring the canonical journal.
  if (isJournalTransition(recovery?.record) && entrySet.has("checkpoint.json")) {
    verifyMirror("checkpoint.json", recovery.hash);
    consumed.add("checkpoint.json");
  }
  const externalEntries = recovery ? canonicalRootEntries(root, lockDir).filter((name) => NEXT_MARKER.test(name) && !presentRetired.has(`root/${name}`)) : [];
  const externalSet = new Set(externalEntries);
  const externalConsumed = new Set<string>();
  const canonicalRecords = recovery ? [{ name: RECOVERY_MARKER, hash: recovery.hash }] : [];
  if (guardHash) canonicalRecords.push({ name: FORMAT_GUARD, hash: guardHash });
  const evidence: LeaseChain["evidence"] = [];
  if (isJournalTransition(recovery?.record)) {
    for (const name of consumed) if (name !== FORMAT_GUARD && !presentRetired.has(`lock/${name}`)) evidence.push({ directory: "lock", name, hash: readRecord(join(lockDir, name)).hash });
  }
  const seenLeaseIds = new Set<string>();
  for (;;) {
    if (seenLeaseIds.has(current.record.leaseId)) throw unexpectedEntries(lockDir);
    seenLeaseIds.add(current.record.leaseId);
    const nextMarker = `next-${current.record.leaseId}.json`;
    if (!(recovery ? externalSet : entrySet).has(nextMarker)) break;
    const next = readRecord(join(recovery ? root : lockDir, nextMarker));
    if (recovery) {
      externalConsumed.add(nextMarker);
      canonicalRecords.push({ name: nextMarker, hash: next.hash });
      evidence.push({ directory: "root", name: nextMarker, hash: next.hash });
      verifyMirror(nextMarker, next.hash);
    }
    // Only two transitions are ever published, and both constrain the successor: reclaim appends
    // an active record over an unreleased (v1 or active-v2) predecessor after proving the same
    // owner and host, and releaseAll releases a v2 active tip copying its identity verbatim. Any
    // other link is fabricated or corrupted state; trusting it would let a "released" tip skip
    // every hostname/owner/liveness check. Only an authentic handoff (an active successor over a
    // released record) may change identity.
    validateTransition(current, next, lockDir);
    if (entrySet.has(nextMarker)) consumed.add(nextMarker);
    if (entrySet.has(nextMarker)) evidence.push({ directory: "lock", name: nextMarker, hash: next.hash });
    current = next;
  }
  const retained = entries.filter((entry) => !consumed.has(entry))
    .map((name) => ({ name, hash: readRecord(join(lockDir, name)).hash }));
  if (retained.length > LIMITS.retainedEntries) throw refusal(lockDir, "exceeds the retained evidence limit");
  if (recovery) {
    if (externalConsumed.size !== externalEntries.length) throw unexpectedEntries(lockDir);
    if (recordsHash(retained) !== (recovery.record as ProviderHomeLeaseRecordV2).recoveredEntriesHash) throw unexpectedEntries(lockDir);
  } else if (retained.length) throw unexpectedEntries(lockDir);
  const snapshotRecords = entries.map((name) => ({ name, hash: readRecord(join(lockDir, name)).hash }));
  for (const { name, hash } of snapshotRecords) {
    if (verifiedMirrors.has(name) && verifiedMirrors.get(name) !== hash) throw unexpectedEntries(lockDir);
  }
  // Optional mirrors are validated aliases, not ownership state. Their publication must not
  // change the recovery snapshot; canonical bytes and every retained entry still do.
  const snapshotEvidence = recovery ? snapshotRecords.filter(({ name }) => !consumed.has(name)) : snapshotRecords;
  if (recovery && recordsHash(snapshotEvidence) !== (recovery.record as ProviderHomeLeaseRecordV2).recoveredEntriesHash) throw unexpectedEntries(lockDir);
  return { entries, tip: current, snapshotHash: recordsHash([
    ...snapshotEvidence, ...canonicalRecords,
  ]), external: recovery !== undefined, transitions: seenLeaseIds.size - 1, anchor: recovery, retired, evidence };
}

function sameTip(left: ReadLeaseRecord, right: ReadLeaseRecord): boolean {
  return left.hash === right.hash && left.record.leaseId === right.record.leaseId;
}

function sameAcquiredTip(tip: ReadLeaseRecord, acquiredHash: string): boolean {
  return tip.hash === acquiredHash || tip.record.version === 4 && tip.record.checkpoint.previousTipHash === acquiredHash;
}

/**
 * Publish a complete immutable record with an exclusive hard link. The temporary file is outside
 * the lock directory, so a crash can leave harmless litter but never a transient in-lock entry.
 */
function publishRecord(root: string, target: string, record: ProviderHomeLeaseRecordV2 | (Omit<ProviderHomeLeaseRecordV2, "version"> & { version: 4; protocol: string }), boundary?: (stage: string) => void): void {
  if (dirname(target) === root && basename(target).startsWith("next-") && lstatExists(join(root, "mutable-home.lock", FORMAT_GUARD))) {
    withLeaseIoOptions({ fenceWaitMs: 10000 }, () => withVerificationBudget(() => {
      const snapshot = capture(root);
      const chain = withSnapshot(snapshot, () => readChainAt(join(root, "mutable-home.lock"), root));
      if (!isJournalTransition(record) || record.previousLeaseId !== chain.tip.record.leaseId || record.previousRecordHash !== chain.tip.hash) throw new Error("provider home lease changed during recovery; retry");
      const work = applyLeaseIoPlan(ioPlan(snapshot, chain.tip, [{ name: `next-${chain.tip.record.leaseId}.json`, raw: Buffer.from(`${JSON.stringify(record)}\n`), copiesOwner: false, retire: [] }]), 2, remainingBudget());
      spendVerificationWork(work.records, work.bytes);
    }));
    return;
  }

  if (boundedEntries(root).length > LIMITS.migrationEntries - 2) throw new Error("provider-home lease storage limit reached; preserve all evidence and quarantine only after proving the HOME unused");
  const temp = join(root, `.provider-home-lease-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
    boundary?.("guard-temp-written");
    syncFile(temp);
    boundary?.("guard-file-durable");
    linkSync(temp, target);
    boundary?.("guard-published");
    syncDirectory(root);
    if (dirname(target) === join(root, "mutable-home.lock")) syncDirectory(join(root, "mutable-home.lock"));
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch {
      // A sibling staging file is not protocol state and must not mask a successful publication.
    }
  }
}

function lstatExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function ioPlan(snapshot: LeaseIoSnapshot, tip: ReadLeaseRecord, jobs: LeaseIoJob[], barrier?: ProviderHomeLeaseOptions["nativeCheckpointBarrierForTest"]) {
  const legacy = !snapshot.entries.some(entry => entry.directory === "root" && entry.name === RECOVERY_MARKER);
  let tipIndex = legacy ? snapshot.entries.findIndex(entry => entry.directory === "lock" && !entry.optional && NEXT_MARKER.test(entry.name) && entry.raw.toString("utf8") === tip.raw) : -1;
  if (tipIndex < 0) tipIndex = snapshot.entries.findIndex((entry) => entry.directory === "root" && !entry.optional && !publicationTemporary(entry) && entry.raw.toString("utf8") === tip.raw);
  if (tipIndex < 0) tipIndex = snapshot.entries.findIndex((entry) => entry.directory === "lock" && !entry.optional && NEXT_MARKER.test(entry.name) && entry.raw.toString("utf8") === tip.raw);
  if (tipIndex < 0) throw new Error("acquired immutable tip is unavailable");
  const guard = snapshot.entries.find((entry) => entry.directory === "lock" && entry.name === FORMAT_GUARD)?.raw ?? Buffer.alloc(0);
  return { snapshot, guard, guardTemp: `.provider-home-lease-${randomUUID()}.tmp`, tipIndex,
    future: `next-${tip.record.leaseId}.json`, jobs, barrier };
}
function syncFile(path: string): void {
  const fd = openSync(path, (process.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = /^\/proc\/self\/fd\/(\d+)$/u.exec(path);
  if (descriptor) { fsyncSync(Number(descriptor[1])); return; }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * A runner holds one lease for each mutable provider home until shutdown. This is deliberately
 * coarser than session admission: Claude/Codex mix auth, config, caches and transcripts in HOME,
 * so allowing a second control plane between turns would still permit cross-owner mutation.
 */
export class ProviderHomeLeaseRegistry {
  // Only this registry knows these reservations were never granted to a caller. A matching PID
  // in another registry (or a record read from disk) is not authority to resume initialization.
  private readonly failedInitializations = new Map<string, FailedInitialization>();
  private readonly held = new Map<string, {
    leaseId: string;
    lockDir: string;
    root: string;
    acquiredHash: string;
    references: number;
  }>();
  private readonly pid: number;
  private readonly hostname: string;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly beforeMarkerWriteForTest?: () => void;
  private readonly beforeTransitionPublishForTest?: () => void;
  private readonly afterInitializationPublishForTest?: () => void;
  private readonly beforeInitializationMirrorForTest?: (mirror: string) => void;
  private readonly nativeCheckpointBarrierForTest?: ProviderHomeLeaseOptions["nativeCheckpointBarrierForTest"];
  private readonly onCheckpointFailureForTest?: ProviderHomeLeaseOptions["onCheckpointFailureForTest"];
  private readonly pendingMigrations = new Set<string>();
  private readonly pendingCompletions = new Map<string, ProviderHomeLeaseRecordV2>();
  private readonly helperDataDir?: string;
  private readonly afterTransitionPublishForTest?: () => void;
  private readonly disableCompactionForTest: boolean;
  private readonly diagnostics: string[] = [];
  private readonly onDiagnostic?: ProviderHomeLeaseOptions["onDiagnostic"];
  private readonly controlPlaneInstanceId?: string;
  private readonly processProbe?: LeaseProcessProbe;
  private readonly processEvidence?: LeaseProcessEvidence;
  private readonly bootTimeMs: () => number | null;
  private lastAcquisitionHome?: string;

  constructor(private readonly ownerHash: string, options: ProviderHomeLeaseOptions = {}) {
    if (!OWNER_HASH.test(ownerHash)) throw new Error("provider-home lease requires an attested owner hash");
    this.pid = options.pid ?? process.pid;
    this.hostname = options.hostname ?? systemHostname();
    this.isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
    this.beforeMarkerWriteForTest = options.beforeMarkerWriteForTest;
    this.beforeTransitionPublishForTest = options.beforeTransitionPublishForTest;
    this.afterInitializationPublishForTest = options.afterInitializationPublishForTest;
    this.beforeInitializationMirrorForTest = options.beforeInitializationMirrorForTest;
    this.nativeCheckpointBarrierForTest = options.nativeCheckpointBarrierForTest;
    this.onCheckpointFailureForTest = options.onCheckpointFailureForTest;
    this.disableCompactionForTest = options.disableCompactionForTest ?? false;
    this.onDiagnostic = options.onDiagnostic;
    this.helperDataDir = options.helperDataDir;
    this.afterTransitionPublishForTest = options.afterTransitionPublishForTest;
    this.controlPlaneInstanceId = options.controlPlaneInstanceId;
    this.processProbe = options.processProbe === null ? undefined : options.processProbe ?? linuxLeaseProcessProbe();
    this.processEvidence = currentLeaseProcessEvidence(this.processProbe, this.pid, options.runnerMarker, options.containment);
    if (options.containment?.kind === "linux-cgroup-v2" && !this.processEvidence) throw new Error("provider containment has no matching lease process evidence");
    this.bootTimeMs = options.bootTimeMs ?? (() => currentBootTimeMs());
  }

  getDiagnostics(): readonly string[] { return this.diagnostics; }

  acquire(request: ProviderHomeLeaseRequest, profile?: ProviderProfileAccess): void {
    const target = providerHomeLeaseTarget(request);
    if (target) this.acquireHome(target.home, target.provider, profile);
  }

  /** Acquire the whole mutable HOME for a non-launch mutation such as managed skill links.
   * `profile` omitted means an older caller: marker-less homes behave as before, and a home with a
   * provider-profile marker is refused as needing a newer control plane. */
  acquireHome(requestedHome: string, provider = "skills", profile?: ProviderProfileAccess): boolean {
    return this.acquireHomeFor(requestedHome, provider, profile);
  }

  private acquireHomeFor(requestedHome: string, provider: string, profile: ProfileContext, authorization?: LeaseRecoveryAuthorization, create = true): boolean {
    let providerHome = resolve(requestedHome);
    try { providerHome = realpathSync(requestedHome); } catch { /* A fresh HOME must not be created before probing. */ }
    return withLeaseIoOptions({ helperDataDir: this.helperDataDir, providerHome }, () => {
      ensureLeaseIoAvailable();
      return this.acquireHomeAvailable(requestedHome, provider, profile, authorization, create);
    });
  }

  /**
   * #3241 part 2: what an Owner or Admin sees before authorizing a recovery of `requestedHome`'s
   * lease. Reads the journal without creating anything, and reports for a stale record the exact
   * hash an authorization must name and whether an authorized recovery would proceed now.
   */
  inspectHome(requestedHome: string, profile?: ProviderProfileAccess): ProviderHomeLeaseInspection {
    let home: string;
    try { home = realpathSync(requestedHome); } catch { return { state: "none" }; }
    const root = join(home, ".agent-manager", "provider-home-leases-v1");
    const lockDir = join(root, "mutable-home.lock");
    if (!lstatExists(root)) return { state: "none" };
    if (this.held.has(home)) return { state: "held" };
    return withLeaseIoOptions({ helperDataDir: this.helperDataDir, providerHome: home }, () => {
      ensureLeaseIoAvailable();
      let chain: LeaseChain;
      try { chain = readChain(lockDir); } catch {
        return lstatExists(lockDir) || lstatExists(join(root, RECOVERY_MARKER)) ? { state: "unverifiable" as const } : { state: "none" as const };
      }
      const tip = chain.tip;
      if (isJournalTransition(tip.record) && tip.record.state === "released") return { state: "released" as const };
      let refused: ProviderHomeLeaseRefusalKind | null = null;
      let blockingProcess: ProviderHomeBlockingProcess | undefined;
      try {
        const profileId = this.assertProfileAccess(home, lockDir, profile);
        this.assertAbandoned(tip.record, lockDir, profileId, { staleTipHash: tip.hash, authorizationId: randomUUID() });
      } catch (error) {
        refused = providerHomeLeaseRefusalKind(error) ?? "unverifiable";
        blockingProcess = providerHomeLeaseBlockingProcess(error);
      }
      return {
        state: "stale" as const, tipHash: tip.hash, createdAt: tip.record.createdAt, sameHost: tip.record.hostname === this.hostname,
        hasEvidence: tip.record.version !== 1 && tip.record.process !== undefined, refusal: refused,
        ...(blockingProcess ? { blockingProcess } : {}),
      };
    });
  }

  /**
   * #3241 part 2: on an Owner or Admin's authorization, succeed the exact unreleased record it names
   * and release the HOME again at once, so later launches acquire it normally. The profile grant
   * check still applies to a HOME with a marker; the record must still be proved abandoned, by its
   * lifecycle evidence or, without evidence, by a boot after it was written. Refused as
   * `stale_tip_changed` when the lease is no longer that record (including when it was released).
   *
   * Only a typed refusal while this attempt holds nothing proves nothing was published. Any other
   * failure, or a failure once the successor is held (completion or the immediate release), may
   * follow publication of the authorized record, so it is `recovery_unconfirmed`, never a refusal.
   */
  recoverStaleLease(requestedHome: string, provider: string, authorization: LeaseRecoveryAuthorization, profile?: ProviderProfileAccess): void {
    const unconfirmed = (cause: unknown) => new ProviderHomeLeaseRefusal("recovery could not be confirmed",
      "the provider HOME lease recovery may have been recorded but could not be confirmed; inspect the lease again before retrying", "recovery_unconfirmed", { cause });
    let heldBefore = false;
    try { heldBefore = this.held.has(realpathSync(requestedHome)); } catch { /* an unavailable HOME is refused below */ }
    let receipt: { first: boolean; cancel: () => boolean };
    try {
      receipt = this.acquireReceiptFor(requestedHome, provider, profile, authorization);
    } catch (error) {
      // This attempt published its successor only if it now holds a HOME it did not hold before.
      const home = this.lastAcquisitionHome;
      const published = !heldBefore && home !== undefined && this.held.has(home);
      if (error instanceof ProviderHomeLeaseRefusal && !published) throw error;
      throw unconfirmed(error);
    }
    let released: boolean;
    try { released = receipt.cancel(); } catch (error) { throw unconfirmed(error); }
    if (!released) throw unconfirmed(new Error("the recovered provider HOME lease could not be released"));
  }

  /** A worker-private reference receipt. Cancellation never re-resolves a mutable HOME alias. */
  acquireHomeWithReceipt(requestedHome: string, provider = "skills", profile?: ProviderProfileAccess): { first: boolean; cancel: () => boolean } {
    return this.acquireReceiptFor(requestedHome, provider, profile);
  }

  private acquireReceiptFor(requestedHome: string, provider: string, profile: ProfileContext, authorization?: LeaseRecoveryAuthorization, create = true): { first: boolean; cancel: () => boolean } {
    const first = this.acquireHomeFor(requestedHome, provider, profile, authorization, create);
    const home = this.lastAcquisitionHome!;
    const held = this.held.get(home);
    if (!held) throw new Error("acquisition has no private reference proof");
    let cancelled = false;
    return { first, cancel: () => {
      if (cancelled || this.held.get(home) !== held) return false;
      if (held.references > 1) { held.references--; cancelled = true; return true; }
      const released = withLeaseIoOptions({ helperDataDir: this.helperDataDir, fenceWaitMs: 10000, providerHome: home }, () => this.releaseHeld(held));
      if (!released) return false;
      this.held.delete(home); this.pendingMigrations.delete(home); this.pendingCompletions.delete(home);
      cancelled = true; return true;
    } };
  }

  /** Worker-internal: replace the profile marker of a HOME whose lease this registry holds. */
  writeProfileMarkerWhileHeld(requestedHome: string, marker: ProviderProfileMarker): void {
    let home: string;
    try { home = realpathSync(requestedHome); } catch { throw new Error("provider credential home is unavailable"); }
    if (!this.held.has(home) || this.pendingCompletions.has(home)) throw new Error("provider profile marker writes require this registry's completed HOME lease");
    writeProviderProfileMarker(home, marker);
  }

  /**
   * Worker-internal (#3239): adoption and revocation. Take this HOME's lease without the grant
   * check (they are how grants change), read the marker while held, write `change`'s result when it
   * reports a change, and drop the reference taken here, which releases the lease only when this
   * was its first reference. A HOME another owner holds is refused exactly like an acquisition.
   */
  changeProfileMarkerWhileHeld<T extends { marker?: ProviderProfileMarker; changed: boolean }>(
    requestedHome: string, provider: "claude" | "codex", change: (read: ProviderProfileRead) => T,
  ): T {
    const receipt = this.acquireReceiptFor(requestedHome, provider, PROFILE_CHANGE);
    const home = this.lastAcquisitionHome!;
    let result: T;
    try {
      result = change(readProviderProfileMarker(home, { provider }));
      if (result.changed && result.marker) this.writeProfileMarkerWhileHeld(home, result.marker);
    } catch (error) {
      if (!receipt.cancel()) throw new Error("provider profile change could not drop its HOME reference", { cause: error });
      throw error;
    }
    if (!receipt.cancel()) throw new Error("provider profile change could not drop its HOME reference");
    return result;
  }

  /**
   * Worker-internal (#3239): retire a removed account's profile grants while holding
   * its lease. Like a marker change it skips the grant check (this control plane's grant may already
   * be revoked), drops every grant of `controlPlaneInstanceId` from the marker, and then drops the
   * reference taken here. True only when that released the lease (no other reference was held here)
   * and the marker grants no other control plane; an unverifiable marker is kept. This boolean
   * proves no authority to delete after release: a successor may already own the HOME (#3157). With
   * `expectedProfileId` a marker that does not hold exactly that identity is kept and left unchanged.
   */
  retireProfileHomeWhileHeld(requestedHome: string, provider: "claude" | "codex", controlPlaneInstanceId: string, expectedProfileId?: string): boolean {
    const receipt = this.acquireReceiptFor(requestedHome, provider, PROFILE_CHANGE);
    const home = this.lastAcquisitionHome!;
    let shared: boolean;
    try {
      const result = retireProviderProfileMarker(readProviderProfileMarker(home, { provider }),
        { controlPlaneInstanceId, ...(expectedProfileId !== undefined ? { expectedProfileId } : {}) });
      if (result.changed && result.marker) this.writeProfileMarkerWhileHeld(home, result.marker);
      shared = result.shared;
    } catch (error) {
      if (!receipt.cancel()) throw new Error("provider HOME retirement could not drop its HOME reference", { cause: error });
      throw error;
    }
    if (!receipt.cancel()) throw new Error("provider HOME retirement could not drop its HOME reference");
    return !shared && !this.held.has(home);
  }

  /**
   * Worker-internal (#3719): copy the Codex API-key sign-in of `sourceHome` into a new managed
   * profile HOME `<destinationRoot>/<profileId>`, in this one operation. The source must already
   * exist as a real directory (it is never created), hold no other provider's marker, and be
   * neither held nor being acquired by this registry, so a running session, sign-in or Agent TUI of
   * this runner refuses the import instead of lending its reference. Its lease is then taken
   * exclusively with the source's own profile context, so another owner's lease and a profile not
   * granted here refuse exactly as an acquisition would. The credential is read and validated while
   * that lease is held; only after the source is admitted is the destination created, given its
   * first marker and a fresh API-key-only record. The source stays held until the destination is
   * published and is checked unchanged before and after. Refusals before the destination is created
   * leave both HOMEs unchanged apart from the source's lease-journal bookkeeping.
   */
  importCodexCredentialWhileHeld(input: {
    sourceHome: string; layout: CodexCredentialLayout; sourceProfile?: ProviderProfileAccess;
    destinationRoot: string; profileId: string; grant: ProviderProfileGrant;
  }): void {
    const { sourceHome } = input;
    if (!isAbsolute(sourceHome)) throw new ProviderCredentialImportRefusal("import_source_unsafe");
    let root: Stats;
    try { root = lstatSync(sourceHome); } catch (error) {
      throw new ProviderCredentialImportRefusal((error as NodeJS.ErrnoException).code === "ENOENT" ? "import_source_missing" : "import_source_unsafe");
    }
    if (root.isSymbolicLink() || !root.isDirectory()) throw new ProviderCredentialImportRefusal("import_source_unsafe");
    let home: string;
    try { home = realpathSync(sourceHome); } catch { throw new ProviderCredentialImportRefusal("import_source_missing"); }
    const busyHere = (path: string) => this.held.has(path) || this.failedInitializations.has(path) ||
      this.pendingCompletions.has(path) || this.pendingMigrations.has(path);
    if (busyHere(home)) throw new ProviderCredentialImportRefusal("import_source_held");
    const marker = readProviderProfileMarker(home);
    if (marker.state === "present" && marker.marker.provider !== "codex") throw new ProviderCredentialImportRefusal("import_source_foreign");
    const unchangedRoot = () => {
      let now: Stats;
      try { now = lstatSync(sourceHome); } catch { throw new ProviderCredentialImportRefusal("import_source_changed"); }
      if (now.isSymbolicLink() || now.dev !== root.dev || now.ino !== root.ino) throw new ProviderCredentialImportRefusal("import_source_changed");
    };
    const source = this.acquireReceiptFor(sourceHome, "codex", input.sourceProfile, undefined, false);
    const acquired = this.lastAcquisitionHome;
    const dropSource = (cause?: unknown) => {
      if (!source.cancel()) throw new Error("provider credential import could not drop its source reference", { cause });
    };
    try {
      if (!source.first || acquired !== home) throw new ProviderCredentialImportRefusal(source.first ? "import_source_changed" : "import_source_held");
      unchangedRoot();
      const credential = readCodexCredentialSource(input.layout === "codex_home" ? home : join(home, ".codex"));
      const destination = createManagedProviderProfileHome(input.destinationRoot, input.profileId);
      const target = this.acquireReceiptFor(destination, "codex", PROFILE_CHANGE);
      const destinationHome = this.lastAcquisitionHome!;
      try {
        if (!target.first) throw new Error("a new managed profile HOME was already held");
        const created = createProviderProfileMarker(readProviderProfileMarker(destinationHome, { provider: "codex" }),
          { provider: "codex", profileId: input.profileId, grant: input.grant });
        this.writeProfileMarkerWhileHeld(destinationHome, created.marker);
        unchangedRoot();
        credential.verifyUnchanged();
        publishCodexCredential(destinationHome, codexApiKeyRecord(credential.apiKey));
        // The source stays held through publication; a change seen now leaves the copy unrecorded.
        credential.verifyUnchanged();
      } catch (error) {
        if (!target.cancel()) throw new Error("provider credential import could not drop its new profile's reference", { cause: error });
        throw error;
      }
      if (!target.cancel()) throw new Error("provider credential import could not drop its new profile's reference");
    } catch (error) {
      dropSource(error);
      throw error;
    }
    dropSource();
  }

  /** Profile grants are checked against the canonical HOME before any lease journal I/O, and again
   * on every re-entrant reference, so a revoked grant stops new references to a held HOME. Returns
   * the profile whose marker grants this control plane, which is what authorizes recovering another
   * owner's abandoned lease (#3241); marker changes and marker-less HOMEs authorize none. */
  private assertProfileAccess(home: string, lockDir: string, profile: ProfileContext): string | undefined {
    const read = readProviderProfileMarker(home);
    // An unsafe `.agent-manager` was refused by the ancestry check before profiles existed; keep
    // that exact refusal so marker-less homes behave as before.
    if (read.state === "unverifiable" && read.cause === "ancestry") throw refusal(lockDir, "has unsafe metadata directory ancestry");
    if (profile === PROFILE_CHANGE) return undefined;
    const decision = decideProviderProfileAccess(read, profile, this.controlPlaneInstanceId);
    if (!decision.allowed) throw new ProviderHomeLeaseRefusal(decision.reason, LEASE_WORKER_ERRORS[decision.reason], decision.reason);
    return decision.profileId;
  }

  private acquireHomeAvailable(requestedHome: string, provider: string, profile: ProfileContext, authorization?: LeaseRecoveryAuthorization, create = true): boolean {
    if (!PROVIDER_KEY.test(provider)) throw new Error("provider home lease key is invalid");
    if (!isAbsolute(requestedHome)) throw new Error("provider HOME must be absolute");
    let home: string;
    try {
      // A newly configured account is expected to be Login Required before the provider creates
      // its files. Establish the private root before canonicalizing it so the ownership boundary,
      // rather than a raw ENOENT containing the runner-local path, is the first launch result.
      // A recovery only ever succeeds a lease that already exists, so it creates nothing, and an
      // import's source must already exist (#3719).
      if (!authorization && create) mkdirSync(requestedHome, { recursive: true, mode: 0o700 });
      home = realpathSync(requestedHome);
    } catch {
      throw new Error("provider credential home is unavailable");
    }
    this.lastAcquisitionHome = home;
    const root = join(home, ".agent-manager", "provider-home-leases-v1");
    // ACP adapters are not provider-specific and known CLIs co-locate auth/config/cache below
    // HOME. Lease the whole effective home rather than pretending those mutations are disjoint.
    const lockDir = join(root, "mutable-home.lock");
    const key = home;
    const recoveryProfileId = this.assertProfileAccess(home, lockDir, profile);
    const borrowed = this.held.get(key);
    // A lease this runner holds or is still initializing is no stale record of anyone's, and an
    // authorized recovery succeeds an existing journal's exact tip: it never creates or initializes one.
    if (authorization && (borrowed || this.failedInitializations.has(key) || !lstatExists(lockDir))) throw staleTipChanged(lockDir);
    if (borrowed) {
      const pending = this.pendingCompletions.get(key);
      if (pending) return withLeaseIoOptions({ fenceWaitMs: 10000 }, () => this.finishAcquisition(key, root, lockDir, pending));
      if (this.pendingMigrations.has(key)) {
        if (!this.compactHeld(borrowed.root, borrowed.lockDir, borrowed.leaseId)) throw refusal(borrowed.lockDir, "requires successful bounded catch-up before this HOME can be granted");
        this.pendingMigrations.delete(key);
        return true;
      }
      if (!sameAcquiredTip(readChain(borrowed.lockDir).tip, borrowed.acquiredHash)) throw unexpectedEntries(borrowed.lockDir);
      borrowed.references++;
      return false;
    }
    for (const directory of [join(home, ".agent-manager"), root]) {
      try { mkdirSync(directory, { mode: 0o700 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw refusal(lockDir, "has unsafe metadata directory ancestry");
    }
    if (boundedEntries(root).length > LIMITS.migrationEntries - 4) throw refusal(lockDir, "has reached the storage cap; reserve space for release and preserve all evidence");
    const failed = this.failedInitializations.get(key);
    if (failed) {
      try {
        const chain = this.verifyInitialization(lockDir, failed);
        if (chain.snapshotHash !== failed.snapshotHash) throw unexpectedEntries(lockDir);
        this.beforeTransitionPublishForTest?.();
        if (this.verifyInitialization(lockDir, failed).snapshotHash !== failed.snapshotHash) throw unexpectedEntries(lockDir);
      } catch (error) {
        throw verificationRefusal(lockDir, error, true);
      }
      this.finishInitialization(key, root, lockDir, failed);
      this.held.set(key, { leaseId: failed.proof.record.leaseId, acquiredHash: failed.proof.hash, lockDir, root, references: 1 });
      this.failedInitializations.delete(key);
      return true;
    }
    const record = this.activeRecord(provider, null, null);
    let exists = true;
    try { lstatSync(lockDir); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      exists = false;
    }
    if (authorization && !exists) throw staleTipChanged(lockDir);
    if (!exists) {
      // Publish the exclusive ownership proof BEFORE creating the directory. A crash at either
      // subsequent instruction leaves a same-host/owner/dead-PID proof, never an unowned empty lock.
      record.recoveredEntriesHash = recordsHash([]);
      let initialized = false;
      try {
        this.beforeMarkerWriteForTest?.();
        publishRecord(root, join(root, RECOVERY_MARKER), record);
        initialized = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (initialized) {
        const reservation: FailedInitialization = {
          proof: { record, hash: createHash("sha256").update(`${JSON.stringify(record)}\n`).digest("hex"), raw: `${JSON.stringify(record)}\n` },
          snapshotHash: "",
        };
        this.finishInitialization(key, root, lockDir, reservation, true);
      } else {
        // The winning initializer may have died before mkdir. Only its verified proof may
        // authorize recreating that directory; never mkdir on a foreign or live reservation.
        let initialization: LeaseChain;
        try { initialization = readChain(lockDir); } catch (error) { throw verificationRefusal(lockDir, error); }
        if (!isJournalTransition(initialization.tip.record) || initialization.tip.record.state !== "released") {
          this.assertAbandoned(initialization.tip.record, lockDir, recoveryProfileId);
        }
        try { mkdirSync(lockDir, { mode: 0o700 }); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        delete record.recoveredEntriesHash;
        this.transitionExistingLease(key, root, lockDir, record, recoveryProfileId);
      }
    } else {
      this.transitionExistingLease(key, root, lockDir, record, recoveryProfileId, authorization);
    }
    this.rememberAcquisition(key, root, lockDir, record);
    return withLeaseIoOptions({ fenceWaitMs: 10000 }, () => this.finishAcquisition(key, root, lockDir, record));
  }

  private rememberAcquisition(key: string, root: string, lockDir: string, record: ProviderHomeLeaseRecordV2): void {
    this.held.set(key, { leaseId: record.leaseId, acquiredHash: createHash("sha256").update(`${JSON.stringify(record)}\n`).digest("hex"), lockDir, root, references: 1 });
    this.pendingCompletions.set(key, record);
  }

  private finishAcquisition(key: string, root: string, lockDir: string, record: ProviderHomeLeaseRecordV2): boolean {
    const held = this.held.get(key);
    if (!held || !sameAcquiredTip(readChain(lockDir).tip, held.acquiredHash)) throw unexpectedEntries(lockDir);
    if (record.previousLeaseId) this.mirrorRecord(root, lockDir, `next-${record.previousLeaseId}.json`);
    // This fixed incompatible marker prevents a rollback binary from ignoring the external
    // journal even when crash recovery recreated an empty directory.
    if (isJournalTransition(readChain(lockDir).anchor?.record)) {
      this.mirrorRecord(root, lockDir, RECOVERY_MARKER, "checkpoint.json", true);
      readChain(lockDir);
    }
    const migrationRequired = this.pendingMigrations.has(key) || (() => {
      const chain = readChain(lockDir);
      return !chain.external || chain.transitions >= LIMITS.hardTransitions - 1;
    })();
    if (migrationRequired) this.pendingMigrations.add(key);
    const compacted = this.compactHeld(root, lockDir, record.leaseId);
    if (migrationRequired && !compacted) throw refusal(lockDir, "requires successful bounded catch-up before this HOME can be granted; preserve the acquired reservation and retry with this registry");
    this.pendingMigrations.delete(key);
    try {
      const confirmed = readChain(lockDir).tip;
      if (confirmed.record.version === 1 || confirmed.record.state !== "active" || confirmed.record.leaseId !== record.leaseId ||
          !sameAcquiredTip(confirmed, held.acquiredHash)) throw unexpectedEntries(lockDir);
    } catch (error) {
      throw verificationRefusal(lockDir, error);
    }
    this.pendingCompletions.delete(key);
    return true;
  }

  private verifyInitialization(lockDir: string, reservation: FailedInitialization): LeaseChain {
    let directory: ReturnType<typeof lstatSync> | undefined;
    try { directory = lstatSync(lockDir); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (reservation.directory
      ? !directory?.isDirectory() || directory.isSymbolicLink() ||
        directory.dev !== reservation.directory.dev || directory.ino !== reservation.directory.ino
      : directory !== undefined) throw unexpectedEntries(lockDir);
    const chain = readChain(lockDir);
    if (!chain.external || !sameTip(chain.tip, reservation.proof)) throw unexpectedEntries(lockDir);
    return chain;
  }

  private finishInitialization(
    home: string, root: string, lockDir: string, reservation: FailedInitialization, first = false,
  ): void {
    try {
      if (first) this.afterInitializationPublishForTest?.();
      this.verifyInitialization(lockDir, reservation);
      if (!reservation.directory) {
        // A competing rollback mkdir is never attributed to our reservation, even if empty.
        mkdirSync(lockDir, { mode: 0o700 });
        const stat = lstatSync(lockDir);
        reservation.directory = { dev: stat.dev, ino: stat.ino };
      }
      for (const mirror of ["checkpoint.json", `lease-${reservation.proof.record.leaseId}.json`]) {
        this.beforeInitializationMirrorForTest?.(mirror);
        this.verifyInitialization(lockDir, reservation);
        this.mirrorRecord(root, lockDir, RECOVERY_MARKER, mirror, true);
      }
      this.verifyInitialization(lockDir, reservation);
    } catch (error) {
      // Retain retry authority only for our unchanged proof and our own directory. Corruption,
      // successors, and rollback collisions keep their evidence but never acquire this token.
      this.failedInitializations.delete(home);
      try {
        reservation.snapshotHash = this.verifyInitialization(lockDir, reservation).snapshotHash;
        this.failedInitializations.set(home, reservation);
      } catch { /* Uncertain ownership requires the complete operator remedy. */ }
      throw verificationRefusal(lockDir, error, true);
    }
  }

  private activeRecord(
    provider: string,
    previousLeaseId: string | null,
    previousRecordHash: string | null,
  ): ProviderHomeLeaseRecordV2 {
    return {
      version: this.processEvidence?.version === 2 ? 5 : 2,
      state: "active",
      ownerHash: this.ownerHash,
      leaseId: randomUUID(),
      previousLeaseId,
      previousRecordHash,
      pid: this.pid,
      hostname: this.hostname,
      provider,
      createdAt: new Date().toISOString(),
      ...(this.processEvidence ? { process: { ...this.processEvidence } } : {}),
    };
  }

  private transitionExistingLease(
    key: string, root: string, lockDir: string, replacement: ProviderHomeLeaseRecordV2, recoveryProfileId?: string,
    authorization?: LeaseRecoveryAuthorization,
  ): void {
    let chain: LeaseChain;
    try {
      chain = readChain(lockDir);
    } catch (error) {
      // A first migration can hold the permanent fence before selecting its
      // initial anchor. Temporary I/O refusals are not malformed legacy state
      // and must never enter partial-journal recovery.
      if (error instanceof LeaseIoError && (error.kind === "busy" || error.kind === "unavailable")) throw error;
      // A published recovery checkpoint is authoritative. Corruption in it or its retained
      // evidence must never trigger another recovery that could erase an ownership boundary.
      try { lstatSync(join(root, RECOVERY_MARKER)); } catch (markerError) {
        if ((markerError as NodeJS.ErrnoException).code === "ENOENT") {
          // A partial in-lock journal has no single tip an authorization could have named.
          if (authorization) throw staleTipChanged(lockDir);
          this.recoverPartialJournal(key, root, lockDir, replacement);
          return;
        }
      }
      throw verificationRefusal(lockDir, error);
    }
    const existing = chain.tip;
    if (chain.anchor?.record.version === 4 && chain.transitions >= LIMITS.hardTransitions - 1) {
      throw refusal(lockDir, `has reached the ${LIMITS.hardTransitions}-transition growth cap; compaction is unavailable; preserve the last valid chain`);
    }
    delete replacement.recovery;
    const released = isJournalTransition(existing.record) && existing.record.state === "released";
    // The authorization names one unreleased record; any other tip, released or not, is not it.
    if (authorization && (released || existing.hash !== authorization.staleTipHash)) throw staleTipChanged(lockDir);
    if (released) {
      // An orderly release is an explicit handoff and may pass the HOME to a different owner.
    } else {
      const recovery = this.assertAbandoned(existing.record, lockDir, recoveryProfileId, authorization);
      if (recovery) replacement.recovery = recovery;
    }

    this.beforeTransitionPublishForTest?.();
    const confirmedChain = readChain(lockDir);
    const confirmed = confirmedChain.tip;
    if (!sameTip(existing, confirmed) || chain.snapshotHash !== confirmedChain.snapshotHash) {
      throw new Error("provider home lease changed during recovery; retry");
    }
    replacement.previousLeaseId = confirmed.record.leaseId;
    replacement.previousRecordHash = confirmed.hash;
    const name = `next-${confirmed.record.leaseId}.json`;
    const target = join(chain.external ? root : lockDir, name);
    try {
      publishRecord(root, target, replacement);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("provider home lease changed during recovery; retry");
      }
      throw error;
    }
    this.rememberAcquisition(key, root, lockDir, replacement);
    const recoveryProof = replacement.recovery?.proof === "authorized" ? replacement.recovery.basis : replacement.recovery?.proof;
    if (recoveryProof === "linux_cgroup_unit_removed") {
      try { this.onDiagnostic?.({ event: "provider_home_boundary_recovered", leaseId: replacement.leaseId,
        message: "Provider HOME recovered after its recorded cgroup and enclosing delegated unit retired on the same boot. Kernel cgroup v2 removal requires emptiness and forbids rename. Lifecycle proof does not cover deliberate same-user cgroup migration by provider code." }); }
      catch { /* diagnostics cannot change published ownership */ }
    }
    this.afterTransitionPublishForTest?.();
  }

  /**
   * Refuse unless `record`'s lease is provably abandoned and this owner may succeed it. A record
   * without lifecycle evidence (older runners, other platforms) is reclaimed only by its own owner
   * once its PID is gone, as before. A record with evidence needs proof that nothing it launched
   * survives (#3241), whoever succeeds it; another owner additionally needs `recoveryProfileId`,
   * the profile whose marker grants this control plane. Returns the note a recovery publishes.
   *
   * With an Owner/Admin `authorization` for this exact record (#3241 part 2), any owner's record may
   * be succeeded without a profile grant, but never on weaker proof: a record with evidence still
   * needs that proof, and one without evidence needs a boot at least a minute after it was written
   * (its PID alone is never consulted, since a later boot may reuse it).
   */
  private assertAbandoned(
    record: ProviderHomeLeaseRecord, lockDir: string, recoveryProfileId?: string, authorization?: LeaseRecoveryAuthorization,
  ): LeaseRecoveryNote | undefined {
    if (record.hostname !== this.hostname) throw refusal(lockDir, `is leased by host ${record.hostname}; use an isolated OS account`, false, "foreign_host");
    const evidence = record.version === 1 ? undefined : record.process;
    if (authorization) {
      const authorized = { proof: "authorized" as const, authorizationId: authorization.authorizationId, ...(recoveryProfileId ? { profileId: recoveryProfileId } : {}) };
      if (evidence) return { ...authorized, basis: this.proveEvidence(evidence, record.pid, lockDir) };
      const booted = this.bootTimeMs();
      const written = Date.parse(record.createdAt);
      if (booted === null || !Number.isFinite(written) || booted - written < BOOT_PROOF_MARGIN_MS) {
        throw refusal(lockDir, "has a stale lease written during the current boot; it can be recovered only after the host restarts", false, "no_reboot_proof");
      }
      return { ...authorized, basis: "booted_after" };
    }
    if (!evidence) {
      if (this.isProcessAlive(record.pid)) throw refusal(lockDir, `is already in use by process ${record.pid}; use bwrap or an isolated OS account`, false, "busy");
      if (record.ownerHash !== this.ownerHash) throw refusal(lockDir, "has a stale lease from another attested owner", false, "foreign_owner");
      return undefined;
    }
    const proof = this.proveEvidence(evidence, record.pid, lockDir);
    if (record.ownerHash === this.ownerHash) return { proof };
    if (!recoveryProfileId) throw refusal(lockDir, "has a stale lease from another attested owner", false, "foreign_owner");
    return { proof, profileId: recoveryProfileId };
  }

  private proveEvidence(evidence: LeaseProcessEvidence, pid: number, lockDir: string): LeaseAbandonmentProof {
    const result = proveLeaseAbandoned(evidence, pid, this.processProbe);
    if (result.proven) return result.proof;
    if (result.reason === "runner_alive") {
      let cgroupMembership: ProviderHomeBlockingProcess["cgroupMembership"] = "unavailable";
      if (evidence.containment?.kind === "linux-cgroup-v2") {
        try { cgroupMembership = this.processProbe?.membership?.(pid, evidence.startTime, evidence.containment) ?? "unavailable"; }
        catch { /* Best-effort diagnostics do not change the live-holder refusal. */ }
      }
      throw refusal(lockDir, `is already in use by process ${pid}; use bwrap or an isolated OS account`, false, "holder_alive", { pid, startTime: evidence.startTime, kind: "recorded_runner", cgroupMembership });
    }
    if (result.reason === "marked_process") throw refusal(lockDir, "is still used by a process the leasing runner launched; stop that process and retry", false, "process_survivor", result.blockingProcess);
    if (result.reason === "boundary_populated") throw refusal(lockDir, "still has a surviving provider or helper in its recorded boundary; stop that work and retry", false, "boundary_survivor", result.blockingProcess);
    if (result.reason === "boundary_unverifiable") throw refusal(lockDir, leaseContainmentGuidance(evidence.containment), false, "boundary_unverifiable");
    throw refusal(lockDir, `has a stale lease whose processes cannot all be inspected. ${leaseContainmentGuidance(evidence.containment)}`, false,
      evidence.containment?.kind === "marker-parent-links" && evidence.containment.reason === "cgroup-not-delegated" ? "process_uninspectable_not_delegated" : "process_uninspectable", result.blockingProcess);
  }

  private recoverPartialJournal(key: string, root: string, lockDir: string, replacement: ProviderHomeLeaseRecordV2): void {
    const snapshot = () => {
      const stat = lstatSync(lockDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw unexpectedEntries(lockDir);
      const entries = boundedEntries(lockDir);
      if (!entries.length) throw refusal(lockDir, "is incomplete and has no ownership proof");
      const byId = new Map<string, ReadLeaseRecord>();
      const records = entries.map((name) => {
        const value = readRecord(join(lockDir, name));
        const record = value.record;
        const genesis = GENESIS_MARKER.exec(name);
        const next = NEXT_MARKER.exec(name);
        const valid = name === LEGACY_MARKER ? record.version === 1 :
          genesis ? isJournalTransition(record) && record.state === "active" && genesis[1] === record.leaseId &&
            record.previousLeaseId === null && record.previousRecordHash === null :
          next ? isJournalTransition(record) && next[1] === record.previousLeaseId &&
            typeof record.previousRecordHash === "string" : false;
        if (!valid || byId.has(record.leaseId) || (isJournalTransition(record) && record.recoveredEntriesHash !== undefined)) throw unexpectedEntries(lockDir);
        this.assertAbandoned(record, lockDir);
        byId.set(record.leaseId, value);
        return { name, ...value };
      });
      for (const value of records) {
        const record = value.record;
        if (!isJournalTransition(record) || record.previousLeaseId === null) continue;
        const previous = byId.get(record.previousLeaseId);
        if (previous) validateTransition(previous, value, lockDir);
        const seen = new Set([record.leaseId]);
        let ancestor = previous;
        while (ancestor) {
          if (seen.has(ancestor.record.leaseId)) throw unexpectedEntries(lockDir);
          seen.add(ancestor.record.leaseId);
          ancestor = isJournalTransition(ancestor.record) && ancestor.record.previousLeaseId
            ? byId.get(ancestor.record.previousLeaseId) : undefined;
        }
      }
      return recordsHash(records);
    };
    let hash: string;
    try { hash = snapshot(); } catch (error) {
      throw verificationRefusal(lockDir, error);
    }
    this.beforeTransitionPublishForTest?.();
    try {
      if (snapshot() !== hash) throw new Error("changed snapshot");
    } catch {
      throw new Error("provider home lease changed during recovery; retry");
    }
    replacement.recoveredEntriesHash = hash;
    try { publishRecord(root, join(root, RECOVERY_MARKER), replacement); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("provider home lease changed during recovery; retry");
      throw error;
    }
    this.rememberAcquisition(key, root, lockDir, replacement);
    this.afterTransitionPublishForTest?.();
  }

  private mirrorRecord(root: string, lockDir: string, name: string, mirror = name, required = false): void {
    if (lstatExists(join(lockDir, FORMAT_GUARD))) {
      try {
        withVerificationBudget(() => {
          const snapshot = capture(root);
          const source = withSnapshot(snapshot, () => readRecord(join(root, name)));
          const plan = ioPlan(snapshot, source, [{ name: mirror, raw: Buffer.alloc(0), copiesOwner: false, retire: [] }]);
          const work = applyLeaseIoPlan(plan, 3, remainingBudget()); spendVerificationWork(work.records, work.bytes);
        });
      } catch (error) { if (required) throw error; }
      return;
    }

    try { linkSync(join(root, name), join(lockDir, mirror)); } catch (error) {
      if (required && ((error as NodeJS.ErrnoException).code !== "EEXIST" ||
          readRecord(join(root, name)).hash !== readRecord(join(lockDir, mirror)).hash)) throw error;
      // The immutable external journal is authoritative. A missing mirror is recoverable;
      // conflicting or changed mirror bytes are detected by readChain and remain fail-closed.
    }
  }

  private compactHeld(root: string, lockDir: string, leaseId: string): boolean {
    try {
      if (this.disableCompactionForTest) throw new Error("checkpoint disabled for unavailable-storage validation");
      return withVerificationBudget(() => {
        let snapshot = capture(root);
        const token = [...this.held.values()].find((held) => held.root === root && held.leaseId === leaseId);
        if (!token) throw new Error("checkpoint has no private acquisition proof");
        const owned = (): LeaseChain => withSnapshot(snapshot, () => {
          const chain = readChainAt(lockDir, root);
          if (chain.tip.record.version === 1 || chain.tip.record.state !== "active" || chain.tip.record.leaseId !== leaseId ||
              chain.tip.record.ownerHash !== this.ownerHash || chain.tip.record.hostname !== this.hostname || chain.tip.record.pid !== this.pid ||
              !sameAcquiredTip(chain.tip, token.acquiredHash)) throw new Error("checkpoint acquired owner changed");
          return chain;
        });
        const apply = (chain: LeaseChain, jobs: LeaseIoJob[], guard?: Buffer) => {
          const plan = ioPlan(snapshot, chain.tip, jobs, this.nativeCheckpointBarrierForTest);
          if (guard) plan.guard = guard;
          const work = applyLeaseIoPlan(plan, 1, remainingBudget()); spendVerificationWork(work.records, work.bytes);
          snapshot = capture(root);
        };
        const indexes = (retired: LeaseRetirementEntry[]): number[] => {
          const index = new Map(snapshot.entries.map((entry, i) => [`${entry.directory}/${entry.name}`, i]));
          const result = retired.flatMap((entry) => { const i = index.get(`${entry.directory}/${entry.name}`); return i === undefined ? [] : [i]; });
          // Windows retains the last moved inode at this fixed witness. Its
          // original name may already be absent; carry the selected tuple's
          // physical witness into the native cleanup manifest as well.
          const aliasIndex = index.get(`root/${RETIREMENT_ALIAS}`);
          if (aliasIndex !== undefined && !result.includes(aliasIndex)) {
            const alias = snapshot.entries[aliasIndex]!;
            const hash = withSnapshot(snapshot, () => readRecord(join(root, RETIREMENT_ALIAS))).hash;
            if (retired.some(entry => entry.device === alias.device && entry.inode === alias.inode && entry.hash === hash)) result.push(aliasIndex);
          }
          return result;
        };
        let chain = owned();
        // A new journal has no historical successor to checkpoint yet. Its first
        // release remains bounded; the following acquisition migrates the chain.
        if (!chain.external && chain.transitions === 0) return true;
        if (chain.retired.some((entry) => snapshot.entries.some((file) => file.directory === entry.directory && file.name === entry.name))) {
          apply(chain, [{ name: "", raw: Buffer.alloc(0), copiesOwner: false, retire: indexes(chain.retired) }]);
          chain = owned();
        }
        let adopted = false;
        // A completed candidate commits to its prior verified anchor and historical tip. Prove
        // that selecting it leaves this newly acquired Q as the exact active successor first.
        const candidates = snapshot.entries.filter((entry) => entry.directory === "root" && CHECKPOINT_SLOTS.includes(entry.name));
        const bootstrapCandidates = new Set<string>();
        if (!chain.anchor && candidates.length) {
          const genesis = snapshot.entries.find(item => item.directory === "lock" && (GENESIS_MARKER.test(item.name) || item.name === LEGACY_MARKER));
          const guard = snapshot.entries.find(item => item.directory === "lock" && item.name === FORMAT_GUARD);
          for (const candidate of candidates) {
            const pending = withSnapshot(snapshot, () => readRecord(join(root, candidate.name)));
            const retired = verifyCheckpoint(pending, lockDir);
            if (pending.record.version !== 4 || !genesis || !guard ||
                pending.record.checkpoint.previousAnchorHash !== hashText(genesis.raw.toString("utf8")) ||
                pending.record.checkpoint.previousHistoryHash !== pending.record.checkpoint.previousAnchorHash ||
                pending.record.ownerHash !== this.ownerHash || pending.record.hostname !== this.hostname ||
                pending.record.checkpoint.guardHash !== hashText(guard.raw.toString("utf8")) ||
                pending.record.checkpoint.guardDevice !== guard.device || pending.record.checkpoint.guardInode !== guard.inode ||
                !chain.evidence.some(item => item.directory === "lock" && item.hash === (pending.record as ProviderHomeLeaseRecordV4).checkpoint.previousTipHash)) throw new Error("unproven first checkpoint candidate");
            withSnapshot(snapshot, () => verifyRetired(root, lockDir, retired));
            bootstrapCandidates.add(candidate.name);
          }
        }
        for (const entry of candidates.slice().reverse()) {
          if (chain.retired.some((item) => item.directory === "root" && item.name === entry.name)) continue;
          const pending = withSnapshot(snapshot, () => readRecord(join(root, entry.name)));
          const retired = verifyCheckpoint(pending, lockDir);
          if (!chain.anchor) {
            // Preserve the complete in-lock chain until an anchor is selected.
            // Exact aliases of the verified successors make the candidate's
            // hypothetical canonical chain retain this private acquired tip.
            if (pending.record.version !== 4 || !bootstrapCandidates.has(entry.name)) throw new Error("unproven first checkpoint candidate");
            let cursor = JSON.parse(pending.record.checkpoint.previousTip) as ProviderHomeLeaseRecord;
            for (let steps = 0; cursor.leaseId !== chain.tip.record.leaseId; steps++) {
              if (steps >= LIMITS.migrationEntries) throw new Error("legacy successor migration limit exceeded");
              const name = `next-${cursor.leaseId}.json`;
              const source = withSnapshot(snapshot, () => readRecord(join(lockDir, name)));
              const alias = snapshot.entries.find(item => item.directory === "root" && item.name === name);
              const original = snapshot.entries.find(item => item.directory === "lock" && item.name === name)!;
              if (alias) {
                if (alias.device !== original.device || alias.inode !== original.inode || !alias.raw.equals(original.raw)) throw new Error("legacy successor alias changed");
                cursor = source.record; continue;
              }
              const plan = ioPlan(snapshot, source, [{ name, raw: Buffer.alloc(0), copiesOwner: false, retire: [] }]);
              const work = applyLeaseIoPlan(plan, 3, remainingBudget()); spendVerificationWork(work.records, work.bytes);
              snapshot = capture(root); chain = owned();
              cursor = source.record;
            }
          }
          if (pending.record.version !== 4 || (chain.anchor && pending.record.checkpoint.previousAnchorHash !== chain.anchor.hash) ||
              pending.record.ownerHash !== this.ownerHash || pending.record.hostname !== this.hostname ||
              !chain.evidence.some((item) => item.directory === (chain.anchor ? "root" : "lock") && item.hash === (pending.record as ProviderHomeLeaseRecordV4).checkpoint.previousTipHash)) throw new Error("unproven completed checkpoint candidate");
          withSnapshot(snapshot, () => verifyRetired(root, lockDir, retired));
          const selectedCandidate = snapshot.entries.find(item => item.directory === "root" && item.name === entry.name)!;
          if (!selectedCandidate.raw.equals(entry.raw)) throw new Error("completed candidate changed during successor migration");
          const oldAnchor = snapshot.entries.find((item) => item.directory === "root" && item.name === RECOVERY_MARKER);
          const hypothetical = { ...snapshot, entries: snapshot.entries.filter((file) => file.name !== RECOVERY_MARKER || file.directory !== "root")
            .filter((file) => file !== selectedCandidate)
            // Selection removes the old anchor's canonical hard link; its two remaining
            // verified mirrors must reflect that physical post-selection count.
            .map((file) => oldAnchor && file.device === oldAnchor.device && file.inode === oldAnchor.inode ? { ...file, links: file.links - 1 } : file)
            .concat({ ...selectedCandidate, name: RECOVERY_MARKER }) };
          const after = withSnapshot(hypothetical, () => readChainAt(lockDir, root));
          if (!sameTip(chain.tip, after.tip)) throw new Error("completed candidate does not preserve the acquired successor");
          apply(chain, [{ name: entry.name, raw: entry.raw, copiesOwner: false, retire: indexes(retired) }]);
          chain = owned(); adopted = true; break;
        }
        if (chain.external && chain.transitions < LIMITS.compactAfter && !adopted) return true;
        if (!isJournalTransition(chain.tip.record)) throw new Error("unsupported checkpoint tip");
        // In-lock journals predate the canonical anchor. They have already passed complete
        // chain validation and abandonment admission, and this registry owns the exact new
        // active successor. Keep their genesis as the history root of the first checkpoint.
        const legacy = !chain.anchor;
        const historyRoot = chain.anchor ?? withSnapshot(snapshot, () => {
          const genesis = snapshot.entries.find(entry => entry.directory === "lock" &&
            (GENESIS_MARKER.test(entry.name) || entry.name === LEGACY_MARKER));
          if (!genesis) throw new Error("legacy journal genesis is unavailable");
          return readRecord(join(lockDir, genesis.name));
        });
        if (!snapshot.entries.some((entry) => entry.directory === "lock" && entry.name === FORMAT_GUARD)) {
          const guard = Buffer.from(`${JSON.stringify({ ...chain.tip.record, version: 4, protocol: "bounded-canonical-checkpoint", fenceBackend: process.platform === "win32" ? "lockfileex" : "flock", previousLeaseId: null, previousRecordHash: null })}\n`);
          apply(chain, [], guard); chain = owned();
        }
        if (!isJournalTransition(chain.tip.record)) throw new Error("unsupported checkpoint tip");
        const retired = new Map<string, LeaseRetirementEntry>();
        const add = (entry: LeaseIoEntry, name = entry.name, directory = entry.directory) => {
          retired.set(`${directory}/${name}`, { directory, name, device: entry.device, inode: entry.inode, hash: withSnapshot(snapshot, () => readRecord(join(root, entry.directory === "root" ? "" : "mutable-home.lock", entry.name))).hash });
        };
        const evidence = new Set(chain.evidence.map((entry) => `${entry.directory}/${entry.name}`));
        const prior = new Set(chain.retired.map((entry) => `${entry.directory}/${entry.name}`));
        for (const entry of snapshot.entries) {
          if (legacy && entry.directory === "lock" && entry.name !== FORMAT_GUARD && entry.name !== LEGACY_MARKER ||
              evidence.has(`${entry.directory}/${entry.name}`) || prior.has(`${entry.directory}/${entry.name}`) || entry.directory === "root" && (entry.name === RETIREMENT_ALIAS || bootstrapCandidates.has(entry.name))) {
            add(entry);
            if (entry.directory === "root" && NEXT_MARKER.test(entry.name) && !snapshot.entries.some((file) => file.directory === "lock" && file.name === entry.name)) {
              add(entry, entry.name, "lock");
            }
          }
        }
        if (legacy) {
          // Canonical checkpoints commit to a root-side previous-tip tuple. The exact
          // in-lock inode supplies that tuple even when its optional root alias never
          // existed; no missing alias authorizes ownership or evidence retirement.
          const tipEntry = snapshot.entries.find(entry => entry.directory === "lock" && entry.raw.toString("utf8") === chain.tip.raw);
          if (!tipEntry) throw new Error("legacy acquired tip is unavailable");
          add(tipEntry, tipEntry.name, "root");
        }
        if (chain.anchor && isJournalTransition(chain.anchor.record)) {
          const anchorEntry = snapshot.entries.find((entry) => entry.directory === "root" && entry.name === RECOVERY_MARKER)!;
          for (const name of ["checkpoint.json", `lease-${chain.anchor.record.leaseId}.json`]) if (!retired.has(`lock/${name}`)) add(anchorEntry, name, "lock");
        }
        if (retired.size > LIMITS.retirementEntries) throw new Error("checkpoint manifest limit exceeded");
        const pendingName = CHECKPOINT_SLOTS.find((name) => !snapshot.entries.some((entry) => entry.directory === "root" && entry.name === name) &&
          !chain.retired.some((entry) => entry.directory === "root" && entry.name === name));
        if (!pendingName) throw new Error("checkpoint slots require a proven completed candidate");
        const guard = snapshot.entries.find((entry) => entry.directory === "lock" && entry.name === FORMAT_GUARD)!;
        const partial: Omit<LeaseCheckpointProof, "historyHash"> = {
          migration: snapshot.entries.filter((entry) => entry.directory === "root").length >= LIMITS.directoryEntries - 4 ||
            snapshot.entries.filter((entry) => entry.directory === "lock").length >= LIMITS.directoryEntries - 4,
          previousTip: chain.tip.raw, previousTipHash: chain.tip.hash, previousAnchorHash: historyRoot.hash,
          previousHistoryHash: historyRoot.record.version === 4 ? historyRoot.record.checkpoint.historyHash : historyRoot.hash,
          guardHash: withSnapshot(snapshot, () => readRecord(join(lockDir, FORMAT_GUARD))).hash, guardDevice: guard.device, guardInode: guard.inode,
          retired: [...retired.values()],
        };
        const checkpoint: ProviderHomeLeaseRecordV4 = { ...chain.tip.record, version: 4, previousLeaseId: null, previousRecordHash: null,
          recoveredEntriesHash: legacy
            ? recordsHash(historyRoot.record.version === 1 ? [{ name: LEGACY_MARKER, hash: historyRoot.hash }] : [])
            : historyRoot.record.version === 1 ? undefined : historyRoot.record.recoveredEntriesHash,
          checkpoint: { ...partial, historyHash: checkpointHistory(partial) } };
        const raw = Buffer.from(`${JSON.stringify(checkpoint)}\n`);
        if (raw.length > LIMITS.checkpointBytes) throw new Error("checkpoint byte limit exceeded");
        verifyCheckpoint({ record: checkpoint, raw: raw.toString("utf8"), hash: hashText(raw.toString("utf8")) }, lockDir);
        // Absent optional mirrors carry exact canonical identities. A late rollback writer can
        // finish only that same immutable alias; the helper verifies it under the fence too.
        for (const item of retired.values()) if (!snapshot.entries.some((entry) => entry.directory === item.directory && entry.name === item.name)) {
          const source = snapshot.entries.find((entry) => !publicationTemporary(entry) && entry.device === item.device && entry.inode === item.inode);
          if (source) snapshot.entries.push({ ...source, directory: item.directory, name: item.name, optional: true });
        }
        apply(chain, [{ name: pendingName, raw, copiesOwner: true, retire: indexes([...retired.values()]) }]);
        owned(); return true;
      });
    } catch (error) {
      this.onCheckpointFailureForTest?.(error);
      const diagnostic = `Provider-home lease checkpoint unavailable; preserving the last valid chain. Acquisitions stop at ${LIMITS.hardTransitions - 1} transitions, reserving one release slot. Check the packaged lease helper, permanent reader/writer fence, durable publication, staging evidence, and the ${LIMITS.verificationBytes}-byte verification budget; quarantine the entire lease directory only after proving this HOME unused.`;
      if (!this.diagnostics.includes(diagnostic) && this.diagnostics.length < 16) {
        this.diagnostics.push(diagnostic); this.onDiagnostic?.({ event: "provider_home_checkpoint_unavailable", leaseId, message: diagnostic });
      }
      return false;
    }
  }

  releaseAll(): boolean {
    return withLeaseIoOptions({ helperDataDir: this.helperDataDir, fenceWaitMs: 10000 }, () => {
      for (const [home, held] of this.held) {
        if (!withLeaseIoOptions({ providerHome: home }, () => this.releaseHeld(held))) continue;
        this.held.delete(home); this.pendingMigrations.delete(home); this.pendingCompletions.delete(home);
      }
      return this.held.size === 0 && this.failedInitializations.size === 0 && this.pendingCompletions.size === 0;
    });
  }

  /** Release one exact home after its supervised process tree is reaped. */
  releaseHome(requestedHome: string): boolean {
    let providerHome = resolve(requestedHome); try { providerHome = realpathSync(requestedHome); } catch { /* release fails closed below */ }
    return withLeaseIoOptions({ helperDataDir: this.helperDataDir, fenceWaitMs: 10000, providerHome }, () => this.releaseHomeAvailable(requestedHome));
  }

  private releaseHomeAvailable(requestedHome: string): boolean {
    let home: string;
    try {
      home = realpathSync(requestedHome);
    } catch {
      return false;
    }
    const held = this.held.get(home);
    if (!held) return false;
    if (held.references > 1) {
      held.references--;
      return false;
    }
    if (!this.releaseHeld(held)) return false;
    this.held.delete(home);
    this.pendingMigrations.delete(home); this.pendingCompletions.delete(home);
    return true;
  }

  private releaseHeld({ leaseId, acquiredHash, lockDir, root }: { leaseId: string; acquiredHash: string; lockDir: string; root: string }): boolean {
    try {
      this.compactHeld(root, lockDir, leaseId);
      const chain = readChain(lockDir);
      const current = chain.tip;
      if (current.record.version === 1 || current.record.state !== "active" ||
          current.record.leaseId !== leaseId || !sameAcquiredTip(current, acquiredHash)) throw unexpectedEntries(lockDir);
      const released: ProviderHomeLeaseRecordV2 = {
        ...current.record,
        version: current.record.process?.version === 2 ? 5 : 2,
        state: "released",
        leaseId: randomUUID(),
        previousLeaseId: current.record.leaseId,
        previousRecordHash: current.hash,
        createdAt: new Date().toISOString(),
      };
      // A transition is a small v2 record, never a recursive copy of checkpoint history.
      delete (released as unknown as Partial<ProviderHomeLeaseRecordV4>).checkpoint;
      delete released.recoveredEntriesHash;
      // A recovery note describes how the active record was acquired, never a release.
      delete released.recovery;
      const name = `next-${current.record.leaseId}.json`;
      publishRecord(root, join(chain.external ? root : lockDir, name), released);
      if (chain.external) this.mirrorRecord(root, lockDir, name);
      return true;
    } catch {
      // Never remove or supersede unreadable or replacement ownership evidence.
      const message = "Provider-home lease release unpublished; preserve the exact acquired reservation and retry release after fence contention or helper availability recovers. Do not grant this HOME to another owner until an exact verified release succeeds.";
      if (!this.diagnostics.includes(message) && this.diagnostics.length < 16) {
        this.diagnostics.push(message); this.onDiagnostic?.({ event: "provider_home_release_unpublished", leaseId, message });
      }
      return false;
    }
  }
}
