import { pendingRequests, prioritizedPendingRequests, type PendingApproval, type SessionView } from "@wollipog/protocol";

/** The sessions and campaigns an Assistant thread launched (#4664), in launch order. */
export interface LaunchedWork {
  sessionIds: readonly string[];
  campaignIds?: readonly string[];
}

/**
 * Where a launched session sits in the Launched Sessions panel (#4776): waiting on the owner first,
 * then still working, then everything that has stopped working. A session this browser has not loaded
 * yet counts as active, so it is never tucked away among the finished ones before anyone has seen it.
 */
export type LaunchedWorkGroup = "needsYou" | "active" | "finished";

const ACTIVE_STATUSES: ReadonlySet<SessionView["status"]> = new Set(["queued", "starting", "running", "input_required"]);

export function launchedWorkGroup(
  session: Pick<SessionView, "status" | "archived" | "pendingApproval"> | undefined,
): LaunchedWorkGroup {
  if (!session) return "active";
  if (session.archived) return "finished";
  if (prioritizedPendingRequests(session.pendingApproval).length > 0) return "needsYou";
  return ACTIVE_STATUSES.has(session.status) ? "active" : "finished";
}

/** Every launched id, sessions then campaigns, without repeats. */
export function launchedWorkIds(work: LaunchedWork): string[] {
  return [...new Set([...work.sessionIds, ...(work.campaignIds ?? [])])];
}

export interface LaunchedWorkGroups {
  /** Newest launch first within each group, so new work lands at the top of its group. */
  needsYou: string[];
  active: string[];
  finished: string[];
}

/**
 * `ids` sorted into their groups, given each id's group (`launchedWorkGroup` of its session) and when
 * it was launched (its session's `createdAt`). Sessions and campaigns arrive as two lists with no
 * shared order, so launch time orders them together. One not loaded yet has no time; it is most
 * likely the newest launch, so it leads. Ties keep the later position in `ids` first.
 */
export function groupLaunchedWork(
  ids: readonly string[],
  groupOf: (id: string, index: number) => LaunchedWorkGroup,
  launchedAt: (id: string, index: number) => number | undefined = () => undefined,
): LaunchedWorkGroups {
  const entries = ids.map((id, index) => ({ id, index, at: launchedAt(id, index) ?? Number.POSITIVE_INFINITY }));
  entries.sort((a, b) => b.at - a.at || b.index - a.index);
  const groups: LaunchedWorkGroups = { needsYou: [], active: [], finished: [] };
  for (const entry of entries) groups[groupOf(entry.id, entry.index)].push(entry.id);
  return groups;
}

/**
 * Whether a card's approval response is older than what the session stream already shows (#4776):
 * the store holds a pending request the response doesn't, other than the one just answered. The
 * response was read before that request was raised, so applying it would hide a request the control
 * plane still waits on; the stream carries the newer state instead. Requests are told apart by
 * occurrence. Without occurrences a request reusing the answered provider id can't be told from the
 * answered one, and the response applies as it always has.
 */
export function approvalResponseIsStale(
  current: Pick<SessionView, "pendingApproval"> | undefined,
  response: Pick<SessionView, "pendingApproval">,
  answered: Pick<PendingApproval, "requestId" | "occurrenceId">,
): boolean {
  if (!current) return false;
  const identity = (request: Pick<PendingApproval, "requestId" | "occurrenceId">) =>
    request.occurrenceId === undefined ? `request:${request.requestId}` : `occurrence:${request.occurrenceId}`;
  const known = new Set(pendingRequests(response.pendingApproval).map(identity));
  const answeredIdentity = identity(answered);
  return pendingRequests(current.pendingApproval).some((request) => {
    const id = identity(request);
    if (known.has(id) || id === answeredIdentity) return false;
    // An occurrence-less copy of the answered request is the answered request as far as we can tell.
    return !(request.occurrenceId === undefined && request.requestId === answered.requestId);
  });
}

/**
 * The thread header's toggle (#4776): "3 Sessions · 1 Needs You". The count of sessions waiting on
 * the owner is named only while there is one.
 */
export function launchedSessionsToggleLabel(counts: { total: number; needsYou: number }): string {
  const sessions = `${counts.total} ${counts.total === 1 ? "Session" : "Sessions"}`;
  return counts.needsYou > 0 ? `${sessions} · ${counts.needsYou} Needs You` : sessions;
}
