import { readFileSync } from "node:fs";
import { listPosixProcesses, type PosixProcessIdentity } from "../src/posix-process-tree.js";

export type { PosixProcessIdentity } from "../src/posix-process-tree.js";

export async function captureLiveProcess(pid: number): Promise<PosixProcessIdentity | undefined> {
  const current = (await listPosixProcesses()).get(pid);
  return current && !current.state?.startsWith("Z") ? current : undefined;
}

/** Wait for a newline-terminated PID so a partially written number cannot name another process. */
export async function waitForLiveProcessPidFile(
  file: string,
  timeoutMs = 5_000,
): Promise<PosixProcessIdentity | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let pid = 0;
    try {
      const match = /^([1-9]\d*)\n$/u.exec(readFileSync(file, "utf8"));
      if (match) pid = Number(match[1]);
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Number.isSafeInteger(pid) && pid > 1) {
      const identity = await captureLiveProcess(pid);
      if (identity) return identity;
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Best-effort test teardown: never signal a PID whose observed owner has changed. */
export async function terminateOriginalProcess(
  expected: PosixProcessIdentity | undefined,
  lookup: (pid: number) => Promise<PosixProcessIdentity | undefined> = captureLiveProcess,
): Promise<boolean> {
  if (!expected) return false;
  try {
    const current = await lookup(expected.pid);
    if (!current || current.startedAt !== expected.startedAt) return false;
    process.kill(expected.pid, "SIGKILL");
    return true;
  } catch {
    // Process enumeration and signalling can fail during teardown. Preserve the test's
    // original result and let callers continue removing their temporary files.
    return false;
  }
}

/** A reparented child may remain visible as a zombie. Match its start stamp so a reused PID is not mistaken for the original child. */
export async function waitForOriginalProcessToStop(
  expected: PosixProcessIdentity,
  timeoutMs = 3_000,
): Promise<PosixProcessIdentity | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = (await listPosixProcesses()).get(expected.pid);
    if (!current || current.startedAt !== expected.startedAt || current.state?.startsWith("Z")) return undefined;
    if (Date.now() >= deadline) return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
