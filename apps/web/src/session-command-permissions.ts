import type { SessionCommandPermissions, SessionView } from "@wollipog/protocol";

/** Why the signed-in principal may not run `command` on this session (#1843), or null when it
 * may. A control plane that sends no permissions refuses nothing here, and the server still
 * decides. */
export function sessionCommandRefusal(
  session: Pick<SessionView, "commandPermissions">,
  command: keyof SessionCommandPermissions,
): string | null {
  const permission = session.commandPermissions?.[command];
  return permission && !permission.allowed ? permission.reason : null;
}

/** The refusal for a session's one archive action, which runs whichever command its label names:
 * Unarchive (or Unarchive and Restart) for an archived session, Retry Stop after an archive's Stop
 * failed, and otherwise Archive (or Archive and Stop). */
export function sessionArchiveActionRefusal(
  session: Pick<SessionView, "archived" | "archiveStatus" | "commandPermissions">,
): string | null {
  return sessionCommandRefusal(
    session,
    session.archived ? "unarchive" : session.archiveStatus === "stop_failed" ? "stop" : "archive",
  );
}
