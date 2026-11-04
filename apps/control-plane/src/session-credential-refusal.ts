import { extractBearer, hashToken } from "./auth.js";
import { WOLLIPOG_AGENT_ACTOR_SESSION_HEADER } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";

/** Diagnostic only, after authentication has refused. Never grants access or trusts an actor
 * header alone. Log only the bounded reason, never headers, tokens, hashes or session ids. */
export function sessionCredentialRefusal(
  headers: { authorization?: string; [key: string]: unknown },
  db: Pick<ControlPlaneDb, "getSession" | "agentControlCredentialValid" | "sessionStopProvenance">,
): { reason: string; error?: string } | null {
  const claimed = headers[WOLLIPOG_AGENT_ACTOR_SESSION_HEADER];
  if (typeof claimed !== "string" || !claimed || claimed.length > 256) return null;
  const bearer = extractBearer(headers.authorization);
  const session = db.getSession(claimed);
  if (!session || !bearer || !db.agentControlCredentialValid(session.id, session.runnerId, hashToken(bearer))) {
    return { reason: "unknown_credential" };
  }
  const stop = db.sessionStopProvenance(session.id);
  if (session.status === "stopped" && stop?.cause === "runner_disconnect" && !stop.confirmation) {
    return { reason: "runner_reconnecting", error: "session agent credential refused: runner reconnecting; retry after the runner reconnects; if it does not recover, ask the Orchestrator to check the runner connection" };
  }
  if (session.status === "stopped") {
    return { reason: "session_stopped", error: "session agent credential refused: session stopped; ask the Orchestrator to restart the session" };
  }
  return { reason: "session_unavailable", error: "session agent credential refused: this request is unavailable to the session credential; check the requested operation, session state and delegated access with the Orchestrator" };
}
