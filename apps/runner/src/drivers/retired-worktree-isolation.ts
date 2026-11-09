import { lstatSync } from "node:fs";
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
 * The stored launch isolation with nothing left of the given retired worktrees: no writable bind of
 * the worktree or under it, no writable bind of its Git admin directory, and no read-only bind of an
 * entry inside either. bubblewrap refuses a bind whose source is missing, so a spawn from the stored
 * list fails once the worktree is removed (#3402). This only takes binds away; it never adds one, so
 * the result is never wider than the launch the session manager proved. A worktree that holds the
 * selected one is never treated as retired.
 *
 * Returns the same object when there is nothing to remove.
 */
export function isolationWithoutRetiredWorktrees(
  isolation: SpawnIsolation | undefined,
  retired: readonly OwnedWorktree[],
): SpawnIsolation | undefined {
  if (isolation?.backend !== "bwrap" || !isolation.protectedWorktree || retired.length === 0) return isolation;
  const selected = isolation.protectedWorktree.path;
  const roots = retired
    .flatMap((owned) => [owned.path, owned.gitAdmin])
    .filter((root) => posix.isAbsolute(root) && !withinOrEqual(root, selected));
  if (roots.length === 0) return isolation;
  const gone = (path: string) => roots.some((root) => withinOrEqual(root, path));
  const { protectedWorktree } = isolation;
  const ownedWorktrees = protectedWorktree.ownedWorktrees?.filter((owned) => !gone(owned.path));
  const writableBinds = isolation.writableBinds?.filter((bind) => !gone(bind.source) && !gone(bind.target));
  const readOnlyBinds = isolation.readOnlyBinds?.filter((path) => !gone(path));
  const codexPackageReadOnlyPaths = isolation.codexPackageReadOnlyPaths?.filter((path) => !gone(path));
  const { ownedWorktrees: _owned, ...protectedRest } = protectedWorktree;
  const {
    writableBinds: _writable, readOnlyBinds: _readOnly, codexPackageReadOnlyPaths: _packages, ...rest
  } = isolation;
  return {
    ...rest,
    ...(writableBinds?.length ? { writableBinds } : {}),
    protectedWorktree: {
      ...protectedRest,
      gitWritableRoots: protectedWorktree.gitWritableRoots.filter((path) => !gone(path)),
      ...(ownedWorktrees?.length ? { ownedWorktrees } : {}),
    },
    ...(readOnlyBinds?.length ? { readOnlyBinds } : {}),
    ...(codexPackageReadOnlyPaths?.length ? { codexPackageReadOnlyPaths } : {}),
  };
}
