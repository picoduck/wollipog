/**
 * Read-only inspection and operator-authorized recovery of a blocked generic updater slot.
 *
 * Recovery never deletes. It atomically renames one fully recognized, inactive attempt slot into
 * a private preservation directory beside the data, which empties the staging parent so the next
 * update is admitted. Authority comes from all of these together, never from any one alone:
 * an explicit operator token bound to the exact inspected identities and contents, a valid owner
 * record whose pinned identities still match, an inventory of only recognized attempt objects,
 * and inactivity evidence from `/proc`: the recorded updater process (PID, start time, boot ID)
 * is gone and no inspectable process holds the staging directories open. Same-user processes
 * whose descriptors cannot be read (non-dumpable agents, other namespaces) are tolerated only
 * when the updater's recorded identity proves it gone, or when the operator explicitly attests
 * that no update is running. Anything unknown, substituted, linked, or unprovable refuses.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants, readdirSync, readFileSync, readlinkSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import {
  STAGING_OWNER, STAGING_PARENT, STAGING_SLOT, isLocalStagingFilesystem, stagingChain, stagingUid, validateSelectedAssets,
  type StagingContext, type StagingFilesystem,
} from "./release-staging.js";
import {
  NONCE_RE, appendJournalEvent, describeJournal, pinPrivateDirectory, readJournal, readPrivateRecord, redactDetail, withSlotEvidence, writePrivateRecord,
  type JournalSummary, type PinnedDirectory, type ProcessIdentity,
} from "./release-staging-journal.js";

export const RECOVERY_DIR = "upgrade-recovery";
export const RECOVERY_RECORD = "recovery.json";
const MAX_ENTRIES = 16;
const MAX_PRESERVED_LISTED = 32;
const MAX_OWNER_BYTES = 64 * 1024;
const TAG_RE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/** Injectable view of the process table; the default reads Linux `/proc`. */
export interface StagingProcesses {
  readonly self: number;
  /** Every visible process ID. Throws when the table cannot be listed. */
  list(): number[];
  /** Real, effective, saved and filesystem UIDs, or null when the process has exited. */
  uids(pid: number): number[] | null;
  /** cwd, root and every descriptor target, or null when the process has exited. Throws when unreadable. */
  links(pid: number): string[] | null;
  /** Start time and boot ID of a running process, or null when it is not running. */
  identity(pid: number): ProcessIdentity | null;
  /** Short command name, for diagnostics only. */
  name(pid: number): string | null;
}

function gone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ESRCH";
}

export function procProcesses(root = "/proc"): StagingProcesses {
  const bootId = (): string => readFileSync(join(root, "sys/kernel/random/boot_id"), "utf8").trim();
  return {
    self: process.pid,
    list: () => readdirSync(root).filter((name) => /^\d+$/u.test(name)).map(Number),
    uids: (pid) => {
      try {
        const line = readFileSync(join(root, String(pid), "status"), "utf8").split("\n").find((entry) => entry.startsWith("Uid:"));
        return line ? line.slice(4).trim().split(/\s+/u).map(Number) : null;
      } catch (error) { if (gone(error)) return null; throw error; }
    },
    links: (pid) => {
      const base = join(root, String(pid));
      const links: string[] = [];
      try {
        for (const name of ["cwd", "root"]) {
          try { links.push(readlinkSync(join(base, name))); }
          catch (error) { if (!gone(error)) throw error; }
        }
        for (const fd of readdirSync(join(base, "fd"))) {
          try { links.push(readlinkSync(join(base, "fd", fd))); }
          catch (error) { if (!gone(error)) throw error; }
        }
      } catch (error) { if (gone(error)) return null; throw error; }
      return links;
    },
    identity: (pid) => {
      try {
        const stat = readFileSync(join(root, String(pid), "stat"), "utf8");
        // Field 22 (starttime) counted after the parenthesized command name, which may hold spaces.
        const startTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
        return startTime ? { pid, startTime, bootId: bootId() } : null;
      } catch (error) { if (gone(error)) return null; throw error; }
    },
    name: (pid) => {
      try {
        const stat = readFileSync(join(root, String(pid), "stat"), "utf8");
        return stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")) || null;
      } catch { return null; }
    },
  };
}

export interface Holders {
  /** "unavailable" only when the process table itself cannot be listed. */
  state: "none" | "found" | "unavailable";
  pids: number[];
  /** Same-user processes whose descriptors could not be read, so they were not checked. */
  uninspectable: Array<{ pid: number; name: string | null }>;
  reason: string | null;
}

/**
 * Find processes whose cwd, root or descriptors are inside `target`. A live updater pins the
 * staging parent and slot for its whole attempt, so a holder means the attempt may be active.
 * Only processes running as `uid` can open the private slot (all processes when root).
 */
export function findHolders(target: string, uid: bigint, procs: StagingProcesses): Holders {
  let pids: number[];
  try { pids = procs.list(); }
  catch (error) { return { state: "unavailable", pids: [], uninspectable: [], reason: `the process table cannot be listed (${redactDetail((error as Error).message)}); activity cannot be ruled out` }; }
  const found: number[] = [];
  const uninspectable: Holders["uninspectable"] = [];
  for (const pid of pids) {
    if (pid === procs.self) continue;
    try {
      const uids = procs.uids(pid);
      if (!uids || (uid !== 0n && !uids.some((id) => BigInt(id) === uid))) continue;
      const links = procs.links(pid);
      if (links?.some((link) => link === target || link.startsWith(`${target}/`))) found.push(pid);
    } catch {
      const name = procs.name(pid);
      uninspectable.push({ pid, name: name === null ? null : redactDetail(name).slice(0, 32) });
    }
  }
  return found.length
    ? { state: "found", pids: found, uninspectable, reason: `process${found.length === 1 ? "" : "es"} ${found.join(", ")} hold${found.length === 1 ? "s" : ""} the staging directory open; the attempt may still be active` }
    : { state: "none", pids: [], uninspectable, reason: null };
}

const describeProcesses = (list: Holders["uninspectable"]) =>
  `${list.slice(0, 8).map(({ pid, name }) => `${pid}${name ? ` ${name}` : ""}`).join(", ")}${list.length > 8 ? `, and ${list.length - 8} more` : ""}`;

type Kind = "file" | "directory" | "symlink" | "other";
const kindOf = (stat: BigIntStats): Kind => stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
const octal = (mode: bigint) => `0${(mode & 0o7777n).toString(8)}`;
const identityOf = (stat: BigIntStats) => ({ dev: String(stat.dev), ino: String(stat.ino), uid: String(stat.uid), mode: String(stat.mode) });
const sameIdentity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;

export interface StagingEntry { name: string; kind: Kind; size: number; mode: string; uid: number; nlink: number }
interface Observed { entry: StagingEntry; stat: BigIntStats }

export interface OwnerSummary {
  state: "absent" | "incomplete" | "invalid" | "valid";
  reason: string | null;
  nonce: string | null;
  tag: string | null;
  assets: Array<{ name: string; size: number }>;
}

export interface PreservedAttempt { name: string; path: string; state: "preserved" | "incomplete" | "unreadable"; detail: string }

export interface StagingInspection {
  mode: "user" | "system";
  dataDir: string;
  parent: string;
  slot: string;
  state: "clear" | "blocked" | "unavailable";
  problem: string | null;
  parentEntries: Array<{ name: string; kind: Kind }>;
  slotEntries: StagingEntry[] | null;
  owner: OwnerSummary;
  journal: JournalSummary;
  holders: Holders;
  /**
   * `token` is present whenever the attempt's objects are proven; `acknowledgement` then names
   * the only remaining doubt (uninspectable processes) that the operator may explicitly accept.
   */
  recovery: { eligible: boolean; reasons: string[]; token: string | null; acknowledgement: string | null; destination: string };
  preserved: PreservedAttempt[];
}

/** Bounded, no-follow inventory; `truncated` when more names exist than the bound. */
function list(path: string, fs: StagingFilesystem, bound: number): { observed: Observed[]; truncated: boolean } {
  const observed: Observed[] = [];
  const dir = fs.directory(path);
  try {
    for (;;) {
      const entry = dir.readSync();
      if (!entry) return { observed: observed.sort((a, b) => (a.entry.name < b.entry.name ? -1 : 1)), truncated: false };
      if (observed.length === bound) return { observed, truncated: true };
      const stat = fs.lstat(join(path, entry.name));
      observed.push({ stat, entry: { name: entry.name, kind: kindOf(stat), size: Number(stat.size), mode: octal(stat.mode), uid: Number(stat.uid), nlink: Number(stat.nlink) } });
    }
  } finally { dir.closeSync(); }
}

interface OwnerEvidence extends OwnerSummary { digest: string | null; partials: Map<string, string>; declared: Map<string, number>; process: ProcessIdentity | null }

function readOwner(slot: string, slotStat: BigIntStats, parentStat: BigIntStats, rootStat: BigIntStats, uid: bigint, fs: StagingFilesystem): OwnerEvidence {
  const empty = { nonce: null, tag: null, assets: [], digest: null, partials: new Map(), declared: new Map(), process: null };
  let bytes: Buffer | null;
  try { bytes = readPrivateRecord(join(slot, STAGING_OWNER), uid, MAX_OWNER_BYTES, fs); }
  catch (error) { return { ...empty, state: "invalid", reason: redactDetail((error as Error).message) }; }
  if (!bytes) return { ...empty, state: "absent", reason: "the slot has no owner record (initialization was interrupted or the slot is legacy)" };
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) return { ...empty, state: "incomplete", reason: "the owner record is incomplete (initialization was interrupted while writing it)" };
  let value: { schema?: unknown; nonce?: unknown; tag?: unknown; root?: unknown; parent?: unknown; attempt?: unknown; assets?: unknown; process?: Partial<ProcessIdentity> };
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { return { ...empty, state: "incomplete", reason: "the owner record is not complete JSON" }; }
  const nonce = typeof value.nonce === "string" && NONCE_RE.test(value.nonce) ? value.nonce : null;
  const tag = typeof value.tag === "string" && TAG_RE.test(value.tag) ? value.tag : null;
  const assets = Array.isArray(value.assets) ? value.assets as Array<{ name: string; size: number; digest: string | null }> : [];
  const summary = { nonce, tag, assets: assets.filter((asset) => asset && typeof asset.name === "string").map(({ name, size }) => ({ name, size })) };
  const invalid = (reason: string): OwnerEvidence => ({ ...empty, ...summary, state: "invalid", reason });
  if (value.schema !== 1) return invalid("the owner record has an unknown schema");
  if (!nonce || !tag) return invalid("the owner record has no valid nonce or release tag");
  try { validateSelectedAssets(assets.map((asset) => ({ ...asset, url: "" }))); }
  catch (error) { return invalid(`the owner record's asset list is invalid (${(error as Error).message})`); }
  const matches = (recorded: unknown, stat: BigIntStats) => JSON.stringify(recorded) === JSON.stringify(identityOf(stat));
  if (!matches(value.root, rootStat) || !matches(value.parent, parentStat) || !matches(value.attempt, slotStat)) {
    return invalid("the owner record's pinned identities do not match the current data directory, parent and slot (substituted or copied)");
  }
  // Older updaters recorded no process identity; a malformed one is not trusted as evidence.
  const recorded = value.process;
  if (recorded !== undefined && (!recorded || !Number.isSafeInteger(recorded.pid) || typeof recorded.startTime !== "string" || typeof recorded.bootId !== "string")) {
    return invalid("the owner record's updater process identity is malformed");
  }
  const process = recorded ? { pid: recorded.pid!, startTime: recorded.startTime!, bootId: recorded.bootId! } : null;
  const declared = new Map(assets.map((asset) => [asset.name, asset.size]));
  const partials = new Map(assets.map((asset) => [`${asset.name}.${nonce}.partial`, asset.name]));
  return { ...summary, state: "valid", reason: null, digest: createHash("sha256").update(bytes).digest("hex"), partials, declared, process };
}

/** Why one slot object is not a recognized object of this owner's attempt, or null when it is. */
function unrecognized({ entry, stat }: Observed, owner: OwnerEvidence, uid: bigint): string | null {
  const name = entry.name;
  if (name === STAGING_OWNER) return null;
  if (name === "web") {
    // Only an attempt that selected the web archive ever extracts one.
    if (!owner.declared.has("wollipog-web.tar.gz")) return "web exists although this attempt selected no web archive";
    return stat.isDirectory() && !stat.isSymbolicLink() ? null : "web is not a real directory";
  }
  const asset = owner.declared.has(name) ? name : owner.partials.get(name);
  if (!asset) return `${name} is not an object of this attempt`;
  if (!stat.isFile() || stat.isSymbolicLink()) return `${name} is not a regular file`;
  if (stat.nlink !== 1n) return `${name} has ${stat.nlink} hard links`;
  if (stat.uid !== uid) return `${name} is not owned by the updater`;
  const mode = stat.mode & 0o7777n;
  if (mode !== 0o600n && !(mode === 0o755n && name === asset)) return `${name} has unexpected permissions ${octal(stat.mode)}`;
  if (stat.size > BigInt(owner.declared.get(asset)!)) return `${name} is larger than its declared size`;
  return null;
}

function tokenFor(slot: string, parentStat: BigIntStats, slotStat: BigIntStats, owner: OwnerEvidence, observed: Observed[]): string {
  const evidence = JSON.stringify({
    slot, parent: identityOf(parentStat), attempt: identityOf(slotStat), owner: owner.digest,
    entries: observed.map(({ entry, stat }) => [entry.name, String(stat.dev), String(stat.ino), String(stat.uid), String(stat.mode), String(stat.size), String(stat.nlink)]),
  });
  return `sa1-${createHash("sha256").update(evidence).digest("hex").slice(0, 32)}`;
}

function listPreserved(dataDir: string, uid: bigint, fs: StagingFilesystem): PreservedAttempt[] {
  const root = join(dataDir, RECOVERY_DIR);
  let observed: Observed[];
  try {
    const stat = fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [{ name: RECOVERY_DIR, path: root, state: "unreadable", detail: "the preservation path is not a directory" }];
    ({ observed } = list(root, fs, MAX_PRESERVED_LISTED));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [{ name: RECOVERY_DIR, path: root, state: "unreadable", detail: redactDetail((error as Error).message) }];
  }
  return observed.filter(({ stat }) => stat.isDirectory() && !stat.isSymbolicLink()).map(({ entry }) => {
    const path = join(root, entry.name);
    let moved = false;
    try { moved = fs.lstat(join(path, STAGING_SLOT)).isDirectory(); } catch { /* not moved */ }
    try {
      const bytes = readPrivateRecord(join(path, RECOVERY_RECORD), uid, MAX_OWNER_BYTES, fs);
      const record = bytes ? JSON.parse(bytes.toString("utf8")) as { state?: string; tag?: string } : null;
      if (record?.state === "preserved" && moved) return { name: entry.name, path, state: "preserved" as const, detail: `${record.tag ?? "unknown release"} attempt preserved` };
      return { name: entry.name, path, state: "incomplete" as const, detail: moved ? "the attempt was moved here, but recovery stopped before its record was finalized" : "recovery stopped before moving the attempt; the staging slot was not changed by it" };
    } catch (error) {
      return { name: entry.name, path, state: "unreadable" as const, detail: redactDetail((error as Error).message) };
    }
  });
}

interface Evidence {
  inspection: StagingInspection;
  parentStat: BigIntStats | null;
  slotStat: BigIntStats | null;
  uid: bigint | null;
}

/** Any unexpected I/O error makes the inspection unavailable rather than escaping the caller. */
function examine(dataDir: string, context: StagingContext, fs: StagingFilesystem, procs: StagingProcesses, options: RecoveryOptions): Evidence {
  const parent = join(dataDir, STAGING_PARENT);
  const inspection: StagingInspection = {
    mode: context.mode, dataDir, parent, slot: join(parent, STAGING_SLOT), state: "clear", problem: null, parentEntries: [], slotEntries: null,
    owner: { state: "absent", reason: "no attempt slot", nonce: null, tag: null, assets: [] },
    journal: describeJournal(readJournal(dataDir, null, fs)),
    holders: { state: "none", pids: [], uninspectable: [], reason: null },
    recovery: { eligible: false, reasons: [], token: null, acknowledgement: null, destination: join(dataDir, RECOVERY_DIR) },
    preserved: [],
  };
  const evidence: Evidence = { inspection, parentStat: null, slotStat: null, uid: null };
  try {
    return gather(evidence, context, fs, procs, options);
  } catch (error) {
    inspection.state = "unavailable";
    inspection.problem = redactDetail((error as Error).message);
    inspection.recovery = { ...inspection.recovery, eligible: false, token: null, reasons: [...inspection.recovery.reasons, `inspection could not complete (${inspection.problem})`] };
    return evidence;
  }
}

function gather(evidence: Evidence, context: StagingContext, fs: StagingFilesystem, procs: StagingProcesses, options: RecoveryOptions): Evidence {
  const { inspection } = evidence;
  const { dataDir, parent, slot } = inspection;
  const refuse = (reason: string) => { inspection.recovery.reasons.push(reason); };
  let uid: bigint;
  let root: BigIntStats;
  try {
    uid = stagingUid(fs);
    root = stagingChain(dataDir, context, uid, fs).at(-1)!.stat;
  } catch (error) {
    inspection.state = "unavailable";
    inspection.problem = redactDetail((error as Error).message);
    refuse("the data directory does not meet the staging safety profile, so nothing can be proven");
    return evidence;
  }
  evidence.uid = uid;
  inspection.preserved = listPreserved(dataDir, uid, fs);
  let parentStat: BigIntStats;
  try { parentStat = fs.lstat(parent); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { refuse("staging is clear; there is nothing to recover"); return evidence; }
    inspection.state = "unavailable"; inspection.problem = redactDetail((error as Error).message);
    refuse("the staging parent cannot be inspected");
    return evidence;
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== uid || (parentStat.mode & 0o7777n) !== 0o700n || !isLocalStagingFilesystem(fs, parent)) {
    inspection.state = "blocked";
    inspection.problem = `${parent} is not a private local directory owned by the updater`;
    refuse(`${parent} is not a private local directory owned by the updater; it is protected`);
    return evidence;
  }
  evidence.parentStat = parentStat;
  const parentList = list(parent, fs, MAX_ENTRIES);
  inspection.parentEntries = parentList.observed.map(({ entry }) => ({ name: entry.name, kind: entry.kind }));
  if (parentList.observed.length === 0) { refuse("staging is clear; there is nothing to recover"); return evidence; }
  inspection.state = "blocked";
  const foreign = parentList.observed.filter(({ entry }) => entry.name !== STAGING_SLOT).map(({ entry }) => entry.name);
  if (foreign.length || parentList.truncated) refuse(`${parent} holds entries other than the attempt slot (${foreign.join(", ")}${parentList.truncated ? ", and more" : ""}); unknown entries are protected and would still block updates`);
  inspection.holders = findHolders(parent, uid, procs);
  if (inspection.holders.reason) refuse(inspection.holders.reason);
  const slotObserved = parentList.observed.find(({ entry }) => entry.name === STAGING_SLOT);
  if (!slotObserved) return evidence;
  const slotStat = slotObserved.stat;
  if (!slotStat.isDirectory() || slotStat.isSymbolicLink()) { refuse(`${slot} is not a real directory; it is protected`); return evidence; }
  if (slotStat.uid !== uid || (slotStat.mode & 0o7777n) !== 0o700n || !isLocalStagingFilesystem(fs, slot)) refuse(`${slot} is not a private local directory owned by the updater`);
  evidence.slotStat = slotStat;
  const slotList = list(slot, fs, MAX_ENTRIES);
  inspection.slotEntries = slotList.observed.map(({ entry }) => entry);
  if (slotList.truncated) refuse(`${slot} holds more than ${MAX_ENTRIES} entries, more than any attempt creates`);
  const owner = readOwner(slot, slotStat, parentStat, root, uid, fs);
  inspection.owner = { state: owner.state, reason: owner.reason, nonce: owner.nonce, tag: owner.tag, assets: owner.assets };
  inspection.journal = describeJournal(readJournal(dataDir, owner.nonce, fs));
  if (owner.state !== "valid") {
    refuse(`${owner.reason}; legacy, incomplete or unverifiable metadata grants no recovery authority`);
    return evidence;
  }
  let recognized = true;
  for (const observed of slotList.observed) {
    const reason = unrecognized(observed, owner, uid);
    if (reason) { recognized = false; refuse(`${reason}; unrecognized objects are protected`); }
  }
  if (recognized) {
    // Replacement starts only after every download is published, and publication removes the
    // partial, so a remaining partial proves nothing was replaced. Retained staged executables
    // prove nothing: the swap moves the live executable aside first, and a cross-filesystem move
    // replaces the live path before removing its staged source.
    const downloading = slotList.observed.some(({ entry }) => owner.partials.has(entry.name));
    inspection.journal = withSlotEvidence(inspection.journal, downloading ? "a download was still in progress" : null);
  }
  const recorded = owner.process ?? inspection.journal.process;
  let updaterGone = false;
  if (recorded) {
    try {
      const running = procs.identity(recorded.pid);
      if (running && running.bootId === recorded.bootId && running.startTime === recorded.startTime) {
        refuse(`updater process ${recorded.pid} that recorded this attempt is still running`);
      } else updaterGone = true;
    } catch (error) {
      refuse(`updater process ${recorded.pid} cannot be checked (${redactDetail((error as Error).message)})`);
    }
  }
  const uninspectable = inspection.holders.uninspectable;
  const acknowledgement = uninspectable.length && !updaterGone
    ? `${uninspectable.length} same-user process${uninspectable.length === 1 ? "" : "es"} could not be inspected (${describeProcesses(uninspectable)}) and this attempt records no updater identity that proves its updater is gone, so activity cannot be ruled out`
    : null;
  const destination = join(dataDir, RECOVERY_DIR);
  try {
    const stat = fs.lstat(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7777n) !== 0o700n) refuse(`${destination} is not a private directory owned by the updater`);
    else if (stat.dev !== parentStat.dev) refuse(`${destination} is on a different filesystem from ${parent}, so the attempt cannot be moved atomically`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") refuse(`${destination} cannot be inspected (${redactDetail((error as Error).message)})`);
  }
  if (inspection.recovery.reasons.length === 0) {
    // The token binds the evidence; an operator attestation can stand in only for unreadable processes.
    inspection.recovery.token = tokenFor(slot, parentStat, slotStat, owner, slotList.observed);
    inspection.recovery.acknowledgement = acknowledgement;
    if (acknowledgement && !options.acceptUninspectable) {
      refuse(`${acknowledgement}; confirm that no Wollipog update is running for this layout, then pass --accept-uninspectable-processes`);
    }
    inspection.recovery.eligible = inspection.recovery.reasons.length === 0;
  }
  return evidence;
}

export interface RecoveryOptions {
  /** Operator attests that same-user processes that cannot be inspected are not updating this layout. */
  acceptUninspectable?: boolean;
}

/** Read-only: lists directories and reads small records, never creates, moves or deletes. */
export function inspectStaging(dataDir: string, context: StagingContext, fs: StagingFilesystem, procs: StagingProcesses, options: RecoveryOptions = {}): StagingInspection {
  return examine(dataDir, context, fs, procs, options).inspection;
}

export class RecoveryRefusedError extends Error {
  constructor(message: string, readonly inspection: StagingInspection | null) { super(message); }
}

export interface RecoveryResult {
  preservedPath: string;
  container: string;
  tag: string;
  nonce: string;
  /** True when the staging parent was empty after the move, so the next update is admitted. */
  admissible: boolean;
  warnings: string[];
}

function compactTime(at: string): string {
  return at.replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
}

/**
 * Move the exact inspected attempt out of the staging namespace. The caller's token must match a
 * fresh inspection made while this process pins the staging directories, so a concurrent update
 * or recovery is either visible as a holder or has changed the evidence the token was bound to.
 */
export function recoverStaging(
  dataDir: string, context: StagingContext, token: string, fs: StagingFilesystem, procs: StagingProcesses, now: () => string,
  options: RecoveryOptions = {},
): RecoveryResult {
  if (!/^sa1-[0-9a-f]{32}$/u.test(token)) throw new RecoveryRefusedError("the attempt token is malformed; copy it from `wollipog service staging inspect`", null);
  const parent = join(dataDir, STAGING_PARENT);
  const slot = join(parent, STAGING_SLOT);
  // Every mutation below is addressed through a pinned directory descriptor, so replacing a path
  // (for example by a service account that owns the data directory) cannot redirect it.
  const pins: number[] = [];
  const pin = (path: string): { fd: number; stat: BigIntStats } => {
    const fd = fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    pins.push(fd);
    const stat = fs.fstat(fd);
    if (!sameIdentity(stat, fs.lstat(path))) throw new RecoveryRefusedError(`${path} changed while it was opened; inspect again`, null);
    return { fd, stat };
  };
  const pinPrivate = (path: string, uid: bigint, create: boolean): PinnedDirectory => {
    const dir = pinPrivateDirectory(path, uid, fs, create);
    pins.push(dir.fd);
    return dir;
  };
  try {
    let pinnedParent: { fd: number; stat: BigIntStats };
    let pinnedSlot: BigIntStats;
    try { pinnedParent = pin(parent); pinnedSlot = pin(slot).stat; }
    catch (error) {
      if (error instanceof RecoveryRefusedError) throw error;
      const inspection = inspectStaging(dataDir, context, fs, procs, options);
      throw new RecoveryRefusedError(`the staging slot cannot be opened (${redactDetail((error as Error).message)}); inspect again`, inspection);
    }
    const first = examine(dataDir, context, fs, procs, options);
    const inspection = first.inspection;
    if (!inspection.recovery.eligible) throw new RecoveryRefusedError(`recovery refused: ${inspection.recovery.reasons.join("; ")}`, inspection);
    if (inspection.recovery.token !== token) {
      throw new RecoveryRefusedError("recovery refused: the token does not match the current attempt; its contents or identity changed since inspection, or the token belongs to a different attempt. Inspect again and confirm the new evidence", inspection);
    }
    if (!sameIdentity(pinnedSlot, first.slotStat!)) throw new RecoveryRefusedError("recovery refused: the slot was substituted during inspection", inspection);
    const uid = first.uid!;
    const at = now();
    const destination = join(dataDir, RECOVERY_DIR);
    let destinationDir: PinnedDirectory;
    try { destinationDir = pinPrivate(destination, uid, true); }
    catch (error) { throw new RecoveryRefusedError(`recovery refused: ${redactDetail((error as Error).message)}`, inspection); }
    if (destinationDir.dev !== first.parentStat!.dev) throw new RecoveryRefusedError(`recovery refused: ${destination} is not on the staging filesystem`, inspection);
    const name = `${compactTime(at)}-${inspection.owner.nonce!.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
    const container = join(destination, name);
    fs.mkdir(join(destinationDir.base, name), { mode: 0o700 });
    let containerDir: PinnedDirectory;
    try { containerDir = pinPrivate(join(destinationDir.base, name), uid, false); }
    catch (error) { throw new RecoveryRefusedError(`recovery refused: ${container} was not created as a private directory (${redactDetail((error as Error).message)})`, inspection); }
    const parentBase = `/proc/self/fd/${pinnedParent.fd}`;
    const record = {
      schema: 1, state: "moving", token, requestedAt: at, source: slot, mode: context.mode,
      acknowledged: inspection.recovery.acknowledgement,
      tag: inspection.owner.tag, nonce: inspection.owner.nonce, entries: inspection.slotEntries,
      phase: { outcome: inspection.journal.outcome, conclusion: inspection.journal.conclusion, events: inspection.journal.events },
    };
    writePrivateRecord(containerDir, RECOVERY_RECORD, Buffer.from(`${JSON.stringify(record)}\n`), fs);
    // Revalidate immediately before the move: same pinned slot, same evidence, still no holder.
    const second = examine(dataDir, context, fs, procs, options).inspection;
    const source = join(parentBase, STAGING_SLOT);
    // The descriptors decide where bytes go; the reported paths must still name those directories.
    const named = (path: string, dir: PinnedDirectory) => {
      try { const stat = fs.lstat(path); return !stat.isSymbolicLink() && stat.dev === dir.dev && stat.ino === dir.ino; }
      catch { return false; }
    };
    if (!second.recovery.eligible || second.recovery.token !== token || !sameIdentity(pinnedSlot, fs.lstat(source)) || !sameIdentity(pinnedParent.stat, fs.lstat(parent))) {
      throw new RecoveryRefusedError(`recovery refused: the attempt changed while recovery was preparing (${second.recovery.reasons.join("; ") || "evidence changed"}); nothing was moved`, second);
    }
    if (!named(destination, destinationDir) || !named(container, containerDir)) {
      throw new RecoveryRefusedError(`recovery refused: ${destination} or ${container} was moved or replaced while recovery was preparing; nothing was moved`, second);
    }
    let preservedPath = join(container, STAGING_SLOT);
    let preservedContainer = container;
    const target = join(containerDir.base, STAGING_SLOT);
    fs.rename(source, target);
    if (!sameIdentity(fs.lstat(target), pinnedSlot)) {
      let restored = false;
      try { fs.rename(target, source); restored = true; } catch { /* leave both for the operator */ }
      throw new RecoveryRefusedError(`recovery stopped: the moved object is not the pinned attempt slot${restored ? "; it was moved back" : `; it remains at ${preservedPath}`}`, null);
    }
    const warnings: string[] = [];
    if (!named(container, containerDir)) {
      // Renamed in the instant after the check: report where the pinned directory actually is.
      let actual: string | null = null;
      try { actual = readlinkSync(containerDir.base); } catch { /* unknown */ }
      if (actual) { preservedContainer = actual; preservedPath = join(actual, STAGING_SLOT); }
      warnings.push(`the preservation directory was moved during recovery; the attempt is now at ${actual ? preservedPath : "an unknown path (inspect the data directory)"}`);
    }
    for (const [path, fd] of [[parent, pinnedParent.fd], [container, containerDir.fd], [destination, destinationDir.fd]] as const) {
      try { fs.sync(fd); }
      catch (error) { warnings.push(`could not flush ${path}: ${redactDetail((error as Error).message)}`); }
    }
    try {
      writePrivateRecord(containerDir, RECOVERY_RECORD, Buffer.from(`${JSON.stringify({ ...record, state: "preserved", preservedAt: now() })}\n`), fs);
    } catch (error) {
      warnings.push(`the attempt was preserved, but its recovery record could not be finalized: ${redactDetail((error as Error).message)}`);
    }
    const journalProblem = appendJournalEvent(dataDir, inspection.owner.nonce!, { phase: "recovered", at: now(), detail: `preserved at ${preservedPath}` }, fs);
    if (journalProblem && inspection.journal.evidence === "recorded") warnings.push(`the phase journal was not updated: ${journalProblem}`);
    let admissible = false;
    try { admissible = list(parent, fs, 1).observed.length === 0; } catch { /* reported as not admissible */ }
    return { preservedPath, container: preservedContainer, tag: inspection.owner.tag!, nonce: inspection.owner.nonce!, admissible, warnings };
  } finally {
    for (const fd of pins) { try { fs.close(fd); } catch { /* descriptor authority is retired either way */ } }
  }
}
