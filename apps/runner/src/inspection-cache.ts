import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";

/** Replacement, append, truncation, same-length edits and permission changes invalidate results. */
export function inspectionFileVersion(path: string): string | null {
  try {
    const stat = statSync(path, { bigint: true });
    if (!stat.isFile()) return null;
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(":");
  } catch { return null; }
}

/** Small LRU of derived data only; callers bound each record's key/value size. */
export class InspectionCache<T> {
  private readonly entries = new Map<string, { version: string; firstSeen: number; value?: T }>();
  constructor(private readonly limit = 128, private readonly settleMs = 2_000) {}
  get(key: string, version: string | null): T | undefined {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    if (!entry || version === null || entry.version !== version) return undefined;
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, version: string, value: T): void {
    const prior = this.entries.get(key);
    const now = performance.now();
    const firstSeen = prior?.version === version ? prior.firstSeen : now;
    this.entries.delete(key);
    // Filesystems can coalesce same-size edits into one timestamp bucket. The first
    // observation is only a candidate: require a fresh read in a later bucket before
    // retaining proof. Reads during this window still return their current result.
    this.entries.set(key, { version, firstSeen,
      ...(now - firstSeen >= this.settleMs ? { value } : {}) });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }
}

/** FIFO admission shared by discovery and receipt reconciliation, including WSL subprocesses. */
export class InspectionLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit = 4) {}
  async run<T>(inspect: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try { return await inspect(); }
    finally {
      const next = this.waiting.shift();
      if (next) next(); // Transfer the occupied slot, rather than racing new arrivals for it.
      else this.active--;
    }
  }
}
