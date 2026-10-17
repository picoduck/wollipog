import { randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, renameSync, symlinkSync, unlinkSync, writeSync, type Stats,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Git deletes any ref — a branch, `refs/worktree/*`, or a sequencer pseudo-ref such as
 * `CHERRY_PICK_HEAD` — by first creating `packed-refs.lock` beside `packed-refs`. In a stock layout
 * that is the shared Git directory's root, which a managed-worktree sandbox must keep read-only:
 * a new file there (`commondir`, `config.worktree`, `modules/`) redirects later host Git calls.
 *
 * Git's lockfile API resolves a symlinked target before appending `.lock` (#3316). The runner
 * therefore moves `packed-refs` into this dedicated directory once, leaves a relative symlink in
 * its place, and binds only the directory writable. The layout stays valid for every Git client
 * that follows symlinks, so stock Git keeps working with or without Wollipog.
 *
 * Reversal, with no protected session running: replace `<common dir>/packed-refs` with
 * `wollipog-refs/packed-refs` (`mv -f wollipog-refs/packed-refs packed-refs`; if that file is
 * absent, just remove the link), then remove `wollipog-refs`. The next protected launch relocates
 * it again. See docs/agent-control.md, "Shared Git Metadata".
 */
export const RELOCATED_PACKED_REFS_DIRECTORY = "wollipog-refs";
const LINK_TARGET = `${RELOCATED_PACKED_REFS_DIRECTORY}/packed-refs`;
/** Runner-only, in the read-only common-directory root: a sandbox can neither reach nor rename it. */
export const PACKED_REFS_QUARANTINE_DIRECTORY = "wollipog-refs-quarantine";

export class PackedRefsViolationError extends Error {
  constructor(message: string, readonly quarantinedAt?: string) {
    super(message);
    this.name = "PackedRefsViolationError";
  }
}

/** Relocations this runner has seen. Every one is re-verified before host Git runs. */
const registered = new Set<string>();

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function ownedByRunner(entry: Stats): boolean {
  const uid = currentUid();
  return uid === undefined || entry.uid === uid;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The relocated directory when `<commonGitDir>/packed-refs` is exactly the runner's relative link
 * and the directory is a real, runner-owned child of the common directory; otherwise null. Reads
 * only: it never relocates, verifies the file inside, or follows a link.
 */
export function relocatedPackedRefsDirectory(commonGitDir: string): string | null {
  try {
    const link = join(commonGitDir, "packed-refs");
    const entry = lstatSync(link);
    if (!entry.isSymbolicLink() || !ownedByRunner(entry) || readlinkSync(link) !== LINK_TARGET) return null;
    const directory = join(commonGitDir, RELOCATED_PACKED_REFS_DIRECTORY);
    const stats = lstatSync(directory);
    if (!stats.isDirectory() || !ownedByRunner(stats) || realpathSync.native(directory) !== directory) return null;
    return directory;
  } catch {
    return null;
  }
}

/** Move a substituted entry out of the sandbox-writable directory so nothing follows it again. */
function quarantine(commonGitDir: string, path: string, reason: string): never {
  const destinationDirectory = join(commonGitDir, PACKED_REFS_QUARANTINE_DIRECTORY);
  const existing = lstatOrNull(destinationDirectory);
  if (!existing) mkdirSync(destinationDirectory, { mode: 0o700 });
  else if (!existing.isDirectory() || existing.isSymbolicLink()) {
    throw new PackedRefsViolationError(`${reason}; ${destinationDirectory} is not a directory, so it was not quarantined`);
  }
  const destination = join(destinationDirectory, `packed-refs.${Date.now()}.${randomUUID()}`);
  renameSync(path, destination);
  throw new PackedRefsViolationError(`${reason}; moved it to ${destination}`, destination);
}

/**
 * Prove the relocated `packed-refs` is a plain runner-owned file, or absent. A sandbox can write
 * the relocated directory, so it could replace the file with a link that host Git would then
 * follow on its next packed-refs rewrite. Such an entry is quarantined and the caller refuses.
 * Returns the relocated directory, or null when the repository is not relocated.
 */
export function verifyRelocatedPackedRefs(commonGitDir: string): string | null {
  const directory = relocatedPackedRefsDirectory(commonGitDir);
  if (!directory) {
    registered.delete(commonGitDir);
    return null;
  }
  registered.add(commonGitDir);
  // The sandbox owns nothing here but shares the runner's user, so it can chmod the directory or
  // file; restore the modes Git needs instead of failing every later command.
  if ((lstatSync(directory).mode & 0o777) !== 0o755) chmodSync(directory, 0o755);
  const file = join(directory, "packed-refs");
  const entry = lstatOrNull(file);
  if (entry && !(entry.isFile() && entry.nlink === 1 && ownedByRunner(entry))) {
    quarantine(commonGitDir, file, `relocated Git packed-refs at ${file} is not a plain runner-owned file`);
  }
  if (entry && (entry.mode & 0o777) !== 0o644) chmodSync(file, 0o644);
  return directory;
}

/** Whether `cwd` is in this repository's primary checkout or one of its registered worktrees. */
function commandUsesRepository(commonGitDir: string, cwd: string): boolean {
  const within = (root: string) => cwd === root || cwd.startsWith(`${root}/`);
  if (within(commonGitDir) || within(dirname(commonGitDir))) return true;
  try {
    for (const name of readdirSync(join(commonGitDir, "worktrees"))) {
      const link = readFileSync(join(commonGitDir, "worktrees", name, "gitdir"), "utf8").trim();
      if (within(dirname(link))) return true;
    }
  } catch {
    return true;
  }
  return false;
}

function openExclusive(path: string): number | null {
  try {
    return openSync(path, "wx", 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
}

export type PackedRefsRelocation =
  | { status: "relocated"; directory: string }
  | { status: "unavailable"; reason: string };

/**
 * Relocate `packed-refs` under Git's own locks: the root `packed-refs.lock` for clients that see
 * the old file, and the relocated directory's lock for clients that resolve the new link. A held
 * lock or an unexpected layout leaves the repository untouched and reports why; it never forces.
 * An existing relocation is verified instead, and a violation throws after quarantine.
 */
export function relocatePackedRefs(commonGitDir: string): PackedRefsRelocation {
  if (realpathSync.native(commonGitDir) !== commonGitDir) {
    return { status: "unavailable", reason: "the common Git directory is not canonical" };
  }
  const existing = verifyRelocatedPackedRefs(commonGitDir);
  if (existing) return { status: "relocated", directory: existing };
  const top = join(commonGitDir, "packed-refs");
  const directory = join(commonGitDir, RELOCATED_PACKED_REFS_DIRECTORY);
  const rootLock = openExclusive(`${top}.lock`);
  if (rootLock === null) return { status: "unavailable", reason: "Git holds packed-refs.lock" };
  closeSync(rootLock);
  try {
    // Only a Git writer holding the lock replaces packed-refs, so this read is stable from here.
    const current = lstatOrNull(top);
    if (current && !(current.isFile() && current.nlink === 1 && ownedByRunner(current))) {
      return { status: "unavailable", reason: "packed-refs is not a plain runner-owned file" };
    }
    const directoryEntry = lstatOrNull(directory);
    if (!directoryEntry) mkdirSync(directory, { mode: 0o755 });
    else if (!directoryEntry.isDirectory() || !ownedByRunner(directoryEntry)) {
      return { status: "unavailable", reason: `${RELOCATED_PACKED_REFS_DIRECTORY} is not a runner-owned directory` };
    }
    // Held until the link is published, so a client resolving the new link waits for the copy.
    // Only this lock, never one a later Git writer takes, is removed below.
    const innerLock = join(directory, "packed-refs.lock");
    const lockFd = openExclusive(innerLock);
    if (lockFd === null) return { status: "unavailable", reason: `Git holds ${LINK_TARGET}.lock` };
    closeSync(lockFd);
    const staged = join(directory, `packed-refs.wollipog-${randomUUID()}`);
    try {
      if (current) {
        const fd = openSync(staged, "wx", 0o644);
        try {
          writeSync(fd, readFileSync(top));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      // rename(2) and unlink(2) act on the entry itself, so a link left in the directory by an
      // earlier relocation is replaced or removed rather than followed.
      if (current) renameSync(staged, join(directory, "packed-refs"));
      else if (lstatOrNull(join(directory, "packed-refs"))) unlinkSync(join(directory, "packed-refs"));
      const temporaryLink = join(commonGitDir, `packed-refs.wollipog-${randomUUID()}`);
      symlinkSync(LINK_TARGET, temporaryLink);
      try {
        renameSync(temporaryLink, top);
      } catch (error) {
        unlinkSync(temporaryLink);
        throw error;
      }
    } finally {
      if (lstatOrNull(staged)) unlinkSync(staged);
      unlinkSync(innerLock);
    }
  } finally {
    unlinkSync(`${top}.lock`);
  }
  const relocated = verifyRelocatedPackedRefs(commonGitDir);
  return relocated
    ? { status: "relocated", directory: relocated }
    : { status: "unavailable", reason: "the relocated layout did not verify" };
}

/**
 * Re-verify every relocation this runner knows before host Git acts on it, and when a protected
 * provider exits. A substituted entry is quarantined first, so the command that follows sees a
 * safe layout. A failure that cannot be repaired refuses only a command whose `cwd` uses that
 * repository; without a `cwd` (provider exit, runner start) it is logged.
 */
export function guardRelocatedPackedRefs(cwd?: string): void {
  for (const commonGitDir of [...registered]) {
    try {
      verifyRelocatedPackedRefs(commonGitDir);
    } catch (error) {
      if (error instanceof PackedRefsViolationError && error.quarantinedAt) {
        console.error(`[wollipog] ${error.message}`);
        continue;
      }
      if (cwd !== undefined && commandUsesRepository(commonGitDir, cwd)) throw error;
      console.error(`[wollipog] relocated Git packed-refs in ${commonGitDir} could not be verified: ${(error as Error).message}`);
    }
  }
}

/** Register an existing relocation found at runner start, before any session relaunches. */
export function registerRepositoryPackedRefs(repoPath: string): void {
  let commonGitDir: string;
  try {
    commonGitDir = realpathSync.native(join(repoPath, ".git"));
    if (!lstatSync(commonGitDir).isDirectory()) return;
  } catch {
    return;
  }
  if (relocatedPackedRefsDirectory(commonGitDir)) registered.add(commonGitDir);
}

/** Test-only: forget every registered relocation. */
export function resetPackedRefsRelocationsForTests(): void {
  registered.clear();
}
