import type { SessionStatus, SessionView } from "@wollipog/protocol";
import { sessionAgentLabel } from "./components/agent-options.js";

export const ARCHIVE_PAGE_SIZE = 50;

export type ArchiveStateFilter = "archived" | "unarchived" | "all";

export interface ArchiveBrowserFilters {
  query: string;
  project: string;
  location: string;
  agent: string;
  archive: ArchiveStateFilter;
  lifecycle: SessionStatus | "all";
}

export interface ArchiveSessionMetadata {
  project: string;
  location: string;
  agent: string;
}

export const CANONICAL_LIFECYCLE_LABELS: Readonly<Record<SessionStatus, string>> = {
  queued: "Queued",
  starting: "Starting",
  running: "Running",
  input_required: "Input Required",
  idle: "Idle",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

export const SESSION_LIFECYCLE_STATES = Object.keys(CANONICAL_LIFECYCLE_LABELS) as SessionStatus[];

export function canonicalLifecycleLabel(status: SessionStatus): string {
  return CANONICAL_LIFECYCLE_LABELS[status];
}

export function sessionArchiveSearchDetail(
  session: Pick<SessionView, "archived" | "status" | "projectName" | "workspaceName" | "agentName" | "driver" | "agentId">,
): string {
  return [
    session.archived ? "Archived" : null,
    canonicalLifecycleLabel(session.status),
    session.projectName ?? session.workspaceName,
    sessionAgentLabel(session.agentName, session.driver, session.agentId),
  ].filter(Boolean).join(" · ");
}

export function archiveSessionMetadata(
  session: SessionView,
  locationNames: ReadonlyMap<string, string> = new Map(),
): ArchiveSessionMetadata {
  return {
    project: session.projectName ?? (session.projectId ? "Unknown Project" : "No Project"),
    location: session.projectLocationId
      ? locationNames.get(session.projectLocationId) ?? session.workspaceName ?? session.projectLocationId
      : session.workspaceName ?? (session.workspaceId ? session.workspaceId : "No Location"),
    agent: sessionAgentLabel(session.agentName, session.driver, session.agentId),
  };
}

export function stableArchiveOrder(left: SessionView, right: SessionView): number {
  return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
}

export function filterArchiveSessions(input: {
  sessions: Iterable<SessionView>;
  filters: ArchiveBrowserFilters;
  locationNames?: ReadonlyMap<string, string>;
  transcriptSessionIds?: ReadonlySet<string>;
}): SessionView[] {
  const query = input.filters.query.trim().toLocaleLowerCase();
  const matchesArchive = (session: SessionView) => {
    if (input.filters.archive === "all") return true;
    const pendingArchive = session.archiveStatus === "stop_pending";
    return input.filters.archive === "archived"
      ? session.archived || pendingArchive
      : !session.archived && !pendingArchive;
  };

  return [...input.sessions].filter((session) => {
    if (!matchesArchive(session) ||
        (input.filters.lifecycle !== "all" && session.status !== input.filters.lifecycle)) return false;
    const metadata = archiveSessionMetadata(session, input.locationNames);
    if (input.filters.project !== "all" && metadata.project !== input.filters.project) return false;
    if (input.filters.location !== "all" && metadata.location !== input.filters.location) return false;
    if (input.filters.agent !== "all" && metadata.agent !== input.filters.agent) return false;
    if (!query) return true;
    const localText = [
      session.id,
      session.title,
      metadata.project,
      metadata.location,
      metadata.agent,
      canonicalLifecycleLabel(session.status),
      session.archived ? "Archived" : "Not Archived",
    ].join("\n").toLocaleLowerCase();
    return localText.includes(query) || Boolean(input.transcriptSessionIds?.has(session.id));
  }).sort(stableArchiveOrder);
}

export function pageArchiveSessions(
  sessions: readonly SessionView[],
  requestedPage: number,
  pageSize = ARCHIVE_PAGE_SIZE,
): { sessions: SessionView[]; page: number; pageCount: number; total: number } {
  const total = sessions.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.max(1, Math.min(Math.trunc(requestedPage) || 1, pageCount));
  const start = (page - 1) * pageSize;
  return { sessions: sessions.slice(start, start + pageSize), page, pageCount, total };
}

/** Merge websocket upserts into the REST catalog without making ordering depend on arrival order. */
export function mergeArchiveSessionCatalog(
  catalog: ReadonlyMap<string, SessionView>,
  upserts: Iterable<SessionView>,
): Map<string, SessionView> {
  const merged = new Map(catalog);
  for (const session of upserts) merged.set(session.id, session);
  return merged;
}
