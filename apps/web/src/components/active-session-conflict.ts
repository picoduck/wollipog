import type { ApiError } from "../api.js";
import { statusMeta } from "../status-meta.js";
import type { ConfirmationDetailRow } from "./FeedbackProvider.js";

/** The active sessions a 409 refusal listed (`activeSessions`) and counted (`activeSessionCount`),
 * shaped for a force confirmation's detail rows. */
export interface ActiveSessionConflict {
  /** The server's count, or null when it sent none. */
  count: number | null;
  /** The sessions the server listed. */
  detailRows: ConfirmationDetailRow[];
  /** Sessions the server counted but did not list (beyond its limit, or not visible to this person). */
  detailRowsOverflow: number;
}

function normalizedSessionTitle(value: unknown): string {
  if (typeof value !== "string") return "Untitled Session";
  return value.replace(/\s+/g, " ").trim() || "Untitled Session";
}

export function activeSessionConflict(error: ApiError): ActiveSessionConflict {
  const count = typeof error.details?.activeSessionCount === "number" ? error.details.activeSessionCount : null;
  const detailRows: ConfirmationDetailRow[] = Array.isArray(error.details?.activeSessions)
    ? error.details.activeSessions
        .filter((session): session is { title?: unknown; status?: unknown } => !!session && typeof session === "object")
        .map((session) => ({
          label: normalizedSessionTitle(session.title),
          ...(typeof session.status === "string" ? { status: statusMeta("session", session.status) } : {}),
        }))
    : [];
  return {
    count,
    detailRows,
    detailRowsOverflow: count == null ? 0 : Math.max(0, count - detailRows.length),
  };
}
