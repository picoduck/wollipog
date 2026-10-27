/** Inventory only: admission still verifies the command and every interpreter independently.
 * Protect every configured native reviewer, including currently unavailable installations, so
 * starting a different harness cannot change an installation later run outside its sandbox. */
import { closeSync, lstatSync, openSync, readSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { AgentDefinition } from "@wollipog/protocol";

export function reviewerInstallationPaths(
  agents: readonly Pick<AgentDefinition, "id" | "command" | "driver" | "context">[],
  agentPath: (id: string, driver: AgentDefinition["driver"]) => string | undefined,
  hostPath = process.env.PATH,
): string[] {
  const directories = new Set<string>();
  const seen = new Set<string>();
  const inspect = (command: string, pathEnv: string | undefined, depth = 0): void => {
    if (depth > 8) throw new Error(`reviewer interpreter chain is too deep: ${command}`);
    let candidate = isAbsolute(command) ? command : undefined;
    if (!candidate) {
      for (const dir of (pathEnv ?? "").split(":")) {
        if (!isAbsolute(dir)) continue;
        const path = join(dir, command);
        try { if (statSync(path).isFile() && (statSync(path).mode & 0o111)) { candidate = path; break; } }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
    if (!candidate) return;
    let resolved: string;
    try { resolved = realpathSync(candidate); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const key = `${candidate}\0${pathEnv}`;
    if (seen.has(key)) return;
    seen.add(key);
    // Pin all symlink containers, not just the final target. Otherwise a writable link could
    // redirect the runner's subsequent PATH lookup to planted code.
    let current = "/";
    const pending = candidate.split("/").filter(Boolean);
    let hops = 0;
    while (pending.length) {
      const next = join(current, pending.shift()!);
      if (!lstatSync(next).isSymbolicLink()) { current = next; continue; }
      if (++hops > 40) throw new Error(`reviewer installation has too many symbolic links: ${candidate}`);
      if (current !== "/") directories.add(current);
      const target = readlinkSync(next);
      if (isAbsolute(target)) current = "/";
      pending.unshift(...target.split("/").filter(Boolean));
    }
    directories.add(dirname(resolved));
    // Read only the shebang, without executing any installation or provider code.
    const descriptor = openSync(resolved, "r");
    let line: string;
    try {
      const head = Buffer.alloc(256);
      line = head.subarray(0, readSync(descriptor, head, 0, head.length, 0)).toString("latin1").split("\n")[0]!;
    } finally { closeSync(descriptor); }
    if (!line.startsWith("#!")) return;
    const words = line.slice(2).trim().split(/\s+/u);
    const interpreter = words[0]!;
    inspect(interpreter, pathEnv, depth + 1);
    if (interpreter.endsWith("/env")) {
      const program = words.slice(1).find((word) => !word.startsWith("-") && !word.includes("="));
      if (program) inspect(program, pathEnv, depth + 1);
    }
  };
  for (const command of ["claude", "codex"]) inspect(command, hostPath);
  for (const agent of agents) {
    if ((agent.context?.kind ?? "native") !== "native" ||
        !["claude-code", "codex", "codex-app-server"].includes(agent.driver ?? "")) continue;
    inspect(agent.command, agentPath(agent.id, agent.driver));
  }
  return [...directories];
}
