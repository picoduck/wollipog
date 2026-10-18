/**
 * Bounded, durable phase diagnostics for generic updater attempts. One small record per attempt
 * lives outside the staging slot so it survives slot retirement and recovery. A record is evidence
 * for inspection only: it never authorizes cleanup, and a record that stops early is uncertain.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { join } from "node:path";
import { stagingUid, type StagingFilesystem } from "./release-staging.js";

export const JOURNAL_DIR = "upgrade-journal";
/** Older records are pruned when a new attempt is admitted. */
export const JOURNAL_KEEP = 8;
const MAX_EVENTS = 32;
const MAX_DETAIL = 300;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_LISTED = 256;
const STALE_TEMP_NS = 3_600_000_000_000n;
export const NONCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const RECORD_NAME_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/u;
const TEMP_NAME_RE = /^\.[0-9a-f-]{36}\.json\.[0-9a-f-]{36}\.tmp$/u;

export type JournalPhase =
  | "reserved" | "staged" | "installing" | "installed" | "verified"
  | "rolled-back" | "failed" | "cleanup-failed" | "cleaned" | "recovered";
const PHASES = new Set<string>(["reserved", "staged", "installing", "installed", "verified", "rolled-back", "failed", "cleanup-failed", "cleaned", "recovered"]);

/** Enough to tell whether the recording process is still the same running process. */
export interface ProcessIdentity { pid: number; startTime: string; bootId: string }
export interface JournalEvent { phase: JournalPhase; at: string; detail?: string }
export interface JournalRecord {
  schema: 1;
  nonce: string;
  tag: string;
  mode: "user" | "system";
  process: ProcessIdentity | null;
  events: JournalEvent[];
}

/** Keep diagnostics short and free of anything that looks like a credential. */
export function redactDetail(text: string): string {
  return text
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|wollipog[a-z]?_[A-Za-z0-9_-]{20,})\b/gu, "[redacted]")
    .replace(/(authorization|token|password|secret)(\s*[:=]\s*)\S+/giu, "$1$2[redacted]")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .slice(0, MAX_DETAIL);
}

/**
 * A private directory pinned by descriptor. Children are addressed through `/proc/self/fd/<fd>/`,
 * which resolves to the pinned inode, so replacing the directory's path (for example by a service
 * account that owns the data directory in system mode) cannot redirect root's writes.
 */
export interface PinnedDirectory { path: string; fd: number; base: string; dev: bigint; ino: bigint }

export function pinPrivateDirectory(path: string, uid: bigint, fs: StagingFilesystem, create: boolean): PinnedDirectory {
  if (create) {
    try { fs.mkdir(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const fd = fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = fs.fstat(fd);
    const named = fs.lstat(path);
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o7777n) !== 0o700n || named.dev !== stat.dev || named.ino !== stat.ino) {
      throw new Error(`${path} is not a private directory owned by the updater`);
    }
    return { path, fd, base: `/proc/self/fd/${fd}`, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    fs.close(fd);
    throw error;
  }
}

export function withPinnedDirectory<T>(path: string, uid: bigint, fs: StagingFilesystem, create: boolean, use: (dir: PinnedDirectory) => T): T {
  const dir = pinPrivateDirectory(path, uid, fs, create);
  try { return use(dir); } finally { fs.close(dir.fd); }
}

/** Write `bytes` to `dir/name` through an exclusive private temporary file and a rename. */
export function writePrivateRecord(dir: PinnedDirectory, name: string, bytes: Buffer, fs: StagingFilesystem): void {
  const temporary = join(dir.base, `.${name}.${randomUUID()}.tmp`);
  const fd = fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let renamed = false;
  try {
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.write(fd, bytes, offset, bytes.length - offset);
        if (count <= 0) throw new Error("record write made no progress");
        offset += count;
      }
      fs.sync(fd);
    } finally { fs.close(fd); }
    fs.rename(temporary, join(dir.base, name));
    renamed = true;
    fs.sync(dir.fd);
  } finally {
    if (!renamed) { try { fs.unlink(temporary); } catch { /* the temporary may not exist */ } }
  }
}

/** Read a small private regular file without following links; null when absent. */
export function readPrivateRecord(path: string, uid: bigint, limit: number, fs: StagingFilesystem): Buffer | null {
  let stat;
  try { stat = fs.lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== uid || (stat.mode & 0o7777n) !== 0o600n) throw new Error("record is not a private single-link regular file");
  if (stat.size > BigInt(limit)) throw new Error(`record exceeds ${limit} bytes`);
  const fd = fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fs.fstat(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("record was substituted while it was read");
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.read(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) break;
      offset += count;
    }
    if (offset !== bytes.length) throw new Error("record changed length while it was read");
    return bytes;
  } finally { fs.close(fd); }
}

function encode(record: JournalRecord): Buffer {
  return Buffer.from(`${JSON.stringify(record)}\n`);
}

function parseRecord(bytes: Buffer, nonce: string): JournalRecord {
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) throw new Error("record is incomplete");
  const value = JSON.parse(bytes.toString("utf8")) as Partial<JournalRecord>;
  if (value.schema !== 1 || value.nonce !== nonce || typeof value.tag !== "string" || (value.mode !== "user" && value.mode !== "system") ||
      !Array.isArray(value.events) || value.events.length > MAX_EVENTS ||
      !value.events.every((event) => event && PHASES.has(event.phase) && typeof event.at === "string" && (event.detail === undefined || typeof event.detail === "string"))) {
    throw new Error("record does not match the journal schema");
  }
  const process = value.process;
  if (process !== null && (typeof process !== "object" || !Number.isSafeInteger(process.pid) || typeof process.startTime !== "string" || typeof process.bootId !== "string")) {
    throw new Error("record process identity is malformed");
  }
  return value as JournalRecord;
}

/**
 * The journal of the attempt the current process owns. Writing it never fails the update: a
 * problem is kept and reported, and inspection then treats the missing phases as unknown.
 */
export class StagingJournal {
  private readonly record: JournalRecord;
  private readonly dir: string;
  private problemText: string | null = null;
  private uid: bigint | null = null;

  private constructor(dataDir: string, header: Omit<JournalRecord, "schema" | "events">, private readonly fs: StagingFilesystem, private readonly now: () => string) {
    this.dir = join(dataDir, JOURNAL_DIR);
    this.record = { schema: 1, ...header, events: [] };
  }

  static open(dataDir: string, header: Omit<JournalRecord, "schema" | "events">, fs: StagingFilesystem, now: () => string): StagingJournal {
    const journal = new StagingJournal(dataDir, header, fs, now);
    try {
      const uid = stagingUid(fs);
      withPinnedDirectory(journal.dir, uid, fs, true, () => undefined);
      journal.uid = uid;
    } catch (error) {
      journal.problemText = `phase journal unavailable: ${redactDetail((error as Error).message)}`;
    }
    return journal;
  }

  get path(): string { return join(this.dir, `${this.record.nonce}.json`); }
  get problem(): string | null { return this.problemText; }

  note(phase: JournalPhase, detail?: string): void {
    // A directory that failed validation is never written, now or later.
    if (this.uid === null) return;
    const event: JournalEvent = { phase, at: this.now(), ...(detail ? { detail: redactDetail(detail) } : {}) };
    if (this.record.events.length >= MAX_EVENTS) this.record.events[MAX_EVENTS - 1] = event;
    else this.record.events.push(event);
    try {
      withPinnedDirectory(this.dir, this.uid, this.fs, false, (dir) => {
        writePrivateRecord(dir, `${this.record.nonce}.json`, encode(this.record), this.fs);
        if (phase === "reserved") this.prune(dir);
      });
    } catch (error) {
      this.problemText ??= `phase journal could not record ${phase}: ${redactDetail((error as Error).message)}`;
    }
  }

  /** Keep the newest records and drop crash-orphaned temporaries; never touches other names. */
  private prune(pinned: PinnedDirectory): void {
    const records: Array<{ name: string; mtime: bigint }> = [];
    const stale: string[] = [];
    // File times come from the real clock, so staleness does too.
    const now = BigInt(Date.now()) * 1_000_000n;
    const dir = this.fs.directory(pinned.base);
    try {
      for (let i = 0; i < MAX_LISTED; i++) {
        const entry = dir.readSync();
        if (!entry) break;
        const record = RECORD_NAME_RE.exec(entry.name);
        if (!record && !TEMP_NAME_RE.test(entry.name)) continue;
        if (record?.[1] === this.record.nonce) continue;
        const stat = this.fs.lstat(join(pinned.base, entry.name));
        if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== this.uid) continue;
        if (record) records.push({ name: entry.name, mtime: stat.mtimeNs });
        else if (now - stat.mtimeNs > STALE_TEMP_NS) stale.push(entry.name);
      }
    } finally { dir.closeSync(); }
    records.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0));
    for (const { name } of records.slice(JOURNAL_KEEP - 1)) this.fs.unlink(join(pinned.base, name));
    for (const name of stale) this.fs.unlink(join(pinned.base, name));
  }
}

export type JournalRead =
  | { state: "absent"; record: null; reason: string }
  | { state: "unreadable"; record: null; reason: string }
  | { state: "recorded"; record: JournalRecord; reason: null };

export function readJournal(dataDir: string, nonce: string | null, fs: StagingFilesystem): JournalRead {
  if (!nonce || !NONCE_RE.test(nonce)) return { state: "absent", record: null, reason: "no valid owner nonce to correlate a phase record" };
  try {
    const bytes = readPrivateRecord(join(dataDir, JOURNAL_DIR, `${nonce}.json`), stagingUid(fs), MAX_RECORD_BYTES, fs);
    if (!bytes) return { state: "absent", record: null, reason: "no phase record; the attempt predates phase journaling or could not record it" };
    return { state: "recorded", record: parseRecord(bytes, nonce), reason: null };
  } catch (error) {
    return { state: "unreadable", record: null, reason: redactDetail((error as Error).message) };
  }
}

/** Append one event to an existing attempt record, for example after recovery. Best effort. */
export function appendJournalEvent(dataDir: string, nonce: string, event: JournalEvent, fs: StagingFilesystem): string | null {
  const read = readJournal(dataDir, nonce, fs);
  if (read.state !== "recorded") return read.reason;
  const record = read.record;
  if (record.events.length >= MAX_EVENTS) record.events[MAX_EVENTS - 1] = event;
  else record.events.push({ ...event, ...(event.detail ? { detail: redactDetail(event.detail) } : {}) });
  try {
    withPinnedDirectory(join(dataDir, JOURNAL_DIR), stagingUid(fs), fs, false, (dir) => writePrivateRecord(dir, `${nonce}.json`, encode(record), fs));
    return null;
  } catch (error) {
    return redactDetail((error as Error).message);
  }
}

export type AttemptOutcome =
  | "unknown"
  | "pre-installation-failure"
  | "installation-awaiting-verification"
  | "rolled-back"
  | "healthy-installation-cleanup-failed"
  | "completed-cleanup";

export interface JournalSummary {
  evidence: "absent" | "unreadable" | "recorded";
  /** True whenever the record stops before a terminal phase or is missing. */
  uncertain: boolean;
  lastPhase: JournalPhase | null;
  outcome: AttemptOutcome;
  cleanup: "complete" | "failed" | "not-reached" | "unknown";
  conclusion: string;
  events: JournalEvent[];
  process: ProcessIdentity | null;
}

/** Translate recorded phases into the operator-facing conclusion, without overstating it. */
export function describeJournal(read: JournalRead): JournalSummary {
  if (read.state !== "recorded") {
    return {
      evidence: read.state, uncertain: true, lastPhase: null, outcome: "unknown", cleanup: "unknown", events: [], process: null,
      conclusion: `${read.state === "absent" ? read.reason : `phase record unreadable (${read.reason})`}; whether this attempt installed anything is unknown, so compare the installed versions and service health`,
    };
  }
  const events = read.record.events;
  const seen = new Set(events.map((event) => event.phase));
  const last = events.at(-1)?.phase ?? null;
  const cleanupFailure = [...events].reverse().find((event) => event.phase === "cleanup-failed");
  const cleanup = seen.has("cleaned") ? "complete" : cleanupFailure ? "failed" : "not-reached";
  // Recovery appends to the record afterwards; it says nothing about how the attempt itself ended.
  const attemptLast = events.filter((event) => event.phase !== "recovered").at(-1)?.phase ?? null;
  const terminal = attemptLast === "cleaned" || attemptLast === "cleanup-failed";
  const stopped = terminal ? "" : `; the attempt's record ends at "${attemptLast ?? "nothing"}", so the process stopped or could not record later phases (uncertain)`;
  let outcome: AttemptOutcome;
  let conclusion: string;
  if (seen.has("verified") && cleanup === "complete") {
    outcome = "completed-cleanup";
    conclusion = "the installation was verified healthy and staging cleanup completed";
  } else if (seen.has("verified")) {
    outcome = "healthy-installation-cleanup-failed";
    conclusion = `the installation was verified healthy, but staging cleanup ${cleanupFailure ? `failed: ${cleanupFailure.detail ?? "no detail"}` : "did not complete"}`;
  } else if (seen.has("rolled-back")) {
    outcome = "rolled-back";
    const rollback = events.find((event) => event.phase === "rolled-back")!;
    conclusion = `installation or verification failed and a rollback to the previous executables ran${rollback.detail ? ` (${rollback.detail})` : ""}`;
  } else if (seen.has("installed") || seen.has("installing")) {
    outcome = "installation-awaiting-verification";
    conclusion = seen.has("installed")
      ? "new executables were installed, but restart and health verification did not complete; check service health"
      : "executable replacement started but did not finish; the installation may be partly replaced, so check installed versions";
  } else {
    // `failed` is recorded only before replacement starts, so it proves the installation was
    // untouched. Journaling is best effort: without it, a later `installing` may simply be unrecorded.
    const failure = events.find((event) => event.phase === "failed");
    if (failure) {
      outcome = "pre-installation-failure";
      conclusion = `the attempt failed before installation${failure.detail ? ` (${failure.detail})` : ""}; installed executables were not replaced by it`;
    } else {
      outcome = "unknown";
      conclusion = `the record ends at "${attemptLast ?? "nothing"}" before any installation was recorded; if later phases could not be recorded, executables may still have been replaced, so compare the installed versions`;
    }
  }
  if (!seen.has("verified")) {
    if (cleanup === "complete") conclusion += "; staging cleanup completed";
    else if (cleanupFailure) conclusion += `; staging cleanup then failed: ${cleanupFailure.detail ?? "no detail"}`;
  }
  return { evidence: "recorded", uncertain: !terminal, lastPhase: last, outcome, cleanup, conclusion: `${conclusion}${stopped}`, events, process: read.record.process };
}

/** Strengthen an unknown conclusion with proof from the retained slot itself. */
export function withSlotEvidence(summary: JournalSummary, untouched: string | null): JournalSummary {
  const replacing = summary.events.some((event) => ["installing", "installed", "verified", "rolled-back"].includes(event.phase));
  if (!untouched || summary.outcome !== "unknown" || replacing) return summary;
  return { ...summary, outcome: "pre-installation-failure", conclusion: `the attempt stopped before installation (${untouched}); installed executables were not replaced by it` };
}
