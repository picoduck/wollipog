import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { RunnerCapacityBlocker } from "@wollipog/protocol";

interface SlotOwner { pid: number; token: string; sessionId: string; agentId: string; }

interface CachedSlotObservation {
  signature: string;
  used: number;
  ownerPids: number[];
  recheckAt?: number;
}

interface SlotInspection {
  used: boolean;
  ownerPid?: number;
  recheckAt?: number;
}

export interface AdmissionRequest {
  sessionId: string;
  agentId: string;
  weight: number;
  agentLimit?: number;
  /** Optional cross-process quota for one exact execution target. */
  targetId?: string;
  targetLimit?: number;
  /** Optional cross-process single-holder group for a shared mutable provider store. */
  exclusiveGroup?: string;
}

/** One bounded diagnostic read. Each filesystem-backed lease root is scanned at most once no
 * matter how many queued requests share it. Admission itself remains authoritative: this snapshot
 * is explanatory only and is never used to grant a lease. */
export interface AdmissionObservation {
  readonly usedCapacity: number;
  usedSlots(root: string): number;
}

/** Cross-process slot leases under the shared runner data directory. Atomic slot-directory
 * creation enforces the box ceiling; dead process owners are reclaimed after crashes. */
export class BoxAdmission {
  private readonly root: string;
  private readonly token = randomUUID();
  private readonly held = new Map<string, string[]>();
  /** Diagnostic reads may reuse a root count while its directory generation and live owners are
   * unchanged. Admission still calls usedSlots() directly and therefore remains authoritative. */
  private readonly observationCache = new Map<string, CachedSlotObservation>();

  constructor(dataDir: string, private limit: number) {
    this.root = join(dataDir, "admission");
    mkdirSync(this.root, { recursive: true });
  }

  setLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > 256) {
      throw new Error("runner capacity must be an integer from 1 to 256");
    }
    this.limit = limit;
  }

  capacity(): number {
    return this.limit;
  }

  acquire(request: AdmissionRequest | string): boolean {
    const normalized: AdmissionRequest = typeof request === "string"
      ? { sessionId: request, agentId: "default", weight: 1 }
      : request;
    if (this.held.has(normalized.sessionId)) return true;
    if (!Number.isInteger(normalized.weight) || normalized.weight < 1 || normalized.weight > this.limit) return false;

    const claimed: string[] = [];
    if (normalized.exclusiveGroup) {
      const exclusiveRoot = join(this.root, "exclusive", createHash("sha256").update(normalized.exclusiveGroup).digest("hex"));
      mkdirSync(exclusiveRoot, { recursive: true });
      const exclusive = this.claimSlots(exclusiveRoot, 1, 1, normalized);
      if (!exclusive) return false;
      claimed.push(...exclusive);
    }
    if (normalized.targetId && normalized.targetLimit) {
      const targetRoot = join(this.root, "targets", createHash("sha256").update(normalized.targetId).digest("hex"));
      mkdirSync(targetRoot, { recursive: true });
      const target = this.claimSlots(targetRoot, normalized.targetLimit, 1, normalized);
      if (!target) {
        this.releaseSlots(claimed);
        return false;
      }
      claimed.push(...target);
    }
    const providerRoot = join(this.root, "providers", createHash("sha256").update(normalized.agentId).digest("hex"));
    // Keep empty hashed provider roots. Removing them races a sibling between its parent mkdir and
    // atomic slot mkdir; the number is bounded by validated configured/discovered agent ids.
    mkdirSync(providerRoot, { recursive: true });
    // Every v42 process claims a provider slot, even without an explicit quota. That makes a later
    // policy tightening visible across sibling runner processes instead of counting only sessions
    // launched by the process that happened to carry the limit.
    const provider = this.claimSlots(providerRoot, normalized.agentLimit ?? 256, 1, normalized);
    if (!provider) {
      this.releaseSlots(claimed);
      return false;
    }
    claimed.push(...provider);
    // A lowered limit can leave valid leases in slots above the new ceiling. Serialize the
    // count-and-claim boundary so those leases still consume capacity and concurrent processes
    // cannot all race through the same observed remainder.
    const mutationRoot = join(this.root, "capacity-mutation");
    mkdirSync(mutationRoot, { recursive: true });
    const mutation = this.claimSlots(mutationRoot, 1, 1, normalized);
    if (!mutation) {
      this.releaseSlots(claimed);
      return false;
    }
    let global: string[] | null = null;
    try {
      if (this.usedCapacity() + normalized.weight <= this.limit) {
        global = this.claimSlots(this.root, this.limit, normalized.weight, normalized);
      }
    } finally {
      this.releaseSlots(mutation);
    }
    if (!global) {
      this.releaseSlots(claimed);
      return false;
    }
    claimed.push(...global);
    this.held.set(normalized.sessionId, claimed);
    return true;
  }

  release(sessionId: string): void {
    const slots = this.held.get(sessionId);
    if (!slots) return;
    this.held.delete(sessionId);
    this.releaseSlots(slots);
  }

  private claimSlots(root: string, limit: number, count: number, request: AdmissionRequest): string[] | null {
    const claimed: string[] = [];
    for (let index = 0; index < limit && claimed.length < count; index++) {
      const slot = join(root, `slot-${index}`);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          mkdirSync(slot);
          this.observationCache.delete(root);
          try {
            writeFileSync(join(slot, "owner.json"), JSON.stringify({
              pid: process.pid,
              token: this.token,
              sessionId: request.sessionId,
              agentId: request.agentId,
            } satisfies SlotOwner));
          } catch (error) {
            rmSync(slot, { recursive: true, force: true });
            throw error;
          }
          claimed.push(slot);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !this.reclaimIfStale(slot)) break;
        }
      }
    }
    if (claimed.length === count) return claimed;
    this.releaseSlots(claimed);
    return null;
  }

  private releaseSlots(slots: string[]): void {
    for (const slot of slots) {
      this.releaseSlot(slot);
    }
  }

  private releaseSlot(slot: string): void {
    try {
      const owner = JSON.parse(readFileSync(join(slot, "owner.json"), "utf8")) as SlotOwner;
      if (owner.token === this.token && this.isOwnedSlot(slot)) {
        rmSync(slot, { recursive: true, force: true });
        this.observationCache.delete(dirname(slot));
      }
    } catch { /* already reclaimed/removed */ }
  }

  releaseAll(): void {
    for (const sessionId of [...this.held.keys()]) this.release(sessionId);
  }

  usedCapacity(): number {
    return this.usedSlots(this.root);
  }

  availableCapacity(): number {
    return Math.max(0, this.limit - this.usedCapacity());
  }

  observe(): AdmissionObservation {
    const counts = new Map<string, number>();
    const usedSlots = (root: string): number => {
      const observed = counts.get(root);
      if (observed !== undefined) return observed;
      const used = this.observedSlots(root);
      counts.set(root, used);
      return used;
    };
    return { usedCapacity: usedSlots(this.root), usedSlots };
  }

  /** Explain the first lease boundary acquire() evaluates without mutating admission state. */
  blocker(request: AdmissionRequest, observation = this.observe()): RunnerCapacityBlocker | null {
    if (this.held.has(request.sessionId)) return null;
    if (!Number.isInteger(request.weight) || request.weight < 1 || request.weight > this.limit) {
      return {
        kind: "request_weight",
        description: `${request.agentId} requires ${request.weight} units but Runner Capacity is ${this.limit}`,
        usedUnits: observation.usedCapacity,
        limitUnits: this.limit,
        requiredUnits: request.weight,
        agentId: request.agentId,
      };
    }
    if (request.exclusiveGroup) {
      const root = join(this.root, "exclusive", createHash("sha256").update(request.exclusiveGroup).digest("hex"));
      const used = observation.usedSlots(root);
      if (used >= 1) return {
        kind: "exclusive_group",
        description: `${request.agentId} is waiting for its exclusive provider slot`,
        usedUnits: used,
        limitUnits: 1,
        requiredUnits: 1,
        agentId: request.agentId,
      };
    }
    if (request.targetId && request.targetLimit) {
      const root = join(this.root, "targets", createHash("sha256").update(request.targetId).digest("hex"));
      const used = observation.usedSlots(root);
      if (used >= request.targetLimit) return {
        kind: "target_quota",
        description: `Execution target ${request.targetId} is using ${used} of ${request.targetLimit} slots`,
        usedUnits: used,
        limitUnits: request.targetLimit,
        requiredUnits: 1,
        targetId: request.targetId,
      };
    }
    if (request.agentLimit !== undefined) {
      const root = join(this.root, "providers", createHash("sha256").update(request.agentId).digest("hex"));
      const used = observation.usedSlots(root);
      if (used >= request.agentLimit) return {
        kind: "agent_quota",
        description: `${request.agentId} is using ${used} of ${request.agentLimit} provider slots`,
        usedUnits: used,
        limitUnits: request.agentLimit,
        requiredUnits: 1,
        agentId: request.agentId,
      };
    }
    const used = observation.usedCapacity;
    if (used + request.weight > this.limit) return {
      kind: "runner_capacity",
      description: `Runner Capacity is ${used} of ${this.limit} units used; this session needs ${request.weight}`,
      usedUnits: used,
      limitUnits: this.limit,
      requiredUnits: request.weight,
      agentId: request.agentId,
    };
    return null;
  }

  private usedSlots(root: string): number {
    // Capture the generation before reading entries. If a sibling mutates the root during this
    // scan, the cached generation is stale in the safe direction and the next observation rescans.
    const signature = this.rootSignature(root);
    let used = 0;
    const ownerPids = new Set<number>();
    let recheckAt: number | undefined;
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^slot-\d+$/.test(entry.name)) continue;
        const inspected = this.inspectSlot(join(root, entry.name));
        if (!inspected.used) continue;
        used++;
        if (inspected.ownerPid !== undefined) ownerPids.add(inspected.ownerPid);
        if (inspected.recheckAt !== undefined) {
          recheckAt = Math.min(recheckAt ?? inspected.recheckAt, inspected.recheckAt);
        }
      }
    } catch {
      // A missing optional quota root is a stable zero. Any other failure may have interrupted a
      // partial scan, which must never become a reusable diagnostic snapshot.
      if (signature === "missing") {
        this.observationCache.set(root, { signature, used: 0, ownerPids: [] });
      } else {
        this.observationCache.delete(root);
      }
      return 0;
    }
    this.observationCache.set(root, {
      signature,
      used,
      ownerPids: [...ownerPids],
      ...(recheckAt === undefined ? {} : { recheckAt }),
    });
    return used;
  }

  private observedSlots(root: string): number {
    const cached = this.observationCache.get(root);
    if (cached && cached.signature === this.rootSignature(root) &&
        (cached.recheckAt === undefined || Date.now() < cached.recheckAt) &&
        cached.ownerPids.every((pid) => pid === process.pid || processAlive(pid))) {
      return cached.used;
    }
    return this.usedSlots(root);
  }

  private rootSignature(root: string): string {
    try {
      const stats = statSync(root, { bigint: true });
      return `${stats.dev}:${stats.ino}:${stats.mtimeNs}:${stats.ctimeNs}`;
    } catch { return "missing"; }
  }

  private reclaimIfStale(slot: string): boolean {
    return !this.inspectSlot(slot).used;
  }

  private inspectSlot(slot: string): SlotInspection {
    try {
      const owner = JSON.parse(readFileSync(join(slot, "owner.json"), "utf8")) as SlotOwner;
      if (processAlive(owner.pid)) return { used: true, ownerPid: owner.pid };
    } catch {
      // Do not steal a slot in the tiny mkdir→owner-write window. A genuinely abandoned empty or
      // partial directory becomes reclaimable after five seconds.
      try {
        const recheckAt = statSync(slot).mtimeMs + 5_000;
        if (Date.now() < recheckAt) return { used: true, recheckAt };
      } catch { return { used: false }; }
    }
    if (!this.isOwnedSlot(slot)) return { used: true };
    rmSync(slot, { recursive: true, force: true });
    this.observationCache.delete(dirname(slot));
    return { used: false };
  }

  private isOwnedSlot(slot: string): boolean {
    const root = resolve(this.root);
    const candidate = resolve(slot);
    return candidate.startsWith(root + sep) && candidate !== root;
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
