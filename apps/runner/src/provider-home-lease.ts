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
} from "node:fs";
import { homedir, hostname as systemHostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentContext, AgentDriverKind } from "@wollipog/protocol";
import { WSL_BWRAP_UNAVAILABLE_ERROR } from "./execution-isolation-policy.js";
import type { SpawnIsolation } from "./spawn.js";
import { readLeaseIoSnapshot, applyLeaseIoPlan, ensureLeaseIoAvailable, withLeaseIoOptions, LeaseIoError, type LeaseIoSnapshot, type LeaseIoEntry, type LeaseIoJob } from "./provider-home-lease-io.js";
import { LEASE_CHECKPOINT_LIMITS as LIMITS, type LeaseCheckpointProof, type LeaseRetirementEntry } from "./provider-home-lease-checkpoint.js";

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
  version: 2;
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
}

interface ProviderHomeLeaseRecordV4 extends Omit<ProviderHomeLeaseRecordV2, "version"> {
  version: 4;
  checkpoint: LeaseCheckpointProof;
}

type ProviderHomeLeaseRecord = ProviderHomeLeaseRecordV1 | ProviderHomeLeaseRecordV2 | ProviderHomeLeaseRecordV4;

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
  onDiagnostic?: (diagnostic: { event: "provider_home_checkpoint_unavailable" | "provider_home_release_unpublished"; leaseId: string; message: string }) => void;
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

/** bwrap redirects mutable transcripts; container/cloud providers do not mutate the host home. */
export function providerLaunchNeedsSharedHomeLease(isolation?: SpawnIsolation): boolean {
  return isolation?.backend !== "bwrap" && isolation?.backend !== "wsl-bwrap" && isolation?.backend !== "container" &&
    isolation?.backend !== "cloud";
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
const decodedEntries = new WeakMap<LeaseIoEntry, ReadLeaseRecord>();
function readRecord(path: string): ReadLeaseRecord {
  const cachedEntry = physicalSnapshot ? snapshotEntry(path) : undefined;
  if (cachedEntry?.links === 3 && physicalSnapshot!.entries.filter((entry) => entry.device === cachedEntry.device && entry.inode === cachedEntry.inode && entry.raw.equals(cachedEntry.raw)).length < 3) throw new Error("unproven lease metadata alias");
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
  const validV2 = (value.version === 2 || value.version === 4) && isBaseRecord(value) &&
    (value.state === "active" || value.state === "released") &&
    (value.previousLeaseId === null || typeof value.previousLeaseId === "string" && LEASE_ID.test(value.previousLeaseId)) &&
    (value.previousRecordHash === null || typeof value.previousRecordHash === "string" && OWNER_HASH.test(value.previousRecordHash));
  if (!validV1 && !validV2 || value.version !== 4 && bytes.length > MAX_RECORD_BYTES) throw new Error("provider-home lease metadata is invalid");
  const result = { record: value as unknown as ProviderHomeLeaseRecord, hash: hashText(bytes.toString("utf8")), raw: bytes.toString("utf8") };
  if (cachedEntry) decodedEntries.set(cachedEntry, result);
  return result;
}

function unexpectedEntries(lockDir: string): Error {
  return refusal(lockDir, "contains unexpected entries; refusing unsafe recovery");
}

class ProviderHomeLeaseRefusal extends Error {
  constructor(readonly reason: string, message: string) { super(message); }
}

function refusal(lockDir: string, reason: string): Error {
  return new ProviderHomeLeaseRefusal(reason, `provider home lease directory ${lockDir} ${reason}; after proving no provider process or runner uses this HOME, manually quarantine the entire provider-home-leases-v1 directory (including mutable-home.lock, all lease-/next- records, and mutable-home.recovery.json) and retry; do not remove individual records`);
}

function verificationRefusal(lockDir: string, error: unknown): Error {
  // Preserve the complete remedy once, and never put malformed record contents from a parser's
  // exception into operator-visible output.
  if (error instanceof LeaseIoError && error.kind === "busy") return new LeaseIoError("busy", `provider home lease directory ${lockDir} is already in use: checkpoint publication is in progress; preserve evidence and retry`);
  if (error instanceof LeaseIoError && error.kind === "unavailable") return error;
  return refusal(lockDir, error instanceof ProviderHomeLeaseRefusal ? error.reason : "cannot be verified: metadata is unsafe or unreadable");
}

function recordsHash(records: Array<{ name: string; hash: string }>): string {
  return hashText(JSON.stringify(records.map(({ name, hash }) => ({ name, hash }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
}

function validateTransition(current: ReadLeaseRecord, next: ReadLeaseRecord, lockDir: string): void {
  if (next.record.version !== 2 || next.record.previousLeaseId !== current.record.leaseId ||
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
  if (tip.version !== 2 || tip.state !== "active" || !isBaseRecord(tip as unknown as Record<string, unknown>) ||
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
    if (String(stat.dev) !== entry.device || String(stat.ino) !== entry.inode || !stat.isFile() || stat.isSymbolicLink() ||
        readRecord(path).hash !== entry.hash) throw unexpectedEntries(lockDir);
    const after = metadataStat(path);
    if (String(after.dev) !== entry.device || String(after.ino) !== entry.inode) throw unexpectedEntries(lockDir);
    present.add(`${entry.directory}/${entry.name}`);
  }
  return present;
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
    if ((recovery.record.version !== 2 && recovery.record.version !== 4) || recovery.record.state !== "active" ||
        recovery.record.previousLeaseId !== null || recovery.record.previousRecordHash !== null ||
        typeof recovery.record.recoveredEntriesHash !== "string" || !OWNER_HASH.test(recovery.record.recoveredEntriesHash)) {
      throw unexpectedEntries(lockDir);
    }
    current = recovery;
    marker = `lease-${current.record.leaseId}.json`;
    if (recovery.record.version === 2) verifyMirror(marker, current.hash);
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
    if (current.record.version !== 2 || current.record.state !== "active" ||
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
  if (recovery?.record.version === 2 && entrySet.has("checkpoint.json")) {
    verifyMirror("checkpoint.json", recovery.hash);
    consumed.add("checkpoint.json");
  }
  const externalEntries = recovery ? canonicalRootEntries(root, lockDir).filter((name) => NEXT_MARKER.test(name) && !presentRetired.has(`root/${name}`)) : [];
  const externalSet = new Set(externalEntries);
  const externalConsumed = new Set<string>();
  const canonicalRecords = recovery ? [{ name: RECOVERY_MARKER, hash: recovery.hash }] : [];
  if (guardHash) canonicalRecords.push({ name: FORMAT_GUARD, hash: guardHash });
  const evidence: LeaseChain["evidence"] = [];
  if (recovery?.record.version === 2) {
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
      if (record.version !== 2 || record.previousLeaseId !== chain.tip.record.leaseId || record.previousRecordHash !== chain.tip.hash) throw new Error("provider home lease changed during recovery; retry");
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
  const tipIndex = snapshot.entries.findIndex((entry) => entry.directory === "root" && entry.raw.toString("utf8") === tip.raw);
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
  }

  getDiagnostics(): readonly string[] { return this.diagnostics; }

  acquire(request: ProviderHomeLeaseRequest): void {
    if (request.context.kind === "wsl" && request.isolation?.backend === "bwrap") {
      throw new Error(WSL_BWRAP_UNAVAILABLE_ERROR);
    }
    if (!providerLaunchNeedsSharedHomeLease(request.isolation)) return;
    const provider = providerKey(request.driver, request.command);
    if (request.context.kind === "wsl") {
      throw new Error(
        `shared ${provider} provider home in WSL cannot be safely owner-leased; use a supported native, container, or cloud execution target`,
      );
    }
    const requestedHome = provider === "claude"
      ? request.env.CLAUDE_CONFIG_DIR || request.env.HOME || homedir()
      : provider === "codex"
        ? request.env.CODEX_HOME || request.env.HOME || homedir()
        : request.env.HOME || homedir();
    this.acquireHome(requestedHome, provider);
  }

  /** Acquire the whole mutable HOME for a non-launch mutation such as managed skill links. */
  acquireHome(requestedHome: string, provider = "skills"): boolean {
    let providerHome = resolve(requestedHome);
    try { providerHome = realpathSync(requestedHome); } catch { /* A fresh HOME must not be created before probing. */ }
    return withLeaseIoOptions({ helperDataDir: this.helperDataDir, providerHome }, () => {
      ensureLeaseIoAvailable();
      return this.acquireHomeAvailable(requestedHome, provider);
    });
  }

  private acquireHomeAvailable(requestedHome: string, provider: string): boolean {
    if (!PROVIDER_KEY.test(provider)) throw new Error("provider home lease key is invalid");
    if (!isAbsolute(requestedHome)) throw new Error("provider HOME must be absolute");
    let home: string;
    try {
      // A newly configured account is expected to be Login Required before the provider creates
      // its files. Establish the private root before canonicalizing it so the ownership boundary,
      // rather than a raw ENOENT containing the runner-local path, is the first launch result.
      mkdirSync(requestedHome, { recursive: true, mode: 0o700 });
      home = realpathSync(requestedHome);
    } catch {
      throw new Error("provider credential home is unavailable");
    }
    const root = join(home, ".agent-manager", "provider-home-leases-v1");
    // ACP adapters are not provider-specific and known CLIs co-locate auth/config/cache below
    // HOME. Lease the whole effective home rather than pretending those mutations are disjoint.
    const lockDir = join(root, "mutable-home.lock");
    const key = home;
    const borrowed = this.held.get(key);
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
        throw verificationRefusal(lockDir, error);
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
        if (initialization.tip.record.version !== 2 || initialization.tip.record.state !== "released") {
          this.assertAbandoned(initialization.tip.record, lockDir);
        }
        try { mkdirSync(lockDir, { mode: 0o700 }); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        delete record.recoveredEntriesHash;
        this.transitionExistingLease(key, root, lockDir, record);
      }
    } else {
      this.transitionExistingLease(key, root, lockDir, record);
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
    if (readChain(lockDir).anchor?.record.version === 2) {
      this.mirrorRecord(root, lockDir, RECOVERY_MARKER, "checkpoint.json", true);
      readChain(lockDir);
    }
    const migrationRequired = (() => { const chain = readChain(lockDir); return chain.external && chain.transitions >= LIMITS.hardTransitions - 1; })();
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
      throw verificationRefusal(lockDir, error);
    }
  }

  private activeRecord(
    provider: string,
    previousLeaseId: string | null,
    previousRecordHash: string | null,
  ): ProviderHomeLeaseRecordV2 {
    return {
      version: 2,
      state: "active",
      ownerHash: this.ownerHash,
      leaseId: randomUUID(),
      previousLeaseId,
      previousRecordHash,
      pid: this.pid,
      hostname: this.hostname,
      provider,
      createdAt: new Date().toISOString(),
    };
  }

  private transitionExistingLease(key: string, root: string, lockDir: string, replacement: ProviderHomeLeaseRecordV2): void {
    let chain: LeaseChain;
    try {
      chain = readChain(lockDir);
    } catch (error) {
      // A published recovery checkpoint is authoritative. Corruption in it or its retained
      // evidence must never trigger another recovery that could erase an ownership boundary.
      try { lstatSync(join(root, RECOVERY_MARKER)); } catch (markerError) {
        if ((markerError as NodeJS.ErrnoException).code === "ENOENT") {
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
    if (existing.record.version === 2 && existing.record.state === "released") {
      // An orderly release is an explicit handoff and may pass the HOME to a different owner.
    } else {
      this.assertAbandoned(existing.record, lockDir);
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
    this.afterTransitionPublishForTest?.();
  }

  private assertAbandoned(record: ProviderHomeLeaseRecord, lockDir: string): void {
    if (record.hostname !== this.hostname) throw refusal(lockDir, `is leased by host ${record.hostname}; use an isolated OS account`);
    if (this.isProcessAlive(record.pid)) throw refusal(lockDir, `is already in use by process ${record.pid}; use bwrap or an isolated OS account`);
    if (record.ownerHash !== this.ownerHash) throw refusal(lockDir, "has a stale lease from another attested owner");
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
          genesis ? record.version === 2 && record.state === "active" && genesis[1] === record.leaseId &&
            record.previousLeaseId === null && record.previousRecordHash === null :
          next ? record.version === 2 && next[1] === record.previousLeaseId &&
            typeof record.previousRecordHash === "string" : false;
        if (!valid || byId.has(record.leaseId) || (record.version === 2 && record.recoveredEntriesHash !== undefined)) throw unexpectedEntries(lockDir);
        this.assertAbandoned(record, lockDir);
        byId.set(record.leaseId, value);
        return { name, ...value };
      });
      for (const value of records) {
        const record = value.record;
        if (record.version !== 2 || record.previousLeaseId === null) continue;
        const previous = byId.get(record.previousLeaseId);
        if (previous) validateTransition(previous, value, lockDir);
        const seen = new Set([record.leaseId]);
        let ancestor = previous;
        while (ancestor) {
          if (seen.has(ancestor.record.leaseId)) throw unexpectedEntries(lockDir);
          seen.add(ancestor.record.leaseId);
          ancestor = ancestor.record.version === 2 && ancestor.record.previousLeaseId
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
          return retired.flatMap((entry) => { const i = index.get(`${entry.directory}/${entry.name}`); return i === undefined ? [] : [i]; });
        };
        let chain = owned();
        if (!chain.external) return true;
        if (chain.retired.some((entry) => snapshot.entries.some((file) => file.directory === entry.directory && file.name === entry.name))) {
          apply(chain, [{ name: "", raw: Buffer.alloc(0), copiesOwner: false, retire: indexes(chain.retired) }]);
          chain = owned();
        }
        let adopted = false;
        // A completed candidate commits to its prior verified anchor and historical tip. Prove
        // that selecting it leaves this newly acquired Q as the exact active successor first.
        const candidates = snapshot.entries.filter((entry) => entry.directory === "root" && CHECKPOINT_SLOTS.includes(entry.name));
        for (const entry of candidates.slice().reverse()) {
          if (chain.retired.some((item) => item.directory === "root" && item.name === entry.name)) continue;
          const pending = withSnapshot(snapshot, () => readRecord(join(root, entry.name)));
          const retired = verifyCheckpoint(pending, lockDir);
          if (pending.record.version !== 4 || !chain.anchor || pending.record.checkpoint.previousAnchorHash !== chain.anchor.hash ||
              pending.record.ownerHash !== this.ownerHash || pending.record.hostname !== this.hostname ||
              !chain.evidence.some((item) => item.directory === "root" && item.hash === (pending.record as ProviderHomeLeaseRecordV4).checkpoint.previousTipHash)) throw new Error("unproven completed checkpoint candidate");
          withSnapshot(snapshot, () => verifyRetired(root, lockDir, retired));
          const oldAnchor = snapshot.entries.find((item) => item.directory === "root" && item.name === RECOVERY_MARKER)!;
          const hypothetical = { ...snapshot, entries: snapshot.entries.filter((file) => file.name !== RECOVERY_MARKER || file.directory !== "root")
            .filter((file) => file !== entry)
            // Selection removes the old anchor's canonical hard link; its two remaining
            // verified mirrors must reflect that physical post-selection count.
            .map((file) => file.device === oldAnchor.device && file.inode === oldAnchor.inode ? { ...file, links: file.links - 1 } : file)
            .concat({ ...entry, name: RECOVERY_MARKER }) };
          const after = withSnapshot(hypothetical, () => readChainAt(lockDir, root));
          if (!sameTip(chain.tip, after.tip)) throw new Error("completed candidate does not preserve the acquired successor");
          apply(chain, [{ name: entry.name, raw: entry.raw, copiesOwner: false, retire: indexes(retired) }]);
          chain = owned(); adopted = true; break;
        }
        if (chain.transitions < LIMITS.compactAfter && !adopted) return true;
        if (chain.tip.record.version !== 2 || !chain.anchor) throw new Error("unsupported checkpoint tip");
        if (!snapshot.entries.some((entry) => entry.directory === "lock" && entry.name === FORMAT_GUARD)) {
          const guard = Buffer.from(`${JSON.stringify({ ...chain.tip.record, version: 4, protocol: "bounded-canonical-checkpoint", fenceBackend: process.platform === "win32" ? "lockfileex" : "flock", previousLeaseId: null, previousRecordHash: null })}\n`);
          apply(chain, [], guard); chain = owned();
        }
        if (chain.tip.record.version !== 2 || !chain.anchor) throw new Error("unsupported checkpoint tip");
        const retired = new Map<string, LeaseRetirementEntry>();
        const add = (entry: LeaseIoEntry, name = entry.name, directory = entry.directory) => {
          retired.set(`${directory}/${name}`, { directory, name, device: entry.device, inode: entry.inode, hash: withSnapshot(snapshot, () => readRecord(join(root, entry.directory === "root" ? "" : "mutable-home.lock", entry.name))).hash });
        };
        const evidence = new Set(chain.evidence.map((entry) => `${entry.directory}/${entry.name}`));
        const prior = new Set(chain.retired.map((entry) => `${entry.directory}/${entry.name}`));
        for (const entry of snapshot.entries) {
          if (evidence.has(`${entry.directory}/${entry.name}`) || prior.has(`${entry.directory}/${entry.name}`) || entry.directory === "root" && entry.name === RETIREMENT_ALIAS) {
            add(entry);
            if (entry.directory === "root" && NEXT_MARKER.test(entry.name) && !snapshot.entries.some((file) => file.directory === "lock" && file.name === entry.name)) {
              add(entry, entry.name, "lock");
            }
          }
        }
        if (chain.anchor.record.version === 2) {
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
          previousTip: chain.tip.raw, previousTipHash: chain.tip.hash, previousAnchorHash: chain.anchor.hash,
          previousHistoryHash: chain.anchor.record.version === 4 ? chain.anchor.record.checkpoint.historyHash : chain.anchor.hash,
          guardHash: withSnapshot(snapshot, () => readRecord(join(lockDir, FORMAT_GUARD))).hash, guardDevice: guard.device, guardInode: guard.inode,
          retired: [...retired.values()],
        };
        const checkpoint: ProviderHomeLeaseRecordV4 = { ...chain.tip.record, version: 4, previousLeaseId: null, previousRecordHash: null,
          recoveredEntriesHash: chain.anchor.record.version === 1 ? undefined : chain.anchor.record.recoveredEntriesHash,
          checkpoint: { ...partial, historyHash: checkpointHistory(partial) } };
        const raw = Buffer.from(`${JSON.stringify(checkpoint)}\n`);
        if (raw.length > LIMITS.checkpointBytes) throw new Error("checkpoint byte limit exceeded");
        verifyCheckpoint({ record: checkpoint, raw: raw.toString("utf8"), hash: hashText(raw.toString("utf8")) }, lockDir);
        // Absent optional mirrors carry exact canonical identities. A late rollback writer can
        // finish only that same immutable alias; the helper verifies it under the fence too.
        for (const item of retired.values()) if (!snapshot.entries.some((entry) => entry.directory === item.directory && entry.name === item.name)) {
          const source = snapshot.entries.find((entry) => entry.device === item.device && entry.inode === item.inode);
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

  releaseAll(): void {
    withLeaseIoOptions({ helperDataDir: this.helperDataDir, fenceWaitMs: 10000 }, () => {
      for (const [home, held] of this.held) {
        if (!withLeaseIoOptions({ providerHome: home }, () => this.releaseHeld(held))) continue;
        this.held.delete(home); this.pendingMigrations.delete(home); this.pendingCompletions.delete(home);
      }
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
        version: 2,
        state: "released",
        leaseId: randomUUID(),
        previousLeaseId: current.record.leaseId,
        previousRecordHash: current.hash,
        createdAt: new Date().toISOString(),
      };
      // A transition is a small v2 record, never a recursive copy of checkpoint history.
      delete (released as unknown as Partial<ProviderHomeLeaseRecordV4>).checkpoint;
      delete released.recoveredEntriesHash;
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
