import type { BoxView, RunnerView } from "@wollipog/protocol";
import { sshTargetHost } from "./runners.js";

/**
 * Each Machine's name without its id: the name its owner gave it, else its SSH host or hostname.
 * Two Machines that read alike add their hostname, as `machineOptionLabels` does, but its last resort
 * (and `runnerDisplay`'s first fallback) is the runner id, which no row here may print (#2982). Two
 * Machines that still read alike keep one name; their sessions' other parts tell them apart.
 */
export function machineDisplayNames(
  runners: Iterable<Pick<RunnerView, "runnerId" | "hostname" | "displayName">>,
  boxFor: (runnerId: string) => Pick<BoxView, "sshTarget" | "displayName"> | undefined = () => undefined,
): Map<string, string> {
  const named = [...runners].map((runner) => {
    const box = boxFor(runner.runnerId);
    const hostname = runner.hostname?.trim() ?? "";
    const name = runner.displayName?.trim() || box?.displayName?.trim() || (box ? sshTargetHost(box.sshTarget) : "") || hostname;
    return { runnerId: runner.runnerId, name, hostname };
  }).filter((machine) => machine.name);
  const counts = new Map<string, number>();
  for (const machine of named) counts.set(normalize(machine.name), (counts.get(normalize(machine.name)) ?? 0) + 1);
  return new Map(named.map(({ runnerId, name, hostname }) => [runnerId,
    (counts.get(normalize(name)) ?? 0) > 1 && hostname && normalize(hostname) !== normalize(name) ? `${name} · ${hostname}` : name]));
}

const normalize = (text: string) => text.toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
