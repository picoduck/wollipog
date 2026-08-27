import { execFile } from "node:child_process";

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
  return table;
}

function startMonitor(): void {
  if (refreshTimer) return;
  // One shared process-table read covers every active provider. This catches a provider that exits
  // unexpectedly after launching a detached tool while avoiding one `ps` process per session.
  refreshTimer = setInterval(() => { void refreshAll().catch(() => {}); }, 250);
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
  private terminating?: Promise<boolean>;

  constructor(readonly rootPid: number, readonly owner?: object) {
    boundaries.add(this);
    startMonitor();
    void refreshAll().catch(() => {});
  }

  extend(table: PosixProcessTable): void {
    const root = table.get(this.rootPid);
    if (root && !this.owned.has(this.rootPid)) this.owned.set(this.rootPid, root);
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

  /** A normally exited provider may intentionally leave background work alive until session
   * disposal. Release an empty boundary, but retain a non-empty one under its session owner. */
  releaseIfEmpty(): Promise<boolean> {
    if (this.terminating) return this.terminating;
    if (!this.releaseCheck) {
      this.releaseCheck = this.releaseIfEmptyOnce().finally(() => { this.releaseCheck = undefined; });
    }
    return this.releaseCheck;
  }

  private async releaseIfEmptyOnce(): Promise<boolean> {
    try {
      const table = await refreshAll();
      if (liveOwned(this.owned, table).length > 0) return false;
      this.released = true;
      boundaries.delete(this);
      stopMonitorIfIdle();
      return true;
    } catch {
      // Enumeration failure is not proof of emptiness. Keep the boundary for disposal/shutdown.
      return false;
    }
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
      table = await refreshAll();
      // A negative PID may have been recycled as an unrelated process group after the provider
      // exited. Signal the group only while its leader still matches the captured start stamp.
      this.signalRootGroup(table, "SIGSTOP");
      // Freeze newly discovered escaped groups and rescan to close forks that raced the first pass.
      for (let pass = 0; pass < 8; pass++) {
        const before = this.owned.size;
        for (const process of liveOwned(this.owned, table)) {
          if (signalIdentity(process, table, "SIGSTOP")) frozen.set(process.pid, process);
        }
        table = await refreshAll();
        if (this.owned.size === before) break;
      }
    } catch (error) {
      console.error(`[runner] could not enumerate provider descendants for pid ${this.rootPid}: ${(error as Error).message}`);
      // Anything successfully stopped cannot fork while we unwind. Resume the identities from the
      // last successful table instead of abandoning escaped descendants in state T forever.
      if (table) {
        for (const process of frozen.values()) signalIdentity(process, table, "SIGCONT");
        this.signalRootGroup(table, "SIGCONT");
      }
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
