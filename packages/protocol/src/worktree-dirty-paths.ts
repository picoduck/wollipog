/** Bounded, escaped diagnostics shared by verification and retirement. */
export function worktreeDirtyPaths(count: number, paths: readonly string[]): string {
  const shown = paths.slice(0, 8).map((path) => {
    const escaped = JSON.stringify(path);
    return escaped.length > 80 ? `${escaped.slice(0, 78)}…\"` : escaped;
  });
  return `the worktree has uncommitted changes (${count} paths): ${shown.join(", ")}` +
    (count > shown.length ? `; ${count - shown.length} more` : "");
}
