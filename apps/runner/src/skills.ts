/**
 * Managed agent-skill deployment (protocol v90).
 *
 * The control plane pushes an authoritative desired skill list for the whole machine; this module
 * reconciles the local filesystem against it and reports authoritative deployment state back.
 *
 * Layout: verified skill versions are materialized once into the runner-owned store at
 * `<dataDir>/skills/store/<name>/<digest>` (plus `<digest>-manual` for the manual-invocation
 * variant). `~/.agents/skills/<name>` is the canonical symlink to the agent-invocation variant,
 * and each supported harness receives its own symlink (`~/.claude/skills`, `~/.codex/skills`)
 * that routes through the canonical link, so one atomic canonical flip switches every harness.
 *
 * Safety invariants (deliberate, tested):
 * - Nothing is ever replaced or deleted unless it is a symlink whose target verifiably resolves
 *   inside the store root (lstat + readlink + containment against the realpathed store root) or
 *   whose immediate readlink target is the canonical link path for that skill name AND this
 *   runner recorded creating it in the link manifest at `<dataDir>/skills/links.json`. A
 *   user-created symlink that happens to point at the canonical path is indistinguishable from a
 *   managed link by shape alone, so shape alone never authorizes removal.
 * - Nothing is ever deleted silently: every link removal and store GC deletion is logged, link
 *   removals are returned in the reconcile result, and foreign links that were left in place are
 *   surfaced through the unmanaged-skill scan.
 * - The link manifest fails safe: unreadable or malformed content degrades to an empty set, which
 *   can only cause the sweep to remove less, never more.
 * - The store is never traversed through a symlink: the store root, `<store>/<name>`, and the
 *   digest dir are lstat-verified as non-symlinks before any mkdir, rename, or GC beneath them,
 *   and the published dir's realpath must stay inside the realpathed store root. The store root's
 *   ancestry is verified too: dataDir itself may be a symlink, but every segment below the
 *   realpathed dataDir must be a real directory (checked before mkdir and re-checked by realpath
 *   equality after), and a violation fails the whole pass with no writes and no removals.
 * - A real file/directory at a link path is a conflict: reported, never touched. When the
 *   canonical link path itself is conflicted, managed harness links that route through it are
 *   removed (they are verified ours first) so foreign content is never served under a managed
 *   name; the foreign canonical path is still never touched.
 * - All materialization goes through a fresh temp dir and one atomic rename; files are created
 *   with "wx" so no pre-existing path (symlinks included) can ever be followed or overwritten.
 * - Names, paths, and digests are validated and the digest recomputed before any write.
 * - Windows performs no writes at all and reports every link as "unsupported" (MVP).
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  SKILL_MAX_FILES,
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_TOTAL_BYTES,
  validSkillFilePath,
  validSkillName,
  type AgentDefinition,
  type AgentDriverKind,
  type DeployedSkillState,
  type SkillFile,
  type SkillSyncEntry,
  type UnmanagedSkillInfo,
} from "@wollipog/protocol";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";

/** Harness skill directories, home-relative. Only native claude-code/codex deployment is built. */
export const SKILL_DIRS: Partial<Record<AgentDriverKind, string>> = {
  "claude-code": ".claude/skills",
  codex: ".codex/skills",
  "codex-app-server": ".codex/skills",
};

export const SKILL_SCAN_LIMITS = {
  maxEntriesPerDirectory: 256,
  maxSkillMdBytes: 64 * 1024,
  maxFrontmatterBytes: 16 * 1024,
  maxFrontmatterLines: 128,
  maxValueCharacters: 280,
} as const;

const DIGEST_HEX = /^[0-9a-f]{64}$/;
const WINDOWS_UNSUPPORTED_DETAIL = "Windows deployment is not yet supported";

export function skillsStoreRoot(dataDir: string): string {
  return join(dataDir, "skills", "store");
}

export function canonicalSkillsDir(home: string): string {
  return join(home, ".agents", "skills");
}

export interface ReconcileSkillsOptions {
  dataDir: string;
  home: string;
  agents: AgentDefinition[];
  desired: SkillSyncEntry[];
  /** Removal sweeps and store GC run only when an authoritative CP desired list is in hand. */
  allowRemovals?: boolean;
  log?: (message: string) => void;
  /** Test seam. */
  platform?: NodeJS.Platform;
  /** Acquire the runner's shared provider-HOME lease after store materialization and before any
   * canonical or harness link mutation. The registry intentionally retains the lease until
   * runner shutdown, matching provider-launch ownership semantics. */
  acquireProviderHomeLease?: () => void;
  /** Runner-local store retention. Production supplies validated config; defaults preserve a
   * useful re-enable window and a shorter version-switch grace period. */
  removedSkillRetentionMs?: number;
  previousVersionGraceMs?: number;
  /** Deterministic GC clock for tests. */
  now?: number;
}

export interface ReconcileSkillsResult {
  deployed: DeployedSkillState[];
  unmanaged: UnmanagedSkillInfo[];
  /** Pass-wide failure that cannot be represented by one desired entry, such as a blocked sweep. */
  error?: string;
  /** Home-relative shown paths of every link this pass removed. Always logged as well; a pass
   * that removes nothing returns an empty array. */
  removedLinks: string[];
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------ frontmatter ------------------------------- */

function boundedValue(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  const characters = [...normalized];
  return characters.length <= SKILL_SCAN_LIMITS.maxValueCharacters
    ? normalized
    : characters.slice(0, SKILL_SCAN_LIMITS.maxValueCharacters).join("");
}

function unquoteScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "string" ? parsed : "";
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed.replace(/\s+#.*$/, "");
}

/** Read only `name:` and `description:` from a SKILL.md frontmatter block. This is intentionally
 * not a YAML parser (same stance as parseClaudeCommandMetadata): aliases, tags, objects, and
 * multi-line scalars are never interpreted, and every bound is enforced before use. */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const bounded = Buffer.from(content, "utf8")
    .subarray(0, SKILL_SCAN_LIMITS.maxSkillMdBytes)
    .toString("utf8")
    .replace(/^\uFEFF/, "");
  const lines = bounded.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  let bytes = 0;
  const frontmatter: string[] = [];
  let closed = false;
  for (let index = 1; index < lines.length && index <= SKILL_SCAN_LIMITS.maxFrontmatterLines; index += 1) {
    const line = lines[index]!;
    bytes += Buffer.byteLength(line, "utf8") + 1;
    if (bytes > SKILL_SCAN_LIMITS.maxFrontmatterBytes) break;
    if (line.trim() === "---" || line.trim() === "...") {
      closed = true;
      break;
    }
    frontmatter.push(line);
  }
  // Malformed or unbounded frontmatter is ordinary body text, not partially trusted metadata.
  if (!closed) return {};
  const value = (key: "name" | "description"): string | undefined => {
    for (const line of frontmatter) {
      const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
      if (!match || match[1]!.toLowerCase() !== key) continue;
      return boundedValue(unquoteScalar(match[2]!));
    }
    return undefined;
  };
  const name = value("name");
  const description = value("description");
  return { ...(name ? { name } : {}), ...(description ? { description } : {}) };
}

/** Produce the manual-invocation variant of a SKILL.md: the frontmatter gains
 * `disable-model-invocation: true` (replacing any existing spelling of the key); a file without
 * a frontmatter block gains one containing only that key. */
export function withManualInvocationFrontmatter(content: string): string {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? content.slice(1) : content;
  const lines = body.split(/(?<=\n)/);
  if ((lines[0] ?? "").trim() === "---" && lines.length > 1) {
    let closedAt = -1;
    for (let index = 1; index < lines.length; index += 1) {
      const trimmed = lines[index]!.trim();
      if (trimmed === "---" || trimmed === "...") {
        closedAt = index;
        break;
      }
    }
    if (closedAt > 0) {
      const kept = lines
        .slice(1, closedAt)
        .filter((line) => !/^disable-model-invocation\s*:/i.test(line.trim()));
      return (
        bom + lines[0]! + "disable-model-invocation: true\n" + kept.join("") + lines.slice(closedAt).join("")
      );
    }
  }
  return `${bom}---\ndisable-model-invocation: true\n---\n\n${body}`;
}

/* ------------------------------- validation ------------------------------- */

/** Full wire-payload validation before any filesystem write. Returns an error string, or null. */
export function validateSkillSyncEntry(entry: SkillSyncEntry): string | null {
  if (typeof entry.name !== "string" || !validSkillName(entry.name)) {
    return "invalid skill name";
  }
  if (typeof entry.versionDigest !== "string" || !DIGEST_HEX.test(entry.versionDigest)) {
    return "invalid version digest";
  }
  if (!Array.isArray(entry.files) || entry.files.length === 0) return "skill has no files";
  if (entry.files.length > SKILL_MAX_FILES) return `skill exceeds ${SKILL_MAX_FILES} files`;
  if (!Array.isArray(entry.targets)) return "invalid skill targets";
  const seen = new Set<string>();
  let total = 0;
  for (const file of entry.files) {
    if (typeof file.path !== "string" || !validSkillFilePath(file.path)) {
      return "invalid skill file path";
    }
    if (file.encoding !== "utf8" && file.encoding !== "base64") return "invalid skill file encoding";
    if (typeof file.content !== "string") return "invalid skill file content";
    if (seen.has(file.path)) return "duplicate skill file path";
    seen.add(file.path);
    const bytes = Buffer.byteLength(
      file.encoding === "base64" ? Buffer.from(file.content, "base64") : file.content,
    );
    if (bytes > SKILL_MAX_FILE_BYTES) return `a skill file exceeds ${SKILL_MAX_FILE_BYTES} bytes`;
    total += bytes;
  }
  if (total > SKILL_MAX_TOTAL_BYTES) return `skill exceeds ${SKILL_MAX_TOTAL_BYTES} total bytes`;
  if (!seen.has("SKILL.md")) return "SKILL.md is missing at the top level";
  if (skillVersionDigest(entry.files) !== entry.versionDigest) {
    return "version digest does not match the delivered files";
  }
  return null;
}

/* ----------------------------- materialization ---------------------------- */

function isRealDirectory(path: string): boolean {
  try {
    const entry = lstatSync(path);
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Refuse to operate through a symlink planted inside the store. The symlink is reported (via the
 * thrown error), never followed, and never deleted through. */
function assertNotSymlink(path: string, what: string): void {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (entry.isSymbolicLink()) {
    throw new Error(`${what} is a symlink and will not be followed`);
  }
}

/** Build the version into a fresh temp dir, then publish it with one atomic rename. Every file is
 * opened "wx" (mirroring protectedWrite): a pre-existing path — symlinks included — always fails
 * instead of being followed or replaced. An already-published digest dir is left untouched. */
function materializeVersion(
  storeRoot: string,
  name: string,
  dirName: string,
  files: SkillFile[],
  manualVariant: boolean,
): void {
  const nameDir = join(storeRoot, name);
  const finalDir = join(nameDir, dirName);
  // A symlink planted at the name or digest path would make mkdir/rename publish outside the
  // store while lexical containment still classifies the links as managed. Never follow it.
  assertNotSymlink(nameDir, `the store directory for this skill`);
  assertNotSymlink(finalDir, `the store version directory for this skill`);
  if (isRealDirectory(finalDir)) return;
  const temp = join(storeRoot, `.tmp-${randomUUID()}`);
  mkdirSync(temp, { recursive: true, mode: 0o755 });
  try {
    for (const file of files) {
      const target = join(temp, ...file.path.split("/"));
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
      let bytes = Buffer.from(file.content, file.encoding);
      if (manualVariant && file.path === "SKILL.md") {
        bytes = Buffer.from(withManualInvocationFrontmatter(bytes.toString("utf8")), "utf8");
      }
      const fd = openSync(target, "wx", 0o644);
      try {
        writeFileSync(fd, bytes);
      } finally {
        closeSync(fd);
      }
    }
    mkdirSync(nameDir, { recursive: true, mode: 0o755 });
    try {
      renameSync(temp, finalDir);
    } catch (error) {
      // A concurrent pass may have published the same digest dir first; that content is identical.
      if (!isRealDirectory(finalDir)) throw error;
    }
    // Belt and suspenders behind the lstat checks: the published dir must physically live inside
    // the (already realpathed) store root, or it was somehow routed through a symlink.
    if (!containedInStore(realpathSync(finalDir), storeRoot)) {
      throw new Error("the published skill version escaped the store root");
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/* --------------------------- link ownership manifest ---------------------- */

/** Removal authority for canonical-target harness links comes from this manifest, not from link
 * shape: it records the absolute path of every link this runner created (or verified as its own
 * while ensuring a desired deployment). A link absent from the manifest is somebody else's. */
const LINK_MANIFEST_VERSION = 1;
const LINK_MANIFEST_MAX_BYTES = 512 * 1024;
const LINK_MANIFEST_MAX_ENTRIES = 4096;

export function linkManifestPath(dataDir: string): string {
  return join(dataDir, "skills", "links.json");
}

/** Load the set of link paths this runner created. Unreadable, oversized, or malformed content
 * degrades to an empty set with a log line: the fail-safe direction is sweeping less, never
 * more. The file itself is opened O_NOFOLLOW and never read through a symlink. */
function loadOwnedLinks(path: string, log?: (message: string) => void): Set<string> {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log?.(`skill link manifest unreadable (${errText(error)}); treating it as empty`);
    }
    return new Set();
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > LINK_MANIFEST_MAX_BYTES) {
      log?.("skill link manifest is not a regular file within bounds; treating it as empty");
      return new Set();
    }
    const buffer = Buffer.alloc(Number(stat.size));
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const parsed = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as unknown;
    const links = (parsed as { version?: unknown; links?: unknown })?.links;
    // Any invalid entry rejects the whole manifest: this runner only ever writes bounded arrays
    // of absolute paths, so a partially-valid file is corrupt or foreign, and partially trusting
    // it could authorize removals the runner never recorded.
    if (
      (parsed as { version?: unknown })?.version !== LINK_MANIFEST_VERSION ||
      !Array.isArray(links) ||
      links.length > LINK_MANIFEST_MAX_ENTRIES ||
      !links.every((entry): entry is string => typeof entry === "string" && entry.startsWith(sep))
    ) {
      log?.("skill link manifest has an unknown shape; treating it as empty");
      return new Set();
    }
    return new Set(links);
  } catch (error) {
    log?.(`skill link manifest unreadable (${errText(error)}); treating it as empty`);
    return new Set();
  } finally {
    closeSync(fd);
  }
}

/** Persist the manifest atomically (temp + rename), pruning entries whose path no longer holds a
 * symlink — there is nothing left there this runner could ever remove. Failure to persist is
 * logged and non-fatal: a lost manifest only makes future sweeps more conservative. */
function saveOwnedLinks(path: string, owned: ReadonlySet<string>, log?: (message: string) => void): void {
  const live = [...owned]
    .filter((linkPath) => {
      try {
        return lstatSync(linkPath).isSymbolicLink();
      } catch {
        return false;
      }
    })
    .sort();
  const links = live.slice(0, LINK_MANIFEST_MAX_ENTRIES);
  if (live.length > links.length) {
    // A deployment large enough to hit this cap loses removal authority over the tail: those
    // links will be left in place (and reported unmanaged), never silently removed. Say so.
    log?.(
      `skill link manifest is over capacity: ${live.length - links.length} link record(s) dropped; the affected links will not be swept`,
    );
  }
  try {
    assertNotSymlink(path, "the skill link manifest");
    const temp = join(dirname(path), `.links.json.tmp-${randomUUID()}`);
    const fd = openSync(temp, "wx", 0o644);
    try {
      writeFileSync(fd, JSON.stringify({ version: LINK_MANIFEST_VERSION, links }, null, 2));
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    log?.(`could not persist the skill link manifest: ${errText(error)}`);
  }
}

/* ------------------------------ symlink safety ---------------------------- */

type LinkProbe =
  | { kind: "missing" }
  | { kind: "ours"; resolvedTarget: string; via: "store" | "canonical" }
  | { kind: "foreign-symlink" }
  | { kind: "occupied" };

function containedInStore(path: string, realStoreRoot: string): boolean {
  const prefix = realStoreRoot.endsWith(sep) ? realStoreRoot : `${realStoreRoot}${sep}`;
  return path === realStoreRoot || path.startsWith(prefix);
}

/** Classify what currently sits at a link path. Only "ours" may ever be replaced or removed: a
 * symlink whose target resolves inside the realpathed store root (`via: "store"` — only this
 * runner creates links into its own store), or — when `canonicalDir` is given (harness link
 * paths) — one whose immediate readlink target is the canonical link path for that skill name
 * (`via: "canonical"`). The canonical match is lexical on the readlink value, deliberately not a
 * resolution: a harness link left dangling because the canonical link was already removed must
 * still classify as ours so a sweep can remove it instead of stranding it as "foreign". A
 * canonical-shaped link is exactly what a user hand-linking a harness to ~/.agents/skills also
 * produces, so `via: "canonical"` alone never authorizes removal — removal additionally requires
 * the link manifest to record that this runner created it. */
function probeLink(linkPath: string, realStoreRoot: string, canonicalDir?: string): LinkProbe {
  let entry;
  try {
    entry = lstatSync(linkPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "occupied" };
  }
  if (!entry.isSymbolicLink()) return { kind: "occupied" };
  let target: string;
  try {
    target = readlinkSync(linkPath);
  } catch {
    return { kind: "occupied" };
  }
  const resolvedTarget = resolve(dirname(linkPath), target);
  if (containedInStore(resolvedTarget, realStoreRoot)) {
    return { kind: "ours", resolvedTarget, via: "store" };
  }
  if (canonicalDir !== undefined && resolvedTarget === join(canonicalDir, basename(linkPath))) {
    return { kind: "ours", resolvedTarget, via: "canonical" };
  }
  return { kind: "foreign-symlink" };
}

type LinkOutcome = { ok: true } | { ok: false; status: "conflict" | "error"; detail: string };

/** Point linkPath at targetDir. Replacement is atomic (temp symlink + rename) and only ever
 * replaces a verified store-owned symlink; anything else is a reported conflict, untouched. */
function ensureManagedSymlink(
  linkPath: string,
  targetDir: string,
  realStoreRoot: string,
  shownPath: string,
  canonicalDir?: string,
): LinkOutcome {
  const probe = probeLink(linkPath, realStoreRoot, canonicalDir);
  if (probe.kind === "occupied") {
    return { ok: false, status: "conflict", detail: `an unmanaged file or directory already exists at ${shownPath}` };
  }
  if (probe.kind === "foreign-symlink") {
    return { ok: false, status: "conflict", detail: `an unmanaged symlink already exists at ${shownPath}` };
  }
  if (probe.kind === "ours" && probe.resolvedTarget === targetDir) return { ok: true };
  try {
    mkdirSync(dirname(linkPath), { recursive: true, mode: 0o755 });
    const temp = join(dirname(linkPath), `.${basename(linkPath)}.tmp-${randomUUID()}`);
    try {
      symlinkSync(targetDir, temp, "dir");
      renameSync(temp, linkPath);
    } finally {
      rmSync(temp, { force: true });
    }
  } catch (error) {
    return { ok: false, status: "error", detail: `could not create the skill link at ${shownPath}: ${errText(error)}` };
  }
  return { ok: true };
}

/** Everything a removal needs to be non-silent and manifest-checked. `shownDir` is the
 * home-relative spelling of `dir` used in logs and the reconcile result. */
interface SweepContext {
  owned: Set<string>;
  removedLinks: string[];
  shownDir: string;
  log?: (message: string) => void;
}

/** Remove this runner's own symlinks whose name is no longer desired: store-target links (only
 * this runner links into its store) and canonical-target links the manifest records this runner
 * creating. Foreign symlinks, real files, real directories, and canonical-shaped links absent
 * from the manifest are never touched. Every removal is logged and reported. */
function sweepManagedLinks(
  dir: string,
  keep: ReadonlySet<string>,
  realStoreRoot: string,
  sweep: SweepContext,
  canonicalDir?: string,
): void {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (keep.has(name)) continue;
    const linkPath = join(dir, name);
    const probe = probeLink(linkPath, realStoreRoot, canonicalDir);
    if (probe.kind !== "ours") continue;
    if (probe.via === "canonical" && !sweep.owned.has(linkPath)) {
      // Shaped like ours, but this runner has no record of creating it — a hand-made link to the
      // canonical location. Leave it; the unmanaged scan reports it.
      continue;
    }
    const shownPath = `${sweep.shownDir}/${name}`;
    try {
      unlinkSync(linkPath);
      sweep.owned.delete(linkPath);
      sweep.removedLinks.push(shownPath);
      sweep.log?.(`skill link removed: ${shownPath} (no longer in the desired skill list)`);
    } catch (error) {
      /* Removal is best effort; a vanished or contested entry is left for the next pass. */
      sweep.log?.(`skill link removal failed for ${shownPath}: ${errText(error)}`);
    }
  }
}

/* -------------------------------- store GC -------------------------------- */

type StoreKeep = Map<string, { digest: string; manual: boolean } | "all">;

export const DEFAULT_REMOVED_SKILL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_PREVIOUS_VERSION_GRACE_MS = 60 * 60 * 1000;
const RETENTION_STATE_VERSION = 1;
const RETENTION_STATE_MAX_BYTES = 1024 * 1024;
const RETENTION_STATE_MAX_ENTRIES = 8192;
const STORE_VERSION_NAME = /^[0-9a-f]{64}(?:-manual)?$/;
type RetentionState = Map<string, number>;

export function skillRetentionStatePath(dataDir: string): string {
  return join(dataDir, "skills", "retention.json");
}

function retentionKey(name: string, version: string): string {
  return `${name}\0${version}`;
}

/** Corrupt state fails in the conservative direction: an empty map starts every observed
 * retention window now, so no stored content is deleted early. */
function loadRetentionState(path: string, log?: (message: string) => void): RetentionState {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log?.(`skill retention state unreadable (${errText(error)}); starting conservatively`);
    }
    return new Map();
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > RETENTION_STATE_MAX_BYTES) throw new Error("unsafe state file");
    const buffer = Buffer.alloc(Number(stat.size));
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const parsed = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as {
      version?: unknown;
      entries?: unknown;
    };
    if (parsed.version !== RETENTION_STATE_VERSION || !Array.isArray(parsed.entries) ||
        parsed.entries.length > RETENTION_STATE_MAX_ENTRIES) throw new Error("invalid state shape");
    const state = new Map<string, number>();
    for (const value of parsed.entries) {
      const entry = value as { name?: unknown; version?: unknown; since?: unknown };
      if (typeof entry.name !== "string" || !validSkillName(entry.name) ||
          typeof entry.version !== "string" || !STORE_VERSION_NAME.test(entry.version) ||
          !Number.isSafeInteger(entry.since) || (entry.since as number) < 0) {
        throw new Error("invalid state entry");
      }
      state.set(retentionKey(entry.name, entry.version), entry.since as number);
    }
    return state;
  } catch (error) {
    log?.(`skill retention state unreadable (${errText(error)}); starting conservatively`);
    return new Map();
  } finally {
    closeSync(fd);
  }
}

function saveRetentionState(path: string, state: RetentionState, log?: (message: string) => void): void {
  const entries = [...state]
    .slice(0, RETENTION_STATE_MAX_ENTRIES)
    .map(([key, since]) => {
      const split = key.indexOf("\0");
      return { name: key.slice(0, split), version: key.slice(split + 1), since };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  try {
    assertNotSymlink(path, "the skill retention state");
    const temp = join(dirname(path), `.retention.json.tmp-${randomUUID()}`);
    try {
      writeFileSync(temp, JSON.stringify({ version: RETENTION_STATE_VERSION, entries }, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temp, path);
    } finally {
      rmSync(temp, { force: true });
    }
  } catch (error) {
    log?.(`could not persist skill retention state: ${errText(error)}`);
  }
}

function treeContainsSymlink(path: string): boolean {
  const pending = [path];
  let examined = 0;
  while (pending.length > 0) {
    if (++examined > 4096) return true;
    const current = pending.pop()!;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) return true;
    if (!stat.isDirectory()) continue;
    for (const entry of readdirSync(current)) pending.push(join(current, entry));
  }
  return false;
}

/** Apply bounded retention to stale and undesired versions. Names whose desired entry could not
 * be validated keep every version: a transient bad payload must not tear down working content. */
function gcStore(
  storeRoot: string,
  keep: StoreKeep,
  state: RetentionState,
  policy: { removedSkillMs: number; previousVersionMs: number; now: number },
  log?: (message: string) => void,
): void {
  const seenKeys = new Set<string>();
  let entries;
  try {
    entries = readdirSync(storeRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(storeRoot, entry.name);
    // Never traverse or delete through a symlink planted inside the store.
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    if (entry.name.startsWith(".tmp-")) {
      // A crashed materialization can strand its temp dir; it is never linked, so reclaim it.
      try {
        if (!treeContainsSymlink(path)) {
          rmSync(path, { recursive: true, force: true });
          log?.(`skill store gc: reclaimed stranded temp dir ${entry.name}`);
        }
      } catch {
        // A raced or unsafe temp tree remains for inspection; never follow it.
      }
      continue;
    }
    // Foreign or legacy store names cannot be represented by the retention-state schema. Skip
    // them entirely so one unrecognized directory cannot poison every valid retention window.
    if (!validSkillName(entry.name)) continue;
    const want = keep.get(entry.name);
    let versions;
    try {
      versions = readdirSync(path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const version of versions) {
      // A symlinked version entry is never ours; skip it rather than delete through it.
      if (version.isSymbolicLink()) continue;
      if (!STORE_VERSION_NAME.test(version.name)) continue;
      const key = retentionKey(entry.name, version.name);
      seenKeys.add(key);
      if (want === "all") {
        state.delete(key);
        continue;
      }
      const wanted = want !== undefined &&
        (version.name === want.digest || (want.manual && version.name === `${want.digest}-manual`));
      if (wanted) {
        state.delete(key);
        continue;
      }
      const threshold = want === undefined ? policy.removedSkillMs : policy.previousVersionMs;
      const since = state.get(key) ?? policy.now;
      state.set(key, since);
      if (policy.now - since < threshold) continue;
      const versionPath = join(path, version.name);
      try {
        if (treeContainsSymlink(versionPath)) {
          log?.(`skill store gc: retained unsafe symlink-bearing version ${entry.name}/${version.name}`);
          continue;
        }
        rmSync(versionPath, { recursive: true, force: true });
        state.delete(key);
        log?.(
          `skill store gc: removed ${want === undefined ? "expired removed skill" : "expired stale version"} ` +
            `${entry.name}/${version.name}`,
        );
      } catch (error) {
        log?.(`skill store gc failed for ${entry.name}/${version.name}: ${errText(error)}`);
      }
    }
  }
  for (const key of state.keys()) {
    if (!seenKeys.has(key)) state.delete(key);
  }
}

/* ----------------------------- unmanaged scan ----------------------------- */

function readBoundedSkillMd(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(SKILL_SCAN_LIMITS.maxSkillMdBytes);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Bounded report-only scan of one harness skill directory: real directories containing a
 * SKILL.md, no recursion beyond that one read. When `isForeignLink` is provided (managed-link
 * classification is available), symlinked entries the runner does not own are scanned too, so a
 * user's hand-linked skill stays visible in the reported state instead of vanishing from it;
 * without a classifier, symlinks are skipped as before. */
function scanHarnessSkillDir(
  dir: string,
  isForeignLink?: (linkPath: string) => boolean,
): { name: string; description?: string }[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: { name: string; description?: string }[] = [];
  let examined = 0;
  for (const entry of entries) {
    if (++examined > SKILL_SCAN_LIMITS.maxEntriesPerDirectory) break;
    if (entry.isSymbolicLink()) {
      if (!isForeignLink?.(join(dir, entry.name))) continue;
    } else if (!entry.isDirectory()) {
      continue;
    }
    const content = readBoundedSkillMd(join(dir, entry.name, "SKILL.md"));
    if (content === null) continue;
    const meta = parseSkillFrontmatter(content);
    const name = meta.name && validSkillName(meta.name) ? meta.name : boundedValue(entry.name);
    if (!name) continue;
    found.push({ name, ...(meta.description ? { description: meta.description } : {}) });
  }
  return found;
}

interface HarnessBinding {
  agentId: string;
  relDir: string;
  driver: AgentDriverKind;
}

/** Native agents whose driver has a harness skill directory, in stable agent order. */
function harnessBindings(agents: AgentDefinition[]): HarnessBinding[] {
  const bindings: HarnessBinding[] = [];
  for (const agent of agents) {
    // The synthesized conductor shares its donor Claude's harness directory; a binding for it
    // would duplicate every unmanaged-skill row and turn one directory's state into a per-agent
    // conflict. Its id is stable across runners (see runner conductor synthesis).
    if (agent.id === "conductor") continue;
    const driver = agent.driver ?? "acp";
    const relDir = SKILL_DIRS[driver];
    if (!relDir) continue;
    if ((agent.context?.kind ?? "native") !== "native") continue;
    bindings.push({ agentId: agent.id, relDir, driver });
  }
  return bindings;
}

function scanUnmanagedSkills(
  home: string,
  agents: AgentDefinition[],
  isForeignLink?: (linkPath: string) => boolean,
): UnmanagedSkillInfo[] {
  const perDir = new Map<string, { name: string; description?: string }[]>();
  const results: UnmanagedSkillInfo[] = [];
  for (const binding of harnessBindings(agents)) {
    let found = perDir.get(binding.relDir);
    if (!found) {
      found = scanHarnessSkillDir(join(home, binding.relDir), isForeignLink);
      perDir.set(binding.relDir, found);
    }
    for (const skill of found) {
      results.push({ agentId: binding.agentId, name: skill.name, ...(skill.description ? { description: skill.description } : {}) });
    }
  }
  return results;
}

/* -------------------------------- reconcile ------------------------------- */

/**
 * Reconcile the machine against the desired skill list and report authoritative state.
 * Callers must serialize invocations; concurrent passes would interleave link replacement.
 */
export async function reconcileSkills(options: ReconcileSkillsOptions): Promise<ReconcileSkillsResult> {
  const { dataDir, home, agents, desired } = options;
  const allowRemovals = options.allowRemovals === true;
  const platform = options.platform ?? process.platform;

  if (platform === "win32") {
    return {
      deployed: desired.map((entry) => ({
        name: entry.name,
        digest: entry.versionDigest,
        links: entry.targets.map((target) => ({
          agentId: target.agentId,
          status: "unsupported" as const,
          detail: WINDOWS_UNSUPPORTED_DETAIL,
        })),
      })),
      unmanaged: [],
      removedLinks: [],
    };
  }

  const storeRoot = skillsStoreRoot(dataDir);
  let realStoreRoot: string;
  try {
    // dataDir itself may legitimately be a symlink, but every segment below it must be a real
    // directory: a symlink planted at an ancestor such as `<dataDir>/skills` would make a
    // recursive mkdir (and every later materialization, link target, and GC pass) land outside
    // the data dir even though the terminal store dir passes its own lstat check. Verify the
    // ancestry before mkdir can follow anything, then re-verify by realpath equality after.
    mkdirSync(dataDir, { recursive: true, mode: 0o755 });
    const realDataDir = realpathSync(dataDir);
    assertNotSymlink(join(dataDir, "skills"), "the skills directory");
    assertNotSymlink(storeRoot, "the skills store root");
    mkdirSync(storeRoot, { recursive: true, mode: 0o755 });
    assertNotSymlink(storeRoot, "the skills store root");
    realStoreRoot = realpathSync(storeRoot);
    if (realStoreRoot !== join(realDataDir, "skills", "store")) {
      throw new Error("the skills store root does not resolve inside the data directory");
    }
  } catch (error) {
    return {
      deployed: desired.map((entry) => ({
        name: String(entry.name),
        digest: String(entry.versionDigest),
        links: [],
        error: `skills store unavailable: ${errText(error)}`,
      })),
      // No store root means no managed-link classification, so symlinks are skipped here rather
      // than misreported; nothing is removed on this path either.
      unmanaged: scanUnmanagedSkills(home, agents),
      removedLinks: [],
    };
  }
  const bindings = harnessBindings(agents);
  const agentBinding = new Map(bindings.map((binding) => [binding.agentId, binding]));

  // Materialization is runner-data-dir-local and must remain available even while another runner
  // owns the shared provider HOME. Finish that phase before attempting the provider-home lease;
  // a contended pass can then report pending link deployment without touching any harness path.
  const seenPreparedNames = new Set<string>();
  const prepared = desired.map((entry) => {
    const invalid = seenPreparedNames.has(entry.name) ? "duplicate skill name" : validateSkillSyncEntry(entry);
    seenPreparedNames.add(entry.name);
    const manualNeeded = !invalid && entry.targets.some(
      (target) =>
        target.invocation === "manual" && agentBinding.get(target.agentId)?.driver === "claude-code",
    );
    let materializationError: string | undefined;
    if (!invalid) {
      try {
        materializeVersion(realStoreRoot, entry.name, entry.versionDigest, entry.files, false);
        if (manualNeeded) {
          materializeVersion(realStoreRoot, entry.name, `${entry.versionDigest}-manual`, entry.files, true);
        }
      } catch (error) {
        materializationError = errText(error);
      }
    }
    return { entry, invalid, manualNeeded, materializationError };
  });

  const leaseNeeded = allowRemovals ||
    prepared.some(({ invalid, materializationError }) => !invalid && !materializationError);
  if (leaseNeeded && options.acquireProviderHomeLease) {
    try {
      options.acquireProviderHomeLease();
    } catch (error) {
      const detail = `Provider-home lease unavailable: ${errText(error)}`;
      options.log?.(`skill reconcile links blocked: ${detail}`);
      return {
        deployed: prepared.map(({ entry, invalid, materializationError }) => {
          if (invalid) {
            return { name: String(entry.name), digest: String(entry.versionDigest), links: [], error: invalid };
          }
          if (materializationError) {
            return {
              name: entry.name,
              digest: entry.versionDigest,
              links: entry.targets.map((target) => ({
                agentId: target.agentId,
                status: "error" as const,
                detail: "the skill version could not be materialized",
              })),
              error: `could not materialize the skill version: ${materializationError}`,
            };
          }
          return {
            name: entry.name,
            digest: entry.versionDigest,
            links: entry.targets.map((target) => {
              const binding = agentBinding.get(target.agentId);
              if (binding) return { agentId: target.agentId, status: "error" as const, detail };
              const agent = agents.find((candidate) => candidate.id === target.agentId);
              const unsupported = !agent
                ? "this agent is not present on the runner"
                : (agent.context?.kind ?? "native") !== "native"
                  ? "only native agent contexts are supported"
                  : "this agent's driver does not support managed skills";
              return { agentId: target.agentId, status: "unsupported" as const, detail: unsupported };
            }),
            error: detail,
          };
        }),
        unmanaged: scanUnmanagedSkills(home, agents),
        removedLinks: [],
        error: detail,
      };
    }
  }
  const canonicalDir = canonicalSkillsDir(home);
  const manifestPath = linkManifestPath(dataDir);
  const owned = loadOwnedLinks(manifestPath, options.log);
  const ownedAtLoad = new Set(owned);
  // Drop recorded paths that no longer hold a symlink before anything consults the set: a stale
  // entry (crash between unlink and save, or a link the user removed by hand) is a standing
  // grant of removal authority over a path this runner no longer controls — a user link created
  // there later must not inherit it. The snapshot above keeps the dirty check able to see the
  // prune, so the shrunken set is persisted below.
  for (const linkPath of owned) {
    let isSymlink = false;
    try {
      isSymlink = lstatSync(linkPath).isSymbolicLink();
    } catch {
      /* ENOENT and friends: nothing of ours is there. */
    }
    if (!isSymlink) owned.delete(linkPath);
  }
  const removedLinks: string[] = [];
  /** Record a link this runner created — or found already correct while ensuring a desired
   * deployment. The second half is deliberate adoption: a pre-manifest runner link and a
   * hand-made link that exactly matches the desired deployment are indistinguishable, and
   * refusing to adopt would strand every link created before the manifest existed. Adopting a
   * user's lookalike link means the runner will manage (and may later remove, logged and
   * reported) a link it did not create, but only for a name the control plane actively deploys
   * to this harness. */
  const ownLink = (linkPath: string): void => {
    owned.add(linkPath);
  };
  const deployed: DeployedSkillState[] = [];
  const storeKeep: StoreKeep = new Map();
  const canonicalKeep = new Set<string>();
  const harnessKeep = new Map<string, Set<string>>();
  for (const relDir of new Set(Object.values(SKILL_DIRS))) harnessKeep.set(relDir, new Set());
  for (const { entry, invalid, manualNeeded, materializationError } of prepared) {
    if (typeof entry.name === "string" && entry.name) {
      canonicalKeep.add(entry.name);
      if (invalid) {
        // A payload this runner cannot verify must not tear anything down: keep the name's
        // existing links and every stored version until a valid replacement arrives.
        storeKeep.set(entry.name, "all");
        for (const set of harnessKeep.values()) set.add(entry.name);
      }
    }
    if (invalid) {
      deployed.push({ name: String(entry.name), digest: String(entry.versionDigest), links: [], error: invalid });
      options.log?.(`skill ${String(entry.name)}: rejected (${invalid})`);
      continue;
    }

    // `disable-model-invocation` is Claude Code frontmatter semantics; only claude-code targets
    // can consume the manual variant (codex-family manual targets are reported unsupported
    // below), so only they force its materialization.
    if (!storeKeep.has(entry.name)) {
      storeKeep.set(entry.name, { digest: entry.versionDigest, manual: manualNeeded });
    }
    const state: DeployedSkillState = { name: entry.name, digest: entry.versionDigest, links: [] };
    if (materializationError) {
      state.error = `could not materialize the skill version: ${materializationError}`;
      state.links = entry.targets.map((target) => ({
        agentId: target.agentId,
        status: "error" as const,
        detail: "the skill version could not be materialized",
      }));
      // The new version never landed; keep the name's prior versions and links deployable.
      storeKeep.set(entry.name, "all");
      for (const set of harnessKeep.values()) set.add(entry.name);
      deployed.push(state);
      continue;
    }

    const agentVariantDir = join(realStoreRoot, entry.name, entry.versionDigest);
    const manualVariantDir = `${agentVariantDir}-manual`;
    const canonicalPath = join(canonicalDir, entry.name);

    // Canonical link always points at the untransformed agent-invocation variant.
    const canonical = ensureManagedSymlink(
      canonicalPath,
      agentVariantDir,
      realStoreRoot,
      `~/.agents/skills/${entry.name}`,
    );
    if (canonical.ok) ownLink(canonicalPath);
    else state.error = `canonical link: ${canonical.detail}`;

    // Group targets by harness link path; a shared harness directory can only carry one variant,
    // and the agent-invocation variant wins when policies disagree.
    const plans = new Map<string, { agentTargets: string[]; manualTargets: string[] }>();
    const manualUnsupported: { agentId: string; relDir: string }[] = [];
    for (const target of entry.targets) {
      const binding = agentBinding.get(target.agentId);
      if (!binding) {
        const agent = agents.find((candidate) => candidate.id === target.agentId);
        const detail = !agent
          ? "this agent is not present on the runner"
          : (agent.context?.kind ?? "native") !== "native"
            ? "only native agent contexts are supported"
            : "this agent's driver does not support managed skills";
        state.links.push({ agentId: target.agentId, status: "unsupported", detail });
        continue;
      }
      if (target.invocation === "manual" && binding.driver !== "claude-code") {
        // `disable-model-invocation` is Claude Code semantics: a codex-family harness has no
        // mechanism that enforces manual-only invocation, so linking would silently over-expose
        // the skill. Report it honestly instead of claiming a linked deployment — and if another
        // target puts a link into the same shared harness directory, this agent can consume the
        // skill anyway, which is a conflict (resolved below once link outcomes are known), not
        // a clean skip.
        manualUnsupported.push({ agentId: target.agentId, relDir: binding.relDir });
        continue;
      }
      let plan = plans.get(binding.relDir);
      if (!plan) {
        plan = { agentTargets: [], manualTargets: [] };
        plans.set(binding.relDir, plan);
      }
      (target.invocation === "manual" ? plan.manualTargets : plan.agentTargets).push(target.agentId);
      harnessKeep.get(binding.relDir)?.add(entry.name);
    }
    const targetedIds = new Set(entry.targets.map((target) => target.agentId));
    const linkedDirs = new Set<string>();
    for (const [relDir, plan] of plans) {
      const mixed = plan.agentTargets.length > 0 && plan.manualTargets.length > 0;
      const useManual = plan.manualTargets.length > 0 && plan.agentTargets.length === 0;
      let outcome: LinkOutcome;
      if (useManual) {
        // The manual variant's content differs from the canonical agent-invocation variant, so
        // its harness link must point straight at the `-manual` digest dir; it cannot route
        // through the canonical link.
        outcome = ensureManagedSymlink(
          join(home, relDir, entry.name),
          manualVariantDir,
          realStoreRoot,
          `~/${relDir}/${entry.name}`,
          canonicalDir,
        );
      } else if (!canonical.ok && canonical.status === "conflict") {
        // The canonical path has been replaced by foreign content. A managed harness link
        // routing through it would serve that foreign content under a managed name, so remove
        // the harness link — verified ours by probe shape AND recorded in the link manifest —
        // and report the removal. A canonical-shaped link this runner has no record of creating
        // belongs to the user: it is left in place and reported, never removed. The foreign
        // canonical path itself is never touched either way.
        const linkPath = join(home, relDir, entry.name);
        const shownPath = `~/${relDir}/${entry.name}`;
        const probe = probeLink(linkPath, realStoreRoot, canonicalDir);
        const removable = probe.kind === "ours" && (probe.via === "store" || owned.has(linkPath));
        if (removable) {
          try {
            unlinkSync(linkPath);
            owned.delete(linkPath);
            removedLinks.push(shownPath);
            options.log?.(
              `skill link removed: ${shownPath} (the canonical location it routes through is conflicted)`,
            );
          } catch (error) {
            /* Removal is best effort; a vanished or contested entry is left for the next pass. */
            options.log?.(`skill link removal failed for ${shownPath}: ${errText(error)}`);
          }
        }
        harnessKeep.get(relDir)?.delete(entry.name);
        outcome =
          probe.kind === "ours" && !removable
            ? {
                ok: false,
                status: "conflict",
                detail: `The canonical location at ~/.agents/skills/${entry.name} is conflicted, and an unmanaged symlink at ${shownPath} routes through it; the link was not created by this runner and was left in place.`,
              }
            : {
                ok: false,
                status: "error",
                detail: `The canonical location at ~/.agents/skills/${entry.name} is conflicted, so this harness link was removed.`,
              };
      } else if (!canonical.ok) {
        // Agent-invocation harness links route through the canonical link; without it there is
        // nothing managed to point at.
        outcome = { ok: false, status: canonical.status, detail: `canonical link: ${canonical.detail}` };
      } else {
        // Point at the canonical link, not the digest dir: one atomic canonical flip then
        // switches every harness at once, and a crash mid-reconcile can never leave harness
        // links on different versions.
        outcome = ensureManagedSymlink(
          join(home, relDir, entry.name),
          canonicalPath,
          realStoreRoot,
          `~/${relDir}/${entry.name}`,
          canonicalDir,
        );
      }
      const linkedIds = useManual ? plan.manualTargets : [...plan.agentTargets, ...(mixed ? [] : plan.manualTargets)];
      for (const agentId of linkedIds) {
        state.links.push(
          outcome.ok
            ? { agentId, status: "linked" }
            : { agentId, status: outcome.status, detail: outcome.detail },
        );
      }
      if (outcome.ok) {
        ownLink(join(home, relDir, entry.name));
        linkedDirs.add(relDir);
        // A shared harness directory (codex and codex-app-server both read ~/.codex/skills)
        // cannot scope a skill to one of its agents: every other native agent reading this
        // directory can consume the link, so report that visibility instead of over-claiming
        // isolation. Targeted agents keep their normal state.
        for (const other of bindings) {
          if (other.relDir !== relDir || targetedIds.has(other.agentId)) continue;
          state.links.push({
            agentId: other.agentId,
            status: "linked",
            detail: "Shared harness directory; also visible to this agent.",
          });
        }
      }
      if (mixed) {
        for (const agentId of plan.manualTargets) {
          state.links.push({
            agentId,
            status: "conflict",
            detail: `another agent shares ~/${relDir} and requires model invocation for this skill`,
          });
        }
      }
    }
    // A manual target on a codex-family driver is only a clean "unsupported" skip while its
    // shared harness directory carries no managed link for this skill. Once another target puts
    // an agent-invocable link there, this agent can consume the skill anyway, so the honest
    // state is a conflict, not a skip.
    for (const { agentId, relDir } of manualUnsupported) {
      state.links.push(
        linkedDirs.has(relDir)
          ? {
              agentId,
              status: "conflict" as const,
              detail:
                "Manual-only invocation is not supported for this agent and the skill is still visible through the shared harness directory.",
            }
          : {
              agentId,
              status: "unsupported" as const,
              detail: "Manual-only invocation is not supported for this agent.",
            },
      );
    }
    deployed.push(state);
  }

  if (allowRemovals) {
    // Harness links route through the canonical link, so remove them first: removing the
    // canonical link first would leave dangling harness links if this pass crashed in between.
    for (const [relDir, keep] of harnessKeep) {
      sweepManagedLinks(
        join(home, relDir),
        keep,
        realStoreRoot,
        { owned, removedLinks, shownDir: `~/${relDir}`, log: options.log },
        canonicalDir,
      );
    }
    sweepManagedLinks(canonicalDir, canonicalKeep, realStoreRoot, {
      owned,
      removedLinks,
      shownDir: "~/.agents/skills",
      log: options.log,
    });
    const retentionPath = skillRetentionStatePath(dataDir);
    const retention = loadRetentionState(retentionPath, options.log);
    gcStore(
      realStoreRoot,
      storeKeep,
      retention,
      {
        removedSkillMs: options.removedSkillRetentionMs ?? DEFAULT_REMOVED_SKILL_RETENTION_MS,
        previousVersionMs: options.previousVersionGraceMs ?? DEFAULT_PREVIOUS_VERSION_GRACE_MS,
        now: options.now ?? Date.now(),
      },
      options.log,
    );
    saveRetentionState(retentionPath, retention, options.log);
  }

  // Persist ownership only when it changed (links created, removed, or newly adopted); the save
  // path also prunes entries whose path no longer holds any symlink.
  if (owned.size !== ownedAtLoad.size || [...owned].some((link) => !ownedAtLoad.has(link))) {
    saveOwnedLinks(manifestPath, owned, options.log);
  }

  return {
    deployed,
    unmanaged: scanUnmanagedSkills(home, agents, (linkPath) => {
      // Foreign is anything the sweep would refuse to touch: a link with a foreign target, or a
      // canonical-shaped link this runner has no record of creating.
      const probe = probeLink(linkPath, realStoreRoot, canonicalDir);
      if (probe.kind !== "ours") return true;
      return probe.via === "canonical" && !owned.has(linkPath);
    }),
    removedLinks,
  };
}
