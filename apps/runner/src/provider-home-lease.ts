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
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname as systemHostname } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AgentContext, AgentDriverKind } from "@wollipog/protocol";
import type { SpawnIsolation } from "./spawn.js";

const OWNER_HASH = /^[a-f0-9]{64}$/u;
const PROVIDER_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_RECORD_BYTES = 4_096;
const LEGACY_MARKER = "lease.json";
const GENESIS_MARKER = /^lease-([0-9a-f-]+)\.json$/u;

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
}

export interface ProviderHomeLeaseOptions {
  pid?: number;
  hostname?: string;
  isProcessAlive?: (pid: number) => boolean;
  beforeMarkerWriteForTest?: () => void;
  beforeTransitionPublishForTest?: () => void;
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
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function providerKey(driver: AgentDriverKind, command: string): string {
  if (driver === "claude-code") return "claude";
  if (driver === "codex" || driver === "codex-app-server") return "codex";
  return `acp-${createHash("sha256").update(command).digest("hex").slice(0, 16)}`;
}

/** bwrap redirects mutable transcripts; container/cloud providers do not mutate the host home. */
export function providerLaunchNeedsSharedHomeLease(isolation?: SpawnIsolation): boolean {
  return isolation?.backend !== "bwrap" && isolation?.backend !== "container" &&
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
  return new Error(`provider home lease directory ${lockDir} contains unexpected entries; refusing unsafe recovery`);
}

/**
 * Resolve the immutable lease journal. A fixed successor pathname is the compare-and-swap: only
 * one process can publish the transition from a particular tip, and no record is ever removed.
 */
function readChain(lockDir: string): LeaseChain {
  const lockStat = lstatSync(lockDir);
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) throw unexpectedEntries(lockDir);
  const entries = readdirSync(lockDir).sort();
  if (entries.length === 0) {
    throw new Error(
      `provider home lease at ${lockDir} is incomplete; after proving no provider process uses this HOME, quarantine the empty directory and retry`,
    );
  }

  const entrySet = new Set(entries);
  let marker: string;
  let current: ReadLeaseRecord;
  if (entrySet.has(LEGACY_MARKER)) {
    marker = LEGACY_MARKER;
    current = readRecord(join(lockDir, marker));
    if (current.record.version !== 1) throw unexpectedEntries(lockDir);
  } else {
    const genesis = entries.filter((entry) => GENESIS_MARKER.test(entry));
    if (genesis.length !== 1) throw unexpectedEntries(lockDir);
    marker = genesis[0]!;
    current = readRecord(join(lockDir, marker));
    const match = GENESIS_MARKER.exec(marker);
    if (current.record.version !== 2 || current.record.previousLeaseId !== null ||
        current.record.previousRecordHash !== null || match?.[1] !== current.record.leaseId) {
      throw unexpectedEntries(lockDir);
    }
  }

  const consumed = new Set([marker]);
  const seenLeaseIds = new Set<string>();
  for (;;) {
    if (seenLeaseIds.has(current.record.leaseId)) throw unexpectedEntries(lockDir);
    seenLeaseIds.add(current.record.leaseId);
    const nextMarker = `next-${current.record.leaseId}.json`;
    if (!entrySet.has(nextMarker)) break;
    const next = readRecord(join(lockDir, nextMarker));
    if (next.record.version !== 2 || next.record.previousLeaseId !== current.record.leaseId ||
        next.record.previousRecordHash !== current.hash) {
      throw unexpectedEntries(lockDir);
    }
    consumed.add(nextMarker);
    current = next;
  }
  if (consumed.size !== entries.length) throw unexpectedEntries(lockDir);
  return { entries, tip: current };
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
  private readonly held = new Map<string, { leaseId: string; lockDir: string; root: string }>();
  private readonly pid: number;
  private readonly hostname: string;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly beforeMarkerWriteForTest?: () => void;
  private readonly beforeTransitionPublishForTest?: () => void;

  constructor(private readonly ownerHash: string, options: ProviderHomeLeaseOptions = {}) {
    if (!OWNER_HASH.test(ownerHash)) throw new Error("provider-home lease requires an attested owner hash");
    this.pid = options.pid ?? process.pid;
    this.hostname = options.hostname ?? systemHostname();
    this.isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
    this.beforeMarkerWriteForTest = options.beforeMarkerWriteForTest;
    this.beforeTransitionPublishForTest = options.beforeTransitionPublishForTest;
  }

  acquire(request: ProviderHomeLeaseRequest): void {
    if (!providerLaunchNeedsSharedHomeLease(request.isolation)) return;
    const provider = providerKey(request.driver, request.command);
    if (request.context.kind === "wsl") {
      throw new Error(
        `shared ${provider} provider home in WSL cannot be safely owner-leased; use bwrap for structured provider launches or use a dedicated distro/OS account`,
      );
    }
    const requestedHome = request.env.HOME || homedir();
    if (!isAbsolute(requestedHome)) throw new Error("provider HOME must be absolute");
    const home = realpathSync(requestedHome);
    const root = join(home, ".agent-manager", "provider-home-leases-v1");
    // ACP adapters are not provider-specific and known CLIs co-locate auth/config/cache below
    // HOME. Lease the whole effective home rather than pretending those mutations are disjoint.
    const lockDir = join(root, "mutable-home.lock");
    const key = home;
    if (this.held.has(key)) return;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const record = this.activeRecord(provider, null, null);
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      try {
        this.beforeMarkerWriteForTest?.();
        publishRecord(root, join(lockDir, `lease-${record.leaseId}.json`), record);
      } catch (error) {
        try {
          rmdirSync(lockDir);
        } catch {
          // Unexpected concurrent entries remain fail-closed and available for inspection.
        }
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      this.transitionExistingLease(root, lockDir, record);
    }
    this.held.set(key, { leaseId: record.leaseId, lockDir, root });
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
    const existing = readChain(lockDir).tip;
    if (existing.record.version === 2 && existing.record.state === "released") {
      // An orderly release is an explicit handoff and may pass the HOME to a different owner.
    } else {
      if (existing.record.hostname !== this.hostname) {
        throw new Error(`provider home is leased by host ${existing.record.hostname}; use an isolated OS account`);
      }
      if (this.isProcessAlive(existing.record.pid)) {
        throw new Error(
          `provider home is already in use by process ${existing.record.pid}; use bwrap or an isolated OS account`,
        );
      }
      if (existing.record.ownerHash !== this.ownerHash) {
        throw new Error(
          `provider home has a stale lease from another attested owner; after proving no provider process uses this HOME, manually quarantine ${lockDir} and retry`,
        );
      }
    }

    this.beforeTransitionPublishForTest?.();
    const confirmed = readChain(lockDir).tip;
    if (!sameTip(existing, confirmed)) {
      throw new Error("provider home lease changed during recovery; retry");
    }
    replacement.previousLeaseId = confirmed.record.leaseId;
    replacement.previousRecordHash = confirmed.hash;
    const target = join(lockDir, `next-${confirmed.record.leaseId}.json`);
    try {
      publishRecord(root, target, replacement);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("provider home lease changed during recovery; retry");
      }
      throw error;
    }
    const published = readChain(lockDir).tip;
    if (published.record.version !== 2 || published.record.state !== "active" ||
        published.record.leaseId !== replacement.leaseId) {
      throw new Error("provider home lease changed during recovery; retry");
    }
  }

  releaseAll(): void {
    for (const { leaseId, lockDir, root } of this.held.values()) {
      try {
        const current = readChain(lockDir).tip;
        if (current.record.version !== 2 || current.record.state !== "active" ||
            current.record.leaseId !== leaseId) continue;
        const released: ProviderHomeLeaseRecordV2 = {
          ...current.record,
          state: "released",
          leaseId: randomUUID(),
          previousLeaseId: current.record.leaseId,
          previousRecordHash: current.hash,
          createdAt: new Date().toISOString(),
        };
        publishRecord(root, join(lockDir, `next-${current.record.leaseId}.json`), released);
      } catch {
        // Never remove or supersede unreadable or replacement ownership evidence.
      }
    }
    this.held.clear();
  }
}
