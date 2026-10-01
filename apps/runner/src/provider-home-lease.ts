import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname as systemHostname } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AgentContext, AgentDriverKind } from "@wollipog/protocol";
import { WSL_BWRAP_UNAVAILABLE_ERROR } from "./execution-isolation-policy.js";
import type { SpawnIsolation } from "./spawn.js";

const OWNER_HASH = /^[a-f0-9]{64}$/u;
const PROVIDER_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_RECORD_BYTES = 4_096;
const LEGACY_MARKER = "lease.json";
const GENESIS_MARKER = /^lease-([0-9a-f-]+)\.json$/u;
const RECOVERY_MARKER = "mutable-home.recovery.json";
const NEXT_MARKER = /^next-([0-9a-f-]+)\.json$/u;

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

type ProviderHomeLeaseRecord = ProviderHomeLeaseRecordV1 | ProviderHomeLeaseRecordV2;

interface ReadLeaseRecord {
  record: ProviderHomeLeaseRecord;
  hash: string;
}

interface LeaseChain {
  entries: string[];
  tip: ReadLeaseRecord;
  snapshotHash: string;
  external: boolean;
}

export interface ProviderHomeLeaseOptions {
  pid?: number;
  hostname?: string;
  isProcessAlive?: (pid: number) => boolean;
  beforeMarkerWriteForTest?: () => void;
  beforeTransitionPublishForTest?: () => void;
  afterInitializationPublishForTest?: () => void;
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

function readRecord(path: string): ReadLeaseRecord {
  if (lstatSync(path).isSymbolicLink()) throw new Error("provider-home lease metadata is unsafe");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw new Error("provider-home lease metadata is unsafe");
    const bytes = readFileSync(fd);
    const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const validV1 = value.version === 1 && isBaseRecord(value);
    const validV2 = value.version === 2 && isBaseRecord(value) &&
      (value.state === "active" || value.state === "released") &&
      (value.previousLeaseId === null ||
        (typeof value.previousLeaseId === "string" && LEASE_ID.test(value.previousLeaseId))) &&
      (value.previousRecordHash === null ||
        (typeof value.previousRecordHash === "string" && OWNER_HASH.test(value.previousRecordHash)));
    if (!validV1 && !validV2) throw new Error("provider-home lease metadata is invalid");
    return {
      record: value as unknown as ProviderHomeLeaseRecord,
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    closeSync(fd);
  }
}

function unexpectedEntries(lockDir: string): Error {
  return refusal(lockDir, "contains unexpected entries; refusing unsafe recovery");
}

class ProviderHomeLeaseRefusal extends Error {}

function refusal(lockDir: string, reason: string): Error {
  return new ProviderHomeLeaseRefusal(`provider home lease directory ${lockDir} ${reason}; after proving no provider process or runner uses this HOME, manually quarantine the entire provider-home-leases-v1 directory (including mutable-home.lock, all lease-/next- records, and mutable-home.recovery.json) and retry; do not remove individual records`);
}

function verificationRefusal(lockDir: string, error: unknown): Error {
  // Preserve the complete remedy once, and never put malformed record contents from a parser's
  // exception into operator-visible output.
  return error instanceof ProviderHomeLeaseRefusal ? error : refusal(lockDir, "cannot be verified: metadata is unsafe or unreadable");
}

function recordsHash(records: Array<{ name: string; hash: string }>): string {
  return createHash("sha256").update(JSON.stringify(records.map(({ name, hash }) => ({ name, hash }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0))).digest("hex");
}

function validateTransition(current: ReadLeaseRecord, next: ReadLeaseRecord, lockDir: string): void {
  if (next.record.version !== 2 || next.record.previousLeaseId !== current.record.leaseId ||
      next.record.previousRecordHash !== current.hash ||
      (next.record.state === "released" &&
        (current.record.version !== 2 || current.record.state !== "active" ||
          next.record.ownerHash !== current.record.ownerHash || next.record.hostname !== current.record.hostname ||
          next.record.pid !== current.record.pid || next.record.provider !== current.record.provider)) ||
      (next.record.state === "active" && (current.record.version === 1 || current.record.state === "active") &&
        (next.record.ownerHash !== current.record.ownerHash || next.record.hostname !== current.record.hostname))) {
    throw unexpectedEntries(lockDir);
  }
}

/**
 * Resolve the immutable lease journal. A fixed successor pathname is the compare-and-swap: only
 * one process can publish the transition from a particular tip, and no record is ever removed.
 */
function readChain(lockDir: string): LeaseChain {
  const root = join(lockDir, "..");
  let entries: string[] = [];
  try {
    const lockStat = lstatSync(lockDir);
    if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) throw unexpectedEntries(lockDir);
    entries = readdirSync(lockDir).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const entrySet = new Set(entries);
  let marker: string;
  let current: ReadLeaseRecord;
  let recovery: ReadLeaseRecord | undefined;
  try {
    recovery = readRecord(join(root, RECOVERY_MARKER));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (recovery) {
    if (recovery.record.version !== 2 || recovery.record.state !== "active" ||
        recovery.record.previousLeaseId !== null || recovery.record.previousRecordHash !== null ||
        typeof recovery.record.recoveredEntriesHash !== "string" || !OWNER_HASH.test(recovery.record.recoveredEntriesHash)) {
      throw unexpectedEntries(lockDir);
    }
    current = recovery;
    marker = `lease-${current.record.leaseId}.json`;
    if (entrySet.has(marker) && readRecord(join(lockDir, marker)).hash !== current.hash) throw unexpectedEntries(lockDir);
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

  const consumed = new Set(entrySet.has(marker) ? [marker] : []);
  // Updated binaries publish the canonical chain outside the directory and leave in-lock
  // mirrors for inspection. A rollback binary must refuse this marker instead of acquiring
  // a lease while ignoring the canonical journal.
  if (recovery && entrySet.has("checkpoint.json")) {
    if (readRecord(join(lockDir, "checkpoint.json")).hash !== recovery.hash) throw unexpectedEntries(lockDir);
    consumed.add("checkpoint.json");
  }
  const externalEntries = recovery ? readdirSync(root).filter((name) => NEXT_MARKER.test(name)).sort() : [];
  const externalSet = new Set(externalEntries);
  const externalConsumed = new Set<string>();
  const canonicalRecords = recovery ? [{ name: RECOVERY_MARKER, hash: recovery.hash }] : [];
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
      if (entrySet.has(nextMarker) && readRecord(join(lockDir, nextMarker)).hash !== next.hash) throw unexpectedEntries(lockDir);
    }
    // Only two transitions are ever published, and both constrain the successor: reclaim appends
    // an active record over an unreleased (v1 or active-v2) predecessor after proving the same
    // owner and host, and releaseAll releases a v2 active tip copying its identity verbatim. Any
    // other link is fabricated or corrupted state; trusting it would let a "released" tip skip
    // every hostname/owner/liveness check. Only an authentic handoff (an active successor over a
    // released record) may change identity.
    validateTransition(current, next, lockDir);
    if (entrySet.has(nextMarker)) consumed.add(nextMarker);
    current = next;
  }
  const retained = entries.filter((entry) => !consumed.has(entry))
    .map((name) => ({ name, hash: readRecord(join(lockDir, name)).hash }));
  if (recovery) {
    if (externalConsumed.size !== externalEntries.length) throw unexpectedEntries(lockDir);
    if (recordsHash(retained) !== (recovery.record as ProviderHomeLeaseRecordV2).recoveredEntriesHash) throw unexpectedEntries(lockDir);
  } else if (retained.length) throw unexpectedEntries(lockDir);
  return { entries, tip: current, snapshotHash: recordsHash([
    ...entries.map((name) => ({ name, hash: readRecord(join(lockDir, name)).hash })),
    ...canonicalRecords,
  ]), external: recovery !== undefined };
}

function sameTip(left: ReadLeaseRecord, right: ReadLeaseRecord): boolean {
  return left.hash === right.hash && left.record.leaseId === right.record.leaseId;
}

/**
 * Publish a complete immutable record with an exclusive hard link. The temporary file is outside
 * the lock directory, so a crash can leave harmless litter but never a transient in-lock entry.
 */
function publishRecord(root: string, target: string, record: ProviderHomeLeaseRecordV2): void {
  const temp = join(root, `.provider-home-lease-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
    linkSync(temp, target);
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch {
      // A sibling staging file is not protocol state and must not mask a successful publication.
    }
  }
}

/**
 * A runner holds one lease for each mutable provider home until shutdown. This is deliberately
 * coarser than session admission: Claude/Codex mix auth, config, caches and transcripts in HOME,
 * so allowing a second control plane between turns would still permit cross-owner mutation.
 */
export class ProviderHomeLeaseRegistry {
  private readonly held = new Map<string, {
    leaseId: string;
    lockDir: string;
    root: string;
    references: number;
  }>();
  private readonly pid: number;
  private readonly hostname: string;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly beforeMarkerWriteForTest?: () => void;
  private readonly beforeTransitionPublishForTest?: () => void;
  private readonly afterInitializationPublishForTest?: () => void;

  constructor(private readonly ownerHash: string, options: ProviderHomeLeaseOptions = {}) {
    if (!OWNER_HASH.test(ownerHash)) throw new Error("provider-home lease requires an attested owner hash");
    this.pid = options.pid ?? process.pid;
    this.hostname = options.hostname ?? systemHostname();
    this.isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
    this.beforeMarkerWriteForTest = options.beforeMarkerWriteForTest;
    this.beforeTransitionPublishForTest = options.beforeTransitionPublishForTest;
    this.afterInitializationPublishForTest = options.afterInitializationPublishForTest;
  }

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
      borrowed.references++;
      return false;
    }
    mkdirSync(root, { recursive: true, mode: 0o700 });
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
        this.afterInitializationPublishForTest?.();
        // Exclusive mkdir detects a competing legacy initializer instead of attributing its
        // directory to our proof. Keep the proof and refuse; no ownership evidence is removed.
        mkdirSync(lockDir, { mode: 0o700 });
        linkSync(join(root, RECOVERY_MARKER), join(lockDir, "checkpoint.json"));
        linkSync(join(root, RECOVERY_MARKER), join(lockDir, `lease-${record.leaseId}.json`));
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
        this.transitionExistingLease(root, lockDir, record);
      }
    } else {
      this.transitionExistingLease(root, lockDir, record);
    }
    // This fixed incompatible marker prevents a rollback binary from ignoring the external
    // journal even when crash recovery recreated an empty directory.
    if (readChain(lockDir).external) {
      this.mirrorRecord(root, lockDir, RECOVERY_MARKER, "checkpoint.json", true);
      readChain(lockDir);
    }
    this.held.set(key, { leaseId: record.leaseId, lockDir, root, references: 1 });
    return true;
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

  private transitionExistingLease(root: string, lockDir: string, replacement: ProviderHomeLeaseRecordV2): void {
    let chain: LeaseChain;
    try {
      chain = readChain(lockDir);
    } catch (error) {
      // A published recovery checkpoint is authoritative. Corruption in it or its retained
      // evidence must never trigger another recovery that could erase an ownership boundary.
      try { lstatSync(join(root, RECOVERY_MARKER)); } catch (markerError) {
        if ((markerError as NodeJS.ErrnoException).code === "ENOENT") {
          this.recoverPartialJournal(root, lockDir, replacement);
          return;
        }
      }
      throw verificationRefusal(lockDir, error);
    }
    const existing = chain.tip;
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
    if (chain.external) this.mirrorRecord(root, lockDir, name);
    const published = readChain(lockDir).tip;
    if (published.record.version !== 2 || published.record.state !== "active" ||
        published.record.leaseId !== replacement.leaseId) {
      throw new Error("provider home lease changed during recovery; retry");
    }
  }

  private assertAbandoned(record: ProviderHomeLeaseRecord, lockDir: string): void {
    if (record.hostname !== this.hostname) throw refusal(lockDir, `is leased by host ${record.hostname}; use an isolated OS account`);
    if (this.isProcessAlive(record.pid)) throw refusal(lockDir, `is already in use by process ${record.pid}; use bwrap or an isolated OS account`);
    if (record.ownerHash !== this.ownerHash) throw refusal(lockDir, "has a stale lease from another attested owner");
  }

  private recoverPartialJournal(root: string, lockDir: string, replacement: ProviderHomeLeaseRecordV2): void {
    const snapshot = () => {
      const stat = lstatSync(lockDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw unexpectedEntries(lockDir);
      const entries = readdirSync(lockDir).sort();
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
    this.mirrorRecord(root, lockDir, RECOVERY_MARKER, "checkpoint.json");
    const published = readChain(lockDir).tip;
    if (!sameTip(published, { record: replacement, hash: readRecord(join(root, RECOVERY_MARKER)).hash })) {
      throw new Error("provider home lease changed during recovery; retry");
    }
  }

  private mirrorRecord(root: string, lockDir: string, name: string, mirror = name, required = false): void {
    try { linkSync(join(root, name), join(lockDir, mirror)); } catch (error) {
      if (required && ((error as NodeJS.ErrnoException).code !== "EEXIST" ||
          readRecord(join(root, name)).hash !== readRecord(join(lockDir, mirror)).hash)) throw error;
      // The immutable external journal is authoritative. A missing mirror is recoverable;
      // conflicting or changed mirror bytes are detected by readChain and remain fail-closed.
    }
  }

  releaseAll(): void {
    for (const held of this.held.values()) this.releaseHeld(held);
    this.held.clear();
  }

  /** Release one exact home after its supervised process tree is reaped. */
  releaseHome(requestedHome: string): boolean {
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
    return true;
  }

  private releaseHeld({ leaseId, lockDir, root }: { leaseId: string; lockDir: string; root: string }): boolean {
    try {
      const chain = readChain(lockDir);
      const current = chain.tip;
      if (current.record.version !== 2 || current.record.state !== "active" ||
          current.record.leaseId !== leaseId) return false;
      const released: ProviderHomeLeaseRecordV2 = {
        ...current.record,
        state: "released",
        leaseId: randomUUID(),
        previousLeaseId: current.record.leaseId,
        previousRecordHash: current.hash,
        createdAt: new Date().toISOString(),
      };
      const name = `next-${current.record.leaseId}.json`;
      publishRecord(root, join(chain.external ? root : lockDir, name), released);
      if (chain.external) this.mirrorRecord(root, lockDir, name);
      return true;
    } catch {
      // Never remove or supersede unreadable or replacement ownership evidence.
      return false;
    }
  }
}
