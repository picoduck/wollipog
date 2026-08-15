import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
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
import { hostname as systemHostname } from "node:os";
import { basename, dirname, join } from "node:path";

const OWNER_FILE = ".wollipog-runner-owner-v1.json";
const LEASE_FILE = ".wollipog-runner-active-v1.lock";
const RECOVERY_DIR = ".wollipog-runner-lease-recovery-v1";
const MAX_METADATA_BYTES = 4_096;
const LEGACY_CREDENTIAL = join("credentials", "active-runner-token");

export interface RunnerDataDirIdentity {
  runnerId: string;
  controlPlaneUrl: string;
  controlPlaneInstanceId: string;
}

interface OwnerRecord {
  version: 1 | 2;
  ownerHash: string;
  legacyMigration?: {
    authorization: "--adopt-legacy-data-dir";
    authorizedAt: string;
  };
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
  migratedLegacyDataDir: boolean;
  ownerHash: string;
  release(): void;
}

export type RunnerDataDirDurabilityOperation =
  | "mkdir"
  | "fsync-file"
  | "link"
  | "fsync-directory"
  | "unlink";

export interface RunnerDataDirLeaseOptions {
  pid?: number;
  hostname?: string;
  isProcessAlive?: (pid: number) => boolean;
  /** One-time operator acknowledgement that every pre-ownership runner using this root is stopped. */
  adoptLegacyDataDir?: boolean;
  /** Fault/ordering hook used only by the filesystem durability regressions. */
  beforeDurabilityOperationForTest?: (operation: RunnerDataDirDurabilityOperation, path: string) => void;
  /** Set only after the v1 scoped credential independently attests to this stable CP identity. */
  allowLegacyEndpointMigration?: boolean;
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
  if (/^127(?:\.\d{1,3}){3}$/u.test(endpoint.hostname) || ["localhost", "[::1]"].includes(endpoint.hostname)) {
    endpoint.hostname = "localhost";
    endpoint.port = "";
  }
  return endpoint.toString();
}

export function runnerDataDirOwnerHash(identity: RunnerDataDirIdentity): string {
  return sha256(`${identity.runnerId}\0${identity.controlPlaneInstanceId.toLowerCase()}`);
}

/** v1 used the mutable network endpoint. Retained only for an attested, lease-protected upgrade. */
export function legacyRunnerDataDirOwnerHash(identity: Pick<RunnerDataDirIdentity, "runnerId" | "controlPlaneUrl">): string {
  return sha256(`${identity.runnerId}\0${normalizeControlPlaneEndpoint(identity.controlPlaneUrl)}`);
}

export function scopedRunnerCredentialFile(dataDir: string, identity: RunnerDataDirIdentity): string {
  return join(dataDir, "credentials", "instances", runnerDataDirOwnerHash(identity), "active-runner-token");
}

/** Read-only upgrade probe used before stores and before the lease. It returns a credential only
 * when the protected v1 marker exactly matches this runner and endpoint. */
export function readV1RunnerCredentialForAttestation(
  requestedDataDir: string,
  identity: Pick<RunnerDataDirIdentity, "runnerId" | "controlPlaneUrl">,
): string | null {
  if (!existsSync(requestedDataDir)) return null;
  const dataDir = realpathSync(requestedDataDir);
  const ownerPath = join(dataDir, OWNER_FILE);
  if (!existsSync(ownerPath)) return null;
  const owner = parseRecord<OwnerRecord>(ownerPath);
  const legacyHash = legacyRunnerDataDirOwnerHash(identity);
  if (owner.version !== 1 || owner.ownerHash !== legacyHash) return null;
  const credential = join(dataDir, "credentials", "instances", legacyHash, "active-runner-token");
  return existsSync(credential) ? protectedRead(credential).toString("utf8").trim() : null;
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

function sameSecret(left: Buffer, right: Buffer): boolean {
  const rightHash = createHash("sha256").update(right).digest();
  const leftHash = createHash("sha256").update(left).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function legacyCredentialForClaim(dataDir: string): Buffer | null {
  const credentialFile = join(dataDir, LEGACY_CREDENTIAL);
  if (!existsSync(credentialFile)) return null;
  try {
    return protectedRead(credentialFile);
  } catch (error) {
    throw new Error(`legacy runner credential cannot be safely adopted: ${(error as Error).message}`);
  }
}

const WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_ERRORS = new Set(["EINVAL", "EISDIR", "EPERM"]);

export function canIgnoreRunnerDataDirDirectorySyncError(
  error: NodeJS.ErrnoException,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && typeof error.code === "string" && WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_ERRORS.has(error.code);
}

function beforeDurabilityOperation(
  options: RunnerDataDirLeaseOptions,
  operation: RunnerDataDirDurabilityOperation,
  path: string,
): void {
  options.beforeDurabilityOperationForTest?.(operation, path);
}

function syncDirectory(directory: string, options: RunnerDataDirLeaseOptions): void {
  beforeDurabilityOperation(options, "fsync-directory", directory);
  let fd: number | undefined;
  try {
    fd = openSync(directory, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (error) {
    if (!canIgnoreRunnerDataDirDirectorySyncError(error as NodeJS.ErrnoException)) {
      throw new Error(`could not durably publish runner data directory ${directory}: ${(error as Error).message}`, { cause: error });
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function ensureDurableDirectory(directory: string, options: RunnerDataDirLeaseOptions): void {
  const missing: string[] = [];
  let cursor = directory;
  while (!existsSync(cursor)) {
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const path of missing.reverse()) {
    beforeDurabilityOperation(options, "mkdir", path);
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      chmodSync(path, 0o700);
    } catch {
      // Windows ACLs are managed by the owning account.
    }
    syncDirectory(dirname(path), options);
  }
}

function publishProtected(
  file: string,
  contents: string | Buffer,
  options: RunnerDataDirLeaseOptions,
): void {
  const temp = join(dirname(file), `.${basename(file)}.publish-${process.pid}-${randomUUID()}`);
  writeFileSync(temp, contents, { flag: "wx", mode: 0o600 });
  try {
    try {
      chmodSync(temp, 0o600);
    } catch {
      // Windows ACLs are managed by the owning account.
    }
    const fd = openSync(temp, constants.O_RDONLY);
    try {
      beforeDurabilityOperation(options, "fsync-file", temp);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      beforeDurabilityOperation(options, "link", file);
      linkSync(temp, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
      throw new Error(`runner data directory must support protected hard-link publication: ${(error as Error).message}`);
    }
    syncDirectory(dirname(file), options);
  } finally {
    beforeDurabilityOperation(options, "unlink", temp);
    rmSync(temp, { force: true });
    syncDirectory(dirname(file), options);
  }
}

function writeProtected(file: string, value: unknown, options: RunnerDataDirLeaseOptions): void {
  publishProtected(file, `${JSON.stringify(value)}\n`, options);
}

function replaceProtected(
  file: string,
  value: unknown,
  options: RunnerDataDirLeaseOptions,
): void {
  const temp = join(dirname(file), `.${basename(file)}.replace-${process.pid}-${randomUUID()}`);
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  try {
    try { chmodSync(temp, 0o600); } catch { /* Windows ACLs are managed by the owning account. */ }
    const fd = openSync(temp, constants.O_RDONLY);
    try {
      beforeDurabilityOperation(options, "fsync-file", temp);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
    syncDirectory(dirname(file), options);
  } finally {
    beforeDurabilityOperation(options, "unlink", temp);
    rmSync(temp, { force: true });
    syncDirectory(dirname(file), options);
  }
}

function migrateV1Credential(
  dataDir: string,
  identity: RunnerDataDirIdentity,
  options: RunnerDataDirLeaseOptions,
): void {
  const oldFile = join(dataDir, "credentials", "instances", legacyRunnerDataDirOwnerHash(identity), "active-runner-token");
  if (!existsSync(oldFile)) return;
  const newFile = scopedRunnerCredentialFile(dataDir, identity);
  const legacy = protectedRead(oldFile);
  ensureDurableDirectory(dirname(newFile), options);
  if (!existsSync(newFile)) publishProtected(newFile, legacy, options);
  else if (!sameSecret(protectedRead(newFile), legacy)) {
    throw new Error(`stable runner credential at ${newFile} conflicts with v1 migration`);
  }
}

/**
 * Claim a runner state root before any mutable store is opened. The durable owner marker prevents
 * a later runner identity from silently adopting the root, while the process lease rejects live
 * concurrent use. A legacy root is claimed once under the lease because it has no owner metadata.
 */
function acquireRunnerDataDirLeaseAt(
  requestedDataDir: string,
  identity: RunnerDataDirIdentity,
  options: RunnerDataDirLeaseOptions = {},
  allowOwnerNamespace = true,
): RunnerDataDirLease {
  ensureDurableDirectory(requestedDataDir, options);
  const dataDir = realpathSync(requestedDataDir);
  const ownerHash = runnerDataDirOwnerHash(identity);
  const legacyOwnerHash = legacyRunnerDataDirOwnerHash(identity);
  const ownerPath = join(dataDir, OWNER_FILE);
  const leasePath = join(dataDir, LEASE_FILE);
  const recoveryPath = join(dataDir, RECOVERY_DIR);
  const pid = options.pid ?? process.pid;
  const hostname = options.hostname ?? systemHostname();
  const isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
  const leaseId = randomUUID();
  const ownerExistedAtClaim = existsSync(ownerPath);
  const legacyMigrationRequired = !ownerExistedAtClaim && readdirSync(dataDir).some(
    (entry) => entry !== LEASE_FILE && entry !== RECOVERY_DIR,
  );

  if (allowOwnerNamespace && ownerExistedAtClaim) {
    const existingOwner = parseRecord<OwnerRecord>(ownerPath);
    if (![1, 2].includes(existingOwner.version) || typeof existingOwner.ownerHash !== "string") {
      throw new Error(`runner data directory ${dataDir} has invalid owner metadata; refusing unsafe recovery`);
    }
    const canMigrateLegacyEndpoint = options.allowLegacyEndpointMigration
      && existingOwner.version === 1
      && existingOwner.ownerHash === legacyOwnerHash;
    if (existingOwner.ownerHash !== ownerHash && !canMigrateLegacyEndpoint) {
      if (options.adoptLegacyDataDir) {
        throw new Error(
          `runner data directory ${dataDir} is already owned by another runner; refusing to record legacy adoption in a replacement namespace`,
        );
      }
      return acquireRunnerDataDirLeaseAt(join(dataDir, "runner-instances", ownerHash), identity, options, false);
    }
  }

  if (legacyMigrationRequired && !options.adoptLegacyDataDir) {
    throw new Error(
      `runner data directory ${dataDir} contains legacy state without an owner marker; stop every pre-upgrade runner using this root, then retry once with --adopt-legacy-data-dir`,
    );
  }

  const lease: LeaseRecord = {
    version: 1,
    ownerHash,
    leaseId,
    pid,
    hostname,
    createdAt: new Date().toISOString(),
  };
  if (existsSync(recoveryPath)) {
    throw new Error(`runner data directory ${dataDir} lease recovery is present; retry shortly, then verify no runner is active before removing ${recoveryPath}`);
  }
  try {
    writeProtected(leasePath, lease, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      beforeDurabilityOperation(options, "mkdir", recoveryPath);
      mkdirSync(recoveryPath);
      syncDirectory(dataDir, options);
    } catch (guardError) {
      if ((guardError as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`runner data directory ${dataDir} lease recovery is already in progress; retry startup`);
      }
      throw guardError;
    }
    try {
      let existing: LeaseRecord;
      try {
        existing = parseRecord<LeaseRecord>(leasePath);
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`runner data directory ${dataDir} lease changed during recovery; retry startup`);
        }
        throw readError;
      }
      if (
        existing.version !== 1 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(existing.leaseId) ||
        !Number.isSafeInteger(existing.pid) ||
        existing.pid <= 0 ||
        typeof existing.hostname !== "string" ||
        !/^[a-f0-9]{64}$/u.test(existing.ownerHash)
      ) {
        throw new Error(`runner data directory ${dataDir} has an invalid active lease; refusing unsafe recovery`);
      }
      if (allowOwnerNamespace && existing.ownerHash !== ownerHash && !(
        options.allowLegacyEndpointMigration && existing.ownerHash === legacyOwnerHash
      )) {
        return acquireRunnerDataDirLeaseAt(join(dataDir, "runner-instances", ownerHash), identity, options, false);
      }
      if (existing.hostname !== hostname) {
        throw new Error(`runner data directory ${dataDir} is leased by host ${existing.hostname}; use a distinct --data-dir`);
      }
      if (isProcessAlive(existing.pid)) {
        throw new Error(`runner data directory ${dataDir} is already in use by process ${existing.pid}; use a distinct --data-dir`);
      }
      beforeDurabilityOperation(options, "unlink", leasePath);
      rmSync(leasePath);
      syncDirectory(dataDir, options);
      writeProtected(leasePath, lease, options);
    } finally {
      beforeDurabilityOperation(options, "unlink", recoveryPath);
      rmdirSync(recoveryPath);
      syncDirectory(dataDir, options);
    }
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    try {
      const current = parseRecord<LeaseRecord>(leasePath);
      if (current.leaseId === leaseId) {
        beforeDurabilityOperation(options, "unlink", leasePath);
        rmSync(leasePath, { force: true });
        syncDirectory(dataDir, options);
      }
    } catch {
      // Never remove an unreadable or replacement lease.
    }
    released = true;
  };

  try {
    if (existsSync(ownerPath)) {
      const owner = parseRecord<OwnerRecord>(ownerPath);
      if (options.allowLegacyEndpointMigration && owner.version === 1 && owner.ownerHash === legacyOwnerHash) {
        migrateV1Credential(dataDir, identity, options);
        replaceProtected(ownerPath, {
          version: 2,
          ownerHash,
          ...(owner.legacyMigration ? { legacyMigration: owner.legacyMigration } : {}),
        } satisfies OwnerRecord, options);
      } else if (owner.version !== 2 || owner.ownerHash !== ownerHash) {
        release();
        if (options.adoptLegacyDataDir) {
          throw new Error(
            `runner data directory ${dataDir} became owned by another runner while legacy adoption was starting; refusing to record adoption in a replacement namespace`,
          );
        }
        if (allowOwnerNamespace) {
          return acquireRunnerDataDirLeaseAt(join(dataDir, "runner-instances", ownerHash), identity, options, false);
        }
        throw new Error(`runner data directory ${dataDir} has invalid owner metadata; refusing unsafe recovery`);
      }
    } else {
      const legacyCredential = legacyCredentialForClaim(dataDir);
      if (legacyCredential) {
        const scopedCredential = scopedRunnerCredentialFile(dataDir, identity);
        ensureDurableDirectory(dirname(scopedCredential), options);
        if (!existsSync(scopedCredential)) {
          publishProtected(scopedCredential, legacyCredential, options);
        } else if (!sameSecret(protectedRead(scopedCredential), legacyCredential)) {
          throw new Error(`scoped runner credential at ${scopedCredential} conflicts with legacy migration`);
        }
      }
      writeProtected(ownerPath, {
        version: 2,
        ownerHash,
        ...(legacyMigrationRequired ? {
          legacyMigration: {
            authorization: "--adopt-legacy-data-dir" as const,
            authorizedAt: new Date().toISOString(),
          },
        } : {}),
      } satisfies OwnerRecord, options);
    }
  } catch (error) {
    release();
    throw error;
  }

  return {
    dataDir,
    credentialFile: scopedRunnerCredentialFile(dataDir, identity),
    migratedLegacyDataDir: legacyMigrationRequired,
    ownerHash,
    release,
  };
}

export function acquireRunnerDataDirLease(
  requestedDataDir: string,
  identity: RunnerDataDirIdentity,
  options: RunnerDataDirLeaseOptions = {},
): RunnerDataDirLease {
  return acquireRunnerDataDirLeaseAt(requestedDataDir, identity, options);
}
