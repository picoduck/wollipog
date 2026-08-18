import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
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
const LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX_RECORD_BYTES = 4_096;
const MARKER = "lease.json";
const RECLAIM_PREFIX = "mutable-home.reclaimed-";
/** Publication retries allowed after a reclaim hands the lock back unheld. Bounded so a stream
 * of competing runners cannot spin here forever. */
const RECLAIM_ATTEMPTS = 2;

interface ProviderHomeLeaseRecord {
  version: 1;
  ownerHash: string;
  leaseId: string;
  pid: number;
  hostname: string;
  provider: string;
  createdAt: string;
}

export interface ProviderHomeLeaseOptions {
  pid?: number;
  hostname?: string;
  isProcessAlive?: (pid: number) => boolean;
  beforeMarkerWriteForTest?: () => void;
  beforeReclaimConfirmForTest?: (quarantine: string) => void;
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

function readRecord(path: string): ProviderHomeLeaseRecord {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw new Error("provider-home lease metadata is unsafe");
    const value = JSON.parse(readFileSync(fd, "utf8")) as Partial<ProviderHomeLeaseRecord>;
    if (value.version !== 1 || !OWNER_HASH.test(value.ownerHash ?? "") ||
        !LEASE_ID.test(value.leaseId ?? "") || !Number.isSafeInteger(value.pid) || (value.pid ?? 0) <= 0 ||
        typeof value.hostname !== "string" || !PROVIDER_KEY.test(value.provider ?? "") ||
        typeof value.createdAt !== "string") {
      throw new Error("provider-home lease metadata is invalid");
    }
    return value as ProviderHomeLeaseRecord;
  } finally {
    closeSync(fd);
  }
}

/**
 * A runner holds one lease for each mutable provider home until shutdown. This is deliberately
 * coarser than session admission: Claude/Codex mix auth, config, caches and transcripts in HOME,
 * so allowing a second control plane between turns would still permit cross-owner mutation.
 */
export class ProviderHomeLeaseRegistry {
  private readonly held = new Map<string, { leaseId: string; lockDir: string }>();
  private readonly pid: number;
  private readonly hostname: string;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly beforeMarkerWriteForTest?: () => void;
  private readonly beforeReclaimConfirmForTest?: (quarantine: string) => void;

  constructor(private readonly ownerHash: string, options: ProviderHomeLeaseOptions = {}) {
    if (!OWNER_HASH.test(ownerHash)) throw new Error("provider-home lease requires an attested owner hash");
    this.pid = options.pid ?? process.pid;
    this.hostname = options.hostname ?? systemHostname();
    this.isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
    this.beforeMarkerWriteForTest = options.beforeMarkerWriteForTest;
    this.beforeReclaimConfirmForTest = options.beforeReclaimConfirmForTest;
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
    const leaseId = randomUUID();
    const record: ProviderHomeLeaseRecord = {
      version: 1,
      ownerHash: this.ownerHash,
      leaseId,
      pid: this.pid,
      hostname: this.hostname,
      provider,
      createdAt: new Date().toISOString(),
    };
    for (let attempt = 0; attempt <= RECLAIM_ATTEMPTS; attempt++) {
      let lockCreated = false;
      try {
        mkdirSync(lockDir, { mode: 0o700 });
        lockCreated = true;
        this.beforeMarkerWriteForTest?.();
        writeFileSync(join(lockDir, MARKER), `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
        this.held.set(key, { leaseId, lockDir });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          // No provider has launched yet, so this call can safely unwind only the lock it created.
          if (lockCreated) {
            rmSync(join(lockDir, MARKER), { force: true });
            try {
              rmdirSync(lockDir);
            } catch {
              // Unexpected concurrent entries remain fail-closed and available for inspection.
            }
          }
          throw error;
        }
        if (attempt === RECLAIM_ATTEMPTS) break;
        // Reclaiming leaves the lock unheld, so publication is retried rather than resolved here.
        this.reclaimAbandonedLease(root, lockDir, leaseId);
      }
    }
    this.rejectExistingLease(lockDir);
  }

  /** True only for a record this same runner identity abandoned on this host. A different attested
   * owner, a different host, or a live process is never reclaimed automatically: those are the
   * cases where a second control plane could still be mutating auth, config, caches or transcripts
   * under the shared HOME. */
  private isAbandonedByThisOwner(record: ProviderHomeLeaseRecord): boolean {
    return record.hostname === this.hostname && record.ownerHash === this.ownerHash &&
      !this.isProcessAlive(record.pid);
  }

  /**
   * Move an abandoned lock aside so the caller can publish a fresh one, restoring the previous
   * requirement that a crashed runner recovers without hand-editing the filesystem.
   *
   * The rename is the mutual exclusion: it is atomic, the destination is unique to this attempt,
   * and every loser observes ENOENT and retries against whichever lock exists next. The record is
   * re-read afterwards because a competing reclaim can replace a dead lease with a live one between
   * the inspection and the move; that lock is put back untouched and left to manual recovery.
   */
  private reclaimAbandonedLease(root: string, lockDir: string, attemptId: string): void {
    const entries = readdirSync(lockDir);
    if (entries.length !== 1 || entries[0] !== MARKER) this.rejectExistingLease(lockDir);
    if (!this.isAbandonedByThisOwner(readRecord(join(lockDir, MARKER)))) this.rejectExistingLease(lockDir);
    const quarantine = join(root, `${RECLAIM_PREFIX}${attemptId}`);
    try {
      renameSync(lockDir, quarantine);
    } catch (error) {
      // A competing reclaim already moved this lock; retry against the current holder.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let confirmed: ProviderHomeLeaseRecord;
    try {
      this.beforeReclaimConfirmForTest?.(quarantine);
      confirmed = readRecord(join(quarantine, MARKER));
    } catch (error) {
      this.restoreReclaimedLease(quarantine, lockDir);
      throw error;
    }
    if (!this.isAbandonedByThisOwner(confirmed)) {
      this.restoreReclaimedLease(quarantine, lockDir);
      this.rejectExistingLease(lockDir);
    }
    // The record is proven to name this owner's dead process, so its evidence is ours to discard.
    rmSync(join(quarantine, MARKER), { force: true });
    try {
      rmdirSync(quarantine);
    } catch {
      // Unexpected concurrent entries remain fail-closed and available for inspection.
    }
  }

  private restoreReclaimedLease(quarantine: string, lockDir: string): void {
    try {
      renameSync(quarantine, lockDir);
    } catch (error) {
      throw new Error(
        `provider home lease could not be restored to ${lockDir} after an aborted reclaim; the ` +
          `record is preserved at ${quarantine} and requires manual recovery`,
        { cause: error },
      );
    }
  }

  private rejectExistingLease(lockDir: string): never {
    const marker = join(lockDir, MARKER);
    const entries = readdirSync(lockDir);
    if (entries.length === 0) {
      throw new Error(
        `provider home lease at ${lockDir} is incomplete; after proving no provider process uses this HOME, quarantine the empty directory and retry`,
      );
    }
    if (entries.length !== 1 || entries[0] !== MARKER) {
      throw new Error(`provider home lease directory ${lockDir} contains unexpected entries; refusing unsafe recovery`);
    }
    const existing = readRecord(marker);
    if (existing.hostname !== this.hostname) {
      throw new Error(`provider home is leased by host ${existing.hostname}; use an isolated OS account`);
    }
    if (this.isProcessAlive(existing.pid)) {
      throw new Error(`provider home is already in use by process ${existing.pid}; use bwrap or an isolated OS account`);
    }
    if (existing.ownerHash !== this.ownerHash) {
      throw new Error(
        `provider home has a stale lease from process ${existing.pid} held by another attested owner; after proving no provider process uses this HOME, manually quarantine ${lockDir} and retry`,
      );
    }
    throw new Error(
      `provider home has a stale lease from process ${existing.pid}; after proving no provider process uses this HOME, manually quarantine ${lockDir} and retry`,
    );
  }

  releaseAll(): void {
    for (const { leaseId, lockDir } of this.held.values()) {
      try {
        const marker = join(lockDir, MARKER);
        const current = readRecord(marker);
        if (current.leaseId !== leaseId) continue;
        rmSync(marker);
        rmdirSync(lockDir);
      } catch {
        // Never remove unreadable or replacement ownership evidence.
      }
    }
    this.held.clear();
  }
}
