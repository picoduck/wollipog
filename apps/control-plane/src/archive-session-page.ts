import type { SessionStatus, SessionView } from "@wollipog/protocol";

export const ARCHIVE_SESSION_PAGE_SIZE = 50;

export interface ArchiveSessionPageQuery {
  cursor?: string;
  project?: string;
  location?: string;
  agent?: string;
  archive?: "archived" | "unarchived" | "all";
  lifecycle?: SessionStatus | "all";
  q?: string;
}

export function parseArchiveSessionPageQuery(
  raw: Record<string, unknown>,
): ArchiveSessionPageQuery | { error: string } {
  const query: Record<string, string> = {};
  for (const key of ["cursor", "project", "location", "agent", "archive", "lifecycle", "q"]) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "string") return { error: `${key} must be specified at most once` };
    query[key] = value;
  }
  return query as ArchiveSessionPageQuery;
}

export interface ArchiveSessionPage {
  sessionIds: string[];
  snippets: Record<string, string>;
  metadata: Record<string, ArchiveSessionMetadata>;
  nextCursor: string | null;
  hasMore: boolean;
  facets: { projects: string[]; locations: string[]; agents: string[] };
}

export type ArchiveSessionCandidate = Pick<SessionView,
  "id" | "title" | "projectId" | "workspaceId" | "agentId" | "agentName" | "driver" |
  "archived" | "archiveStatus" | "status" | "createdAt"
> & {
  projectName: string | null;
  locationName: string | null;
};

export interface ArchiveSessionMetadata {
  project: string;
  location: string;
  agent: string;
}

export interface ArchiveSessionCursor {
  version: 1;
  filterKey: string;
  anchorCreatedAt: number;
  anchorId: string;
  afterCreatedAt: number;
  afterId: string;
}

export interface ArchiveSessionCursorWindow {
  archive: "archived" | "unarchived" | "all";
  lifecycle: SessionStatus | "all";
  filterKey: string;
  cursor: ArchiveSessionCursor | null;
}

const STATUSES = new Set<SessionStatus>([
  "queued", "starting", "running", "input_required", "idle", "completed", "failed", "stopped",
]);

function encodeCursor(cursor: ArchiveSessionCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeArchiveCursor(raw: string): ArchiveSessionCursor | null {
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<ArchiveSessionCursor>;
    if (value.version !== 1 || typeof value.filterKey !== "string" || value.filterKey.length > 2_048 ||
        !Number.isSafeInteger(value.anchorCreatedAt) || value.anchorCreatedAt! < 0 ||
        typeof value.anchorId !== "string" || !value.anchorId || value.anchorId.length > 512 ||
        !Number.isSafeInteger(value.afterCreatedAt) || value.afterCreatedAt! < 0 ||
        typeof value.afterId !== "string" || !value.afterId || value.afterId.length > 512) return null;
    return value as ArchiveSessionCursor;
  } catch {
    return null;
  }
}

function lifecycleLabel(status: SessionStatus): string {
  return status === "input_required"
    ? "Input Required"
    : status.slice(0, 1).toLocaleUpperCase() + status.slice(1);
}

function metadata(session: ArchiveSessionCandidate): ArchiveSessionMetadata {
  const conductor = session.agentId === "conductor" ||
    /^Conductor \((?:Wollipog|Agent Manager)\)$/u.test(session.agentName ?? "");
  const agent = conductor
    ? "Conductor (Wollipog)"
    : session.driver === "codex-app-server"
    ? "Codex — Interactive"
    : session.driver === "codex"
      ? "Codex — Non-Interactive (codex exec)"
      : session.agentName ?? session.agentId ?? session.driver;
  return {
    project: session.projectName ?? (session.projectId ? "Unknown Project" : "No Project"),
    location: session.locationName ?? session.workspaceId ?? "No Location",
    agent,
  };
}

function compareIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function order(left: ArchiveSessionCandidate, right: ArchiveSessionCandidate): number {
  return right.createdAt - left.createdAt || compareIds(left.id, right.id);
}

function tupleAtOrBelow(session: ArchiveSessionCandidate, createdAt: number, id: string): boolean {
  return session.createdAt < createdAt || (session.createdAt === createdAt && compareIds(session.id, id) >= 0);
}

function cursorFilterKey(query: ArchiveSessionPageQuery, archive: string, lifecycle: string): string {
  return JSON.stringify({
    project: query.project ?? "",
    location: query.location ?? "",
    agent: query.agent ?? "",
    archive,
    lifecycle,
    q: (query.q ?? "").trim(),
  });
}

export function archiveSessionCursorWindow(
  query: ArchiveSessionPageQuery,
): ArchiveSessionCursorWindow | { error: string } {
  const archive = query.archive ?? "archived";
  const lifecycle = query.lifecycle ?? "all";
  if (!(["archived", "unarchived", "all"] as const).includes(archive)) {
    return { error: "archive filter is invalid" };
  }
  if (lifecycle !== "all" && !STATUSES.has(lifecycle)) return { error: "lifecycle filter is invalid" };
  const cursor = query.cursor ? decodeArchiveCursor(query.cursor) : null;
  if (query.cursor && !cursor) return { error: "cursor is invalid" };
  const filterKey = cursorFilterKey(query, archive, lifecycle);
  if (cursor && cursor.filterKey !== filterKey) return { error: "cursor does not match filters" };
  return { archive, lifecycle, filterKey, cursor };
}

export function archiveSessionPage(input: {
  sessions: ArchiveSessionCandidate[];
  query: ArchiveSessionPageQuery;
  transcriptHits?: ReadonlyMap<string, string>;
}): ArchiveSessionPage | { error: string } {
  const window = archiveSessionCursorWindow(input.query);
  if ("error" in window) return window;
  const { archive, lifecycle, cursor, filterKey } = window;

  const ordered = [...input.sessions].sort(order);
  const anchor = cursor ?? (ordered[0] ? {
    version: 1 as const,
    filterKey,
    anchorCreatedAt: ordered[0].createdAt,
    anchorId: ordered[0].id,
    afterCreatedAt: ordered[0].createdAt,
    afterId: ordered[0].id,
  } : null);
  const query = (input.query.q ?? "").trim().toLocaleLowerCase();
  const transcriptIds = new Set(input.transcriptHits?.keys() ?? []);
  const scoped = ordered.filter((session) => {
    if (anchor && !tupleAtOrBelow(session, anchor.anchorCreatedAt, anchor.anchorId)) return false;
    const pendingArchive = session.archiveStatus === "stop_pending" || session.archiveStatus === "stop_failed";
    if (archive === "archived" && !session.archived && !pendingArchive) return false;
    if (archive === "unarchived" && (session.archived || pendingArchive)) return false;
    if (lifecycle !== "all" && session.status !== lifecycle) return false;
    const item = metadata(session);
    if (input.query.project && item.project !== input.query.project) return false;
    if (input.query.location && item.location !== input.query.location) return false;
    if (input.query.agent && item.agent !== input.query.agent) return false;
    if (!query) return true;
    const local = [session.id, session.title, item.project, item.location, item.agent,
      lifecycleLabel(session.status), session.archived ? "Archived" : "Not Archived"].join("\n").toLocaleLowerCase();
    return local.includes(query) || transcriptIds.has(session.id);
  });
  const facetsSource = ordered;
  const facets = {
    projects: [...new Set(facetsSource.map((session) => metadata(session).project))].sort(),
    locations: [...new Set(facetsSource.map((session) => metadata(session).location))].sort(),
    agents: [...new Set(facetsSource.map((session) => metadata(session).agent))].sort(),
  };
  const after = cursor
    ? scoped.filter((session) => session.createdAt < cursor.afterCreatedAt ||
      (session.createdAt === cursor.afterCreatedAt && compareIds(session.id, cursor.afterId) > 0))
    : scoped;
  const sessions = after.slice(0, ARCHIVE_SESSION_PAGE_SIZE);
  const hasMore = after.length > sessions.length;
  const last = sessions.at(-1);
  const nextCursor = hasMore && anchor && last ? encodeCursor({
    ...anchor,
    afterCreatedAt: last.createdAt,
    afterId: last.id,
  }) : null;
  return {
    sessionIds: sessions.map((session) => session.id),
    snippets: Object.fromEntries(sessions.flatMap((session) => {
      const snippet = input.transcriptHits?.get(session.id);
      return snippet ? [[session.id, snippet]] : [];
    })),
    metadata: Object.fromEntries(sessions.map((session) => [session.id, metadata(session)])),
    nextCursor,
    hasMore,
    facets,
  };
}
