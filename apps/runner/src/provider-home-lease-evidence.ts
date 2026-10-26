import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { ProviderHomeBlockingProcess } from "@wollipog/protocol";
import { inspectLeaseCgroup, isLeaseContainmentEvidence, type LeaseContainmentEvidence, type LeaseContainmentResult, type LeaseCgroupEvidence } from "./provider-home-lease-containment.js";

/**
 * #3241: lifecycle evidence for provider-HOME leases.
 *
 * A runner records, in each active lease record it publishes, the boot it runs in, its own process
 * start time, and a random marker that every process it launches inherits through this
 * environment variable. A later owner may treat that lease as abandoned only when the evidence
 * proves no process of it survives: the host has rebooted since, or (same boot) the recorded
 * runner process is gone and no readable process of this user carries the marker, with no process
 * of this user left uninspected. A dead PID alone never proves anything.
 */
export const PROVIDER_HOME_RUNNER_MARKER_ENV = "WOLLIPOG_PROVIDER_HOME_RUNNER";

/** The evidence persisted as an active lease record's `process` field. */
export interface LeaseProcessEvidence {
  bootId: string;
  /** Opaque platform start time of the recorded runner process (Linux: /proc stat field 22). */
  startTime: string;
  marker: string;
  /** Version 2 is deliberately rejected by older readers' exact three-key validator. */
  version?: 2;
  containment?: LeaseContainmentEvidence;
}

/** How a stale lease was proved abandoned. */
export type LeaseAbandonmentProof = "reboot" | "process_scan" | "linux_cgroup" | "linux_cgroup_unit_removed";

export type LeaseAbandonmentResult =
  | { proven: true; proof: LeaseAbandonmentProof }
  | { proven: false; reason: "runner_alive" | "marked_process" | "uninspectable" | "boundary_populated" | "boundary_unverifiable"; blockingProcess?: ProviderHomeBlockingProcess };

export interface LeaseScanBlocker {
  pid: number;
  startTime?: string;
  command?: string;
  reason: "marked" | "uninspectable";
}

/** The process view a proof is made from. Injected in tests. */
export interface LeaseProcessProbe {
  bootId(): string;
  /** The start time of `pid` in the current boot, or null when no such process exists. */
  startTime(pid: number): string | null;
  /**
   * Every process of this user carrying `marker`, and every process of this user that cannot be
   * inspected and might descend from the runner that started at `runnerStartTime` in this boot.
   */
  scan(marker: string, runnerStartTime: string, diagnostics?: boolean, detailed?: boolean): { marked: number[]; uninspectable: number[]; blockingProcess?: ProviderHomeBlockingProcess; blockers?: LeaseScanBlocker[] };
  boundaryMember?(identity: LeaseCgroupEvidence): ProviderHomeBlockingProcess | undefined;
  membership?(pid: number, startTime: string, identity: LeaseCgroupEvidence): ProviderHomeBlockingProcess["cgroupMembership"];
  containment?(identity: LeaseCgroupEvidence): LeaseContainmentResult;
}

const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const START_TIME = /^[1-9][0-9]{0,19}$/u;
const MARKER = /^[0-9a-f]{32}$/u;

export function isLeaseProcessEvidence(value: unknown): value is LeaseProcessEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const legacy = Object.keys(record).length === 3 && record.version === undefined && record.containment === undefined;
  const bounded = Object.keys(record).length === 5 && record.version === 2 && isLeaseContainmentEvidence(record.containment) &&
    (record.containment.kind !== "linux-cgroup-v2" || record.containment.bootId === record.bootId);
  return (legacy || bounded) &&
    typeof record.bootId === "string" && BOOT_ID.test(record.bootId) &&
    typeof record.startTime === "string" && START_TIME.test(record.startTime) &&
    typeof record.marker === "string" && MARKER.test(record.marker);
}

export function isLeaseRunnerMarker(value: unknown): value is string {
  return typeof value === "string" && MARKER.test(value);
}

let runnerMarker: string | undefined;

/**
 * This runner process's marker, created on first use. It replaces any value inherited from a
 * predecessor runner in `process.env`, so every process launched from here on (through
 * `process.env` or `spawnAgent`'s explicit environment) carries this runner's marker only.
 */
export function providerHomeRunnerMarker(): string {
  if (!runnerMarker) {
    runnerMarker = randomBytes(16).toString("hex");
    process.env[PROVIDER_HOME_RUNNER_MARKER_ENV] = runnerMarker;
  }
  return runnerMarker;
}

/** The marker if this process created one; launches add it to their environment. */
export function currentProviderHomeRunnerMarker(): string | undefined {
  return runnerMarker;
}

function gone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ESRCH";
}

/** Fields after the parenthesized command name, which may hold spaces: [0] state, [1] ppid, [19] starttime. */
function statFields(stat: string): string[] {
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
}

function statStartTime(stat: string): string | null {
  const value = statFields(stat)[19];
  return value && START_TIME.test(value) ? value : null;
}

const MAX_ANCESTRY = 256;
const MAX_SCAN_ROUNDS = 16;

/** The Linux procfs probe for the current user. Other platforms have no probe and record no evidence. */
export function linuxLeaseProcessProbe(
  root = "/proc", uid = process.getuid?.(), self = process.pid,
  testHooks?: { afterListing?: (round: number) => void; afterInspection?: (pid: number) => void },
): LeaseProcessProbe | undefined {
  if (process.platform !== "linux" || uid === undefined) return undefined;
  return {
    containment: inspectLeaseCgroup,
    membership: (pid, startTime, identity) => {
      try {
        const member = /^0::(\/.*)$/mu.exec(readFileSync(join(root, String(pid), "cgroup"), "utf8"))?.[1];
        if (!member || statStartTime(readFileSync(join(root, String(pid), "stat"), "utf8")) !== startTime) return "unavailable";
        const boundary = posix.join(identity.mountRoot, identity.cgroupPath);
        return member === boundary || member.startsWith(boundary + "/") ? "recorded_boundary" : "outside_recorded_boundary";
      } catch { return "unavailable"; }
    },
    boundaryMember: (identity) => {
      // Diagnostics are bounded and read-only; they never contribute ownership proof.
      const boundary = posix.join(identity.mountRoot, identity.cgroupPath);
      try {
        for (const name of readdirSync(root).slice(0, 16_384)) {
          if (!/^[1-9][0-9]*$/u.test(name)) continue;
          try {
            const before = statStartTime(readFileSync(join(root, name, "stat"), "utf8"));
            const member = /^0::(\/.*)$/mu.exec(readFileSync(join(root, name, "cgroup"), "utf8"))?.[1];
            if (!before || !member || (member !== boundary && !member.startsWith(boundary + "/"))) continue;
            if (statStartTime(readFileSync(join(root, name, "stat"), "utf8")) !== before) continue;
            return { pid: Number(name), startTime: before, kind: "boundary_member", cgroupMembership: "recorded_boundary" };
          } catch { /* Disappeared or unreadable: do not guess an identity. */ }
        }
      } catch { /* Unavailable diagnostics do not change the refusal. */ }
      return undefined;
    },
    bootId: () => {
      const value = readFileSync(join(root, "sys/kernel/random/boot_id"), "utf8").trim();
      if (!BOOT_ID.test(value)) throw new Error("boot identity is unavailable");
      return value;
    },
    startTime: (pid) => {
      try { return statStartTime(readFileSync(join(root, String(pid), "stat"), "utf8")); }
      catch (error) { if (gone(error)) return null; throw error; }
    },
    scan: (marker, runnerStartTime, diagnostics, detailed) => {
      const entry = Buffer.from(`${PROVIDER_HOME_RUNNER_MARKER_ENV}=${marker}`);
      // A read either succeeds, proves the process gone (ENOENT/ESRCH), or fails; only the second
      // ever excuses a process from inspection.
      const read = (pid: number, file: string): Buffer | "gone" | "failed" => {
        try { return readFileSync(join(root, String(pid), file)); }
        catch (error) { return gone(error) ? "gone" : "failed"; }
      };
      const stats = new Map<number, string[] | "gone" | "failed">();
      const fields = (pid: number): string[] | "gone" | "failed" => {
        if (!stats.has(pid)) {
          const raw = read(pid, "stat");
          stats.set(pid, typeof raw === "string" ? raw : statFields(raw.toString("utf8")));
        }
        return stats.get(pid)!;
      };
      // Non-dumpable processes (Codex, set-id programs, some sandboxes) hide their environment but
      // not their world-readable stat. Such a process cannot descend from the recorded runner when
      // it exited, is a zombie, started before that runner did, or descends from the scanning runner.
      const cannotDescend = (pid: number): boolean => {
        const own = fields(pid);
        if (own === "gone") return true;
        if (own === "failed") return false;
        if (own[0] === "Z" || own[0] === "X") return true;
        const started = own[19];
        if (!started || !START_TIME.test(started) || !START_TIME.test(runnerStartTime)) return false;
        if (BigInt(started) < BigInt(runnerStartTime)) return true;
        let parent = Number(own[1]);
        for (let depth = 0; depth < MAX_ANCESTRY && parent > 1; depth++) {
          if (parent === self) return true;
          const next = fields(parent);
          if (typeof next === "string") return false;
          parent = Number(next[1]);
        }
        return false;
      };
      type Verdict = "clear" | "marked" | "uninspectable";
      const inspect = (pid: number): Verdict => {
        const status = read(pid, "status");
        if (status === "gone") return "clear";
        if (status === "failed") return "uninspectable";
        const line = status.toString("utf8").split("\n").find((item) => item.startsWith("Uid:"));
        const ids = line?.slice(4).trim().split(/\s+/u).map(Number);
        if (!ids || ids.length < 2 || !ids.every(Number.isSafeInteger)) return "uninspectable";
        const [real, effective] = ids as [number, number];
        // Another user's process cannot have been launched by this user's runner, except through a
        // set-id program: its real uid is still ours, and it is treated as uninspectable below.
        if (real !== uid && effective !== uid) return "clear";
        // Exited processes cannot write. Inspect their surviving children separately. This also
        // applies to readable empty zombie environments and set-id processes.
        const own = fields(pid);
        if (typeof own !== "string" && (own[0] === "Z" || own[0] === "X")) return "clear";
        if (effective !== uid) return cannotDescend(pid) ? "clear" : "uninspectable";
        const environ = read(pid, "environ");
        if (environ === "gone") return "clear";
        if (environ === "failed") return cannotDescend(pid) ? "clear" : "uninspectable";
        let cursor = 0;
        while (cursor < environ.length) {
          const end = environ.indexOf(0, cursor);
          const limit = end === -1 ? environ.length : end;
          if (environ.subarray(cursor, limit).equals(entry)) return "marked";
          cursor = limit + 1;
        }
        return "clear";
      };
      // One listing misses a process forked after it by a listed process that then exits before it
      // is read. Repeat the listing until one shows only identities (pid and start time) already
      // inspected, and no listed process vanished before its identity was read (it may have forked
      // first). A process alive after that listing was then listed and inspected, or was forked by
      // one that was.
      const verdicts = new Map<string, { pid: number; verdict: Verdict; startTime?: string }>();
      const diagnostic = () => {
        if (!diagnostics) return {};
        const blockers: LeaseScanBlocker[] = !detailed ? [] : [...verdicts.values()]
          .filter((item) => item.verdict !== "clear")
          .map((item) => {
            const raw = read(item.pid, "stat");
            const stable = Buffer.isBuffer(raw) && statStartTime(raw.toString("utf8")) === item.startTime;
            const command = stable ? /\((.*)\)/u.exec(raw.toString("utf8"))?.[1] : undefined;
            return { pid: item.pid, ...(stable && item.startTime ? { startTime: item.startTime } : {}),
              ...(command ? { command: command.slice(0, 128) } : {}), reason: item.verdict as "marked" | "uninspectable" };
          });
        const item = [...verdicts.values()].find(item => item.verdict === "marked") ??
          [...verdicts.values()].find(item => item.verdict === "uninspectable");
        if (!item) return detailed ? { blockers } : {};
        let startTime: string | undefined;
        if (item.startTime) {
          testHooks?.afterInspection?.(item.pid);
          const after = read(item.pid, "stat");
          if (Buffer.isBuffer(after) && statStartTime(after.toString("utf8")) === item.startTime) startTime = item.startTime;
        }
        const blockingProcess: ProviderHomeBlockingProcess = {
          pid: item.pid, ...(startTime ? { startTime } : {}),
          kind: item.verdict === "marked" ? "provider_descendant" : "uninspectable", cgroupMembership: "unavailable",
        };
        return { blockingProcess, ...(detailed ? { blockers } : {}) };
      };
      const of = (verdict: Verdict) => [...verdicts.values()].filter((item) => item.verdict === verdict).map((item) => item.pid);
      for (let round = 0; round < MAX_SCAN_ROUNDS; round++) {
        stats.clear();
        let fresh = false;
        const names = readdirSync(root);
        testHooks?.afterListing?.(round);
        for (const name of names) {
          if (!/^[1-9][0-9]*$/u.test(name)) continue;
          const pid = Number(name);
          // A runner started by its predecessor (a self-update restart) inherited that runner's
          // marker in its own initial environment; the scanning process is never a survivor.
          if (pid === self) continue;
          const own = fields(pid);
          if (own === "gone") { fresh = true; continue; }
          const key = own === "failed" ? `${pid}:?` : `${pid}:${own[19] ?? "?"}`;
          if (verdicts.has(key)) continue;
          fresh = true;
          const verdict = own === "failed" ? "uninspectable" : inspect(pid);
          const startTime = diagnostics && typeof own !== "string" && START_TIME.test(own[19] ?? "") ? own[19] : undefined;
          verdicts.set(key, { pid, verdict, ...(startTime ? { startTime } : {}) });
        }
        // A marked process seen at any point refuses, even if it has exited since.
        if (!fresh && round > 0) return { marked: of("marked"), uninspectable: of("uninspectable"), ...diagnostic() };
      }
      // The process table never settled (a busy host may need a later retry); nothing can be proved
      // from a view that keeps changing, but every marked process seen is still reported.
      return { marked: of("marked"), uninspectable: [...of("uninspectable"), -1], ...diagnostic() };
    },
  };
}

/** The evidence this runner process records, or undefined when the platform cannot prove it later. */
export function currentLeaseProcessEvidence(probe: LeaseProcessProbe | undefined, pid: number, marker: string | undefined, containment?: LeaseContainmentEvidence): LeaseProcessEvidence | undefined {
  if (!probe || !isLeaseRunnerMarker(marker)) return undefined;
  try {
    const startTime = probe.startTime(pid);
    if (!startTime) return undefined;
    const evidence: LeaseProcessEvidence = { bootId: probe.bootId(), startTime, marker,
      ...(containment ? { version: 2 as const, containment: { ...containment } } : {}) };
    if (!isLeaseProcessEvidence(evidence)) throw new Error("invalid process containment evidence");
    return evidence;
  } catch {
    return undefined;
  }
}

/**
 * Prove that nothing launched under `evidence` survives. Never throws for an unprovable view: an
 * unreadable boot identity or process table is reported as uninspectable.
 */
export function proveLeaseAbandoned(evidence: LeaseProcessEvidence, pid: number, probe: LeaseProcessProbe | undefined): LeaseAbandonmentResult {
  if (!probe) return { proven: false, reason: "uninspectable" };
  try {
    if (probe.bootId() !== evidence.bootId) return { proven: true, proof: "reboot" };
    if (probe.startTime(pid) === evidence.startTime) return { proven: false, reason: "runner_alive" };
    if (evidence.containment?.kind === "linux-cgroup-v2") {
      const boundary = probe.containment?.(evidence.containment) ?? "unverifiable";
      if (boundary === "populated") {
        let blockingProcess: ProviderHomeBlockingProcess | undefined;
        try { blockingProcess = probe.boundaryMember?.(evidence.containment); } catch { /* diagnostic only */ }
        return { proven: false, reason: "boundary_populated", ...(blockingProcess ? { blockingProcess } : {}) };
      }
      if (boundary !== "empty" && boundary !== "unit_removed") return { proven: false, reason: "boundary_unverifiable" };
      if (probe.startTime(pid) === evidence.startTime) return { proven: false, reason: "runner_alive" };
      return { proven: true, proof: boundary === "unit_removed" ? "linux_cgroup_unit_removed" : "linux_cgroup" };
    }
    const scan = probe.scan(evidence.marker, evidence.startTime, true);
    if (scan.marked.length) return { proven: false, reason: "marked_process", ...(scan.blockingProcess ? { blockingProcess: scan.blockingProcess } : {}) };
    if (scan.uninspectable.length) return { proven: false, reason: "uninspectable", ...(scan.blockingProcess ? { blockingProcess: scan.blockingProcess } : {}) };
    // A runner process that started between the first check and the scan would carry no marker
    // of the recorded runner; confirm the recorded identity is still gone after the scan.
    if (probe.startTime(pid) === evidence.startTime) return { proven: false, reason: "runner_alive" };
    return { proven: true, proof: "process_scan" };
  } catch {
    return { proven: false, reason: "uninspectable" };
  }
}
