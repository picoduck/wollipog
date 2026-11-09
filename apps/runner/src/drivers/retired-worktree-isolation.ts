import { existsSync, lstatSync } from "node:fs";
import { posix } from "node:path";
import type { SpawnIsolation } from "../spawn.js";

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
 * - Only writable mounts of a retired worktree go. A read-only overlay inside one stays while its
 *   source exists, and goes only once it is missing, when bwrap would refuse it.
 * - A retired worktree that a mount this launch keeps writable still covers (a requested-worktree
 *   boundary, say) is left exactly as stored: removing its overlays there would make them writable.
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
  const rootsOf = (owned: OwnedWorktree) => [owned.path, owned.gitAdmin];
  let removable = retired.filter((owned) =>
    rootsOf(owned).every((root) => posix.isAbsolute(root) && !withinOrEqual(root, selected)));
  let gone: (path: string) => boolean = () => false;
  let writableBinds = isolation.writableBinds;
  let gitWritableRoots = protectedWorktree.gitWritableRoots;
  // Dropping one worktree's mounts can uncover another only if they nest; repeat until it settles.
  for (;;) {
    const roots = removable.flatMap(rootsOf);
    gone = (path) => roots.some((root) => withinOrEqual(root, path));
    writableBinds = isolation.writableBinds?.filter((bind) => !gone(bind.source) && !gone(bind.target));
    gitWritableRoots = protectedWorktree.gitWritableRoots.filter((path) => !gone(path));
    const retainedWritable = [selected, ...gitWritableRoots, ...(writableBinds ?? []).map((bind) => bind.target)];
    const uncovered = removable.filter((owned) =>
      !rootsOf(owned).some((root) => retainedWritable.some((mount) => withinOrEqual(mount, root))));
    if (uncovered.length === removable.length) break;
    removable = uncovered;
  }
  if (removable.length === 0) return isolation;
  const stale = (path: string) => gone(path) && !exists(path);
  const ownedWorktrees = protectedWorktree.ownedWorktrees?.filter((owned) => !gone(owned.path));
  const readOnlyBinds = isolation.readOnlyBinds?.filter((path) => !stale(path));
  const codexPackageReadOnlyPaths = isolation.codexPackageReadOnlyPaths?.filter((path) => !stale(path));
  const { ownedWorktrees: _owned, ...protectedRest } = protectedWorktree;
  const {
    writableBinds: _writable, readOnlyBinds: _readOnly, codexPackageReadOnlyPaths: _packages, ...rest
  } = isolation;
  return {
    ...rest,
    ...(writableBinds?.length ? { writableBinds } : {}),
    protectedWorktree: {
      ...protectedRest,
      gitWritableRoots,
      ...(ownedWorktrees?.length ? { ownedWorktrees } : {}),
    },
    ...(readOnlyBinds?.length ? { readOnlyBinds } : {}),
    ...(codexPackageReadOnlyPaths?.length ? { codexPackageReadOnlyPaths } : {}),
  };
}
