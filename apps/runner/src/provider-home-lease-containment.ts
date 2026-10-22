import { closeSync, constants, fstatSync, statfsSync, lstatSync, openSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import type { LinuxCgroupIdentity, ProviderContainmentStatus } from "./linux-cgroup.js";

export type LeaseContainmentEvidence = LinuxCgroupIdentity |
  { kind: "marker-parent-links"; reason: ProviderContainmentStatus["reason"] };
export type LeaseContainmentResult = "empty" | "populated" | "unverifiable";

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
  return v.kind === "linux-cgroup-v2" && Object.keys(v).length === 5 && typeof v.bootId === "string" && BOOT.test(v.bootId) &&
    path(v.mountRoot, true) && path(v.cgroupPath, false) && typeof v.inode === "string" && /^[1-9][0-9]{0,19}$/u.test(v.inode);
}

/** Read-only recovery by a different runner. Never select a different path by PID, process name,
 * or inode search. An absent path is ambiguous (it could have been renamed), so fails closed.
 * cgroup.events is recursive and the fd plus before/after identity checks prevent path reuse
 * from turning an unrelated empty cgroup into proof of the recorded boundary's emptiness. */
export function inspectLeaseCgroup(identity: LinuxCgroupIdentity): LeaseContainmentResult {
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
      const directory = posix.join(mount, identity.cgroupPath);
      const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
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
  } catch { /* missing, replaced, inaccessible, or unmounted is not emptiness */ }
  return "unverifiable";
}

export function leaseContainmentGuidance(evidence?: LeaseContainmentEvidence): string {
  if (evidence?.kind === "linux-cgroup-v2") return "The recorded cgroup path and inode could not be verified; preserve the boundary and journal for inspection.";
  const reason = evidence?.reason;
  return reason === "cgroup-not-delegated"
    ? "Boundary proof was unavailable because the runner's systemd unit is not delegated. An operator must launch the runner in a Delegate=yes unit for future leases; existing leases still require the process scan."
    : `Boundary proof was unavailable (${reason ?? "legacy lease has no recorded boundary evidence"}); every potentially related process must be inspectable before scan-based recovery. Use a delegated Linux cgroup v2 unit for future leases.`;
}
