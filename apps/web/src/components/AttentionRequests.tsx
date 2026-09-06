import { pendingRequests, sessionAttentionStatus, type SessionView } from "@wollipog/protocol";
import type { View } from "../navigation.js";

/** Navigation only: responses stay in the existing session/request boundary. */
export function AttentionRequests({ session, onNavigate }: {
  session: SessionView;
  onNavigate?: (view: View) => void;
}) {
  const requests = pendingRequests(session.pendingApproval);
  if (!onNavigate || requests.length === 0) return null;
  const open = (requestId?: string) => onNavigate({ name: "session", id: session.id,
    attention: { eventEpoch: session.eventEpoch ?? 0, ...(requestId === undefined ? {} : { requestId }) } });
  return <details className="attention-requests" onClick={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()}
    onPointerDown={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      // This navigation control must not invoke Inbox approval/row shortcuts.
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        event.currentTarget.open = false;
        event.currentTarget.querySelector("summary")?.focus();
      }
    }}>
    <summary>{requests.length} {requests.length === 1 ? "Request" : "Requests"}</summary>
    <div className="attention-requests-picker" aria-label="Pending Requests">
      {requests.slice(0, 10).map((request, index) => <button type="button" className="btn sm"
        key={request.requestId} onClick={() => open(request.requestId)}>
        Request {index + 1} · {sessionAttentionStatus({ status: session.status, pendingApproval: request })?.label ?? "Input Required"}
      </button>)}
      <button type="button" className="btn sm" onClick={() => open()}>View All Requests</button>
    </div>
  </details>;
}
