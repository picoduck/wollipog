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

const LEGACY_OWNER_FILE = ".wollipog-runner-owner-v1.json";
const OWNER_FILE = ".wollipog-runner-owner-v2.json";
const LEASE_FILE = ".wollipog-runner-active-v1.lock";
const RECOVERY_DIR = ".wollipog-runner-lease-recovery-v1";
const MAX_METADATA_BYTES = 4_096;
const LEGACY_CREDENTIAL = join("credentials", "active-runner-token");
const SHA256_HEX = /^[a-f0-9]{64}$/u;

export interface RunnerDataDirIdentity {
  runnerId: string;
  controlPlaneUrl: string;
  controlPlaneInstanceId: string;
}

interface OwnerRecord {
  version: 2;
  ownerHash: string;
  legacyMigration?: {
    authorization: "--adopt-legacy-data-dir";
    authorizedAt: string;
  };
}

interface LegacyOwnerRecord extends Omit<OwnerRecord, "version"> {
  version: 1;
}

interface LeaseRecord {
  version: 1;
  ownerHash: string;
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
  /** Exact v1 credential hash proven by the current control plane before lease acquisition. */
  legacyEndpointMigrationCredentialHash?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasValidOwnerFields(value: unknown): value is Omit<OwnerRecord, "version"> & { version: unknown } {
  if (!value || typeof value !== "object") return false;
  const owner = value as Partial<OwnerRecord>;
  if (typeof owner.ownerHash !== "string"
      || !SHA256_HEX.test(owner.ownerHash)) {
    return false;
  }
  if (owner.legacyMigration === undefined) return true;
  if (!owner.legacyMigration || typeof owner.legacyMigration !== "object") return false;
  const migration = owner.legacyMigration as Partial<NonNullable<OwnerRecord["legacyMigration"]>>;
  return migration.authorization === "--adopt-legacy-data-dir"
    && typeof migration.authorizedAt === "string"
    && !Number.isNaN(Date.parse(migration.authorizedAt));
}

function isValidOwnerRecord(value: unknown): value is OwnerRecord {
  return hasValidOwnerFields(value) && value.version === 2;
}

function isValidLegacyOwnerRecord(value: unknown): value is LegacyOwnerRecord {
  return hasValidOwnerFields(value) && value.version === 1;
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
  const ownerPath = join(dataDir, LEGACY_OWNER_FILE);
  if (!existsSync(ownerPath)) return null;
  const owner = parseRecord<unknown>(ownerPath);
  if (!isValidLegacyOwnerRecord(owner)) {
    throw new Error(`runner data directory ${dataDir} has invalid owner metadata; refusing unsafe recovery`);
  }
  const legacyHash = legacyRunnerDataDirOwnerHash(identity);
  if (owner.ownerHash !== legacyHash) return null;
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

function replaceProtectedContents(
  file: string,
  contents: string | Buffer,
  options: RunnerDataDirLeaseOptions,
): void {
  const temp = join(dirname(file), `.${basename(file)}.replace-${process.pid}-${randomUUID()}`);
  writeFileSync(temp, contents, { flag: "wx", mode: 0o600 });
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

function replaceProtected(file: string, value: unknown, options: RunnerDataDirLeaseOptions): void {
  replaceProtectedContents(file, `${JSON.stringify(value)}\n`, options);
}

function migrateV1Credential(
  dataDir: string,
  identity: RunnerDataDirIdentity,
  options: RunnerDataDirLeaseOptions,
  expectedCredentialHash: string,
): void {
  const oldFile = join(dataDir, "credentials", "instances", legacyRunnerDataDirOwnerHash(identity), "active-runner-token");
  if (!existsSync(oldFile)) {
    throw new Error("v1 runner credential changed after attestation; refusing ownership migration");
  }
  const newFile = scopedRunnerCredentialFile(dataDir, identity);
  const legacy = protectedRead(oldFile);
  if (sha256(legacy.toString("utf8").trim()) !== expectedCredentialHash) {
    throw new Error("v1 runner credential changed after attestation; refusing ownership migration");
  }
  ensureDurableDirectory(dirname(newFile), options);
  if (!existsSync(newFile)) publishProtected(newFile, legacy, options);
  else if (!sameSecret(protectedRead(newFile), legacy)) {
    // A crash after credential publication but before the v2 owner marker can leave the previous
    // attested bytes here. Under the acquired v1 lease and with no v2 owner yet, the freshly
    // attested v1 credential is authoritative and can safely resume the interrupted publication.
    replaceProtectedContents(newFile, legacy, options);
  }
}

/** Keep the marker understood by the immediately previous runner generation. The stable v2
 * marker remains authoritative for current runners; v1 is frozen to the endpoint that first
 * published it so that both generations continue to coordinate through the same lease hash. */
function ensureLegacyRollbackOwner(
  file: string,
  rollbackOwnerHash: string,
  stableOwner: OwnerRecord,
  options: RunnerDataDirLeaseOptions,
): void {
  const desired = {
    version: 1,
    ownerHash: rollbackOwnerHash,
    ...(stableOwner.legacyMigration ? { legacyMigration: stableOwner.legacyMigration } : {}),
  } satisfies LegacyOwnerRecord;
  if (!existsSync(file)) {
    writeProtected(file, desired, options);
    return;
  }
  const existing = parseRecord<unknown>(file);
  if (!isValidLegacyOwnerRecord(existing)) {
    throw new Error(`runner data directory ${dirname(file)} has invalid legacy owner metadata; refusing unsafe recovery`);
  }
  if (existing.ownerHash !== rollbackOwnerHash) {
    throw new Error(`runner data directory ${dirname(file)} legacy owner changed during lease acquisition; refusing unsafe recovery`);
  }
  if (JSON.stringify(existing.legacyMigration) !== JSON.stringify(desired.legacyMigration)) {
    replaceProtected(file, desired, options);
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
  if (options.legacyEndpointMigrationCredentialHash !== undefined
      && !SHA256_HEX.test(options.legacyEndpointMigrationCredentialHash)) {
    throw new Error("attested v1 runner credential hash is invalid; refusing ownership migration");
  }
  ensureDurableDirectory(requestedDataDir, options);
  const dataDir = realpathSync(requestedDataDir);
  const ownerHash = runnerDataDirOwnerHash(identity);
  const legacyOwnerHash = legacyRunnerDataDirOwnerHash(identity);
  const ownerPath = join(dataDir, OWNER_FILE);
  const legacyOwnerPath = join(dataDir, LEGACY_OWNER_FILE);
  const leasePath = join(dataDir, LEASE_FILE);
  const recoveryPath = join(dataDir, RECOVERY_DIR);
  const pid = options.pid ?? process.pid;
  const hostname = options.hostname ?? systemHostname();
  const isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
  const leaseId = randomUUID();
  const ownerExistedAtClaim = existsSync(ownerPath) || existsSync(legacyOwnerPath);
  const legacyMigrationRequired = !ownerExistedAtClaim && readdirSync(dataDir).some(
    (entry) => entry !== LEASE_FILE && entry !== RECOVERY_DIR,
  );
  let rollbackOwnerHash = legacyOwnerHash;
  let explicitlyAdoptingLegacyEndpoint = false;

  if (ownerExistedAtClaim) {
    const hasStableOwner = existsSync(ownerPath);
    let existingOwner: OwnerRecord | LegacyOwnerRecord;
    if (hasStableOwner) {
      const parsed = parseRecord<unknown>(ownerPath);
      if (!isValidOwnerRecord(parsed)) {
        throw new Error(`runner data directory ${dataDir} has invalid owner metadata; refusing unsafe recovery`);
      }
      existingOwner = parsed;
    } else {
      const parsed = parseRecord<unknown>(legacyOwnerPath);
      if (!isValidLegacyOwnerRecord(parsed)) {
        throw new Error(`runner data directory ${dataDir} has invalid owner metadata; refusing unsafe recovery`);
      }
      existingOwner = parsed;
    }
    const canMigrateLegacyEndpoint = !hasStableOwner
      && options.legacyEndpointMigrationCredentialHash !== undefined
      && existingOwner.ownerHash === legacyOwnerHash;
    explicitlyAdoptingLegacyEndpoint = !hasStableOwner
      && options.adoptLegacyDataDir === true
      && existingOwner.ownerHash === legacyOwnerHash;
    const ownerMatches = hasStableOwner
      ? existingOwner.ownerHash === ownerHash
      : canMigrateLegacyEndpoint || explicitlyAdoptingLegacyEndpoint;
    if (!ownerMatches) {
      if (options.adoptLegacyDataDir) {
        throw new Error(
          `runner data directory ${dataDir} is already owned by another runner; refusing to record legacy adoption in a replacement namespace`,
        );
      }
      if (allowOwnerNamespace) {
        return acquireRunnerDataDirLeaseAt(join(dataDir, "runner-instances", ownerHash), identity, options, false);
      }
      throw new Error(`runner data directory ${dataDir} has conflicting owner metadata; refusing unsafe recovery`);
    }
    if (hasStableOwner && existsSync(legacyOwnerPath)) {
      const legacyOwner = parseRecord<unknown>(legacyOwnerPath);
      if (!isValidLegacyOwnerRecord(legacyOwner)) {
        throw new Error(`runner data directory ${dataDir} has invalid legacy owner metadata; refusing unsafe recovery`);
      }
      rollbackOwnerHash = legacyOwner.ownerHash;
    } else if (!hasStableOwner) {
      rollbackOwnerHash = existingOwner.ownerHash;
    }
  }

  if (legacyMigrationRequired && !options.adoptLegacyDataDir) {
    throw new Error(
      `runner data directory ${dataDir} contains legacy state without an owner marker; stop every pre-upgrade runner using this root, then retry once with --adopt-legacy-data-dir`,
    );
  }

  const lease: LeaseRecord = {
    version: 1,
    ownerHash: rollbackOwnerHash,
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
        !SHA256_HEX.test(existing.ownerHash)
      ) {
        throw new Error(`runner data directory ${dataDir} has an invalid active lease; refusing unsafe recovery`);
      }
      if (existing.ownerHash !== rollbackOwnerHash) {
        if (options.adoptLegacyDataDir) {
          throw new Error(
            `runner data directory ${dataDir} is leased by another runner; refusing to record legacy adoption in a replacement namespace`,
          );
        }
        if (allowOwnerNamespace && !ownerExistedAtClaim) {
          return acquireRunnerDataDirLeaseAt(join(dataDir, "runner-instances", ownerHash), identity, options, false);
        }
        throw new Error(`runner data directory ${dataDir} has a conflicting active lease; refusing unsafe recovery`);
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
    let stableOwner: OwnerRecord;
    if (existsSync(ownerPath)) {
      const owner = parseRecord<unknown>(ownerPath);
      if (!isValidOwnerRecord(owner)) {
        release();
        throw new Error(`runner data directory ${dataDir} has invalid owner metadata; refusing unsafe recovery`);
      }
      if (owner.ownerHash !== ownerHash) {
        release();
        if (options.adoptLegacyDataDir) {
          throw new Error(
            `runner data directory ${dataDir} became owned by another runner while legacy adoption was starting; refusing to record adoption in a replacement namespace`,
          );
        }
        if (allowOwnerNamespace) {
          return acquireRunnerDataDirLeaseAt(join(dataDir, "runner-instances", ownerHash), identity, options, false);
        }
        throw new Error(`runner data directory ${dataDir} has conflicting owner metadata; refusing unsafe recovery`);
      }
      stableOwner = owner;
    } else if (existsSync(legacyOwnerPath)) {
      const legacyOwner = parseRecord<unknown>(legacyOwnerPath);
      if (!isValidLegacyOwnerRecord(legacyOwner)) {
        release();
        throw new Error(`runner data directory ${dataDir} has invalid owner metadata; refusing unsafe recovery`);
      }
      if (options.legacyEndpointMigrationCredentialHash !== undefined
          && legacyOwner.ownerHash === legacyOwnerHash) {
        migrateV1Credential(
          dataDir,
          identity,
          options,
          options.legacyEndpointMigrationCredentialHash,
        );
        stableOwner = {
          version: 2,
          ownerHash,
          ...(legacyOwner.legacyMigration ? { legacyMigration: legacyOwner.legacyMigration } : {}),
        };
        writeProtected(ownerPath, stableOwner, options);
      } else if (explicitlyAdoptingLegacyEndpoint && legacyOwner.ownerHash === legacyOwnerHash) {
        stableOwner = {
          version: 2,
          ownerHash,
          legacyMigration: legacyOwner.legacyMigration ?? {
            authorization: "--adopt-legacy-data-dir",
            authorizedAt: new Date().toISOString(),
          },
        };
        writeProtected(ownerPath, stableOwner, options);
      } else {
        release();
        if (options.adoptLegacyDataDir) {
          throw new Error(
            `runner data directory ${dataDir} became owned by another runner while legacy adoption was starting; refusing to record adoption in a replacement namespace`,
          );
        }
        if (allowOwnerNamespace) {
          return acquireRunnerDataDirLeaseAt(join(dataDir, "runner-instances", ownerHash), identity, options, false);
        }
        throw new Error(`runner data directory ${dataDir} has conflicting owner metadata; refusing unsafe recovery`);
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
      stableOwner = {
        version: 2,
        ownerHash,
        ...(legacyMigrationRequired ? {
          legacyMigration: {
            authorization: "--adopt-legacy-data-dir" as const,
            authorizedAt: new Date().toISOString(),
          },
        } : {}),
      };
      writeProtected(ownerPath, stableOwner, options);
    }
    ensureLegacyRollbackOwner(legacyOwnerPath, rollbackOwnerHash, stableOwner, options);
  } catch (error) {
    release();
    throw error;
  }

  return {
    dataDir,
    credentialFile: scopedRunnerCredentialFile(dataDir, identity),
    migratedLegacyDataDir: legacyMigrationRequired || explicitlyAdoptingLegacyEndpoint,
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
