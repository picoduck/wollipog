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
 *   whose immediate readlink target is the canonical link path for that skill name.
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
}

export interface ReconcileSkillsResult {
  deployed: DeployedSkillState[];
  unmanaged: UnmanagedSkillInfo[];
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

/* ------------------------------ symlink safety ---------------------------- */

type LinkProbe =
  | { kind: "missing" }
  | { kind: "ours"; resolvedTarget: string }
  | { kind: "foreign-symlink" }
  | { kind: "occupied" };

function containedInStore(path: string, realStoreRoot: string): boolean {
  const prefix = realStoreRoot.endsWith(sep) ? realStoreRoot : `${realStoreRoot}${sep}`;
  return path === realStoreRoot || path.startsWith(prefix);
}

/** Classify what currently sits at a link path. Only "ours" may ever be replaced or removed: a
 * symlink whose target resolves inside the realpathed store root, or — when `canonicalDir` is
 * given (harness link paths) — one whose immediate readlink target is the canonical link path for
 * that skill name. The canonical match is lexical on the readlink value, deliberately not a
 * resolution: a harness link left dangling because the canonical link was already removed must
 * still classify as ours so a sweep can remove it instead of stranding it as "foreign". */
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
  if (canonicalDir !== undefined && resolvedTarget === join(canonicalDir, basename(linkPath))) {
    return { kind: "ours", resolvedTarget };
  }
  return containedInStore(resolvedTarget, realStoreRoot)
    ? { kind: "ours", resolvedTarget }
    : { kind: "foreign-symlink" };
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

/** Remove store-owned symlinks whose name is no longer desired. Foreign symlinks, real files,
 * and real directories are never touched. */
function sweepManagedLinks(
  dir: string,
  keep: ReadonlySet<string>,
  realStoreRoot: string,
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
    if (probeLink(linkPath, realStoreRoot, canonicalDir).kind !== "ours") continue;
    try {
      unlinkSync(linkPath);
    } catch {
      /* Removal is best effort; a vanished or contested entry is left for the next pass. */
    }
  }
}

/* -------------------------------- store GC -------------------------------- */

type StoreKeep = Map<string, { digest: string; manual: boolean } | "all">;

/** Prune stale store versions of names still present in desired. Names absent from desired keep
 * their store content: disabling a skill is link removal only, and re-enabling it must not
 * require a full re-transfer. Known MVP limitation: retention for removed skills is therefore
 * unbounded — nothing ever reclaims the store content of a never-again-desired name. Names whose
 * desired entry could not be validated also keep every version: a transient bad payload must not
 * tear down a working deployment. */
function gcStore(storeRoot: string, keep: StoreKeep): void {
  let entries;
  try {
    entries = readdirSync(storeRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(storeRoot, entry.name);
    if (entry.name.startsWith(".tmp-")) {
      // A crashed materialization can strand its temp dir; it is never linked, so reclaim it.
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    // Never traverse or delete through a symlink planted inside the store.
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const want = keep.get(entry.name);
    if (!want || want === "all") continue;
    let versions;
    try {
      versions = readdirSync(path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const version of versions) {
      // A symlinked version entry is never ours; skip it rather than delete through it.
      if (version.isSymbolicLink()) continue;
      const wanted =
        version.name === want.digest || (want.manual && version.name === `${want.digest}-manual`);
      if (!wanted) rmSync(join(path, version.name), { recursive: true, force: true });
    }
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

/** Bounded report-only scan of one harness skill directory: real directories (never symlinks —
 * managed deployments are symlinks) containing a SKILL.md, no recursion beyond that one read. */
function scanHarnessSkillDir(dir: string): { name: string; description?: string }[] {
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
    if (!entry.isDirectory()) continue;
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

function scanUnmanagedSkills(home: string, agents: AgentDefinition[]): UnmanagedSkillInfo[] {
  const perDir = new Map<string, { name: string; description?: string }[]>();
  const results: UnmanagedSkillInfo[] = [];
  for (const binding of harnessBindings(agents)) {
    let found = perDir.get(binding.relDir);
    if (!found) {
      found = scanHarnessSkillDir(join(home, binding.relDir));
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
      unmanaged: scanUnmanagedSkills(home, agents),
    };
  }
  const canonicalDir = canonicalSkillsDir(home);
  const bindings = harnessBindings(agents);
  const agentBinding = new Map(bindings.map((binding) => [binding.agentId, binding]));

  const deployed: DeployedSkillState[] = [];
  const storeKeep: StoreKeep = new Map();
  const canonicalKeep = new Set<string>();
  const harnessKeep = new Map<string, Set<string>>();
  for (const relDir of new Set(Object.values(SKILL_DIRS))) harnessKeep.set(relDir, new Set());
  const seenNames = new Set<string>();

  for (const entry of desired) {
    const invalid = seenNames.has(entry.name) ? "duplicate skill name" : validateSkillSyncEntry(entry);
    seenNames.add(entry.name);
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
    const manualNeeded = entry.targets.some(
      (target) =>
        target.invocation === "manual" && agentBinding.get(target.agentId)?.driver === "claude-code",
    );
    if (!storeKeep.has(entry.name)) {
      storeKeep.set(entry.name, { digest: entry.versionDigest, manual: manualNeeded });
    }
    const state: DeployedSkillState = { name: entry.name, digest: entry.versionDigest, links: [] };
    try {
      materializeVersion(realStoreRoot, entry.name, entry.versionDigest, entry.files, false);
      if (manualNeeded) {
        materializeVersion(realStoreRoot, entry.name, `${entry.versionDigest}-manual`, entry.files, true);
      }
    } catch (error) {
      state.error = `could not materialize the skill version: ${errText(error)}`;
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
    if (!canonical.ok) state.error = `canonical link: ${canonical.detail}`;

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
        // the harness link — it is verified ours by the canonical-path-equality probe rule —
        // and report the removal. The foreign canonical path itself is never touched.
        const linkPath = join(home, relDir, entry.name);
        if (probeLink(linkPath, realStoreRoot, canonicalDir).kind === "ours") {
          try {
            unlinkSync(linkPath);
          } catch {
            /* Removal is best effort; a vanished or contested entry is left for the next pass. */
          }
        }
        harnessKeep.get(relDir)?.delete(entry.name);
        outcome = {
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
      sweepManagedLinks(join(home, relDir), keep, realStoreRoot, canonicalDir);
    }
    sweepManagedLinks(canonicalDir, canonicalKeep, realStoreRoot);
    // Known limitation (MVP): no retention window — a running session keeps deleted version
    // content alive only through its already-open file descriptors.
    gcStore(realStoreRoot, storeKeep);
  }

  return { deployed, unmanaged: scanUnmanagedSkills(home, agents) };
}
