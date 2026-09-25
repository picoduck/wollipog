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

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
  type Stats,
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

/**
 * Change fingerprint of a copy that cannot be read as skill content, so it has no content digest to
 * fence a discard on. It covers every entry's path, type, identity, mode, size, and modification and
 * change times, plus each symlink's own target text. It never opens a file or follows a link. Any
 * write, rename, or replacement inside the tree changes a change time, which a writer cannot set back.
 * Undefined when the tree is larger than the bound or changes while it is walked.
 */
export function keptAsideFingerprint(dir: string): string | undefined {
  const hash = createHash("sha256");
  let entries = 0;
  const record = (path: string, relative: string, stat: BigIntStats): void => {
    const type = stat.isSymbolicLink() ? "l" : stat.isDirectory() ? "d" : stat.isFile() ? "f" : "o";
    hash.update(`${JSON.stringify([
      relative, type, String(stat.dev), String(stat.ino), String(stat.mode), String(stat.size),
      String(stat.mtimeNs), String(stat.ctimeNs),
      type === "l" ? readlinkSync(path, { encoding: "buffer" }).toString("base64") : "",
    ])}\n`);
  };
  const visit = (path: string, prefix: string): void => {
    for (const name of readdirSync(path).sort()) {
      if (++entries > FINGERPRINT_MAX_ENTRIES) throw new Error("too many entries");
      const child = join(path, name);
      const stat = lstatSync(child, { bigint: true });
      record(child, prefix + name, stat);
      if (stat.isDirectory()) visit(child, `${prefix}${name}/`);
    }
  };
  try {
    const root = lstatSync(dir, { bigint: true });
    if (!root.isDirectory()) return undefined;
    record(dir, "", root);
    visit(dir, "");
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

function unlinkEntry(path: string, stat: Stats): void {
  try {
    unlinkSync(path);
  } catch (error) {
    // A Windows directory symlink or junction is removed as a directory entry; its target is untouched.
    if (process.platform === "win32" && stat.isSymbolicLink()) rmdirSync(path);
    else throw error;
  }
}

/** Delete a kept-aside tree without following any symlink inside it: links are unlinked, never
 * traversed. On Linux every directory is addressed through its own no-follow descriptor, so replacing
 * a directory with a symlink mid-removal cannot redirect it. Elsewhere each directory's identity is
 * checked immediately before it is listed. Throws on the first failure and leaves the rest in place. */
export function removeKeptAsideTree(
  dir: string,
  options: { anchored?: boolean; /** Test seam: runs after a subdirectory is inspected. */ afterInspect?: (name: string) => void } = {},
): void {
  const anchored = options.anchored ?? process.platform === "linux";
  const empty = (base: string): void => {
    for (const name of readdirSync(base)) {
      const child = anchored ? `${base}/${name}` : join(base, name);
      const stat = lstatSync(child);
      if (!stat.isDirectory()) {
        unlinkEntry(child, stat);
        continue;
      }
      options.afterInspect?.(name);
      if (anchored) {
        const fd = openSync(child, DIRECTORY_FLAGS);
        try {
          const opened = fstatSync(fd);
          if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("a directory changed while it was removed");
          empty(`/proc/self/fd/${fd}`);
        } finally {
          closeSync(fd);
        }
      } else {
        const now = lstatSync(child);
        if (!now.isDirectory() || now.dev !== stat.dev || now.ino !== stat.ino) {
          throw new Error("a directory changed while it was removed");
        }
        empty(child);
      }
      rmdirSync(child);
    }
  };
  if (anchored) {
    const fd = openSync(dir, DIRECTORY_FLAGS);
    try {
      empty(`/proc/self/fd/${fd}`);
    } finally {
      closeSync(fd);
    }
  } else {
    if (!isRealDirectory(dir)) throw new Error("the copy is not a directory");
    empty(dir);
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

/** Every kept-aside copy in the store, oldest first (copies without a record last), bounded. */
export function scanKeptAsideCopies(
  storeRoot: string,
  options: { skillName?: (skillMd: string) => string | undefined; log?: (message: string) => void } = {},
): SkillKeptAsideCopy[] {
  let entries: string[];
  try {
    entries = readdirSync(storeRoot);
  } catch {
    return [];
  }
  const found = entries.flatMap((entry) => {
    const id = KEPT_ASIDE_ENTRY.exec(entry)?.[1];
    return id && isRealDirectory(join(storeRoot, entry)) ? [{ id, record: readKeptAsideRecord(storeRoot, id) }] : [];
  }).sort((a, b) => (a.record?.keptAsideAt ?? Infinity) - (b.record?.keptAsideAt ?? Infinity) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (found.length > KEPT_ASIDE_REPORT_LIMIT) {
    options.log?.(`skill store: reporting the oldest ${KEPT_ASIDE_REPORT_LIMIT} of ${found.length} kept-aside copies`);
  }
  return found.slice(0, KEPT_ASIDE_REPORT_LIMIT).map(({ id, record }) =>
    describeKeptAsideCopy(storeRoot, id, { ...(record ? { record } : {}), ...(options.skillName ? { skillName: options.skillName } : {}) }));
}
