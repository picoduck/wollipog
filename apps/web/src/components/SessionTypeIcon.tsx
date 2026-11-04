import { sessionRole, type SessionView } from "@wollipog/protocol";
import { OrchestratorIcon, ReviewSessionIcon } from "./Icons.js";

export type SessionTypeLabel = "Orchestrator Session" | "Review Session";

/**
 * What kind of session this is, or null for an ordinary one (#4076). It reads the CURRENT role, so a
 * completed conversion changes it; a session that omits `kind` is a standard one.
 */
export function sessionTypeLabel(session: Pick<SessionView, "role" | "permissionMode" | "kind">): SessionTypeLabel | null {
  if (sessionRole(session) === "orchestrator") return "Orchestrator Session";
  return session.kind === "review" ? "Review Session" : null;
}

/**
 * The 14px mark before a session's title in the Sessions list, on a Board card, in the session bar
 * and the Sessions preview, and on an Archived Sessions row (#4076). It encodes the type by shape
 * alone, in the muted secondary ink, so status keeps colour to itself. An ordinary session, the
 * common case, draws nothing. It sits inline at the start of the title, so the title's own ellipsis
 * truncates the text after it and the mark never shrinks or wraps.
 */
export function SessionTypeIcon({ session }: { session: Pick<SessionView, "role" | "permissionMode" | "kind"> }) {
  const label = sessionTypeLabel(session);
  if (!label) return null;
  const Glyph = label === "Orchestrator Session" ? OrchestratorIcon : ReviewSessionIcon;
  return (
    <span className="session-type-icon" role="img" aria-label={label} title={label}>
      <Glyph size={14} />
    </span>
  );
}
