import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

interface SlotOwner { pid: number; token: string; sessionId: string; agentId: string; }

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

/** Cross-process slot leases under the shared runner data directory. Atomic slot-directory
 * creation enforces the box ceiling; dead process owners are reclaimed after crashes. */
export class BoxAdmission {
  private readonly root: string;
  private readonly token = randomUUID();
  private readonly held = new Map<string, string[]>();

  constructor(dataDir: string, private readonly limit: number) {
    this.root = join(dataDir, "admission");
    mkdirSync(this.root, { recursive: true });
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
    const global = this.claimSlots(this.root, this.limit, normalized.weight, normalized);
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
      if (owner.token === this.token && this.isOwnedSlot(slot)) rmSync(slot, { recursive: true, force: true });
    } catch { /* already reclaimed/removed */ }
  }

  releaseAll(): void {
    for (const sessionId of [...this.held.keys()]) this.release(sessionId);
  }

  usedCapacity(): number {
    try {
      return readdirSync(this.root, { withFileTypes: true })
        .filter((entry) => {
          if (!entry.isDirectory() || !/^slot-\d+$/.test(entry.name)) return false;
          return !this.reclaimIfStale(join(this.root, entry.name));
        }).length;
    } catch {
      return 0;
    }
  }

  private reclaimIfStale(slot: string): boolean {
    try {
      const owner = JSON.parse(readFileSync(join(slot, "owner.json"), "utf8")) as SlotOwner;
      if (processAlive(owner.pid)) return false;
    } catch {
      // Do not steal a slot in the tiny mkdir→owner-write window. A genuinely abandoned empty or
      // partial directory becomes reclaimable after five seconds.
      try { if (Date.now() - statSync(slot).mtimeMs < 5_000) return false; } catch { return true; }
    }
    if (!this.isOwnedSlot(slot)) return false;
    rmSync(slot, { recursive: true, force: true });
    return true;
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
