import type { SessionView } from "@wollipog/protocol";
import { sessionAgentLabel } from "./components/agent-options.js";
import { isInboxBlocked, type InboxSplit } from "./inbox.js";

/**
 * The Sessions search (#2200, docs/design-system.md §8.4, §10.1, §12.2): a fast filter of the
 * sessions the list already holds. Transcript search lives in the command palette, which needs the
 * server's index. Kept apart from the views so every surface that searches Sessions (the tab row's
 * field, the phone app bar's Search mode) matches, counts and words its result the same way.
 */

export const SESSIONS_SEARCH_LABEL = "Search Sessions";
/** What the field matches, as its tooltip. */
export const SESSIONS_SEARCH_SCOPE = "Searches titles, agents, projects and the latest message.";

/** The form a query is matched in: trimmed and lowercased. Empty means no search. */
export function normalizeSessionsQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

/** Whether a session matches a normalized query: its title, latest message, agent or project. */
export function sessionMatchesQuery(
  session: SessionView,
  normalizedQuery: string,
  projectName: string,
): boolean {
  if (!normalizedQuery) return true;
  return [
    session.title,
    session.preview,
    sessionAgentLabel(session.agentName, session.driver, session.agentId),
    session.agentName,
    projectName,
  ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
}

/**
 * Each group narrowed to its matches, so the tab counts follow the results (§10.1): the count is the
 * number of matching sessions, and the attention badges count only matches, so a group with none
 * reads a plain 0 with no badge. An empty query returns the groups unchanged, totals included.
 */
export function searchInboxSplits(
  splits: readonly InboxSplit[],
  normalizedQuery: string,
  projectName: (session: SessionView) => string,
  stalledSessionIds: ReadonlySet<string>,
): readonly InboxSplit[] {
  if (!normalizedQuery) return splits;
  return splits.map((split) => {
    const sessions = split.sessions.filter((session) => sessionMatchesQuery(session, normalizedQuery, projectName(session)));
    return {
      ...split,
      sessions,
      count: sessions.length,
      blockedCount: sessions.reduce((total, session) => total + Number(isInboxBlocked(session)), 0),
      stalledCount: sessions.reduce((total, session) => total + Number(stalledSessionIds.has(session.id)), 0),
    };
  });
}

/** The No Matches sentence (§12.2): what was searched, and where. All is every group. */
export function sessionsNoMatchesMessage(query: string, group: { kind: InboxSplit["kind"]; name: string }): string {
  return `No sessions match “${query.trim()}” in ${group.kind === "all" ? "any group" : group.name}.`;
}
