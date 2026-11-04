import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, relative, sep } from "node:path";
import type { AgentContext } from "@wollipog/protocol";
import type { RunnerConfigWorkspace } from "./config.js";

export function validateSharedDirectoryConfiguration(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 16 || value.some((path) => typeof path !== "string" ||
      !isAbsolute(path) || path.includes("\0") || normalize(path) !== path)) {
    throw new Error("workspace sharedWritableDirectories must contain at most 16 normalized absolute directory paths");
  }
  return [...new Set(value as string[])];
}

function contains(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix));
}

/** Only runner-local operator configuration can supply these roots. A session's repository
 * config, prompt, environment and requested extra directories never enter this function. */
export function projectSharedDirectories(
  workspaces: readonly RunnerConfigWorkspace[],
  session: { workspaceId: string | null; repoPath: string; context: AgentContext; review?: unknown },
  forbiddenRoots: readonly string[],
): string[] {
  if (session.review || session.context.kind !== "native") return [];
  const workspace = workspaces.find((entry) => entry.id === session.workspaceId && entry.path === session.repoPath);
  const directories = validateSharedDirectoryConfiguration(workspace?.sharedWritableDirectories) ?? [];
  for (const directory of directories) {
    // Existing exact canonical directories only: no mkdir, symlink adoption, repo overlap or
    // grants to HOME/ancestors. Parent credential/config files retain the read-only root bind.
    if (contains(directory, homedir()) || contains(directory, session.repoPath) || contains(session.repoPath, directory) ||
        forbiddenRoots.some((root) => contains(root, directory) || contains(directory, root)) ||
        directories.some((other) => other !== directory && (contains(other, directory) || contains(directory, other)))) {
      throw new Error("workspace shared writable directory overlaps a protected root");
    }
    if (!lstatSync(directory).isDirectory() || realpathSync.native(directory) !== directory) {
      throw new Error("workspace shared writable directory must already exist without symlink aliases");
    }
  }
  return directories;
}
