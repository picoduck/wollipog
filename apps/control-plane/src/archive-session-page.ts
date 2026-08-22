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

export interface ArchiveSessionPage {
  sessions: SessionView[];
  snippets: Record<string, string>;
  nextCursor: string | null;
  hasMore: boolean;
  facets: { projects: string[]; locations: string[]; agents: string[] };
}

interface Cursor {
  version: 1;
  filterKey: string;
  anchorCreatedAt: number;
  anchorId: string;
  afterCreatedAt: number;
  afterId: string;
}

const STATUSES = new Set<SessionStatus>([
  "queued", "starting", "running", "input_required", "idle", "completed", "failed", "stopped",
]);

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeArchiveCursor(raw: string): Cursor | null {
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor>;
    if (value.version !== 1 || typeof value.filterKey !== "string" || value.filterKey.length > 2_048 ||
        !Number.isSafeInteger(value.anchorCreatedAt) || value.anchorCreatedAt! < 0 ||
        typeof value.anchorId !== "string" || !value.anchorId || value.anchorId.length > 512 ||
        !Number.isSafeInteger(value.afterCreatedAt) || value.afterCreatedAt! < 0 ||
        typeof value.afterId !== "string" || !value.afterId || value.afterId.length > 512) return null;
    return value as Cursor;
  } catch {
    return null;
  }
}

function lifecycleLabel(status: SessionStatus): string {
  return status === "input_required"
    ? "Input Required"
    : status.slice(0, 1).toLocaleUpperCase() + status.slice(1);
}

function metadata(session: SessionView, locationNames?: ReadonlyMap<string, string>) {
  const agent = session.driver === "codex-app-server"
    ? "Codex — Interactive"
    : session.driver === "codex"
      ? "Codex — Non-Interactive (codex exec)"
      : session.agentName ?? session.agentId ?? session.driver;
  return {
    project: session.projectName ?? (session.projectId ? "Unknown Project" : "No Project"),
    location: (session.projectLocationId ? locationNames?.get(session.projectLocationId) : undefined) ??
      session.workspaceName ?? session.workspaceId ?? "No Location",
    agent,
  };
}

function order(left: SessionView, right: SessionView): number {
  return right.createdAt - left.createdAt || left.id.localeCompare(right.id);
}

function tupleAtOrBelow(session: SessionView, createdAt: number, id: string): boolean {
  return session.createdAt < createdAt || (session.createdAt === createdAt && session.id.localeCompare(id) >= 0);
}

export function archiveSessionPage(input: {
  sessions: SessionView[];
  query: ArchiveSessionPageQuery;
  transcriptHits?: ReadonlyMap<string, string>;
  locationNames?: ReadonlyMap<string, string>;
}): ArchiveSessionPage | { error: string } {
  const archive = input.query.archive ?? "archived";
  const lifecycle = input.query.lifecycle ?? "all";
  if (!(["archived", "unarchived", "all"] as const).includes(archive)) return { error: "archive filter is invalid" };
  if (lifecycle !== "all" && !STATUSES.has(lifecycle)) return { error: "lifecycle filter is invalid" };
  const cursor = input.query.cursor ? decodeArchiveCursor(input.query.cursor) : null;
  if (input.query.cursor && !cursor) return { error: "cursor is invalid" };
  const filterKey = JSON.stringify({
    project: input.query.project ?? "",
    location: input.query.location ?? "",
    agent: input.query.agent ?? "",
    archive,
    lifecycle,
    q: (input.query.q ?? "").trim(),
  });
  if (cursor && cursor.filterKey !== filterKey) return { error: "cursor does not match filters" };

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
    const stopPending = session.archiveStatus === "stop_pending";
    if (archive === "archived" && !session.archived && !stopPending) return false;
    if (archive === "unarchived" && (session.archived || stopPending)) return false;
    if (lifecycle !== "all" && session.status !== lifecycle) return false;
    const item = metadata(session, input.locationNames);
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
    projects: [...new Set(facetsSource.map((session) => metadata(session, input.locationNames).project))].sort(),
    locations: [...new Set(facetsSource.map((session) => metadata(session, input.locationNames).location))].sort(),
    agents: [...new Set(facetsSource.map((session) => metadata(session, input.locationNames).agent))].sort(),
  };
  const after = cursor
    ? scoped.filter((session) => session.createdAt < cursor.afterCreatedAt ||
      (session.createdAt === cursor.afterCreatedAt && session.id.localeCompare(cursor.afterId) > 0))
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
    sessions,
    snippets: Object.fromEntries(sessions.flatMap((session) => {
      const snippet = input.transcriptHits?.get(session.id);
      return snippet ? [[session.id, snippet]] : [];
    })),
    nextCursor,
    hasMore,
    facets,
  };
}
