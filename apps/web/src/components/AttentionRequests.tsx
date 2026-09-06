import { pendingRequests, sessionAttentionStatus, type SessionView } from "@wollipog/protocol";
import type { View } from "../navigation.js";
import { useEffect, useRef } from "react";

/** Navigation only: responses stay in the existing session/request boundary. */
export function AttentionRequests({ session, onNavigate, keyboardActive = true, onActivate }: {
  session: SessionView;
  onNavigate?: (view: View) => void;
  keyboardActive?: boolean;
  onActivate?: () => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!keyboardActive && detailsRef.current) detailsRef.current.open = false;
  }, [keyboardActive]);
  const requests = pendingRequests(session.pendingApproval);
  if (!onNavigate || requests.length === 0) return null;
  const open = (requestId?: string) => onNavigate({ name: "session", id: session.id,
    attention: { eventEpoch: session.eventEpoch ?? 0, ...(requestId === undefined ? {} : { requestId }) } });
  return <details ref={detailsRef} className="attention-requests" onClick={(event) => event.stopPropagation()}
    onFocusCapture={onActivate}
    onDoubleClick={(event) => event.stopPropagation()}
    onPointerDown={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      if (event.key === "Escape" && event.currentTarget.open) {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.open = false;
        event.currentTarget.querySelector("summary")?.focus();
      }
    }}>
    <summary tabIndex={keyboardActive ? 0 : -1}>{requests.length} {requests.length === 1 ? "Request" : "Requests"}</summary>
    <div className="attention-requests-picker" role="group" aria-label="Pending Requests">
      {requests.slice(0, 10).map((request, index) => <button type="button" className="btn sm"
        tabIndex={keyboardActive ? 0 : -1} key={request.requestId} onClick={() => open(request.requestId)}>
        Request {index + 1} · {sessionAttentionStatus({ status: session.status, pendingApproval: request })?.label ?? "Input Required"}
      </button>)}
      <button type="button" className="btn sm" tabIndex={keyboardActive ? 0 : -1} onClick={() => open()}>View All Requests</button>
    </div>
  </details>;
}
