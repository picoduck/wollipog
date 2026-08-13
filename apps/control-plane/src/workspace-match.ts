/**
 * Pure path matching from a session working directory to one exact runner workspace. Durable
 * Project inference may then resolve that workspace's stable Location; names never participate.
 *
 * WSL: the drvfs form of a Windows drive (`/mnt/c/…`) canonicalizes to `C:/…`, so a WSL
 * CLI session matches its natively-registered workspace (and vice versa). The
 * `\\wsl$\<distro>\…` ↔ distro-home (`/home/…`) equivalence is intentionally
 * unsupported — it depends on the distro mapping, which the paths alone don't carry.
 */

/** Comparison form of a path: backslashes → forward slashes, trailing slashes stripped. */
function normalize(p: string): string {
  let slashed = p.replace(/\\/g, "/");
  // WSL drvfs form of a Windows drive: /mnt/c/… is the same (case-insensitive) filesystem as
  // C:/…, so canonicalize to drive-letter form — which also makes it fold-eligible below. The
  // lookahead leaves non-drive mounts (/mnt/wsl, /mnt/data) untouched.
  const drv = /^\/mnt\/([a-zA-Z])(?=\/|$)/.exec(slashed);
  if (drv) slashed = `${drv[1]!.toUpperCase()}:${slashed.slice(6)}`;
  // Keep a bare root ("/", "C:/") intact — stripping it would break the boundary check below.
  return slashed.replace(/(?<=[^/:])\/+$/, "");
}

/** True when two paths name the same exact directory under the supported cross-platform rules. */
export function workspacePathsEqual(left: string, right: string): boolean {
  const a = normalize(left.trim());
  const b = normalize(right.trim());
  if (!a || !b) return false;
  return isWindowsPath(a) && isWindowsPath(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Windows-style path = starts with a drive letter like `C:`. */
function isWindowsPath(p: string): boolean {
  return /^[a-zA-Z]:/.test(p);
}

/**
 * The exact workspace whose path equals — or contains — `sessionPath`, or null when none does.
 * Case-insensitive only when BOTH sides are drive-letter paths (Windows filesystems are
 * case-insensitive; POSIX/WSL paths are not, so /home/Me and /home/me stay distinct).
 * With nested workspaces the LONGEST (most specific) path wins.
 */
export function matchWorkspaceId(
  workspaces: ReadonlyArray<{ id: string; path: string }>,
  sessionPath: string | null | undefined,
): string | null {
  if (!sessionPath?.trim()) return null;
  const sess = normalize(sessionPath.trim());
  let best: { id: string; len: number } | null = null;
  for (const ws of workspaces) {
    const wsPath = normalize(ws.path);
    if (!wsPath) continue;
    const fold = isWindowsPath(sess) && isWindowsPath(wsPath);
    const a = fold ? sess.toLowerCase() : sess;
    const b = fold ? wsPath.toLowerCase() : wsPath;
    // Equal, or inside it — the separator boundary keeps /repo2 from matching /repo.
    if (a !== b && !a.startsWith(b.endsWith("/") ? b : b + "/")) continue;
    if (!best || wsPath.length > best.len) best = { id: ws.id, len: wsPath.length };
  }
  return best?.id ?? null;
}

/**
 * Every workspace tied for the most-specific containing path. Imported-session inference uses this
 * to fail closed when two different durable workspace identities describe the same directory.
 */
export function matchWorkspaceIds(
  workspaces: ReadonlyArray<{ id: string; path: string }>,
  sessionPath: string | null | undefined,
): string[] {
  if (!sessionPath?.trim()) return [];
  const sess = normalize(sessionPath.trim());
  let bestLength = -1;
  let matches: string[] = [];
  for (const workspace of workspaces) {
    const workspacePath = normalize(workspace.path);
    if (!workspacePath) continue;
    const fold = isWindowsPath(sess) && isWindowsPath(workspacePath);
    const candidate = fold ? workspacePath.toLowerCase() : workspacePath;
    const requested = fold ? sess.toLowerCase() : sess;
    if (requested !== candidate && !requested.startsWith(candidate.endsWith("/") ? candidate : `${candidate}/`)) {
      continue;
    }
    if (workspacePath.length > bestLength) {
      bestLength = workspacePath.length;
      matches = [workspace.id];
    } else if (workspacePath.length === bestLength && !matches.includes(workspace.id)) {
      matches.push(workspace.id);
    }
  }
  return matches;
}
