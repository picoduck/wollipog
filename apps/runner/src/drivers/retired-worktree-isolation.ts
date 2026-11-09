import { existsSync, lstatSync } from "node:fs";
import { posix } from "node:path";
import { buildBwrapArgs, bwrapPathMayBeWritable, type SpawnIsolation } from "../spawn.js";

type OwnedWorktree = { path: string; gitAdmin: string };

/**
 * Whether one of the session's other worktrees that a bwrap launch bound writable (#3316) has been
 * retired since: it is no longer one of the session's managed worktrees, or its `.git` link, which
 * the launch bound read-only, is gone. The same rule the session manager uses to request the
 * retirement relaunch (#3402). `managed` is undefined when the caller cannot list managed worktrees;
 * only the link is checked then.
 */
export function ownedWorktreeRetired(owned: OwnedWorktree, managed: ReadonlySet<string> | undefined): boolean {
  if (managed && !managed.has(owned.path)) return true;
  try {
    return !lstatSync(posix.join(owned.path, ".git")).isFile();
  } catch {
    return true;
  }
}

function withinOrEqual(root: string, path: string): boolean {
  const relative = posix.relative(root, path);
  return relative === "" || (relative !== ".." && !relative.startsWith("../") && !posix.isAbsolute(relative));
}

/**
 * The stored launch isolation without the writable mounts of the given retired worktrees: no
 * writable bind of the worktree or under it, and no writable bind of its Git admin directory.
 * bubblewrap refuses a bind whose source is missing, so a spawn from the stored list fails once the
 * worktree is removed (#3402).
 *
 * The result is never wider than the launch the session manager proved:
 * - Removing a writable mount cannot make anything writable.
 * - A read-only overlay inside a retired worktree stays while its source exists. It goes only once
 *   the source is missing, which is when bwrap would refuse it.
 * - Every overlay that goes must still be read-only in the argv `buildBwrapArgs` renders for the
 *   result. If one is not (a writable mount the launch keeps covers it, such as a requested-worktree
 *   boundary or the sandbox's private `/tmp`), the stored isolation is returned unchanged, and that
 *   spawn fails as it did before rather than leaving the path writable.
 * - A worktree that holds the selected one is never treated as retired.
 *
 * Returns the same object when there is nothing to remove.
 */
export function isolationWithoutRetiredWorktrees(
  isolation: SpawnIsolation | undefined,
  retired: readonly OwnedWorktree[],
  exists: (path: string) => boolean = existsSync,
): SpawnIsolation | undefined {
  if (isolation?.backend !== "bwrap" || !isolation.protectedWorktree || retired.length === 0) return isolation;
  const { protectedWorktree } = isolation;
  const selected = protectedWorktree.path;
  const roots = retired
    .filter((owned) => [owned.path, owned.gitAdmin].every((root) => posix.isAbsolute(root) && !withinOrEqual(root, selected)))
    .flatMap((owned) => [owned.path, owned.gitAdmin]);
  if (roots.length === 0) return isolation;
  const gone = (path: string) => roots.some((root) => withinOrEqual(root, path));
  const writableBinds = isolation.writableBinds?.filter((bind) => !gone(bind.source) && !gone(bind.target));
  const ownedWorktrees = protectedWorktree.ownedWorktrees?.filter((owned) => !gone(owned.path));
  const droppedOverlays = (isolation.readOnlyBinds ?? []).filter((path) => gone(path) && !exists(path));
  const readOnlyBinds = isolation.readOnlyBinds?.filter((path) => !droppedOverlays.includes(path));
  const { ownedWorktrees: _owned, ...protectedRest } = protectedWorktree;
  const { writableBinds: _writable, readOnlyBinds: _readOnly, ...rest } = isolation;
  const narrowed: SpawnIsolation = {
    ...rest,
    ...(writableBinds?.length ? { writableBinds } : {}),
    protectedWorktree: {
      ...protectedRest,
      gitWritableRoots: protectedWorktree.gitWritableRoots.filter((path) => !gone(path)),
      ...(ownedWorktrees?.length ? { ownedWorktrees } : {}),
    },
    ...(readOnlyBinds?.length ? { readOnlyBinds } : {}),
  };
  if (droppedOverlays.length) {
    let options: string[];
    try {
      options = buildBwrapArgs({ command: "true", args: [], cwd: selected }, narrowed).slice(narrowed.args.length);
    } catch {
      return isolation;
    }
    if (droppedOverlays.some((path) => bwrapPathMayBeWritable(options, path))) return isolation;
  }
  return narrowed;
}
