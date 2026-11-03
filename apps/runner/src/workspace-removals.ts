/**
 * Configured Workspaces removed in Wollipog (#4123). The runner's configuration (file, flags or
 * environment) stays operator-owned and untouched; the runner records each removal in its data
 * directory instead and leaves that Workspace out of what it advertises and uses, across restarts
 * and reconnects. Removal never touches the Workspace's folder, files, sessions or worktrees.
 *
 * An entry matches only the exact id and path it removed, so an operator who configures a
 * different folder under the same id gets that Workspace back. Restoring the exact Workspace means
 * deleting its entry from this file.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerConfigWorkspace } from "./config.js";
import { protectedWrite } from "./protected-file.js";

export const WORKSPACE_REMOVALS_FILE = "workspace-removals.json";

export interface WorkspaceRemovalEntry {
  id: string;
  path: string;
  removedAt: number;
}

interface WorkspaceRemovalsFile {
  version: 1;
  removed: WorkspaceRemovalEntry[];
}

export class WorkspaceRemovals {
  readonly file: string;

  constructor(dataDir: string, private readonly warn: (message: string) => void = () => {}) {
    this.file = join(dataDir, WORKSPACE_REMOVALS_FILE);
  }

  /** The recorded removals. An unreadable file is reported and treated as empty: the operator's
   * configuration then applies as written, which is how the runner behaved before removal. */
  entries(): WorkspaceRemovalEntry[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<WorkspaceRemovalsFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.removed)) throw new Error("unrecognized format");
      return parsed.removed.filter((entry): entry is WorkspaceRemovalEntry =>
        typeof entry?.id === "string" && typeof entry.path === "string" && typeof entry.removedAt === "number");
    } catch (error) {
      this.warn(`ignoring unreadable ${this.file}: ${(error as Error).message}`);
      return [];
    }
  }

  removed(workspace: Pick<RunnerConfigWorkspace, "id" | "path">, entries = this.entries()): boolean {
    return entries.some((entry) => entry.id === workspace.id && entry.path === workspace.path);
  }

  record(workspace: Pick<RunnerConfigWorkspace, "id" | "path">, now = Date.now()): void {
    const entries = this.entries();
    if (this.removed(workspace, entries)) return;
    const contents: WorkspaceRemovalsFile = {
      version: 1,
      removed: [...entries, { id: workspace.id, path: workspace.path, removedAt: now }],
    };
    protectedWrite(this.file, `${JSON.stringify(contents, null, 2)}\n`, "workspace removal record");
  }

  /** Drop every recorded removal from `workspaces` in place, returning what was dropped. */
  apply(workspaces: RunnerConfigWorkspace[]): RunnerConfigWorkspace[] {
    const entries = this.entries();
    const dropped = workspaces.filter((workspace) => this.removed(workspace, entries));
    for (const workspace of dropped) workspaces.splice(workspaces.indexOf(workspace), 1);
    return dropped;
  }
}

export type ConfiguredWorkspaceRemoval =
  | { ok: true; removed: RunnerConfigWorkspace | null }
  | { ok: false; error: string };

/**
 * Remove one configured Workspace: refuse while a session runs in it, record the removal, then drop
 * it from `workspaces` in place so every reader of the live configuration stops using it. Retrying
 * a removal that already happened succeeds with `removed: null`.
 */
export function removeConfiguredWorkspace(input: {
  workspaces: RunnerConfigWorkspace[];
  removals: WorkspaceRemovals;
  workspaceId: string;
  path: string;
  sessionRunningIn: (workspaceId: string) => boolean;
  now?: number;
}): ConfiguredWorkspaceRemoval {
  const workspace = input.workspaces.find((candidate) => candidate.id === input.workspaceId);
  if (!workspace) {
    return input.removals.removed({ id: input.workspaceId, path: input.path })
      ? { ok: true, removed: null }
      : { ok: false, error: "This workspace is not configured on this machine." };
  }
  if (workspace.path !== input.path) {
    return { ok: false, error: "This workspace's folder changed on this machine. Reload and try again." };
  }
  if (input.sessionRunningIn(workspace.id)) {
    return { ok: false, error: "A session is running in this workspace. Stop it, then try again." };
  }
  input.removals.record(workspace, input.now);
  input.workspaces.splice(input.workspaces.indexOf(workspace), 1);
  return { ok: true, removed: workspace };
}
