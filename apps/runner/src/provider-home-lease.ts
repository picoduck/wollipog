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
const MAX_RECORD_BYTES = 4_096;
const MARKER = "lease.json";

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
  return isolation === undefined || isolation.backend === "seatbelt" || isolation.backend === "windows-job";
}

function readRecord(path: string): ProviderHomeLeaseRecord {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw new Error("provider-home lease metadata is unsafe");
    const value = JSON.parse(readFileSync(fd, "utf8")) as Partial<ProviderHomeLeaseRecord>;
    if (value.version !== 1 || !OWNER_HASH.test(value.ownerHash ?? "") ||
        typeof value.leaseId !== "string" || !Number.isSafeInteger(value.pid) || (value.pid ?? 0) <= 0 ||
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

  constructor(private readonly ownerHash: string, options: ProviderHomeLeaseOptions = {}) {
    if (!OWNER_HASH.test(ownerHash)) throw new Error("provider-home lease requires an attested owner hash");
    this.pid = options.pid ?? process.pid;
    this.hostname = options.hostname ?? systemHostname();
    this.isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
  }

  acquire(request: ProviderHomeLeaseRequest): void {
    if (!providerLaunchNeedsSharedHomeLease(request.isolation)) return;
    const provider = providerKey(request.driver, request.command);
    if (request.context.kind === "wsl") {
      throw new Error(
        `shared ${provider} provider home in WSL cannot be safely owner-leased; select bwrap isolation or use a dedicated distro/OS account`,
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
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      writeFileSync(join(lockDir, MARKER), `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      this.recoverOrReject(lockDir, record);
    }
    this.held.set(key, { leaseId, lockDir });
  }

  private recoverOrReject(lockDir: string, replacement: ProviderHomeLeaseRecord): void {
    const recoveryDir = `${lockDir}.recovery`;
    try {
      mkdirSync(recoveryDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`provider home lease recovery is already in progress at ${recoveryDir}; retry shortly`);
      }
      throw error;
    }
    try {
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
      const confirmed = readRecord(marker);
      if (confirmed.leaseId !== existing.leaseId) throw new Error("provider home lease changed during recovery; retry");
      rmSync(marker);
      rmdirSync(lockDir);
      mkdirSync(lockDir, { mode: 0o700 });
      writeFileSync(join(lockDir, MARKER), `${JSON.stringify(replacement)}\n`, { flag: "wx", mode: 0o600 });
    } finally {
      rmdirSync(recoveryDir);
    }
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
