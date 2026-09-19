import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

/** A PID plus its kernel-reported start stamp. The stamp prevents a late cleanup pass from
 * signalling an unrelated process that reused one of the provider tree's PIDs. */
export interface PosixProcessIdentity {
  pid: number;
  ppid: number;
  startedAt: string;
  state?: string;
}

export type PosixProcessTable = Map<number, PosixProcessIdentity>;

const PROCESS_TABLE_ARGS = ["-axo", "pid=,ppid=,state=,lstart="];

export function parsePosixProcessTable(stdout: string): PosixProcessTable {
  const table: PosixProcessTable = new Map();
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 1 || !Number.isSafeInteger(ppid) || ppid < 0) continue;
    table.set(pid, { pid, ppid, state: match[3]!, startedAt: match[4]! });
  }
  return table;
}

export function listPosixProcesses(): Promise<PosixProcessTable> {
  return new Promise((resolve, reject) => {
    execFile("ps", PROCESS_TABLE_ARGS, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(parsePosixProcessTable(String(stdout)));
    });
  });
}

export const DESCENDANT_MARKER_ENV = "WOLLIPOG_DESCENDANT_BOUNDARY";
export const WORKTREE_DESCENDANT_MARKER_ENV = "WOLLIPOG_WORKTREE_DESCENDANT_BOUNDARY";

export type PosixMarkedProcessIds = Map<string, Set<number>>;

function addMarkedProcess(result: PosixMarkedProcessIds, marker: string, pid: number): void {
  if (!marker) return;
  const matches = result.get(marker) ?? new Set<number>();
  matches.add(pid);
  result.set(marker, matches);
}

async function listEnvironmentMarkedProcessIds(
  table: PosixProcessTable,
  environmentName: string,
): Promise<PosixMarkedProcessIds> {
  const result: PosixMarkedProcessIds = new Map();
  if (process.platform === "linux") {
    const prefix = Buffer.from(`${environmentName}=`);
    const pids = [...table.keys()];
    // Ownership-critical reads are infrequent, but a large host can have thousands of processes.
    // Bound concurrency so /proc inspection cannot exhaust the runner's file descriptors.
    for (let offset = 0; offset < pids.length; offset += 32) {
      await Promise.all(pids.slice(offset, offset + 32).map(async (pid) => {
        try {
          const environ = await readFile(`/proc/${pid}/environ`);
          let cursor = 0;
          while (cursor < environ.length) {
            const end = environ.indexOf(0, cursor);
            const limit = end === -1 ? environ.length : end;
            const entry = environ.subarray(cursor, limit);
            if (entry.subarray(0, prefix.length).equals(prefix)) {
              addMarkedProcess(result, entry.subarray(prefix.length).toString("utf8"), pid);
              break;
            }
            if (end === -1) break;
            cursor = end + 1;
          }
        } catch {
          /* exited or belongs to a uid whose environment is unreadable */
        }
      }));
    }
    return result;
  }

  // macOS/BSD have no procfs environ file. `ps eww` appends each visible process environment to
  // command output; inspect it in memory only and never include it in diagnostics.
  const output = await new Promise<string>((resolve, reject) => {
    execFile("ps", ["eww", "-axo", "pid=,command="], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
  return parseEnvironmentMarkedProcessIds(output, table, environmentName);
}

export function listMarkedProcessIds(table: PosixProcessTable): Promise<PosixMarkedProcessIds> {
  return listEnvironmentMarkedProcessIds(table, DESCENDANT_MARKER_ENV);
}

/** Parse the macOS/BSD `ps eww` form. Command arguments precede the appended environment, so use
 * the final marker-shaped token and do not treat an earlier argv decoy as ownership evidence. */
export function parsePosixMarkedProcessIds(
  output: string,
  table: PosixProcessTable,
): PosixMarkedProcessIds {
  return parseEnvironmentMarkedProcessIds(output, table, DESCENDANT_MARKER_ENV);
}

function parseEnvironmentMarkedProcessIds(
  output: string,
  table: PosixProcessTable,
  environmentName: string,
): PosixMarkedProcessIds {
  const result: PosixMarkedProcessIds = new Map();
  const prefix = `${environmentName}=`;
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (!match) continue;
    let markerEntry: string | undefined;
    for (const entry of match[2]!.split(/\s+/u)) {
      if (entry.startsWith(prefix)) markerEntry = entry;
    }
    if (!markerEntry) continue;
    const pid = Number(match[1]);
    if (table.has(pid)) addMarkedProcess(result, markerEntry.slice(prefix.length), pid);
  }
  return result;
}

export interface PosixMarkedProcessSnapshot {
  table: PosixProcessTable;
  markedProcessIds: PosixMarkedProcessIds;
}

interface PosixMarkerScanBatch {
  started: boolean;
  promise: Promise<PosixMarkedProcessSnapshot>;
}

/** Coalesce calls made before enumeration starts. A caller arriving after the batch starts gets a
 * new snapshot, preserving post-spawn, post-close, and post-signal freshness barriers. */
export class PosixMarkerScanner {
  private pending?: PosixMarkerScanBatch;

  constructor(
    private readonly listProcesses: () => Promise<PosixProcessTable> = listPosixProcesses,
    private readonly listMarkers: (table: PosixProcessTable) => Promise<PosixMarkedProcessIds> = listMarkedProcessIds,
  ) {}

  snapshot(): Promise<PosixMarkedProcessSnapshot> {
    if (!this.pending || this.pending.started) {
      const batch = { started: false } as PosixMarkerScanBatch;
      batch.promise = Promise.resolve().then(async () => {
        batch.started = true;
        const table = await this.listProcesses();
        return { table, markedProcessIds: await this.listMarkers(table) };
      }).finally(() => {
        if (this.pending === batch) this.pending = undefined;
      });
      this.pending = batch;
    }
    return this.pending.promise;
  }
}

const markerScanner = new PosixMarkerScanner();
const worktreeMarkerScanner = new PosixMarkerScanner(
  listPosixProcesses,
  (table) => listEnvironmentMarkedProcessIds(table, WORKTREE_DESCENDANT_MARKER_ENV),
);

function sameProcess(expected: PosixProcessIdentity, current: PosixProcessIdentity | undefined): boolean {
  return current?.startedAt === expected.startedAt;
}

export function ownsPosixRootProcessGroup(
  rootPid: number,
  owned: Map<number, PosixProcessIdentity>,
  table: PosixProcessTable,
): boolean {
  const root = owned.get(rootPid);
  return root !== undefined && sameProcess(root, table.get(rootPid));
}

/** Add every descendant of any already-owned live process. Starting from the whole owned set lets
 * the monitor keep following an escaped session even after its original provider parent exits. */
export function extendOwnedProcessTree(
  owned: Map<number, PosixProcessIdentity>,
  table: PosixProcessTable,
): number {
  let added = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of table.values()) {
      if (owned.has(process.pid)) continue;
      const parent = owned.get(process.ppid);
      if (!parent || !sameProcess(parent, table.get(parent.pid))) continue;
      owned.set(process.pid, process);
      added++;
      changed = true;
    }
  }
  return added;
}

function liveOwned(
  owned: Map<number, PosixProcessIdentity>,
  table: PosixProcessTable,
): PosixProcessIdentity[] {
  return [...owned.values()].filter((process) => {
    const current = table.get(process.pid);
    return sameProcess(process, current) && !current?.state?.startsWith("Z");
  });
}

function signalIdentity(
  process: PosixProcessIdentity,
  table: PosixProcessTable,
  signal: NodeJS.Signals,
  kill: (pid: number, signal: NodeJS.Signals) => void = globalThis.process.kill.bind(globalThis.process),
): boolean {
  if (!sameProcess(process, table.get(process.pid))) return false;
  try {
    kill(process.pid, signal);
    return true;
  } catch {
    /* exited between the identity check and signal */
    return false;
  }
}

const boundaries = new Set<PosixProcessBoundary>();
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let refreshInFlight: Promise<PosixProcessTable> | undefined;

function refreshTable(): Promise<PosixProcessTable> {
  if (!refreshInFlight) {
    refreshInFlight = listPosixProcesses().finally(() => { refreshInFlight = undefined; });
  }
  return refreshInFlight;
}

async function refreshAll(): Promise<PosixProcessTable> {
  const table = await refreshTable();
  for (const boundary of boundaries) boundary.extend(table);
  for (const boundary of [...boundaries]) boundary.releaseFromMonitor(table);
  return table;
}

function startMonitor(): void {
  if (refreshTimer) return;
  // One shared process-table read covers every active provider. This catches a provider that exits
  // unexpectedly after launching a detached tool while avoiding one `ps` process per session.
  refreshTimer = setInterval(() => { void refreshAll().catch(() => {}); }, 1_000);
  refreshTimer.unref?.();
}

function stopMonitorIfIdle(): void {
  if (boundaries.size || !refreshTimer) return;
  clearInterval(refreshTimer);
  refreshTimer = undefined;
}

/** Internal-only deterministic seam for process-boundary tests. Production construction never
 * supplies this object, and no runner configuration or provider input can select it. */
export interface PosixProcessBoundaryTestRuntime {
  listProcesses(): Promise<PosixProcessTable>;
  listMarkers?(table: PosixProcessTable): Promise<PosixMarkedProcessIds>;
  signal?(pid: number, signal: NodeJS.Signals): void;
  sleep?(milliseconds: number): Promise<void>;
  now?(): number;
}

export class PosixProcessBoundary {
  private readonly owned = new Map<number, PosixProcessIdentity>();
  private releaseCheck?: Promise<boolean>;
  private released = false;
  private rootClosed = false;
  private rootExited = false;
  private terminating?: Promise<boolean>;

  constructor(
    readonly rootPid: number,
    readonly owner?: object,
    private readonly marker?: string,
    private readonly testRuntime?: PosixProcessBoundaryTestRuntime,
    private readonly scanner: PosixMarkerScanner = markerScanner,
  ) {
    boundaries.add(this);
    if (testRuntime) return;
    startMonitor();
    // Do not reuse a monitor read that may predate this spawn: the first ownership snapshot must
    // start after the provider PID exists.
    void this.refreshFresh().catch(() => {});
  }

  private async refreshFresh(): Promise<PosixProcessTable> {
    let table: PosixProcessTable;
    let markedProcessIds: PosixMarkedProcessIds | undefined;
    if (this.marker) {
      if (this.testRuntime) {
        table = await this.testRuntime.listProcesses();
        markedProcessIds = await this.testRuntime.listMarkers?.(table) ?? new Map();
      } else {
        const snapshot = await this.scanner.snapshot();
        table = snapshot.table;
        markedProcessIds = snapshot.markedProcessIds;
      }
      for (const pid of markedProcessIds.get(this.marker) ?? []) {
        const process = table.get(pid);
        if (process) this.owned.set(pid, process);
      }
    } else {
      table = this.testRuntime ? await this.testRuntime.listProcesses() : await listPosixProcesses();
    }
    // While Node still owns a live child handle, the spawn PID is authoritative even when a
    // set-id wrapper makes /proc/<pid>/environ unreadable. Once exit is observed, only the exact
    // inherited marker may add identities.
    const root = table.get(this.rootPid);
    if (root && !this.rootExited && !this.owned.has(this.rootPid)) this.owned.set(this.rootPid, root);
    this.extend(table);
    return table;
  }

  private async refreshTracked(): Promise<PosixProcessTable> {
    if (!this.testRuntime) return refreshAll();
    const table = await this.testRuntime.listProcesses();
    this.extend(table);
    return table;
  }

  private signal(process: PosixProcessIdentity, table: PosixProcessTable, signal: NodeJS.Signals): boolean {
    return signalIdentity(process, table, signal, this.testRuntime?.signal);
  }

  private sleep(milliseconds: number): Promise<void> {
    return this.testRuntime?.sleep?.(milliseconds) ?? new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private now(): number {
    return this.testRuntime?.now?.() ?? Date.now();
  }

  extend(table: PosixProcessTable): void {
    const root = table.get(this.rootPid);
    // Marker-backed boundaries anchor the root only through refreshFresh(), which either proves the
    // exact token or observes that Node still owns the live child handle. A monitor tick alone must
    // not adopt a recycled PID.
    if (root && !this.marker && !this.owned.has(this.rootPid)) this.owned.set(this.rootPid, root);
    extendOwnedProcessTree(this.owned, table);
    // A dead identity cannot acquire new children. Prune it after extending the live tree so
    // long-running sessions do not retain every short-lived tool process forever.
    for (const [pid, process] of this.owned) {
      const current = table.get(pid);
      if (pid !== this.rootPid && (!sameProcess(process, current) || current?.state?.startsWith("Z"))) {
        this.owned.delete(pid);
      }
    }
  }

  /** Node's waitpid-backed exit event permanently ends safe numeric-PGID fallback authority. */
  markRootExited(): void {
    this.rootExited = true;
  }

  /** A normally exited provider may intentionally leave background work alive until session
   * disposal. Release an empty boundary, but retain a non-empty one under its session owner. */
  releaseIfEmpty(): Promise<boolean> {
    if (this.terminating) return this.terminating;
    this.rootClosed = true;
    if (!this.releaseCheck) {
      this.releaseCheck = this.releaseIfEmptyOnce().finally(() => { this.releaseCheck = undefined; });
    }
    return this.releaseCheck;
  }

  private async releaseIfEmptyOnce(): Promise<boolean> {
    try {
      // A shared monitor read may have started before the close event. Ownership release always
      // gets a fresh post-close process table.
      const table = await this.refreshFresh();
      if (liveOwned(this.owned, table).length > 0) return false;
      this.release();
      return true;
    } catch {
      // Enumeration failure is not proof of emptiness. Keep the boundary for disposal/shutdown.
      return false;
    }
  }

  releaseFromMonitor(table: PosixProcessTable): void {
    // A post-close marker scan is authoritative. Do not let a concurrent shared refresh retire the
    // boundary from its older ownership snapshot while that scan is still in flight.
    if (!this.rootClosed || this.releaseCheck || this.terminating || this.released || liveOwned(this.owned, table).length > 0) return;
    this.release();
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    boundaries.delete(this);
    stopMonitorIfIdle();
  }

  private signalRootGroup(table: PosixProcessTable, signal: NodeJS.Signals): boolean {
    if (!ownsPosixRootProcessGroup(this.rootPid, this.owned, table)) return false;
    try {
      (this.testRuntime?.signal ?? globalThis.process.kill.bind(globalThis.process))(-this.rootPid, signal);
      return true;
    } catch {
      return false;
    }
  }

  /** Signal the whole root group without an ownership snapshot.
   *
   * Two conditions make the bare negative PID safe, and neither may be skipped:
   *
   * - The root PID must name a real process group. A marker-only boundary carries root PID 0, and
   *   `kill(-0, …)` signals the RUNNER'S OWN process group; `kill(-1, …)` signals every process the
   *   runner may signal. Both are catastrophic, so only a root PID above 1 may be used this way.
   * - Node must not have reaped the root yet. A PID that has not been waited on cannot be recycled,
   *   so the group carrying that ID is still exactly this root's group. After waitpid-backed exit
   *   the numeric PGID may belong to anyone and is permanently unsafe. */
  private signalRootGroupUnverified(signal: NodeJS.Signals): boolean {
    if (this.rootPid <= 1 || this.rootExited) return false;
    try {
      (this.testRuntime?.signal ?? globalThis.process.kill.bind(globalThis.process))(-this.rootPid, signal);
      return true;
    } catch {
      return false;
    }
  }

  private async fallbackRootGroupAfterEnumerationFailure(liftEarlyFreeze: () => void): Promise<void> {
    // Preserve main's dependency-free TERM/KILL path.
    const delivered = this.signalRootGroupUnverified("SIGTERM");
    // A group frozen before enumeration cannot act on that SIGTERM until it is resumed, and the
    // resume has to happen here rather than after the escalation sleep below: a resume deferred
    // across two seconds can land on a PGID the kernel has since handed to somebody else.
    liftEarlyFreeze();
    if (!delivered) return;
    await this.sleep(2_000);
    this.signalRootGroupUnverified("SIGKILL");
  }

  /** Freeze the original group first, then close over escaped process groups by parent identity.
   * Once every owned branch is stopped, the boundary cannot fork while signals are delivered. */
  terminate(): Promise<boolean> {
    if (this.terminating) return this.terminating;
    const work = (async () => {
      if (this.releaseCheck) await this.releaseCheck;
      if (this.released) return true;
      return this.terminateOnce();
    })();
    this.terminating = work.then((complete) => {
      if (complete) boundaries.delete(this);
      else this.terminating = undefined;
      return complete;
    }, (error) => {
      this.terminating = undefined;
      throw error;
    }).finally(() => {
      stopMonitorIfIdle();
    });
    return this.terminating;
  }

  private async terminateOnce(): Promise<boolean> {
    // Freeze the root group before anything is enumerated. Descendant discovery reads the whole
    // process table, which on a loaded machine takes long enough — seconds, with a marker scan over
    // a thousand processes — for the step being stopped to run to completion and keep writing to
    // the worktree after the caller was told it was killed. Stopping first makes the caller's
    // observation true immediately and closes the fork window the discovery passes exist to close.
    let outstandingFreeze = this.signalRootGroupUnverified("SIGSTOP");

    /** Lift the pre-enumeration freeze, at most once, and never long after it was delivered.
     *
     * Not gated on `rootExited`, unlike every other bare-PID group signal, because the matching
     * SIGSTOP already reached this PID's group: the resume repairs that rather than intruding
     * somewhere new. That argument only survives while the two signals stay close together, so
     * every caller lifts within the same phase as its own SIGTERM and never across a sleep — a
     * resume deferred by seconds could reach a PGID the kernel has since reissued. `outstanding`
     * also carries `signalRootGroupUnverified`'s own refusals, so a root PID of 0 or 1, or an
     * already-reaped root, never reaches the send. */
    const liftEarlyFreeze = (): void => {
      if (!outstandingFreeze) return;
      outstandingFreeze = false;
      try {
        (this.testRuntime?.signal ?? globalThis.process.kill.bind(globalThis.process))(-this.rootPid, "SIGCONT");
      } catch { /* already gone */ }
    };

    try {
      return await this.terminateFrozenTree(liftEarlyFreeze);
    } finally {
      // Backstop only. Every phase above lifts its own freeze promptly, so by the time this runs
      // the flag is normally already clear; it exists so that no path out of the attempt — an
      // early return, or a throw from the enumeration or timer seams — can leave a group this
      // call stopped stranded for good.
      liftEarlyFreeze();
    }
  }

  private async terminateFrozenTree(liftEarlyFreeze: () => void): Promise<boolean> {
    let table: PosixProcessTable | undefined;
    const frozen = new Map<number, PosixProcessIdentity>();
    try {
      // Do not make an ownership-critical stop decision from a possibly stale shared monitor read.
      table = await this.refreshFresh();
      // A negative PID may have been recycled as an unrelated process group after the provider
      // exited. Signal the group only while its leader still matches the captured start stamp.
      this.signalRootGroup(table, "SIGSTOP");
      // Freeze newly discovered escaped groups and rescan to close forks that raced the first pass.
      for (let pass = 0; pass < 8; pass++) {
        const before = [...this.owned.values()]
          .map((process) => `${process.pid}:${process.startedAt}`)
          .sort()
          .join("\n");
        for (const process of liveOwned(this.owned, table)) {
          if (this.signal(process, table, "SIGSTOP")) frozen.set(process.pid, process);
        }
        table = await this.refreshTracked();
        const after = [...this.owned.values()]
          .map((process) => `${process.pid}:${process.startedAt}`)
          .sort()
          .join("\n");
        if (after === before) break;
      }
    } catch (error) {
      console.error(`[runner] could not enumerate provider descendants for pid ${this.rootPid}: ${(error as Error).message}`);
      // Anything successfully stopped cannot fork while we unwind. Resume the identities from the
      // last successful table instead of abandoning escaped descendants in state T forever.
      if (table) {
        for (const process of frozen.values()) this.signal(process, table, "SIGCONT");
        this.signalRootGroup(table, "SIGCONT");
      }
      // The fallback lifts the early freeze immediately after its own SIGTERM, before it sleeps.
      await this.fallbackRootGroupAfterEnumerationFailure(liftEarlyFreeze);
      return false;
    }

    // The successful try path always assigns table before any later use.
    if (!table) return false;

    for (const process of liveOwned(this.owned, table)) this.signal(process, table, "SIGTERM");
    this.signalRootGroup(table, "SIGTERM");
    for (const process of liveOwned(this.owned, table)) this.signal(process, table, "SIGCONT");
    this.signalRootGroup(table, "SIGCONT");
    // Lift here, in the same phase as the SIGTERM above, rather than leaving it to the backstop:
    // the graceful window below gives a TERM handler up to two seconds to unwind and it cannot
    // use them while stopped, and a resume deferred that long could reach a reissued PGID.
    liftEarlyFreeze();

    const gracefulDeadline = this.now() + 2_000;
    while (this.now() < gracefulDeadline) {
      await this.sleep(40);
      try {
        table = await this.refreshTracked();
      } catch (error) {
        console.error(`[runner] could not verify provider descendant cleanup for pid ${this.rootPid}: ${(error as Error).message}`);
        return false;
      }
      if (!liveOwned(this.owned, table).length) {
        // A TERM handler can fork an immediately reparented setsid helper after SIGCONT. Parent
        // links cannot recover it once the handler exits, so success requires one exact-marker scan.
        try {
          table = await this.refreshFresh();
        } catch (error) {
          console.error(`[runner] could not verify marked provider descendants for pid ${this.rootPid}: ${(error as Error).message}`);
          return false;
        }
        const rediscovered = liveOwned(this.owned, table);
        if (!rediscovered.length) return true;
        for (const process of rediscovered) this.signal(process, table, "SIGTERM");
      }
    }

    for (const process of liveOwned(this.owned, table)) this.signal(process, table, "SIGKILL");
    this.signalRootGroup(table, "SIGKILL");
    const killDeadline = this.now() + 2_000;
    while (this.now() < killDeadline) {
      await this.sleep(40);
      try {
        table = await this.refreshTracked();
      } catch (error) {
        console.error(`[runner] could not verify forced provider descendant cleanup for pid ${this.rootPid}: ${(error as Error).message}`);
        return false;
      }
      const live = liveOwned(this.owned, table);
      // A descendant can appear after the initial forced sweep. Re-signal every current identity
      // instead of merely waiting for a newly tracked process until the verification deadline.
      for (const process of live) this.signal(process, table, "SIGKILL");
      this.signalRootGroup(table, "SIGKILL");
      if (!live.length) {
        try {
          table = await this.refreshFresh();
        } catch (error) {
          console.error(`[runner] could not verify forced marked-provider cleanup for pid ${this.rootPid}: ${(error as Error).message}`);
          return false;
        }
        const rediscovered = liveOwned(this.owned, table);
        if (!rediscovered.length) return true;
        for (const process of rediscovered) this.signal(process, table, "SIGKILL");
      }
    }

    const survivors = liveOwned(this.owned, table).map((process) => process.pid);
    console.error(`[runner] provider descendant boundary for pid ${this.rootPid} is not empty (survivors: ${survivors.join(", ")})`);
    return false;
  }
}

/** Return every live boundary for one session owner, or every boundary during runner shutdown. */
export function terminatePosixProcessBoundaries(owner?: object): Promise<boolean>[] {
  return [...boundaries]
    .filter((boundary) => owner === undefined || boundary.owner === owner)
    .map((boundary) => boundary.terminate());
}

/** Reconstruct an exact marker-backed boundary after the runner process that created it is gone.
 * The random marker is runner-private durable cleanup identity; numeric PIDs alone are never
 * trusted because they may have been reused while the runner was offline. */
export async function terminatePosixProcessesByMarker(marker: string): Promise<boolean> {
  if (process.platform === "win32") return true;
  const boundary = new PosixProcessBoundary(0, undefined, marker, undefined, worktreeMarkerScanner);
  return boundary.terminate();
}
