/**
 * Edited skill store copies that a restore kept aside instead of deleting (protocol v184).
 *
 * A restore that cannot fence a copy on its content (it was reported unreadable), finds the replaced
 * copy changed after the swap, or cannot finish the swap moves the copy to `<store>/.drift-<id>`.
 * The runner records which skill, version, and variant it came from beside it, in
 * `<store>/.drift-<id>.json`, before the move. Every base reconciliation reports each kept-aside copy,
 * and a copy is deleted only by a confirmed discard that still matches the reviewed observation.
 * Neither store name is a valid skill name or a `.tmp-` directory, so store GC never reclaims them.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { join } from "node:path";
import { validSkillName, type SkillInvocationPolicy, type SkillKeptAsideCopy } from "@wollipog/protocol";
import { readStoreSkillCopy } from "./skill-store-copy.js";

export const KEPT_ASIDE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEPT_ASIDE_ENTRY = /^\.drift-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** Copies reported per pass. Each is re-read in full on every pass, like every published copy. */
export const KEPT_ASIDE_REPORT_LIMIT = 256;
const RECORD_MAX_BYTES = 4096;
/** Entries a fingerprint may cover; a larger unreadable tree cannot be discarded remotely. */
const FINGERPRINT_MAX_ENTRIES = 4096;
const DIGEST = /^[0-9a-f]{64}$/;
const DIRECTORY_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
const RECORD_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const FILE_FLAGS = RECORD_FLAGS;
/** Private name an entry is moved to, inside its own directory, just before it is removed. */
const DISCARD_PREFIX = ".wollipog-discard-";

/** What a restore recorded about the copy it moved aside. */
export interface KeptAsideRecord {
  name: string;
  digest: string;
  variant: SkillInvocationPolicy;
  keptAsideAt: number;
}

export function keptAsideDirectory(storeRoot: string, id: string): string {
  return join(storeRoot, `.drift-${id}`);
}

function recordPath(storeRoot: string, id: string): string {
  return join(storeRoot, `.drift-${id}.json`);
}

/** Written before the copy moves, so a kept-aside copy is never unidentified. `wx` never follows or
 * replaces an existing entry. */
export function writeKeptAsideRecord(storeRoot: string, id: string, record: KeptAsideRecord): void {
  writeFileSync(recordPath(storeRoot, id), JSON.stringify({ version: 1, ...record }), { flag: "wx", mode: 0o600 });
}

export function removeKeptAsideRecord(storeRoot: string, id: string): void {
  try {
    unlinkSync(recordPath(storeRoot, id));
  } catch {
    // Absent already.
  }
}

/** A malformed, oversized, or non-regular record reads as absent: the copy is still reported. */
export function readKeptAsideRecord(storeRoot: string, id: string): KeptAsideRecord | undefined {
  let fd: number;
  try {
    fd = openSync(recordPath(storeRoot, id), RECORD_FLAGS);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > RECORD_MAX_BYTES) return undefined;
    const buffer = Buffer.alloc(stat.size);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const parsed = JSON.parse(buffer.subarray(0, length).toString("utf8")) as Record<string, unknown>;
    if (parsed.version !== 1 || typeof parsed.name !== "string" || !validSkillName(parsed.name) ||
        typeof parsed.digest !== "string" || !DIGEST.test(parsed.digest) ||
        (parsed.variant !== "agent" && parsed.variant !== "manual") ||
        !Number.isSafeInteger(parsed.keptAsideAt) || (parsed.keptAsideAt as number) < 0) return undefined;
    return { name: parsed.name, digest: parsed.digest, variant: parsed.variant, keptAsideAt: parsed.keptAsideAt as number };
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function isRealDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** One entry's identity and change state: type, device, inode, mode, size, modification and change
 * times, and a symlink's own target text. Never its contents. */
function entryStamp(path: string, stat: BigIntStats): string {
  const type = stat.isSymbolicLink() ? "l" : stat.isDirectory() ? "d" : stat.isFile() ? "f" : "o";
  return JSON.stringify([
    type, String(stat.dev), String(stat.ino), String(stat.mode), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs),
    type === "l" ? readlinkSync(path, { encoding: "buffer" }).toString("base64") : "",
  ]);
}

/** The stamp of every entry of a kept-aside copy, keyed by its path relative to the copy ("" is the
 * copy itself). The walk never follows a symlink: on Linux every directory is listed through its own
 * no-follow descriptor, and elsewhere each directory's identity is checked again after the walk. Any
 * write, rename, or replacement inside the tree changes a change time, which a writer cannot set back.
 * Undefined when the tree is larger than the bound or changes while it is walked. */
export function keptAsideStamps(
  dir: string,
  options: { anchored?: boolean; /** Test seam: runs before a subdirectory is listed. */ beforeList?: (relative: string) => void } = {},
): Map<string, string> | undefined {
  const anchored = options.anchored ?? process.platform === "linux";
  const stamps = new Map<string, string>();
  const visited: { path: string; stat: BigIntStats }[] = [];
  const visit = (base: string, prefix: string): void => {
    for (const name of readdirSync(base).sort()) {
      if (stamps.size > FINGERPRINT_MAX_ENTRIES) throw new Error("too many entries");
      const child = anchored ? `${base}/${name}` : join(base, name);
      const stat = lstatSync(child, { bigint: true });
      stamps.set(prefix + name, entryStamp(child, stat));
      if (!stat.isDirectory()) continue;
      options.beforeList?.(prefix + name);
      if (!anchored) {
        visited.push({ path: child, stat });
        visit(child, `${prefix}${name}/`);
        continue;
      }
      const fd = openSync(child, DIRECTORY_FLAGS);
      try {
        const opened = fstatSync(fd, { bigint: true });
        if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("a directory changed while it was walked");
        visit(`/proc/self/fd/${fd}`, `${prefix}${name}/`);
      } finally {
        closeSync(fd);
      }
    }
  };
  try {
    const root = lstatSync(dir, { bigint: true });
    if (!root.isDirectory()) return undefined;
    stamps.set("", entryStamp(dir, root));
    if (anchored) {
      const fd = openSync(dir, DIRECTORY_FLAGS);
      try {
        const opened = fstatSync(fd, { bigint: true });
        if (opened.dev !== root.dev || opened.ino !== root.ino) return undefined;
        visit(`/proc/self/fd/${fd}`, "");
      } finally {
        closeSync(fd);
      }
    } else {
      visited.push({ path: dir, stat: root });
      visit(dir, "");
      for (const { path, stat } of visited) {
        const now = lstatSync(path, { bigint: true });
        if (!now.isDirectory() || now.dev !== stat.dev || now.ino !== stat.ino) return undefined;
      }
    }
    return stamps;
  } catch {
    return undefined;
  }
}

export function sameKeptAsideStamps(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  return left.size === right.size && [...left].every(([path, stamp]) => right.get(path) === stamp);
}

/**
 * Change fingerprint of a copy that cannot be read as skill content, so it has no content digest to
 * fence a discard on: a digest of every entry's stamp (see keptAsideStamps). Undefined when the tree is
 * larger than the bound or changes while it is walked.
 */
export function keptAsideFingerprint(dir: string, stamps = keptAsideStamps(dir)): string | undefined {
  if (!stamps) return undefined;
  const hash = createHash("sha256");
  for (const path of [...stamps.keys()].sort()) hash.update(`${JSON.stringify([path, stamps.get(path)])}\n`);
  return hash.digest("hex");
}

function unlinkEntry(path: string, stat: BigIntStats): void {
  try {
    unlinkSync(path);
  } catch (error) {
    // A Windows directory symlink or junction is removed as a directory entry; its target is untouched.
    if (process.platform === "win32" && stat.isSymbolicLink()) rmdirSync(path);
    else throw error;
  }
}

class CopyChanged extends Error {
  constructor() {
    super("the copy changed while it was discarded");
  }
}

/** A stamp without its change time, which moving an entry to a private name updates. */
function stampWithoutChangeTime(stamp: string | undefined): string | undefined {
  if (stamp === undefined) return undefined;
  const [type, dev, ino, mode, size, mtime, , target] = JSON.parse(stamp) as string[];
  return JSON.stringify([type, dev, ino, mode, size, mtime, target]);
}

/** Put an entry back under its name without ever replacing whatever took that name meanwhile. If the
 * name is taken, the entry stays under its private name inside the copy, where it is still reported. */
function putBack(aside: string, original: string): void {
  try {
    linkSync(aside, original);
    unlinkSync(aside);
  } catch {
    // Kept under its private name.
  }
}

/** Write what an unlinked file still holds back into the copy, under its name or its private name. */
function preserveFromHandle(fd: number, paths: readonly string[], mode: bigint): void {
  for (const path of paths) {
    let out: number;
    try {
      out = openSync(path, "wx", Number(mode & 0o777n));
    } catch {
      continue;
    }
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      for (let position = 0; ;) {
        const read = readSync(fd, buffer, 0, buffer.length, position);
        if (!read) break;
        writeSync(out, buffer, 0, read);
        position += read;
      }
    } finally {
      closeSync(out);
    }
    return;
  }
}

/** Removal seams for tests. */
export interface KeptAsideRemovalHooks {
  anchored?: boolean;
  /** After an entry is verified under its name. */
  afterVerify?: (relative: string) => void;
  /** Before a verified subdirectory is listed. */
  beforeList?: (relative: string) => void;
  /** After a file is verified under its private name and opened, before it is unlinked. */
  beforeUnlink?: (relative: string) => void;
}

/** Delete a kept-aside tree, but only entries that still have the stamp they had when the discard was
 * verified. Each entry is checked under its name, then moved to a private name in the same directory,
 * so a replacement saved over its name (an editor's atomic save) is never touched, and checked again
 * there. A file is unlinked while a handle to it is held; if its size or modification time moved since
 * the check, a write landed first, and those bytes are written back. Any change, addition, or
 * replacement stops the removal and keeps the entry and everything not yet removed. Links are unlinked,
 * never traversed. On Linux every directory is addressed through its own no-follow descriptor.
 * Elsewhere a directory swapped for a link after its check lists entries that do not match their
 * stamps, so nothing it reaches is removed. Throws when it stops. */
export function removeKeptAsideTree(
  dir: string,
  expected: ReadonlyMap<string, string>,
  options: KeptAsideRemovalHooks = {},
): void {
  const anchored = options.anchored ?? process.platform === "linux";
  const childPath = (base: string, name: string) => anchored ? `${base}/${name}` : join(base, name);
  const verified = (path: string, relative: string): BigIntStats => {
    const stat = lstatSync(path, { bigint: true });
    if (expected.get(relative) !== entryStamp(path, stat)) throw new CopyChanged();
    options.afterVerify?.(relative);
    return stat;
  };
  const removeEntry = (base: string, name: string, relative: string): void => {
    const original = childPath(base, name);
    const aside = childPath(base, `${DISCARD_PREFIX}${randomUUID()}`);
    renameSync(original, aside);
    let stat: BigIntStats;
    let fd: number | undefined;
    try {
      stat = lstatSync(aside, { bigint: true });
      if (stampWithoutChangeTime(entryStamp(aside, stat)) !== stampWithoutChangeTime(expected.get(relative))) throw new CopyChanged();
      if (stat.isFile()) {
        fd = openSync(aside, FILE_FLAGS);
        const opened = fstatSync(fd, { bigint: true });
        if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new CopyChanged();
      }
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      putBack(aside, original);
      throw error;
    }
    if (fd === undefined) {
      unlinkEntry(aside, stat);
      return;
    }
    try {
      options.beforeUnlink?.(relative);
      unlinkSync(aside);
      const after = fstatSync(fd, { bigint: true });
      if (after.size !== stat.size || after.mtimeNs !== stat.mtimeNs) {
        // Written through a handle opened before the discard: keep those bytes.
        preserveFromHandle(fd, [original, aside], stat.mode);
        throw new CopyChanged();
      }
    } finally {
      closeSync(fd);
    }
  };
  const empty = (base: string, prefix: string): void => {
    options.beforeList?.(prefix);
    for (const name of readdirSync(base)) {
      const child = childPath(base, name);
      const stat = verified(child, prefix + name);
      if (!stat.isDirectory()) {
        removeEntry(base, name, prefix + name);
        continue;
      }
      if (anchored) {
        const fd = openSync(child, DIRECTORY_FLAGS);
        try {
          const opened = fstatSync(fd, { bigint: true });
          if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new CopyChanged();
          empty(`/proc/self/fd/${fd}`, `${prefix}${name}/`);
        } finally {
          closeSync(fd);
        }
      } else {
        empty(child, `${prefix}${name}/`);
      }
      // Fails, and keeps it, if anything appeared in it meanwhile.
      rmdirSync(child);
    }
  };
  const root = verified(dir, "");
  if (!root.isDirectory()) throw new Error("the copy is not a directory");
  if (anchored) {
    const fd = openSync(dir, DIRECTORY_FLAGS);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (opened.dev !== root.dev || opened.ino !== root.ino) throw new CopyChanged();
      empty(`/proc/self/fd/${fd}`, "");
    } finally {
      closeSync(fd);
    }
  } else {
    empty(dir, "");
  }
  rmdirSync(dir);
}

const KEPT_ASIDE_DETAIL = "A restore kept this edited copy aside in the skill store instead of deleting it.";
const LEGACY_DETAIL = "An earlier runner kept this edited copy aside without recording the skill version it came from.";

/** Describe one kept-aside copy as the runner reports it. `skillName` reads a name from SKILL.md for
 * a copy kept aside before records existed. */
export function describeKeptAsideCopy(
  storeRoot: string,
  id: string,
  options: { record?: KeptAsideRecord; skillName?: (skillMd: string) => string | undefined } = {},
): SkillKeptAsideCopy {
  const dir = keptAsideDirectory(storeRoot, id);
  const record = options.record ?? readKeptAsideRecord(storeRoot, id);
  const copy = readStoreSkillCopy(dir);
  let name = record?.name;
  if (!name && copy.readable && options.skillName) {
    const skillMd = copy.files.find((file) => file.path === "SKILL.md");
    const inferred = skillMd && options.skillName(Buffer.from(skillMd.content, skillMd.encoding).toString("utf8"));
    if (inferred && validSkillName(inferred)) name = inferred;
  }
  const fingerprint = copy.readable ? undefined : keptAsideFingerprint(dir);
  let detail = record ? KEPT_ASIDE_DETAIL : LEGACY_DETAIL;
  if (!copy.readable) {
    detail += ` It cannot be read as skill content: ${copy.reason}.`;
    if (!fingerprint) detail += " It is too large to verify, so it can only be removed on the machine itself.";
  }
  return {
    id,
    ...(name ? { name } : {}),
    ...(record ? { digest: record.digest, variant: record.variant, keptAsideAt: record.keptAsideAt } : {}),
    ...(copy.readable ? { observedDigest: copy.digest } : fingerprint ? { observedFingerprint: fingerprint } : {}),
    detail,
  };
}

/** Every kept-aside copy in the store, oldest first (copies without a record last), bounded. `omitted`
 * counts the copies beyond the bound, so none is left unaccounted for. */
export function scanKeptAsideCopies(
  storeRoot: string,
  options: { skillName?: (skillMd: string) => string | undefined; log?: (message: string) => void } = {},
): { copies: SkillKeptAsideCopy[]; omitted: number } {
  let entries: string[];
  try {
    entries = readdirSync(storeRoot);
  } catch {
    return { copies: [], omitted: 0 };
  }
  const found = entries.flatMap((entry) => {
    const id = KEPT_ASIDE_ENTRY.exec(entry)?.[1];
    return id && isRealDirectory(join(storeRoot, entry)) ? [{ id, record: readKeptAsideRecord(storeRoot, id) }] : [];
  }).sort((a, b) => (a.record?.keptAsideAt ?? Infinity) - (b.record?.keptAsideAt ?? Infinity) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (found.length > KEPT_ASIDE_REPORT_LIMIT) {
    options.log?.(`skill store: reporting the oldest ${KEPT_ASIDE_REPORT_LIMIT} of ${found.length} kept-aside copies`);
  }
  return {
    copies: found.slice(0, KEPT_ASIDE_REPORT_LIMIT).map(({ id, record }) =>
      describeKeptAsideCopy(storeRoot, id, { ...(record ? { record } : {}), ...(options.skillName ? { skillName: options.skillName } : {}) })),
    omitted: Math.max(0, found.length - KEPT_ASIDE_REPORT_LIMIT),
  };
}
