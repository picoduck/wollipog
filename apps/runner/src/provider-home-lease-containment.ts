import { closeSync, constants, fstatSync, statfsSync, lstatSync, openSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import type { LinuxCgroupIdentity, ProviderContainmentStatus } from "./linux-cgroup.js";

export type LeaseCgroupEvidence = LinuxCgroupIdentity & { unit?: LinuxCgroupIdentity };
export type LeaseContainmentEvidence = LeaseCgroupEvidence |
  { kind: "marker-parent-links"; reason: ProviderContainmentStatus["reason"] };
export type LeaseContainmentResult = "empty" | "populated" | "unit_removed" | "unverifiable";

const BOOT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function path(value: unknown, absolute: boolean): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2048 && !value.includes("\0") &&
    posix.isAbsolute(value) === absolute && posix.normalize(value) === value &&
    !value.split("/").some((part) => part === "." || part === "..");
}

export function isLeaseContainmentEvidence(value: unknown): value is LeaseContainmentEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.kind === "marker-parent-links") return Object.keys(v).length === 2 &&
    ["not-probed", "unsupported-platform", "cgroup-not-delegated", "cgroup-unavailable", "boundary-creation-failed"].includes(v.reason as string);
  const unit = Object.hasOwn(v, "unit");
  return v.kind === "linux-cgroup-v2" && Object.keys(v).length === (unit ? 6 : 5) && typeof v.bootId === "string" && BOOT.test(v.bootId) &&
    path(v.mountRoot, true) && path(v.cgroupPath, false) && typeof v.inode === "string" && /^[1-9][0-9]{0,19}$/u.test(v.inode) &&
    (!unit || typeof v.unit === "object" && v.unit !== null && !Array.isArray(v.unit) && !Object.hasOwn(v.unit, "unit") &&
      isLeaseContainmentEvidence(v.unit) && v.unit.kind === "linux-cgroup-v2" &&
      v.unit.bootId === v.bootId && v.unit.mountRoot === v.mountRoot && v.cgroupPath.startsWith(v.unit.cgroupPath + "/") &&
      /\.(?:service|scope)$/u.test(posix.basename(v.unit.cgroupPath)));
}

/** Read-only recovery by a different runner. Never select a different path by PID, process name,
 * or inode search. Missing provider parents require a recorded own unit that also retired.
 * cgroup v2 has no rename syscall operation; rmdir is serialized against migration and requires
 * no population/online children (kernel/cgroup/cgroup.c cgroup_destroy_locked and syscall ops).
 * Like populated=0, this lifecycle proof excludes deliberate same-user migration by provider code.
 * cgroup.events is recursive and the fd plus before/after identity checks prevent path reuse
 * from turning an unrelated empty cgroup into proof of the recorded boundary's emptiness. */
export function inspectLeaseCgroup(identity: LeaseCgroupEvidence): LeaseContainmentResult {
  if (process.platform !== "linux" || !isLeaseContainmentEvidence(identity)) return "unverifiable";
  try {
    if (readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== identity.bootId) return "unverifiable";
    for (const line of readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
      const [left, right] = line.split(" - ");
      if (right?.split(" ")[0] !== "cgroup2") continue;
      const fields = left!.split(" ");
      const decode = (text: string) => text.replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
      if (decode(fields[3] ?? "") !== identity.mountRoot) continue;
      const mount = decode(fields[4] ?? "");
      if (!path(mount, true)) continue;
      if (statfsSync(mount).type !== 0x63677270) return "unverifiable";
      const directory = posix.join(mount, identity.cgroupPath);
      let fd: number;
      try { fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !identity.unit) return "unverifiable";
        const unit = posix.join(mount, identity.unit.cgroupPath);
        let retired = false;
        let unitFd: number | undefined;
        try {
          unitFd = openSync(unit, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          const stat = fstatSync(unitFd, { bigint: true });
          const named = lstatSync(unit, { bigint: true });
          retired = statfsSync(`/proc/self/fd/${unitFd}`).type === 0x63677270 && named.isDirectory() &&
            !named.isSymbolicLink() && named.ino === stat.ino && named.dev === stat.dev && stat.nlink !== 0n &&
            stat.ino.toString() !== identity.unit.inode;
        } catch (unitError) { retired = (unitError as NodeJS.ErrnoException).code === "ENOENT"; }
        finally { if (unitFd !== undefined) closeSync(unitFd); }
        // A present exact unit with a missing child is insufficient; only the unit's own
        // retirement establishes this additional removal proof. Recheck the absent child.
        if (!retired) return "unverifiable";
        try { lstatSync(directory); return "unverifiable"; }
        catch (missing) { if ((missing as NodeJS.ErrnoException).code !== "ENOENT") return "unverifiable"; }
        return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() === identity.bootId ? "unit_removed" : "unverifiable";
      }
      try {
        if (statfsSync(`/proc/self/fd/${fd}`).type !== 0x63677270) return "unverifiable";
        const initial = fstatSync(fd, { bigint: true });
        const verify = () => {
          const named = lstatSync(directory, { bigint: true });
          return named.isDirectory() && !named.isSymbolicLink() && named.ino.toString() === identity.inode &&
            initial.ino === named.ino && initial.dev === named.dev && fstatSync(fd, { bigint: true }).nlink !== 0n;
        };
        if (!verify()) return "unverifiable";
        const events = readFileSync(`/proc/self/fd/${fd}/cgroup.events`, "utf8");
        const matches = [...events.matchAll(/^populated ([01])$/gmu)];
        if (matches.length !== 1 || !verify()) return "unverifiable";
        return matches[0]![1] === "0" ? "empty" : "populated";
      } finally { closeSync(fd); }
    }
  } catch { /* replaced, inaccessible, or unmounted is not emptiness */ }
  return "unverifiable";
}

export function leaseContainmentGuidance(evidence?: LeaseContainmentEvidence): string {
  if (evidence?.kind === "linux-cgroup-v2") return "The recorded cgroup path and inode could not be verified, or its recorded enclosing delegated unit has not retired; preserve the boundary and journal. Lifecycle proof does not cover deliberate same-user cgroup migration by provider code.";
  const reason = evidence?.reason;
  return reason === "cgroup-not-delegated"
    ? "Boundary proof was unavailable because the runner's systemd unit is not delegated. An operator must launch the runner in a Delegate=yes unit for future leases; existing leases still require the process scan."
    : `Boundary proof was unavailable (${reason ?? "legacy lease has no recorded boundary evidence"}); every potentially related process must be inspectable before scan-based recovery. Use a delegated Linux cgroup v2 unit for future leases.`;
}
