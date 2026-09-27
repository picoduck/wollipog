import {
  queueHoldRecoveryAction,
  type SessionCommandPermissions,
  type SessionHoldView,
  type SessionView,
} from "@wollipog/protocol";

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

/** A hold's recovery advice written for the signed-in person (#1857). The control plane writes it
 * for them (#1867, #1875), but one that predates #1875 sends queue-hold advice as one copy for
 * every reader, naming Stop Job and restarting; when this client holds the session's queue hold and
 * the person's permissions, it rewrites that advice to name only what they may do, from the same
 * verdicts the server reads. Otherwise (an unknown session, or a control plane that predates
 * #1857's verdicts, marked by their absence) the advice is shown as written, as a worktree hold's
 * always is (#1867). */
export function holdRecoveryActionFor(
  hold: SessionHoldView,
  session: Pick<SessionView, "queueHold" | "commandPermissions"> | undefined,
): string {
  const queueHold = session?.queueHold;
  const permissions = session?.commandPermissions;
  if (!queueHold || permissions?.cancelTurn === undefined || queueHold.holdId !== hold.holdId ||
      hold.kind === "worktree_recovery") {
    return hold.recoveryAction;
  }
  return queueHoldRecoveryAction(queueHold, {
    canStopJobs: permissions.stopBackgroundJob.allowed,
    canRestart: permissions.restart.allowed,
  });
}
