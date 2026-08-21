import { archiveRequiresStop, type SessionView } from "@wollipog/protocol";

type ArchiveActionSession = Pick<SessionView, "archiveStatus" | "archived" | "status">;

export function sessionArchiveRequiresStop(
  session: Pick<ArchiveActionSession, "archiveStatus" | "status">,
): boolean {
  return session.archiveStatus === "stop_pending" || archiveRequiresStop(session.status);
}

export function sessionArchiveActionLabel(session: ArchiveActionSession): "Archive" | "Archive and Stop" | "Unarchive" {
  if (session.archived) return "Unarchive";
  return sessionArchiveRequiresStop(session) ? "Archive and Stop" : "Archive";
}

export type SetSessionArchived = (sessionId: string, archived: boolean) => Promise<unknown>;

/** Apply an idempotent archive state to every exact id and report every rejected response. */
export async function setArchivedForSessions(
  sessionIds: readonly string[],
  archived: boolean,
  setArchived: SetSessionArchived,
): Promise<number> {
  const results = await Promise.allSettled(sessionIds.map((id) => setArchived(id, archived)));
  return results.filter((result) => result.status === "rejected").length;
}

/** A partial bulk archive is unsafe to leave implicit, so immediately compensate the whole set. */
export async function archiveSessionsWithCompensation(
  sessionIds: readonly string[],
  setArchived: SetSessionArchived,
): Promise<{ ok: true } | { ok: false; archiveFailures: number; rollbackFailures: number }> {
  const archiveFailures = await setArchivedForSessions(sessionIds, true, setArchived);
  if (archiveFailures === 0) return { ok: true };
  // Retry the inverse for every id: a rejected response can be ambiguous about whether it mutated.
  const rollbackFailures = await setArchivedForSessions(sessionIds, false, setArchived);
  return { ok: false, archiveFailures, rollbackFailures };
}
