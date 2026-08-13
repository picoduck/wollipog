import { TERMINAL_STATUSES, type SessionStatus, type SessionView } from "@wollipog/protocol";

const TERMINAL_SESSION_STATUSES = new Set<SessionStatus>(TERMINAL_STATUSES);

export interface BoxLifecycleSession {
  id: string;
  title: string;
  status: SessionStatus;
}

/** Sessions whose runner-owned process or queued work would be interrupted by replacing the
 * supervised SSH tunnel. Idle/input-required sessions still own resumable process state and are
 * intentionally included; an operator may proceed only through the explicit force contract. */
export function blockingRunnerSessions(
  sessions: readonly Pick<SessionView, "id" | "runnerId" | "title" | "status">[],
  runnerId: string,
): BoxLifecycleSession[] {
  return sessions
    .filter((session) => session.runnerId === runnerId && !TERMINAL_SESSION_STATUSES.has(session.status))
    .map(({ id, title, status }) => ({ id, title, status }));
}

export function parseBoxLifecycleForce(body: unknown): { ok: true; force: boolean } | { ok: false; error: string } {
  if (body === null || body === undefined) return { ok: true, force: false };
  if (typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "request body must be an object" };
  const value = body as { force?: unknown };
  if (value.force !== undefined && typeof value.force !== "boolean") {
    return { ok: false, error: "force must be a boolean" };
  }
  return { ok: true, force: value.force === true };
}

export function boxLifecycleConflict(
  sessions: readonly BoxLifecycleSession[],
  action: "reconnect" | "update",
  visibleSessions: readonly BoxLifecycleSession[] = sessions,
) {
  const noun = sessions.length === 1 ? "session" : "sessions";
  return {
    error: `box has ${sessions.length} active ${noun}; ${action} would interrupt runner-owned work. Let it settle or retry with force=true`,
    code: "BOX_HAS_ACTIVE_SESSIONS",
    activeSessions: visibleSessions.slice(0, 20),
    activeSessionCount: sessions.length,
  } as const;
}

export function decideBoxLifecycle(
  sessions: readonly BoxLifecycleSession[],
  force: boolean,
  action: "reconnect" | "update",
  visibleSessions: readonly BoxLifecycleSession[] = sessions,
): { ok: true } | { ok: false; conflict: ReturnType<typeof boxLifecycleConflict> } {
  return force || sessions.length === 0
    ? { ok: true }
    : { ok: false, conflict: boxLifecycleConflict(sessions, action, visibleSessions) };
}

/** Apply the lifecycle gate to every runner session while limiting response details to the
 * requesting principal's session scope. Hidden sessions still block and contribute to the count. */
export function decideScopedBoxLifecycle(
  sessions: readonly Pick<SessionView, "id" | "runnerId" | "title" | "status">[],
  runnerId: string,
  force: boolean,
  action: "reconnect" | "update",
  canAccessSession: (sessionId: string) => boolean,
) {
  const activeSessions = blockingRunnerSessions(sessions, runnerId);
  const visibleSessions = activeSessions.filter((session) => canAccessSession(session.id));
  return decideBoxLifecycle(activeSessions, force, action, visibleSessions);
}
