import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  currentLeaseProcessEvidence, isLeaseProcessEvidence, linuxLeaseProcessProbe,
  proveLeaseAbandoned, providerHomeRunnerMarker,
  type LeaseProcessEvidence, type LeaseProcessProbe,
} from "./provider-home-lease-evidence.js";

type WriterKind = "agent_tui" | "provider";
type WriterEntry = {
  sessionId: string;
  kind: WriterKind;
  file?: string;
  process?: LeaseProcessEvidence;
  runnerPid?: number;
};

/** Admission evidence for host agent writers. A root process exiting, a session disappearing,
 * or a runner restart cannot substitute for a complete process-tree exit proof. */
export class ReviewWriterRegistry {
  private readonly entries = new Map<string, WriterEntry>();

  constructor(
    private readonly directory?: string,
    private readonly probe: LeaseProcessProbe | undefined = linuxLeaseProcessProbe(),
  ) {
    if (!directory) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".json")) continue;
      const file = join(directory, name);
      let sessionId = "unknown (unreadable agent writer record)";
      let kind: WriterKind = "agent_tui";
      let identity: Pick<WriterEntry, "process" | "runnerPid"> = {};
      try {
        const record: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (typeof record !== "object" || record === null || Array.isArray(record)) throw new Error("invalid writer record");
        const { sessionId: recordedSession, kind: recordedKind, process: evidence, runnerPid } = record as Record<string, unknown>;
        if (recordedSession && typeof recordedSession === "string") sessionId = recordedSession;
        if (recordedKind === "provider") kind = "provider";
        // A partial/legacy record must never acquire proof authority from only a PID, age,
        // or a subset of otherwise plausible fields.
        if (typeof recordedSession === "string" && recordedSession &&
            (recordedKind === "provider" || recordedKind === "agent_tui") &&
            isLeaseProcessEvidence(evidence) && Number.isSafeInteger(runnerPid) && (runnerPid as number) > 1) {
          identity = { process: evidence, runnerPid: runnerPid as number };
        }
      } catch { /* A partial pre-spawn write is uncertain evidence too. */ }
      this.entries.set(`recovered:${name}`, { sessionId, kind, file, ...identity });
    }
    this.reconcileRecovered();
  }

  /** Reuse provider-HOME's conservative runner-wide lifecycle proof. A dead runner PID alone
   * cannot settle a tree: same-boot recovery also requires the inherited-marker scan to exclude
   * every possible survivor, with no uninspectable same-user process. Never kill during recovery.
   * This is coarser than a writer's live proof and can retain it because of another runner child. */
  reconcileRecovered(): void {
    const proofs = new Map<string, boolean>();
    for (const [id, entry] of this.entries) {
      if (!id.startsWith("recovered:") || !entry.process || !entry.runnerPid) continue;
      const key = JSON.stringify([entry.runnerPid, entry.process]);
      if (!proofs.has(key)) proofs.set(key, proveLeaseAbandoned(entry.process, entry.runnerPid, this.probe).proven);
      this.retire(id, proofs.get(key) === true);
    }
  }

  acquire(sessionId: string, kind: WriterKind): string {
    const id = randomUUID();
    const file = this.directory ? join(this.directory, `${id}.json`) : undefined;
    // Publish before anything can spawn. Even a partial constructor/launch failure must retain
    // its evidence when no exact process-tree proof can settle it.
    // All spawnAgent launches inherit this runner marker, including explicit environments.
    // Capture it before publication/spawn, so interrupted launches can be reconciled too.
    const evidence = currentLeaseProcessEvidence(this.probe, process.pid, providerHomeRunnerMarker());
    const record = { sessionId, kind, ...(evidence ? { process: evidence, runnerPid: process.pid } : {}) };
    if (file) writeFileSync(file, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    this.entries.set(id, { sessionId, kind, ...(file ? { file } : {}) });
    return id;
  }

  retire(id: string, proven: boolean): boolean {
    if (!proven) return false;
    const entry = this.entries.get(id);
    if (!entry) return true;
    if (entry.file) {
      try { unlinkSync(entry.file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    }
    this.entries.delete(id);
    return true;
  }

  sessions(kind?: WriterKind): string[] {
    return [...new Set([...this.entries.values()].filter((entry) => !kind || entry.kind === kind)
      .map((entry) => entry.sessionId))];
  }
}
