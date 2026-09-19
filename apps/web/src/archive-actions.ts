import { archiveRequiresStop, type SessionView } from "@wollipog/protocol";

type ArchiveActionSession = Pick<SessionView, "archiveStatus" | "archived" | "status"> &
  Partial<Pick<SessionView, "stopOperation">>;

/** An archived session is restored with one preflighted Unarchive and Restart only when the control
 * plane owns that operation. Stop Pending and Stop Failed keep their Stop recovery path first, and an
 * older control plane keeps the plain Unarchive: two client requests would not be atomic. */
export function sessionUnarchiveRestarts(
  session: ArchiveActionSession,
  unarchiveAndRestartSupported: boolean,
): boolean {
  return unarchiveAndRestartSupported && session.archived && !session.archiveStatus &&
    session.stopOperation?.status !== "stop_failed";
}

export function sessionArchiveRequiresStop(
  session: Pick<ArchiveActionSession, "archiveStatus" | "status">,
  stopBeforeArchiveSupported: boolean,
): boolean {
  return session.archiveStatus === "stop_pending" || session.archiveStatus === "stop_failed" ||
    (stopBeforeArchiveSupported && archiveRequiresStop(session.status));
}

export function sessionArchiveActionLabel(
  session: ArchiveActionSession,
  stopBeforeArchiveSupported: boolean,
  unarchiveAndRestartSupported = false,
): "Archive" | "Archive and Stop" | "Retry Stop" | "Unarchive" | "Unarchive and Restart" {
  if (session.archived) {
    return sessionUnarchiveRestarts(session, unarchiveAndRestartSupported) ? "Unarchive and Restart" : "Unarchive";
  }
  if (session.archiveStatus === "stop_failed") return "Retry Stop";
  return sessionArchiveRequiresStop(session, stopBeforeArchiveSupported) ? "Archive and Stop" : "Archive";
}

/** The server refuses Unarchive and Restart with a 4xx only from its preflight, before the archive
 * flag changes, so the session is known to be archived still. Anything else (a dropped connection,
 * a gateway error) is ambiguous and must be reconciled against the server, never assumed. */
export function unarchiveAndRestartFailureMessage(cause: unknown): { message: string; ambiguous: boolean } {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const status = typeof cause === "object" && cause !== null && "status" in cause ? (cause as { status: unknown }).status : null;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return { message: `Could not unarchive and restart session: ${detail}. The session is still archived.`, ambiguous: false };
  }
  return {
    message: `Could not confirm Unarchive and Restart: ${detail}. Reloading the current session state.`,
    ambiguous: true,
  };
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
