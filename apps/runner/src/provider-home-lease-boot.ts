import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { uptime } from "node:os";

/**
 * #3241: when the current boot started, in epoch milliseconds, or null when it cannot be read.
 *
 * An Owner or Admin may authorize recovering a stale provider-HOME lease that carries no lifecycle
 * evidence only when the host booted after that lease was written: no process of an earlier boot
 * survives a reboot. Linux reads `btime` from /proc/stat, macOS `kern.boottime`, and Windows derives
 * it from uptime. Windows Fast Startup resumes the kernel, so uptime keeps counting and the derived
 * boot time stays earlier than a lease written since; recovery is then refused, never wrongly allowed.
 */
export function currentBootTimeMs(platform = process.platform): number | null {
  try {
    if (platform === "linux") {
      const line = readFileSync("/proc/stat", "utf8").split("\n").find((item) => item.startsWith("btime "));
      const seconds = Number(line?.slice(6).trim());
      return Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : null;
    }
    if (platform === "darwin") return parseDarwinBootTime(execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 5_000 }));
    if (platform === "win32") {
      const seconds = uptime();
      return Number.isFinite(seconds) && seconds > 0 ? Date.now() - Math.ceil(seconds) * 1000 : null;
    }
  } catch {
    return null;
  }
  return null;
}

/** `{ sec = 1729000000, usec = 123456 } Mon Oct 14 ...` */
export function parseDarwinBootTime(output: string): number | null {
  const match = /\bsec\s*=\s*(\d{1,12})\b/u.exec(output);
  const seconds = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : null;
}
