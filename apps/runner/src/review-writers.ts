import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  currentLeaseProcessEvidence, isLeaseProcessEvidence, linuxLeaseProcessProbe,
  proveLeaseAbandoned, providerHomeRunnerMarker,
  type LeaseProcessEvidence, type LeaseProcessProbe, type LeaseScanBlocker,
} from "./provider-home-lease-evidence.js";
import { createLinuxCgroupGroup, providerContainmentStatus, providerContainmentUnitIdentity, type LinuxCgroupGroup } from "./linux-cgroup.js";
import { leaseContainmentGuidance } from "./provider-home-lease-containment.js";

type WriterKind = "agent_tui" | "provider";
export type UnsandboxedReviewSession = { sessionId: string; kind: WriterKind };
type WriterEntry = {
  sessionId: string;
  kind: WriterKind;
  file?: string;
  process?: LeaseProcessEvidence;
  runnerPid?: number;
  group?: LinuxCgroupGroup;
  digest?: string;
  recoveryReason?: string;
  exitProven?: boolean;
};
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

export type WriterInspection = {
  recordId: string;
  sessionId: string;
  kind: WriterKind;
  state: "current_runner" | "previous_runner" | "unknown_runner";
  containment: "linux-cgroup-v2" | "unavailable";
  sha256?: string;
  exitProven: boolean;
  recovery: string;
};

/** Non-blocking lifecycle diagnostics, never reviewer admission evidence. A root process exiting,
 * a session disappearing or a restart cannot substitute for an exact diagnostic retirement proof. */
export class ReviewWriterRegistry {
  private readonly entries = new Map<string, WriterEntry>();
  /** Known host-access launches are observations, never durable blocking obligations. */
  private readonly unsandboxed = new Map<string, UnsandboxedReviewSession>();

  constructor(
    private readonly directory?: string,
    private readonly probe: LeaseProcessProbe | undefined = linuxLeaseProcessProbe(),
    private readonly options: { createGroup?: () => LinuxCgroupGroup | undefined; reconcile?: boolean } = {},
  ) {
    if (!directory) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".json")) continue;
      const file = join(directory, name);
      let sessionId = "unknown (unreadable agent writer record)";
      let kind: WriterKind = "agent_tui";
      let identity: Pick<WriterEntry, "process" | "runnerPid" | "digest"> = {};
      try {
        const bytes = readFileSync(file, "utf8");
        identity.digest = digest(bytes);
        const record: unknown = JSON.parse(bytes);
        if (typeof record !== "object" || record === null || Array.isArray(record)) throw new Error("invalid writer record");
        const { sessionId: recordedSession, kind: recordedKind, process: evidence, runnerPid } = record as Record<string, unknown>;
        if (recordedSession && typeof recordedSession === "string") sessionId = recordedSession;
        if (recordedKind === "provider") kind = "provider";
        // A partial/legacy record must never acquire proof authority from only a PID, age,
        // or a subset of otherwise plausible fields.
        if (typeof recordedSession === "string" && recordedSession &&
            (recordedKind === "provider" || recordedKind === "agent_tui") &&
            isLeaseProcessEvidence(evidence) && Number.isSafeInteger(runnerPid) && (runnerPid as number) > 1) {
          identity = { ...identity, process: evidence, runnerPid: runnerPid as number };
        }
      } catch { /* A partial pre-spawn write is uncertain evidence too. */ }
      this.entries.set(`recovered:${name}`, { sessionId, kind, file, ...identity });
    }
    if (options.reconcile !== false) this.reconcileRecovered();
  }

  /** Only recorded writer boundaries grant automatic recovery. Legacy process evidence requires
   * explicit operator proof; a restart, PID disappearance, or age cannot settle it. Never kill. */
  reconcileRecovered(entryPoint: "startup" | "admission" = "startup"): void {
    const proofs = new Map<string, ReturnType<typeof proveLeaseAbandoned>>();
    for (const [id, entry] of this.entries) {
      if (!id.startsWith("recovered:")) {
        // A sealed driver's successful proof remains valid while a transient boundary read or
        // a delayed kernel emptiness observation settles. Never infer this from an empty parent.
        if (entry.exitProven && entry.group) this.retire(id, true);
        continue;
      }
      let reason = "legacy_boundary_unavailable", retired = false;
      if (entry.process?.containment?.kind === "linux-cgroup-v2" && entry.runnerPid) {
        const key = JSON.stringify([entry.runnerPid, entry.process]);
        if (!proofs.has(key)) proofs.set(key, proveLeaseAbandoned(entry.process, entry.runnerPid, this.probe));
        const proof = proofs.get(key)!;
        retired = proof.proven && this.retire(id, true);
        reason = proof.proven ? retired ? proof.proof : "record_not_removed" : proof.reason;
      }
      if (reason !== entry.recoveryReason) {
        entry.recoveryReason = reason;
        console.error(JSON.stringify({ event: "review_writer_recovery", entryPoint, recordId: id.slice("recovered:".length),
          sessionId: entry.sessionId, outcome: retired ? "retired" : "retained", reason }));
      }
    }
  }

  acquire(sessionId: string, kind: WriterKind, native = true): string {
    const id = randomUUID();
    const file = this.directory ? join(this.directory, `${id}.json`) : undefined;
    // Publish before anything can spawn. Even a partial constructor/launch failure must retain
    // its evidence when no exact process-tree proof can settle it.
    // All spawnAgent launches inherit this runner marker, including explicit environments.
    // Capture it before publication/spawn, so interrupted launches can be reconciled too.
    const group = native ? (this.options.createGroup ?? createLinuxCgroupGroup)() : undefined;
    const unit = providerContainmentUnitIdentity();
    const reason = native ? providerContainmentStatus().reason : "unsupported-platform";
    const containment = group ? { ...group.identity, ...(unit ? { unit } : {}) }
      : { kind: "marker-parent-links" as const, reason: reason === "available" ? "boundary-creation-failed" as const : reason };
    const evidence = currentLeaseProcessEvidence(this.probe, process.pid, providerHomeRunnerMarker(), containment);
    const record = { sessionId, kind, ...(evidence ? { process: evidence, runnerPid: process.pid } : {}) };
    const bytes = JSON.stringify(record);
    try { if (file) writeFileSync(file, bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) { group?.releaseIfEmpty(); throw error; }
    this.entries.set(id, { sessionId, kind, file, process: evidence, runnerPid: process.pid, group, digest: digest(bytes) });
    return id;
  }

  group(id: string | undefined): LinuxCgroupGroup | undefined { return id ? this.entries.get(id)?.group : undefined; }

  observeUnsandboxed(sessionId: string, kind: WriterKind): string {
    const id = randomUUID();
    this.unsandboxed.set(id, { sessionId, kind });
    return id;
  }

  unsandboxedSessions(): UnsandboxedReviewSession[] {
    return [...new Map([...this.unsandboxed.values()].map((entry) => [`${entry.sessionId}:${entry.kind}`, entry])).values()]
      .map((entry) => ({ ...entry }));
  }

  retire(id: string, proven: boolean): boolean {
    if (!proven) return false;
    if (this.unsandboxed.delete(id)) return true;
    const entry = this.entries.get(id);
    if (!entry) return true;
    entry.exitProven = true;
    if (entry.group && (!entry.process?.containment || entry.process.containment.kind !== "linux-cgroup-v2" ||
        this.probe?.containment?.(entry.process.containment) !== "empty")) return false;
    if (entry.file) {
      try { unlinkSync(entry.file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    }
    this.entries.delete(id);
    entry.group?.releaseIfEmpty();
    return true;
  }

  sessions(kind?: WriterKind): string[] {
    return [...new Set([...this.entries.values()].filter((entry) => !kind || entry.kind === kind)
      .map((entry) => entry.sessionId))];
  }

  inspect(): WriterInspection[] {
    return [...this.entries].map(([id, entry]) => {
      let current = !id.startsWith("recovered:");
      try { current ||= !!entry.process && entry.runnerPid === process.pid &&
        this.probe?.bootId() === entry.process.bootId && this.probe.startTime(process.pid) === entry.process.startTime; }
      catch { /* diagnostic only */ }
      const bounded = entry.process?.containment?.kind === "linux-cgroup-v2";
      const liveRecovery = entry.exitProven ? "Tree exit is proven; retry admission to recheck the writer boundary."
        : "End this writer's complete process tree; exact exit settlement retires its record.";
      // Remote containment cannot be established by delegating the host runner's cgroup.
      const guidance = entry.process?.containment?.kind === "marker-parent-links" &&
        entry.process.containment.reason === "unsupported-platform"
        ? "Native cgroup containment is unavailable for this launch; verify its complete process tree on its execution target."
        : leaseContainmentGuidance(entry.process?.containment);
      return { recordId: id.replace(/^recovered:/u, "").replace(/\.json$/u, ""), sessionId: entry.sessionId, kind: entry.kind,
        state: current ? "current_runner" : entry.process ? "previous_runner" : "unknown_runner",
        containment: bounded ? "linux-cgroup-v2" : "unavailable", sha256: entry.digest, exitProven: entry.exitProven === true,
        recovery: !entry.process || !entry.runnerPid
          ? (current ? liveRecovery + " " : "") + "This record lacks verifiable runner identity. Preserve it for independent operator investigation; the legacy retirement command cannot authorize its removal."
          : current ? liveRecovery + (bounded ? "" : " " + guidance)
          : bounded ? entry.recoveryReason === "runner_alive"
            ? "The recorded previous runner is still alive. End this writer through its owning runner, then retry boundary reconciliation."
            : "The recorded writer boundary is still populated or cannot be verified. End its surviving processes and retry boundary reconciliation."
            : "Use --state-doctor review-writers inspect, then retire-legacy with the exact record id and SHA-256. " +
              guidance,
      };
    });
  }

  /** Local OS-owner administration only. No forced deletion and no inferred cgroup exclusions.
   * Re-read the exact bytes after proof so a replaced record never inherits another's authority. */
  retireLegacy(recordId: string, expectedSha256: string): { retired: boolean; reason: string; blockers?: LeaseScanBlocker[] } {
    const id = `recovered:${recordId}.json`;
    const entry = this.entries.get(id);
    if (!entry?.file || entry.digest !== expectedSha256) return { retired: false, reason: "record_changed" };
    if (!entry.process || !entry.runnerPid || !this.probe || entry.process.containment?.kind === "linux-cgroup-v2") {
      return { retired: false, reason: "legacy_identity_unverifiable" };
    }
    let blockers: LeaseScanBlocker[] | undefined;
    const proof = proveLeaseAbandoned(entry.process, entry.runnerPid, { ...this.probe, scan: (...args) => {
      const scanned = this.probe!.scan(args[0], args[1], true, true);
      blockers = scanned.blockers ?? [
        ...scanned.marked.map((pid) => ({ pid, reason: "marked" as const })),
        ...scanned.uninspectable.map((pid) => ({ pid, reason: "uninspectable" as const })),
      ];
      return scanned;
    } });
    if (!proof.proven) {
      return { retired: false, reason: proof.reason, ...(blockers ? { blockers } : {}) };
    }
    try { if (digest(readFileSync(entry.file, "utf8")) !== expectedSha256) return { retired: false, reason: "record_changed" }; }
    catch { return { retired: false, reason: "record_changed" }; }
    return this.retire(id, true) ? { retired: true, reason: proof.proof } : { retired: false, reason: "record_not_removed" };
  }
}
