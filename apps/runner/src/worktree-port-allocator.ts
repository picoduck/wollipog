import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { WorktreePortBlock } from "@wollipog/protocol";
import type { RunnerWorktreePorts } from "./config.js";
import { BoxAdmission } from "./box-admission.js";

interface WorktreePortAllocation extends WorktreePortBlock {
  owner: string;
  allocatedAt: number;
}

interface WorktreePortAllocationFile {
  version: 1;
  allocations: WorktreePortAllocation[];
}

function validBlock(value: unknown): value is WorktreePortBlock {
  if (!value || typeof value !== "object") return false;
  const block = value as Partial<WorktreePortBlock>;
  return Number.isInteger(block.start) && Number.isInteger(block.end) && Number.isInteger(block.size) &&
    block.start! >= 1 && block.end! <= 65_535 && block.size! >= 1 &&
    block.end! - block.start! + 1 === block.size;
}

function overlaps(a: WorktreePortBlock, b: WorktreePortBlock): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/**
 * Runner-private durable allocator. A dead-owner-reclaiming data-root mutex serializes independent
 * runner processes; atomic replacement keeps the ownership map crash-safe and configuration
 * changes preserve every older live block until its exact worktree is removed.
 */
export class WorktreePortAllocator {
  private readonly path: string;
  private readonly allocations = new Map<string, WorktreePortAllocation>();
  private readonly mutationLock: BoxAdmission;

  constructor(
    stateDir: string,
    private readonly range: RunnerWorktreePorts,
  ) {
    mkdirSync(stateDir, { recursive: true });
    this.path = join(stateDir, "worktree-port-allocations.json");
    this.mutationLock = new BoxAdmission(join(stateDir, "worktree-port-allocation-lock"), 1);
    this.reload();
  }

  private reload(): void {
    this.allocations.clear();
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<WorktreePortAllocationFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.allocations)) {
        throw new Error("unsupported allocation journal format");
      }
      for (const allocation of parsed.allocations) {
        if (!allocation || typeof allocation.owner !== "string" || !allocation.owner ||
            !Number.isSafeInteger(allocation.allocatedAt) || !validBlock(allocation)) {
          throw new Error("invalid allocation journal entry");
        }
        if (this.allocations.has(allocation.owner) ||
            [...this.allocations.values()].some((existing) => overlaps(existing, allocation))) {
          throw new Error("duplicate or overlapping allocation journal entry");
        }
        this.allocations.set(allocation.owner, { ...allocation });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`could not read worktree port allocation journal ${this.path}: ${(error as Error).message}`);
      }
    }
  }

  private withMutation<T>(operation: () => T): T {
    const owner = `${process.pid}-${randomUUID()}`;
    const deadline = Date.now() + 10_000;
    while (!this.mutationLock.acquire({ sessionId: owner, agentId: "worktree-ports", weight: 1 })) {
      if (Date.now() >= deadline) throw new Error("timed out waiting for the worktree port allocation lock");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    try {
      // Every process may have constructed its allocator before another process committed. The
      // journal is authoritative only after the dead-owner-reclaiming mutation lease is held.
      this.reload();
      return operation();
    } finally {
      this.mutationLock.release(owner);
    }
  }

  runtime(): RunnerWorktreePorts & { capacity: number } {
    return {
      ...this.range,
      capacity: Math.floor((this.range.end - this.range.start + 1) / this.range.blockSize),
    };
  }

  get(owner: string): WorktreePortBlock | undefined {
    const allocation = this.allocations.get(owner);
    return allocation ? { start: allocation.start, end: allocation.end, size: allocation.size } : undefined;
  }

  /** Return the durable block for one exact worktree, restoring a view-persisted allocation when
   * the ownership journal was lost only if it remains collision-free. */
  allocate(owner: string, preferred?: WorktreePortBlock): WorktreePortBlock {
    return this.withMutation(() => {
      const existing = this.get(owner);
      if (existing) {
        if (preferred && (existing.start !== preferred.start || existing.end !== preferred.end ||
            existing.size !== preferred.size)) {
          throw new Error("worktree port allocation disagrees with its durable session record");
        }
        return existing;
      }

      let selected: WorktreePortBlock | undefined;
      if (preferred) {
        if (!validBlock(preferred)) throw new Error("worktree has an invalid persisted port block");
        if ([...this.allocations.values()].some((allocation) => overlaps(allocation, preferred))) {
          throw new Error("worktree port allocation collides with another durable owner");
        }
        selected = { ...preferred };
      } else {
        for (let start = this.range.start;
          start + this.range.blockSize - 1 <= this.range.end;
          start += this.range.blockSize) {
          const candidate = { start, end: start + this.range.blockSize - 1, size: this.range.blockSize };
          if (![...this.allocations.values()].some((allocation) => overlaps(allocation, candidate))) {
            selected = candidate;
            break;
          }
        }
      }
      if (!selected) {
        const capacity = this.runtime().capacity;
        throw new Error(
          `worktree port range ${this.range.start}-${this.range.end} is exhausted ` +
          `(block size ${this.range.blockSize}; capacity ${capacity})`,
        );
      }
      this.allocations.set(owner, { owner, ...selected, allocatedAt: Date.now() });
      try {
        this.flush();
      } catch (error) {
        this.allocations.delete(owner);
        throw error;
      }
      return { ...selected };
    });
  }

  release(owner: string): boolean {
    return this.withMutation(() => {
      const allocation = this.allocations.get(owner);
      if (!allocation) return false;
      this.allocations.delete(owner);
      try {
        this.flush();
      } catch (error) {
        this.allocations.set(owner, allocation);
        throw error;
      }
      return true;
    });
  }

  list(): Array<{ owner: string; block: WorktreePortBlock }> {
    return [...this.allocations.values()].map(({ owner, start, end, size }) => ({
      owner,
      block: { start, end, size },
    }));
  }

  private flush(): void {
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      const body: WorktreePortAllocationFile = { version: 1, allocations: [...this.allocations.values()] };
      writeFileSync(fd, `${JSON.stringify(body, null, 2)}\n`);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, this.path);
      let directoryFd: number | undefined;
      try {
        directoryFd = openSync(dirname(this.path), constants.O_RDONLY);
        fsyncSync(directoryFd);
      } catch (error) {
        if (!(["EINVAL", "ENOTSUP", "EPERM"] as Array<string | undefined>)
          .includes((error as NodeJS.ErrnoException).code)) throw error;
      } finally {
        if (directoryFd !== undefined) closeSync(directoryFd);
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch { /* renamed or never created */ }
    }
  }
}
