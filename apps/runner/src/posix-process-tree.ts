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

async function listMarkedProcessIds(marker: string, table: PosixProcessTable): Promise<Set<number>> {
  const result = new Set<number>();
  if (process.platform === "linux") {
    const needle = Buffer.from(`${DESCENDANT_MARKER_ENV}=${marker}\0`);
    const pids = [...table.keys()];
    // Ownership-critical reads are infrequent, but a large host can have thousands of processes.
    // Bound concurrency so /proc inspection cannot exhaust the runner's file descriptors.
    for (let offset = 0; offset < pids.length; offset += 32) {
      await Promise.all(pids.slice(offset, offset + 32).map(async (pid) => {
        try {
          const environ = await readFile(`/proc/${pid}/environ`);
          if (environ.includes(needle)) result.add(pid);
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
  const needle = `${DESCENDANT_MARKER_ENV}=${marker}`;
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (!match || !match[2]!.split(/\s+/u).includes(needle)) continue;
    const pid = Number(match[1]);
    if (table.has(pid)) result.add(pid);
  }
  return result;
}

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
): boolean {
  if (!sameProcess(process, table.get(process.pid))) return false;
  try {
    globalThis.process.kill(process.pid, signal);
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

export class PosixProcessBoundary {
  private readonly owned = new Map<number, PosixProcessIdentity>();
  private releaseCheck?: Promise<boolean>;
  private released = false;
  private rootClosed = false;
  private rootExited = false;
  private terminating?: Promise<boolean>;

  constructor(readonly rootPid: number, readonly owner?: object, private readonly marker?: string) {
    boundaries.add(this);
    startMonitor();
    // Do not reuse a monitor read that may predate this spawn: the first ownership snapshot must
    // start after the provider PID exists.
    void this.refreshFresh().catch(() => {});
  }

  private async refreshFresh(): Promise<PosixProcessTable> {
    const table = await listPosixProcesses();
    if (this.marker) {
      for (const pid of await listMarkedProcessIds(this.marker, table)) {
        const process = table.get(pid);
        if (process) this.owned.set(pid, process);
      }
    }
    // While Node still owns a live child handle, the spawn PID is authoritative even when a
    // set-id wrapper makes /proc/<pid>/environ unreadable. Once exit is observed, only the exact
    // inherited marker may add identities.
    const root = table.get(this.rootPid);
    if (root && !this.rootExited && !this.owned.has(this.rootPid)) this.owned.set(this.rootPid, root);
    this.extend(table);
    return table;
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
      globalThis.process.kill(-this.rootPid, signal);
      return true;
    } catch {
      return false;
    }
  }

  private async fallbackRootGroupAfterEnumerationFailure(): Promise<void> {
    // Preserve main's dependency-free TERM/KILL path only while Node has not observed root exit.
    // After waitpid-backed exit, the numeric PGID may be recycled and is permanently unsafe.
    if (this.rootExited) return;
    try { globalThis.process.kill(-this.rootPid, "SIGTERM"); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    if (this.rootExited) return;
    try { globalThis.process.kill(-this.rootPid, "SIGKILL"); } catch { /* already gone */ }
  }

  /** Freeze the original group first, then close over escaped process groups by parent identity.
   * Once every owned branch is stopped, the boundary cannot fork while signals are delivered. */
  terminate(): Promise<boolean> {
    if (this.terminating) return this.terminating;
    this.terminating = (async () => {
      if (this.releaseCheck) await this.releaseCheck;
      if (this.released) return true;
      return this.terminateOnce();
    })().finally(() => {
      boundaries.delete(this);
      stopMonitorIfIdle();
    });
    return this.terminating;
  }

  private async terminateOnce(): Promise<boolean> {
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
          if (signalIdentity(process, table, "SIGSTOP")) frozen.set(process.pid, process);
        }
        table = await refreshAll();
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
        for (const process of frozen.values()) signalIdentity(process, table, "SIGCONT");
        this.signalRootGroup(table, "SIGCONT");
      }
      await this.fallbackRootGroupAfterEnumerationFailure();
      return false;
    }

    // The successful try path always assigns table before any later use.
    if (!table) return false;

    for (const process of liveOwned(this.owned, table)) signalIdentity(process, table, "SIGTERM");
    this.signalRootGroup(table, "SIGTERM");
    for (const process of liveOwned(this.owned, table)) signalIdentity(process, table, "SIGCONT");
    this.signalRootGroup(table, "SIGCONT");

    const gracefulDeadline = Date.now() + 2_000;
    while (Date.now() < gracefulDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      try {
        table = await refreshAll();
      } catch (error) {
        console.error(`[runner] could not verify provider descendant cleanup for pid ${this.rootPid}: ${(error as Error).message}`);
        return false;
      }
      if (!liveOwned(this.owned, table).length) return true;
    }

    for (const process of liveOwned(this.owned, table)) signalIdentity(process, table, "SIGKILL");
    this.signalRootGroup(table, "SIGKILL");
    const killDeadline = Date.now() + 2_000;
    while (Date.now() < killDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      try {
        table = await refreshAll();
      } catch (error) {
        console.error(`[runner] could not verify forced provider descendant cleanup for pid ${this.rootPid}: ${(error as Error).message}`);
        return false;
      }
      if (!liveOwned(this.owned, table).length) return true;
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
