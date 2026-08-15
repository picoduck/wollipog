import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname as systemHostname } from "node:os";
import { dirname, join } from "node:path";

const OWNER_FILE = ".wollipog-runner-owner-v1.json";
const LEASE_FILE = ".wollipog-runner-active-v1.lock";
const MAX_METADATA_BYTES = 4_096;
const LEGACY_CREDENTIAL = join("credentials", "active-runner-token");
const LEGACY_STATE_ENTRIES = [
  "admission",
  "checkpoint-ref-ownership",
  "command-receipts",
  "conductor",
  "hooks",
  "provider-state",
  "provider-state-cleanup",
  "registry",
  "session-command-receipts",
  "sessions",
  "worktree-cleanup.json",
  "worktrees",
];

export interface RunnerDataDirIdentity {
  runnerId: string;
  controlPlaneUrl: string;
}

interface OwnerRecord {
  version: 1;
  ownerHash: string;
}

interface LeaseRecord extends OwnerRecord {
  leaseId: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

export interface RunnerDataDirLease {
  dataDir: string;
  credentialFile: string;
  release(): void;
}

export interface RunnerDataDirLeaseOptions {
  pid?: number;
  hostname?: string;
  isProcessAlive?: (pid: number) => boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeControlPlaneEndpoint(controlPlaneUrl: string): string {
  const endpoint = new URL(controlPlaneUrl);
  if (endpoint.username || endpoint.password) {
    throw new Error("control-plane URL must not contain embedded credentials");
  }
  endpoint.hash = "";
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "") || "/";
  return endpoint.toString();
}

export function runnerDataDirOwnerHash(identity: RunnerDataDirIdentity): string {
  return sha256(`${identity.runnerId}\0${normalizeControlPlaneEndpoint(identity.controlPlaneUrl)}`);
}

export function scopedRunnerCredentialFile(dataDir: string, identity: RunnerDataDirIdentity): string {
  return join(dataDir, "credentials", "instances", runnerDataDirOwnerHash(identity), "active-runner-token");
}

function protectedRead(file: string): Buffer {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) {
      throw new Error(`unsafe runner data metadata file: ${file}`);
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function parseRecord<T>(file: string): T {
  try {
    return JSON.parse(protectedRead(file).toString("utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new Error(`could not safely read runner data metadata ${file}: ${(error as Error).message}`);
  }
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sameSecret(left: Buffer, right: string): boolean {
  const rightHash = createHash("sha256").update(right).digest();
  const leftHash = createHash("sha256").update(left).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function legacyCredentialForClaim(dataDir: string, token: string): Buffer | null {
  const credentialFile = join(dataDir, LEGACY_CREDENTIAL);
  const hasLegacyState = existsSync(credentialFile) || LEGACY_STATE_ENTRIES.some((entry) => existsSync(join(dataDir, entry)));
  if (!hasLegacyState) return null;
  if (!existsSync(credentialFile)) {
    throw new Error(
      `legacy runner data at ${dataDir} has no ownership marker or active credential; move it aside or select a distinct --data-dir`,
    );
  }
  let legacyToken: Buffer;
  try {
    legacyToken = protectedRead(credentialFile);
  } catch (error) {
    throw new Error(`legacy runner credential cannot be safely adopted: ${(error as Error).message}`);
  }
  if (!sameSecret(legacyToken, token)) {
    throw new Error(
      `legacy runner data at ${dataDir} is bound to another credential; use its matching token or select a distinct --data-dir`,
    );
  }
  return legacyToken;
}

function writeProtected(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows ACLs are managed by the owning account.
  }
}

/**
 * Claim a runner state root before any mutable store is opened. The durable owner marker prevents
 * a later runner identity from silently adopting the root, while the process lease rejects live
 * concurrent use. A legacy root is adopted only when its protected active token matches exactly.
 */
export function acquireRunnerDataDirLease(
  requestedDataDir: string,
  identity: RunnerDataDirIdentity,
  token: string,
  options: RunnerDataDirLeaseOptions = {},
): RunnerDataDirLease {
  mkdirSync(requestedDataDir, { recursive: true });
  const dataDir = realpathSync(requestedDataDir);
  const ownerHash = runnerDataDirOwnerHash(identity);
  const ownerPath = join(dataDir, OWNER_FILE);
  const leasePath = join(dataDir, LEASE_FILE);
  const pid = options.pid ?? process.pid;
  const hostname = options.hostname ?? systemHostname();
  const isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
  const leaseId = randomUUID();

  for (;;) {
    const lease: LeaseRecord = {
      version: 1,
      ownerHash,
      leaseId,
      pid,
      hostname,
      createdAt: new Date().toISOString(),
    };
    try {
      writeProtected(leasePath, lease);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: LeaseRecord;
      try {
        existing = parseRecord<LeaseRecord>(leasePath);
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw readError;
      }
      if (
        existing.version !== 1 ||
        typeof existing.leaseId !== "string" ||
        !Number.isSafeInteger(existing.pid) ||
        existing.pid <= 0 ||
        typeof existing.hostname !== "string" ||
        typeof existing.ownerHash !== "string"
      ) {
        throw new Error(`runner data directory ${dataDir} has an invalid active lease; refusing unsafe recovery`);
      }
      if (existing.hostname !== hostname) {
        throw new Error(`runner data directory ${dataDir} is leased by host ${existing.hostname}; use a distinct --data-dir`);
      }
      if (isProcessAlive(existing.pid)) {
        throw new Error(`runner data directory ${dataDir} is already in use by process ${existing.pid}; use a distinct --data-dir`);
      }
      const stalePath = `${leasePath}.stale-${existing.leaseId}`;
      try {
        renameSync(leasePath, stalePath);
        rmSync(stalePath, { force: true });
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
      }
    }
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    try {
      const current = parseRecord<LeaseRecord>(leasePath);
      if (current.leaseId === leaseId) rmSync(leasePath, { force: true });
    } catch {
      // Never remove an unreadable or replacement lease.
    }
    released = true;
  };

  try {
    if (existsSync(ownerPath)) {
      const owner = parseRecord<OwnerRecord>(ownerPath);
      if (owner.version !== 1 || owner.ownerHash !== ownerHash) {
        throw new Error(
          `runner data directory ${dataDir} belongs to a different runner or control plane; use a distinct --data-dir`,
        );
      }
    } else {
      const legacyCredential = legacyCredentialForClaim(dataDir, token);
      if (legacyCredential) {
        const scopedCredential = scopedRunnerCredentialFile(dataDir, identity);
        mkdirSync(dirname(scopedCredential), { recursive: true });
        if (!existsSync(scopedCredential)) {
          writeFileSync(scopedCredential, legacyCredential, { flag: "wx", mode: 0o600 });
          try {
            chmodSync(scopedCredential, 0o600);
          } catch {
            // Windows ACLs are managed by the owning account.
          }
        } else if (!sameSecret(protectedRead(scopedCredential), legacyCredential.toString("utf8"))) {
          throw new Error(`scoped runner credential at ${scopedCredential} conflicts with legacy migration`);
        }
      }
      writeProtected(ownerPath, { version: 1, ownerHash } satisfies OwnerRecord);
    }
  } catch (error) {
    release();
    throw error;
  }

  return {
    dataDir,
    credentialFile: scopedRunnerCredentialFile(dataDir, identity),
    release,
  };
}
