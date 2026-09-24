import { listPosixProcesses, type PosixProcessIdentity } from "../src/posix-process-tree.js";

export async function captureLiveProcess(pid: number): Promise<PosixProcessIdentity | undefined> {
  const current = (await listPosixProcesses()).get(pid);
  return current && !current.state?.startsWith("Z") ? current : undefined;
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
