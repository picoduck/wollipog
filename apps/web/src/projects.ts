import type { SessionView } from "@wollipog/protocol";

/**
 * Compatibility-only grouping for control planes that do not expose durable Projects.
 * Repo-less sessions (`workspaceId == null`) collect under the legacy "Chats" bucket.
 */

export interface LegacyWorkspaceGroup {
  /** Stable unique group id for React keys and compatibility pin migration. */
  key: string;
  /** workspaceId, or null for the repo-less "Chats" bucket. */
  id: string | null;
  name: string;
  sessions: SessionView[];
}

const CHATS_KEY = " chats"; // sentinel so a real workspaceId can never collide

/** Unambiguous (runner, workspace) group key — JSON keeps ids with spaces/delimiters distinct. */
export function workspaceLocationKey(runnerId: string, workspaceId: string): string {
  return JSON.stringify([runnerId, workspaceId]);
}

/** Group non-archived sessions by workspace. Pinned groups sort first (alphabetical within),
 * then the rest alphabetically; Chats always sorts last (it can't be pinned). Sessions within
 * a group sort pinned-first, then most-recently-updated. */
export function groupLegacySessionsByWorkspace(
  sessions: Iterable<SessionView>,
  pinned?: ReadonlySet<string>,
  pinnedSessions?: ReadonlySet<string>,
): LegacyWorkspaceGroup[] {
  const groups = new Map<string, LegacyWorkspaceGroup>();
  for (const s of sessions) {
    if (s.archived) continue;
    // Workspace ids are scoped per-runner (boxes reuse ids like "home"), so include runnerId to avoid
    // merging unrelated workspace groups from different machines. Repo-less sessions share Chats.
    // JSON-encoded pair: a plain delimiter would collide when ids themselves contain it
    // (("box a","repo") vs ("box","a repo")), merging unrelated projects.
    const key = s.workspaceId == null ? CHATS_KEY : workspaceLocationKey(s.runnerId, s.workspaceId);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        id: s.workspaceId ?? null,
        name: s.workspaceId ? (s.workspaceName ?? s.workspaceId) : "Chats",
        sessions: [],
      };
      groups.set(key, g);
    }
    g.sessions.push(s);
  }
  for (const g of groups.values()) {
    g.sessions.sort((a, b) => {
      const ap = pinnedSessions?.has(a.id) ? 0 : 1;
      const bp = pinnedSessions?.has(b.id) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return b.updatedAt - a.updatedAt;
    });
  }
  return [...groups.values()].sort((a, b) => {
    if (a.id === null) return 1; // Chats last
    if (b.id === null) return -1;
    const ap = pinned?.has(a.key) ? 0 : 1;
    const bp = pinned?.has(b.key) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.name.localeCompare(b.name);
  });
}

/** One exact runner/workspace place in the pre-Project compatibility model. */
export interface LegacyWorkspaceLocation {
  runnerId: string;
  workspaceId: string;
  lastUpdated: number;
  count: number;
}

/**
 * Legacy locations matched by workspace display name. This heuristic is never used when the control
 * plane provides stable Project and Location identities.
 */
export function legacyWorkspaceLocationsByName(
  sessions: Iterable<SessionView>,
  workspaceName: string,
): LegacyWorkspaceLocation[] {
  const byLoc = new Map<string, LegacyWorkspaceLocation>();
  for (const s of sessions) {
    if (s.archived || s.workspaceId == null || s.workspaceName !== workspaceName) continue;
    const key = workspaceLocationKey(s.runnerId, s.workspaceId);
    const cur = byLoc.get(key);
    if (cur) {
      cur.lastUpdated = Math.max(cur.lastUpdated, s.updatedAt);
      cur.count += 1;
    } else {
      byLoc.set(key, { runnerId: s.runnerId, workspaceId: s.workspaceId, lastUpdated: s.updatedAt, count: 1 });
    }
  }
  return [...byLoc.values()].sort((a, b) => b.lastUpdated - a.lastUpdated);
}
