import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, normalize, posix } from "node:path";
import type { AgentContext } from "@wollipog/protocol";

export const MAX_CHECKPOINT_REF_OWNERSHIP_RECORDS = 4_096;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_REPO_PATH_LENGTH = 4_096;
const MAX_DISTRO_LENGTH = 256;
const RECORD_VERSION = 2;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RECORD_NAME = /^[a-f0-9]{64}\.json$/;
const HARD_LINK_UNSUPPORTED = new Set(["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EPERM"]);

export interface CheckpointRefOwnershipRecord {
  version: typeof RECORD_VERSION;
  sessionId: string;
  repoPath: string;
  context: AgentContext;
}

export type CheckpointRefOwnershipClaim = Omit<CheckpointRefOwnershipRecord, "version">;

function validContext(context: unknown): context is AgentContext {
  if (!context || typeof context !== "object") return false;
  const candidate = context as { kind?: unknown; distro?: unknown };
  if (candidate.kind === "native") return candidate.distro === undefined;
  return candidate.kind === "wsl" &&
    typeof candidate.distro === "string" &&
    candidate.distro.length > 0 &&
    candidate.distro.length <= MAX_DISTRO_LENGTH &&
    candidate.distro.trim() === candidate.distro &&
    !candidate.distro.includes("\0");
}

function validCanonicalRepoPath(repoPath: unknown, context: AgentContext): repoPath is string {
  if (typeof repoPath !== "string" || repoPath.length === 0 || repoPath.length > MAX_REPO_PATH_LENGTH ||
      repoPath.includes("\0")) return false;
  if (context.kind === "wsl") {
    return posix.isAbsolute(repoPath) && posix.normalize(repoPath) === repoPath;
  }
  return isAbsolute(repoPath) && normalize(repoPath) === repoPath;
}

function parseRecord(raw: string, expectedName?: string): CheckpointRefOwnershipRecord {
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) {
    throw new Error("checkpoint ref ownership record is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`checkpoint ref ownership record is not valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("checkpoint ref ownership record is invalid");
  const candidate = parsed as Partial<CheckpointRefOwnershipRecord>;
  if (candidate.version !== RECORD_VERSION || typeof candidate.sessionId !== "string" ||
      !SESSION_ID.test(candidate.sessionId) || !validContext(candidate.context) ||
      !validCanonicalRepoPath(candidate.repoPath, candidate.context)) {
    throw new Error("checkpoint ref ownership record is invalid");
  }
  const record: CheckpointRefOwnershipRecord = {
    version: RECORD_VERSION,
    sessionId: candidate.sessionId,
    repoPath: candidate.repoPath,
    context: candidate.context,
  };
  if (expectedName && `${checkpointRefOwnershipKey(record)}.json` !== expectedName) {
    throw new Error("checkpoint ref ownership record does not match its filename");
  }
  return record;
}

function sameRecord(left: CheckpointRefOwnershipRecord, right: CheckpointRefOwnershipRecord): boolean {
  return left.version === right.version && left.sessionId === right.sessionId &&
    left.repoPath === right.repoPath && left.context.kind === right.context.kind &&
    (left.context.kind !== "wsl" || (right.context.kind === "wsl" && left.context.distro === right.context.distro));
}

/** Stable identity for one exact session/repository/execution-context ownership tuple. */
export function checkpointRefOwnershipKey(
  record: CheckpointRefOwnershipClaim | CheckpointRefOwnershipRecord,
): string {
  const context = record.context.kind === "wsl" ? `wsl\0${record.context.distro}` : "native";
  return createHash("sha256")
    .update(`${record.sessionId}\0${context}\0${record.repoPath}`)
    .digest("hex");
}

/**
 * Durable proof that this runner owns one exact session's checkpoint namespace in one exact
 * repository. Records deliberately outlive session rows so a pre-compatibility rollback cannot
 * make the canonical refs anonymous by deleting only its legacy row and refs.
 */
export class CheckpointRefOwnershipLedger {
  private readonly dir: string;

  constructor(dataDir: string, private readonly maxRecords = MAX_CHECKPOINT_REF_OWNERSHIP_RECORDS) {
    if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0 ||
        maxRecords > MAX_CHECKPOINT_REF_OWNERSHIP_RECORDS) {
      throw new Error("checkpoint ref ownership record limit is invalid");
    }
    this.dir = join(dataDir, "checkpoint-ref-ownership");
    mkdirSync(this.dir, { recursive: true });
  }

  list(): CheckpointRefOwnershipRecord[] {
    const names = readdirSync(this.dir).filter((name) => RECORD_NAME.test(name)).sort();
    if (names.length > this.maxRecords) {
      throw new Error(`checkpoint ref ownership ledger exceeds its ${this.maxRecords}-record safety limit`);
    }
    return names.map((name) => {
      try {
        return parseRecord(readFileSync(join(this.dir, name), "utf8"), name);
      } catch (error) {
        throw new Error(`could not read checkpoint ref ownership record ${name}: ${(error as Error).message}`);
      }
    });
  }

  get(claim: CheckpointRefOwnershipClaim | CheckpointRefOwnershipRecord): CheckpointRefOwnershipRecord | null {
    const record = parseRecord(JSON.stringify({ version: RECORD_VERSION, ...claim }));
    const path = this.recordPath(record);
    try {
      return parseRecord(readFileSync(path, "utf8"), `${checkpointRefOwnershipKey(record)}.json`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  listSession(sessionId: string): CheckpointRefOwnershipRecord[] {
    if (!SESSION_ID.test(sessionId)) throw new Error(`invalid checkpoint session id: ${sessionId}`);
    return this.list().filter((record) => record.sessionId === sessionId);
  }

  claim(claim: CheckpointRefOwnershipClaim): CheckpointRefOwnershipRecord {
    const record = parseRecord(JSON.stringify({ version: RECORD_VERSION, ...claim }));
    const path = this.recordPath(record);
    try {
      const existing = parseRecord(readFileSync(path, "utf8"), `${checkpointRefOwnershipKey(record)}.json`);
      if (!sameRecord(existing, record)) throw new Error("checkpoint ref ownership record key collision");
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const count = readdirSync(this.dir).filter((name) => RECORD_NAME.test(name)).length;
    if (count >= this.maxRecords) {
      throw new Error(`checkpoint ref ownership ledger reached its ${this.maxRecords}-record safety limit`);
    }

    const temp = `${path}.${process.pid}.${createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 12)}.tmp`;
    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    let fd: number | undefined;
    let published = false;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, serialized, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      this.publishRecord(temp, path, serialized);
      published = true;
      rmSync(temp);
      this.syncDirectory();
      return record;
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      rmSync(temp, { force: true });
      // Only a no-replace collision is eligible for reread. Once this call published, later temp
      // cleanup or POSIX directory-fsync failures remain hard durability failures.
      if (!published && (error as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          const existing = parseRecord(readFileSync(path, "utf8"), `${checkpointRefOwnershipKey(record)}.json`);
          if (sameRecord(existing, record)) return existing;
        } catch {
          // Preserve the original publication collision below.
        }
      }
      throw error;
    }
  }

  /** Remove only the exact claim the caller successfully reclaimed. */
  remove(expected: CheckpointRefOwnershipRecord): void {
    const path = this.recordPath(expected);
    let current: CheckpointRefOwnershipRecord;
    try {
      current = parseRecord(readFileSync(path, "utf8"), `${checkpointRefOwnershipKey(expected)}.json`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!sameRecord(current, expected)) {
      throw new Error(`checkpoint ref ownership for ${expected.sessionId} changed before removal`);
    }
    try {
      rmSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    this.syncDirectoryAfterRemoval();
  }

  private recordPath(record: CheckpointRefOwnershipClaim | CheckpointRefOwnershipRecord): string {
    if (!SESSION_ID.test(record.sessionId)) throw new Error(`invalid checkpoint session id: ${record.sessionId}`);
    return join(this.dir, `${checkpointRefOwnershipKey(record)}.json`);
  }

  private publishRecord(temp: string, path: string, serialized: string): void {
    try {
      // Preferred publication is atomic and no-replace. Concurrent runners can publish only the
      // same immutable tuple; a different repo/context claim can never overwrite existing proof.
      this.linkRecord(temp, path);
      return;
    } catch (error) {
      if (!HARD_LINK_UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }

    // Some valid runner data filesystems do not support hard links. Exclusive creation preserves
    // no-overwrite semantics. A failed write removes only the file descriptor this call created;
    // EEXIST is left untouched so claim() can reread and accept only the same immutable record.
    let fd: number | undefined;
    let created = false;
    try {
      fd = openSync(path, "wx", 0o600);
      created = true;
      writeFileSync(fd, serialized, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (created) rmSync(path, { force: true });
      throw error;
    }
  }

  /** Test seam for filesystems that reject hard-link publication. */
  private linkRecord(temp: string, path: string): void { linkSync(temp, path); }

  /** Test seam for Windows directory-handle behavior. */
  private openDirectoryForSync(): number { return openSync(this.dir, "r"); }

  private syncDirectory(): void {
    let fd: number | undefined;
    try {
      fd = this.openDirectoryForSync();
      fsyncSync(fd);
    } catch (error) {
      // Match SessionStore: Windows does not offer a portable directory-fsync contract, and may
      // report filesystem/driver-specific codes. The record itself was fsynced before publication.
      if (process.platform !== "win32") throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private syncDirectoryAfterRemoval(): void {
    this.syncDirectory();
  }
}
