import { prioritizedPendingRequests, type SessionView } from "@wollipog/protocol";

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

/** `ids` sorted into their groups, given each id's group (`launchedWorkGroup` of its session). */
export function groupLaunchedWork(ids: readonly string[], groupOf: (id: string, index: number) => LaunchedWorkGroup): LaunchedWorkGroups {
  const groups: LaunchedWorkGroups = { needsYou: [], active: [], finished: [] };
  for (let index = ids.length - 1; index >= 0; index--) groups[groupOf(ids[index]!, index)].push(ids[index]!);
  return groups;
}

/**
 * The thread header's toggle (#4776): "3 Sessions · 1 Needs You". The count of sessions waiting on
 * the owner is named only while there is one.
 */
export function launchedSessionsToggleLabel(counts: { total: number; needsYou: number }): string {
  const sessions = `${counts.total} ${counts.total === 1 ? "Session" : "Sessions"}`;
  return counts.needsYou > 0 ? `${sessions} · ${counts.needsYou} Needs You` : sessions;
}
