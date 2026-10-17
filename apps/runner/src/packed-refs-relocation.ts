import { randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeSync, type Stats,
} from "node:fs";
import { join } from "node:path";

/**
 * Git deletes any ref — a branch, `refs/worktree/*`, or a sequencer pseudo-ref such as
 * `CHERRY_PICK_HEAD` — by first creating `packed-refs.lock` beside `packed-refs`. In a stock layout
 * that is the shared Git directory's root, which a managed-worktree sandbox must keep read-only:
 * a new file there (`commondir`, `config.worktree`, `modules/`) redirects later host Git calls.
 *
 * Git's lockfile API resolves a symlinked target before appending `.lock` (#3316). The runner
 * therefore moves `packed-refs` into this dedicated directory once, leaves a relative symlink in
 * its place, and binds only the directory writable. Host Git follows the relocated file by name,
 * so a special file planted there would redirect its next packed-refs rewrite. The directory is
 * bound only under the Landlock helper (landlock-special-files.c), which leaves the sandbox able to
 * create nothing there but regular files and directories; renames and hard links into it fail
 * across the bind mount. Stock Git keeps working with the layout, with or without Wollipog.
 *
 * Reversal, with no protected session running: replace `<common dir>/packed-refs` with
 * `wollipog-refs/packed-refs` (`mv -f wollipog-refs/packed-refs packed-refs`; if that file is
 * absent, just remove the link), then remove `wollipog-refs`. The next protected launch that can
 * enforce the helper relocates it again. See docs/agent-control.md, "Shared Git Metadata".
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

/** Common Git directories whose relocated directory this runner has bound into a sandbox. */
const bound = new Set<string>();

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

/** Attempts before a packed-refs that Git keeps replacing is reported as busy rather than verified. */
const VERIFY_ATTEMPTS = 5;

/**
 * Move exactly the examined entry out of the sandbox-writable directory so nothing follows it
 * again. Git replaces packed-refs only while holding its lock, so the move happens under that lock,
 * and only when the name still refers to the same inode: a concurrent, legitimate rewrite is left in
 * place and the caller examines it again.
 */
function quarantineExamined(commonGitDir: string, file: string, examined: Stats, reason: string): "replaced" {
  const destinationDirectory = join(commonGitDir, PACKED_REFS_QUARANTINE_DIRECTORY);
  const existing = lstatOrNull(destinationDirectory);
  if (!existing) mkdirSync(destinationDirectory, { mode: 0o700 });
  else if (!existing.isDirectory() || existing.isSymbolicLink()) {
    throw new PackedRefsViolationError(`${reason}; ${destinationDirectory} is not a directory, so it was not quarantined`);
  }
  const lock = `${file}.lock`;
  const lockFd = openExclusive(lock);
  if (lockFd === null) throw new PackedRefsViolationError(`${reason}; Git holds ${lock}, so it was not quarantined`);
  closeSync(lockFd);
  try {
    const current = lstatOrNull(file);
    if (!current || current.dev !== examined.dev || current.ino !== examined.ino) return "replaced";
    const destination = join(destinationDirectory, `packed-refs.${Date.now()}.${randomUUID()}`);
    renameSync(file, destination);
    throw new PackedRefsViolationError(`${reason}; moved it to ${destination}`, destination);
  } finally {
    unlinkSync(lock);
  }
}

type Examination = "absent" | "verified" | "replaced";

/** One look at the relocated file. A name replaced since it was opened reports "replaced". */
function examine(commonGitDir: string, file: string, reason: string): Examination {
  const plain = (entry: Stats) => entry.isFile() && entry.nlink === 1 && ownedByRunner(entry);
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "absent";
    if (code !== "ELOOP" && code !== "EACCES") throw error;
    const entry = lstatOrNull(file);
    if (!entry) return "replaced";
    if (!plain(entry)) return quarantineExamined(commonGitDir, file, entry, reason);
    // An unreadable mode leaves no descriptor to repair through. Only the sandbox writes this
    // directory, and its Landlock helper refuses every symlink there, so a name that is still a
    // plain runner-owned file after lstat cannot redirect the chmod.
    chmodSync(file, 0o644);
    return "replaced";
  }
  try {
    const entry = fstatSync(fd);
    // Git rewrites packed-refs by renaming its lock over the name; an inode opened just before that
    // has no links left. The new file is examined on the next attempt, never judged by the old one.
    if (entry.nlink === 0) return "replaced";
    const current = lstatOrNull(file);
    if (!current || current.dev !== entry.dev || current.ino !== entry.ino) return "replaced";
    if (!plain(entry)) return quarantineExamined(commonGitDir, file, entry, reason);
    if ((entry.mode & 0o777) !== 0o644) fchmodSync(fd, 0o644);
    return "verified";
  } finally {
    closeSync(fd);
  }
}

/**
 * Prove the relocated `packed-refs` is a plain, singly linked, runner-owned file, or absent, and
 * restore the modes Git needs: a sandbox shares the runner's user and can chmod both. The file is
 * opened without following a link and checked and repaired through that descriptor, retrying when
 * Git replaces it meanwhile. Anything else is quarantined and the caller refuses. Returns the
 * directory, or null when not relocated.
 */
export function verifyRelocatedPackedRefs(commonGitDir: string): string | null {
  const directory = relocatedPackedRefsDirectory(commonGitDir);
  if (!directory) return null;
  // The directory's own name is in the read-only common root, so it cannot have been replaced.
  if ((lstatSync(directory).mode & 0o777) !== 0o755) chmodSync(directory, 0o755);
  const file = join(directory, "packed-refs");
  const reason = `relocated Git packed-refs at ${file} is not a plain runner-owned file`;
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
    if (examine(commonGitDir, file, reason) !== "replaced") return directory;
  }
  throw new Error(`relocated Git packed-refs at ${file} kept changing while it was verified`);
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
        // writeSync may write less than asked without throwing; only a complete, synced copy of the
        // file read under the lock is ever published.
        const contents = readFileSync(top);
        const fd = openSync(staged, "wx", 0o644);
        try {
          for (let offset = 0; offset < contents.length;) {
            const written = writeSync(fd, contents, offset, contents.length - offset);
            if (written <= 0) throw new Error("packed-refs copy made no progress");
            offset += written;
          }
          fsyncSync(fd);
          if (fstatSync(fd).size !== contents.length) throw new Error("packed-refs copy is incomplete");
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

/** Record that a launch bound this repository's relocated directory, for verification at exit. */
export function recordBoundPackedRefs(commonGitDir: string): void {
  bound.add(commonGitDir);
}

/**
 * Re-verify every relocated directory this runner has bound, when a provider exits. The helper
 * keeps special files out while a sandbox runs, so this repairs modes and catches only what Git
 * itself or an operator left behind. Violations are quarantined and reported, never thrown.
 */
export function verifyBoundPackedRefs(): string[] {
  const reports: string[] = [];
  for (const commonGitDir of [...bound]) {
    try {
      if (!verifyRelocatedPackedRefs(commonGitDir)) bound.delete(commonGitDir);
    } catch (error) {
      reports.push((error as Error).message);
    }
  }
  return reports;
}

/** Test-only: forget every bound relocation. */
export function resetPackedRefsRelocationsForTests(): void {
  bound.clear();
}
