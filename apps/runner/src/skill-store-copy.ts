/**
 * Drift verification for runner-owned skill store copies (protocol v183).
 *
 * A published version directory is immutable by contract, but deployed harness links resolve into
 * it and its files are ordinary writable files, so an edit made through `~/.claude/skills/<name>`
 * lands here. Each reconciliation re-reads every published copy and compares it with the digest it
 * was published as. Reads never follow a symlink, never open a special file, and stay within the
 * skill payload limits; a copy that breaks those rules is reported as drift without content.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import {
  SKILL_MAX_FILES,
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_TOTAL_BYTES,
  validSkillFilePath,
  validSkillName,
  type SkillFile,
} from "@wollipog/protocol";
import { manualInvocationVariantFiles, withoutManualInvocationFrontmatter } from "@wollipog/protocol/skill-invocation";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";

/** Published store directory names: an agent-invocation digest or its Manual Only variant. */
export const STORE_VERSION_NAME = /^[0-9a-f]{64}(?:-manual)?$/;
/** Files and directories one copy may hold. A valid payload has at most SKILL_MAX_FILES files whose
 * paths have at most eight components, so up to eight entries per file; the bound is twice that so
 * generated artifacts never make a valid tree unreadable. */
const MAX_COPY_ENTRIES = SKILL_MAX_FILES * 8 * 2;
const DIRECTORY_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
const FILE_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export type StoreCopyRead =
  | {
      readable: true;
      /** Skill files, excluding generated tooling artifacts, sorted by path. */
      files: SkillFile[];
      digest: string;
      /** Digest including generated artifacts, when any exist and still fit the skill limits. */
      withArtifactsDigest?: string;
    }
  | { readable: false; reason: string };

/** Test seams for the traversal. */
export interface StoreCopyReadOptions {
  /** Address every directory through its own no-follow descriptor. Defaults to Linux, which exposes
   * `/proc/self/fd`; elsewhere each directory's identity is re-checked after the read. */
  anchored?: boolean;
  /** Runs after a directory is verified and before its entries are listed. */
  beforeList?: (relativeDirectory: string) => void;
}

class UnreadableCopy extends Error {}

/** Files that interpreters and file browsers create beside skill content without a user edit
 * (Python bytecode caches when a skill script imports a sibling module, Finder metadata). They
 * never make a copy drift on their own and are never imported as skill content. */
export function generatedSkillArtifact(path: string): boolean {
  const parts = path.split("/");
  return parts.includes("__pycache__") || parts[parts.length - 1] === ".DS_Store";
}

function readRegularFile(path: string, listed: Stats): Buffer {
  const fd = openSync(path, FILE_FLAGS);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.ino !== listed.ino || before.dev !== listed.dev) {
      throw new UnreadableCopy("a file changed while it was read");
    }
    if (before.size > SKILL_MAX_FILE_BYTES) throw new UnreadableCopy("a file exceeds the skill file size limit");
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, length);
      if (!read) break;
      length += read;
    }
    const after = fstatSync(fd);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new UnreadableCopy("a file changed while it was read");
    }
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

function skillFile(path: string, bytes: Buffer): SkillFile {
  const utf8 = bytes.toString("utf8");
  return Buffer.from(utf8).equals(bytes)
    ? { path, encoding: "utf8", content: utf8 }
    : { path, encoding: "base64", content: bytes.toString("base64") };
}

const byPath = (a: SkillFile, b: SkillFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Read one store copy as skill content. Callers pass a directory they have already verified to be
 * a real directory inside the realpathed store root. Replacing any directory inside the copy with
 * a symlink during the read can never redirect it outside the copy. */
export function readStoreSkillCopy(dir: string, options: StoreCopyReadOptions = {}): StoreCopyRead {
  const anchored = options.anchored ?? process.platform === "linux";
  const content: SkillFile[] = [];
  const artifacts: SkillFile[] = [];
  const visited: { path: string; stat: Stats }[] = [];
  let artifactsFit = true;
  let entries = 0;
  let total = 0;
  let artifactBytes = 0;
  const visit = (base: string, prefix: string): void => {
    options.beforeList?.(prefix);
    for (const entry of readdirSync(base)) {
      if (++entries > MAX_COPY_ENTRIES) throw new UnreadableCopy("it has more entries than a skill may contain");
      const path = prefix + entry;
      if (!validSkillFilePath(path)) throw new UnreadableCopy("it contains a path that is not a valid skill file path");
      const child = anchored ? `${base}/${entry}` : join(base, entry);
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) throw new UnreadableCopy("it contains a symlink");
      if (stat.isDirectory()) {
        if (!anchored) {
          visited.push({ path: child, stat });
          visit(child, `${path}/`);
          continue;
        }
        const fd = openSync(child, DIRECTORY_FLAGS);
        try {
          const opened = fstatSync(fd);
          if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new UnreadableCopy("a directory changed while it was read");
          visit(`/proc/self/fd/${fd}`, `${path}/`);
        } finally {
          closeSync(fd);
        }
        continue;
      }
      if (!stat.isFile()) throw new UnreadableCopy("it contains a special file");
      if (generatedSkillArtifact(path)) {
        // Artifacts matter only when a library version itself contains one; any that cannot be
        // read within the limits simply cannot be part of a matching version.
        if (!artifactsFit || content.length + artifacts.length >= SKILL_MAX_FILES ||
            total + artifactBytes + stat.size > SKILL_MAX_TOTAL_BYTES) {
          artifactsFit = false;
          continue;
        }
        try {
          const bytes = readRegularFile(child, stat);
          artifactBytes += bytes.length;
          artifacts.push(skillFile(path, bytes));
        } catch {
          artifactsFit = false;
        }
        continue;
      }
      if (content.length >= SKILL_MAX_FILES) throw new UnreadableCopy("it has more files than a skill may contain");
      const bytes = readRegularFile(child, stat);
      total += bytes.length;
      if (total > SKILL_MAX_TOTAL_BYTES) throw new UnreadableCopy("it exceeds the skill size limit");
      content.push(skillFile(path, bytes));
    }
  };
  try {
    if (anchored) {
      const fd = openSync(dir, DIRECTORY_FLAGS);
      try {
        visit(`/proc/self/fd/${fd}`, "");
      } finally {
        closeSync(fd);
      }
    } else {
      const root = lstatSync(dir);
      if (!root.isDirectory() || root.isSymbolicLink()) throw new UnreadableCopy("it is not a directory");
      visited.push({ path: dir, stat: root });
      visit(dir, "");
      // Without descriptor-relative traversal, prove afterwards that no directory was swapped for a
      // symlink or another directory while it was being read.
      for (const { path, stat } of visited) {
        const now = lstatSync(path);
        if (now.isSymbolicLink() || !now.isDirectory() || now.dev !== stat.dev || now.ino !== stat.ino) {
          throw new UnreadableCopy("a directory changed while it was read");
        }
      }
    }
    const files = content.sort(byPath);
    const digest = skillVersionDigest(files);
    // A library version may itself contain an artifact (for example a snapshot imported from a
    // Mac), so a copy also matches when the complete tree, artifacts included, has the digest.
    const withArtifactsDigest = artifacts.length > 0 && artifactsFit
      ? skillVersionDigest([...files, ...artifacts].sort(byPath))
      : undefined;
    return { readable: true, files, digest, ...(withArtifactsDigest ? { withArtifactsDigest } : {}) };
  } catch (error) {
    if (error instanceof UnreadableCopy) return { readable: false, reason: error.message };
    return { readable: false, reason: "it could not be read" };
  }
}

export function storeCopyMatches(copy: StoreCopyRead, expectedDigest: string): boolean {
  return copy.readable && (copy.digest === expectedDigest || copy.withArtifactsDigest === expectedDigest);
}

/** Digest of the Manual Only copy a runner publishes for these untransformed version files. */
export function manualVariantDigest(files: SkillFile[]): string {
  return skillVersionDigest(manualInvocationVariantFiles(files));
}

/** Whether a Manual Only copy is exactly what the runner publishes for version `digest`. With
 * source files (delivered, or read from a clean agent-invocation sibling) the check is exact.
 * Without them, removing the injected frontmatter line must reproduce the version digest. That
 * fails closed for a source whose own `disable-model-invocation` key the transform replaced. */
export function manualCopyMatches(copy: StoreCopyRead, digest: string, sourceFiles?: SkillFile[]): boolean {
  if (sourceFiles) return storeCopyMatches(copy, manualVariantDigest(sourceFiles));
  if (!copy.readable) return false;
  const skillMd = copy.files.find((file) => file.path === "SKILL.md");
  const source = skillMd && withoutManualInvocationFrontmatter(Buffer.from(skillMd.content, skillMd.encoding).toString("utf8"));
  if (!skillMd || source === null || source === undefined) return false;
  return skillVersionDigest(copy.files.map((file) =>
    file === skillMd ? { path: file.path, content: source, encoding: "utf8" as const } : file)) === digest;
}

function isRealDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Clean agent-invocation files for `digest`, read from the sibling copy; undefined when the
 * sibling is absent or itself edited. */
function cleanSiblingFiles(nameDir: string, digest: string): SkillFile[] | undefined {
  if (!isRealDirectory(join(nameDir, digest))) return undefined;
  const sibling = readStoreSkillCopy(join(nameDir, digest));
  return sibling.readable && storeCopyMatches(sibling, digest) ? sibling.files : undefined;
}

/** Clean agent-invocation files of one stored version, or undefined. */
export function cleanAgentCopyFiles(storeRoot: string, name: string, digest: string): SkillFile[] | undefined {
  return cleanSiblingFiles(join(storeRoot, name), digest);
}

/** Re-read one copy immediately before store GC deletes it. It is collectable only while it still
 * matches the version it was published as, or its capture target (the same variant of the desired
 * version, which the library holds). Anything that cannot be verified is kept. */
export function storeCopyCollectable(storeRoot: string, name: string, version: string, captureDigest?: string): boolean {
  const nameDir = join(storeRoot, name);
  const copy = readStoreSkillCopy(join(nameDir, version));
  if (captureDigest !== undefined && storeCopyMatches(copy, captureDigest)) return true;
  if (!version.endsWith("-manual")) return storeCopyMatches(copy, version);
  const digest = version.slice(0, 64);
  return manualCopyMatches(copy, digest, cleanSiblingFiles(nameDir, digest));
}

export interface StoreCopyDrift {
  name: string;
  /** Store directory name (`<digest>` or `<digest>-manual`). */
  version: string;
  digest: string;
  variant: "agent" | "manual";
  observedDigest?: string;
  unreadableReason?: string;
}

export interface StoreDriftScan {
  drift: StoreCopyDrift[];
  /** Expected Manual Only digest of each named desired version, when its content is known. */
  desiredManualDigests: Map<string, string>;
  /** Content digest (generated artifacts excluded) of every readable copy, keyed `<name>/<version>`. */
  copyDigests: Map<string, string>;
}

/** Verify every published copy in the store. Agent copies are checked against their directory
 * digest; Manual Only copies with manualCopyMatches. A copy that cannot be verified is drift.
 * Symlinked or foreign entries are never followed. */
export function scanStoreDrift(
  storeRoot: string,
  options: {
    /** Desired digest per skill name. */
    desired: ReadonlyMap<string, string>;
    /** Validated source files delivered for a version in this pass. */
    sourceFiles?: (name: string, digest: string) => SkillFile[] | undefined;
  },
): StoreDriftScan {
  const scan: StoreDriftScan = { drift: [], desiredManualDigests: new Map(), copyDigests: new Map() };
  let names: string[];
  try {
    names = readdirSync(storeRoot);
  } catch {
    return scan;
  }
  for (const name of names) {
    if (!validSkillName(name)) continue;
    const nameDir = join(storeRoot, name);
    if (!isRealDirectory(nameDir)) continue;
    let versions: string[];
    try {
      versions = readdirSync(nameDir).filter((version) =>
        STORE_VERSION_NAME.test(version) && isRealDirectory(join(nameDir, version)));
    } catch {
      continue;
    }
    const desiredDigest = options.desired.get(name);
    const manualDigests = new Set(versions.filter((version) => version.endsWith("-manual")).map((version) => version.slice(0, 64)));
    // Clean agent files are retained only where a Manual Only sibling or the desired version needs them.
    const agentSources = new Map<string, SkillFile[]>();
    for (const version of versions) {
      if (version.endsWith("-manual")) continue;
      const copy = readStoreSkillCopy(join(nameDir, version));
      if (copy.readable) scan.copyDigests.set(`${name}/${version}`, copy.digest);
      if (storeCopyMatches(copy, version)) {
        if (copy.readable && (manualDigests.has(version) || version === desiredDigest)) agentSources.set(version, copy.files);
        continue;
      }
      scan.drift.push({
        name, version, digest: version, variant: "agent",
        ...(copy.readable ? { observedDigest: copy.digest } : { unreadableReason: copy.reason }),
      });
    }
    const sourceFor = (digest: string): SkillFile[] | undefined =>
      options.sourceFiles?.(name, digest) ?? agentSources.get(digest);
    for (const version of versions) {
      if (!version.endsWith("-manual")) continue;
      const digest = version.slice(0, 64);
      const copy = readStoreSkillCopy(join(nameDir, version));
      if (copy.readable) scan.copyDigests.set(`${name}/${version}`, copy.digest);
      if (manualCopyMatches(copy, digest, sourceFor(digest))) continue;
      scan.drift.push({
        name, version, digest, variant: "manual",
        ...(copy.readable ? { observedDigest: copy.digest } : { unreadableReason: copy.reason }),
      });
    }
    const desiredSource = desiredDigest === undefined ? undefined : sourceFor(desiredDigest);
    if (desiredSource) scan.desiredManualDigests.set(name, manualVariantDigest(desiredSource));
  }
  return scan;
}
