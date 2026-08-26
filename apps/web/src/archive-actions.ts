import { archiveRequiresStop, type SessionView } from "@wollipog/protocol";

type ArchiveActionSession = Pick<SessionView, "archiveStatus" | "archived" | "status">;

export function sessionArchiveRequiresStop(
  session: Pick<ArchiveActionSession, "archiveStatus" | "status">,
  stopBeforeArchiveSupported: boolean,
): boolean {
  return session.archiveStatus === "stop_pending" || session.archiveStatus === "stop_failed" ||
    (stopBeforeArchiveSupported && archiveRequiresStop(session.status));
}

export function sessionArchiveActionLabel(session: ArchiveActionSession, stopBeforeArchiveSupported: boolean): "Archive" | "Archive and Stop" | "Retry Stop" | "Unarchive" {
  if (session.archived) return "Unarchive";
  if (session.archiveStatus === "stop_failed") return "Retry Stop";
  return sessionArchiveRequiresStop(session, stopBeforeArchiveSupported) ? "Archive and Stop" : "Archive";
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
): Promise<
  { ok: true; pendingSessionIds: string[]; failedSessionIds: string[] } |
  { ok: false; archiveFailures: number; rollbackFailures: number }
> {
  const results = await Promise.allSettled(sessionIds.map((id) => setArchived(id, true)));
  const archiveFailures = results.filter((result) => result.status === "rejected").length;
  if (archiveFailures === 0) {
    const statusIds = (status: "stop_pending" | "stop_failed") => sessionIds.filter((_id, index) => {
      const result = results[index];
      if (result?.status !== "fulfilled" || typeof result.value !== "object" || result.value === null) return false;
      return "archiveStatus" in result.value && result.value.archiveStatus === status;
    });
    return {
      ok: true,
      pendingSessionIds: statusIds("stop_pending"),
      failedSessionIds: statusIds("stop_failed"),
    };
  }
  // Retry the inverse for every id: a rejected response can be ambiguous about whether it mutated.
  const rollbackFailures = await setArchivedForSessions(sessionIds, false, setArchived);
  return { ok: false, archiveFailures, rollbackFailures };
}
