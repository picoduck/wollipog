import { useEffect, useMemo, useState, type ReactNode } from "react";
import { prioritizedPendingRequests, type PendingApproval, type SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { relativeTime } from "../format.js";
import { approvalOptionForIntent } from "../inbox.js";
import { sessionCommandRefusal } from "../session-command-permissions.js";
import { sessionDisplayTitle } from "../session-title.js";
import { sessionStatusSignal } from "../status-meta.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { useFeedback } from "./FeedbackProvider.js";
import { StatusBadge } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";

/**
 * The sessions an assistant thread launched, as live work cards (#4664). Each card reads its
 * session from the store, so its status follows the session stream as the work progresses, and
 * opens that session. A launched session waiting on a tool approval carries the approval inline
 * (Approve Once, Deny, Open Session); a question is answered in its session, which Open Session
 * opens on it.
 *
 * `confirmations` is the seam for owner confirmations bound to the thread itself (#4665): they are
 * drawn first, ahead of the work they would unblock, in their own list. Only the work cards scroll,
 * so an owner's action is never left at a scroll edge.
 */
export function AssistantWorkCards({ sessionIds, campaignIds, confirmations }: {
  sessionIds: readonly string[];
  campaignIds?: readonly string[];
  confirmations?: ReactNode;
}) {
  const ids = useMemo(() => campaignIds?.length ? [...sessionIds, ...campaignIds] : sessionIds, [sessionIds, campaignIds]);
  // Work waiting on the person comes first, so its approval is never the card scrolled out of view.
  const waiting = useStoreSelector((state) => ids.filter((id) => {
    const session = state.sessions.get(id);
    return session !== undefined && !session.archived && prioritizedPendingRequests(session.pendingApproval).length > 0;
  }).join("\n"));
  const ordered = useMemo(() => {
    const first = new Set(waiting ? waiting.split("\n") : []);
    return [...ids.filter((id) => first.has(id)), ...ids.filter((id) => !first.has(id))];
  }, [ids, waiting]);
  if (ids.length === 0 && !confirmations) return null;
  return (
    <section className="assistant-work" aria-label="Launched Work">
      {confirmations && <ul className="assistant-work-confirmations" aria-label="Approvals Needed">{confirmations}</ul>}
      {ordered.length > 0 && (
        <ul className="assistant-work-cards">
          {ordered.map((sessionId) => <AssistantWorkCard key={sessionId} sessionId={sessionId} campaign={campaignIds?.includes(sessionId)} />)}
        </ul>
      )}
    </section>
  );
}

function AssistantWorkCard({ sessionId, campaign }: { sessionId: string; campaign?: boolean }) {
  const session = useStoreSelector((state) => state.sessions.get(sessionId));
  const runnerOnline = useStoreSelector((state) => {
    const runnerId = session?.runnerId;
    return runnerId ? state.runners.get(runnerId)?.status === "online" : true;
  });
  const { navigate } = useStoreActions();
  const open = (requestId?: string) => navigate(requestId && session
    ? { name: "session", id: sessionId, attention: { eventEpoch: session.eventEpoch ?? 0, requestId } }
    : { name: "session", id: sessionId });
  if (!session) {
    // Launched, but not in this dashboard's snapshot yet: it can still be opened by id.
    return (
      <li className="assistant-work-card">
        <button type="button" className="assistant-work-open" onClick={() => open()}>
          <span className="assistant-work-title">{campaign ? "Launched Campaign" : "Launched Session"}</span>
          <span className="assistant-work-meta">Not loaded yet</span>
        </button>
      </li>
    );
  }
  const signal = sessionStatusSignal(session, { runnerOnline });
  const title = sessionDisplayTitle(session.title) || "Untitled Session";
  const request = session.archived ? undefined : prioritizedPendingRequests(session.pendingApproval)[0];
  return (
    <li className="assistant-work-card" data-needs-you={request ? "" : undefined}>
      <button type="button" className="assistant-work-open" onClick={() => open()} title={title}>
        <span className="assistant-work-line">
          <span className="assistant-work-title">{title}</span>
          {campaign && <StatusBadge label="Campaign" noDot />}
          <StatusBadge meta={signal.meta} />
        </span>
        <span className="assistant-work-meta">
          {session.agentName ? `${session.agentName} · ` : ""}{relativeTime(session.updatedAt)}
        </span>
      </button>
      {request && <WorkCardRequest session={session} requestId={request.requestId} onOpen={() => open(request.requestId)} />}
    </li>
  );
}

/** A launched session's waiting request, inline on its card: Approve Once / Deny / Open Session. */
function WorkCardRequest({ session, requestId, onOpen }: { session: SessionView; requestId: string; onOpen: () => void }) {
  const api = useApi();
  const { loadSession, beginSessionDetailLoad } = useStoreActions();
  const { showToast } = useFeedback();
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const listed = prioritizedPendingRequests(session.pendingApproval).find((candidate) => candidate.requestId === requestId);
  // The live list carries summary sessions, whose requests arrive without their options. The card
  // reads the session's detail once per request and keeps that request's options, so a later
  // summary upsert of the same request cannot take Approve Once and Deny away again.
  const [hydrated, setHydrated] = useState<PendingApproval | null>(null);
  const needsDetail = listed !== undefined && listed.options.length === 0 && listed.kind !== "question" &&
    hydrated?.requestId !== requestId;
  useEffect(() => {
    if (!needsDetail) return;
    const load = beginSessionDetailLoad(session.id);
    let current = true;
    void api.session(session.id).then(({ session: detail }) => {
      const match = prioritizedPendingRequests(detail.pendingApproval).find((candidate) => candidate.requestId === requestId);
      if (current && match) setHydrated(match);
      load.apply(detail);
    }, () => { /* The card still offers Open Session, where the request can be answered. */ })
      .finally(() => load.cancel());
    return () => { current = false; };
  }, [api, beginSessionDetailLoad, needsDetail, requestId, session.id]);
  const request = listed && listed.options.length === 0 && hydrated?.requestId === requestId ? hydrated : listed;
  if (!request) return null;
  // Only a request with exactly one once-only option per intent is decided from the card; anything
  // richer (a question, a choice of scopes) is answered in the session, where its context is.
  const approve = approvalOptionForIntent(request, "approve");
  const deny = approvalOptionForIntent(request, "deny");
  const refusal = sessionCommandRefusal(session, "respond");
  const decide = async (intent: "approve" | "deny") => {
    const option = intent === "approve" ? approve : deny;
    if (!option || busy) return;
    setBusy(intent);
    try {
      loadSession(await api.approve(session.id, { requestId: request.requestId, optionId: option.optionId }));
    } catch (cause) {
      showToast(intent === "approve" ? "Couldn't approve the request." : "Couldn't deny the request.", {
        tone: "error",
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="assistant-work-request">
      <p className="assistant-work-request-title">{request.title}</p>
      <div className="assistant-work-request-actions">
        {approve && deny && (
          <>
            <BusyButton className="btn sm primary" busy={busy === "approve"} progress="Approving…"
              disabled={busy !== null || refusal !== null} title={refusal ?? undefined}
              onClick={() => void decide("approve")}>
              Approve Once
            </BusyButton>
            <BusyButton className="btn sm" busy={busy === "deny"} progress="Denying…"
              disabled={busy !== null || refusal !== null} title={refusal ?? undefined}
              onClick={() => void decide("deny")}>
              Deny
            </BusyButton>
          </>
        )}
        <button type="button" className="btn sm ghost" onClick={onOpen}>Open Session</button>
      </div>
    </div>
  );
}
