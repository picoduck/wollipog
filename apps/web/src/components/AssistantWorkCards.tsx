import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { prioritizedPendingRequests, type PendingApproval, type SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import {
  groupLaunchedWork,
  launchedSessionsToggleLabel,
  launchedWorkGroup,
  launchedWorkIds,
  type LaunchedWork,
  type LaunchedWorkGroup,
  type LaunchedWorkGroups,
} from "../assistant-launched-work.js";
import { relativeTime } from "../format.js";
import { approvalOptionForIntent } from "../inbox.js";
import { sessionCommandRefusal } from "../session-command-permissions.js";
import { sessionDisplayTitle } from "../session-title.js";
import { sessionStatusSignal } from "../status-meta.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { useFeedback } from "./FeedbackProvider.js";
import { AssistantsIcon, ChevronRightIcon } from "./Icons.js";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";

const GROUP_CODES: Record<LaunchedWorkGroup, string> = { needsYou: "n", active: "a", finished: "f" };
const GROUP_OF_CODE: Record<string, LaunchedWorkGroup> = { n: "needsYou", a: "active", f: "finished" };

/**
 * A thread's launched work, grouped live from the store (#4776): each session's group follows its
 * stream, so the counts and the panel's order change as the work does. The selector returns one line
 * per id, its group code and launch time, so a stream update that moves no session between groups
 * re-renders nothing.
 */
export function useLaunchedWorkGroups(work: LaunchedWork): { ids: string[]; groups: LaunchedWorkGroups } {
  const ids = useMemo(() => launchedWorkIds(work), [work]);
  const lines = useStoreSelector((state) => ids.map((id) => {
    const session = state.sessions.get(id);
    return `${GROUP_CODES[launchedWorkGroup(session)]}${session?.createdAt ?? ""}`;
  }).join("\n"));
  const groups = useMemo(() => {
    const parsed = lines.split("\n");
    return groupLaunchedWork(
      ids,
      (_id, index) => GROUP_OF_CODE[parsed[index]?.charAt(0) ?? ""] ?? "active",
      (_id, index) => {
        const at = parsed[index]?.slice(1);
        return at ? Number(at) : undefined;
      },
    );
  }, [ids, lines]);
  return { ids, groups };
}

/**
 * What a thread is waiting on its owner for, in the thread header where a closed panel never hides it
 * (#4665, #4776): the owner confirmations bound to the thread itself first, ahead of the work they
 * would unblock, then each launched session waiting on an approval or a question, as its work card
 * with the approval inline. `showSessions` is false while the Launched Sessions panel shows those
 * cards itself, so the same approval is never offered twice on one screen.
 *
 * A card leaves once its session stops waiting, Approve Once's own card included. When focus was in
 * one that left, it moves to the header's Launched Sessions toggle, where that session now is,
 * rather than dropping to the page.
 */
export function AssistantWaitingWork({ work, confirmations, showSessions }: {
  work: LaunchedWork;
  confirmations?: ReactNode;
  showSessions: boolean;
}) {
  const { groups } = useLaunchedWorkGroups(work);
  const waiting = showSessions ? groups.needsYou : [];
  const campaigns = useMemo(() => new Set(work.campaignIds ?? []), [work.campaignIds]);
  const sectionRef = useRef<HTMLElement | null>(null);
  // Whether focus was last inside this region. A removed element takes focus with it without a blur
  // that names where focus went, so only a blur to somewhere else clears it.
  const focusWithin = useRef(false);
  const waitingKey = waiting.join("\n");
  useLayoutEffect(() => {
    if (!focusWithin.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && sectionRef.current?.contains(active)) return;
    focusWithin.current = false;
    if (active && active !== document.body) return;
    document.querySelector<HTMLElement>(".assistant-thread-head .assistant-launched-toggle")?.focus();
  }, [waitingKey]);
  if (waiting.length === 0 && !confirmations) return null;
  return (
    <section
      ref={sectionRef}
      className="assistant-work"
      aria-label="Waiting for You"
      onFocus={() => { focusWithin.current = true; }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && !event.currentTarget.contains(next)) focusWithin.current = false;
      }}
    >
      {confirmations && <ul className="assistant-work-confirmations" aria-label="Approvals Needed">{confirmations}</ul>}
      {waiting.length > 0 && (
        <ul className="assistant-work-cards" aria-label="Sessions Waiting for You">
          {waiting.map((sessionId) => <AssistantWorkCard key={sessionId} sessionId={sessionId} campaign={campaigns.has(sessionId)} />)}
        </ul>
      )}
    </section>
  );
}

/**
 * The thread header's Launched Sessions toggle (#4776): the live counts, "3 Sessions · 1 Needs You",
 * opening and closing the panel. Hidden until the thread has launched something.
 */
export function LaunchedSessionsToggle({ work, open, onToggle }: {
  work: LaunchedWork;
  open: boolean;
  onToggle: () => void;
}) {
  const { ids, groups } = useLaunchedWorkGroups(work);
  if (ids.length === 0) return null;
  const needsYou = groups.needsYou.length;
  return (
    <button
      type="button"
      className="btn sm assistant-launched-toggle"
      data-needs-you={needsYou > 0 ? "" : undefined}
      aria-expanded={open}
      aria-controls={open ? "right-panel" : undefined}
      title={open ? "Hide Launched Sessions" : "Show Launched Sessions"}
      onClick={onToggle}
    >
      {launchedSessionsToggleLabel({ total: ids.length, needsYou })}
    </button>
  );
}

/**
 * The side panel's Launched Sessions tool (#4776): every session the thread launched, those waiting
 * on the owner first, then those still working, then the finished ones in a group that folds away.
 * The list scrolls inside the panel, so the conversation keeps its height however many there are.
 * Finished work starts folded while anything else is listed, and open when it is all there is.
 * `beforeOpen` runs before a card opens its session: a phone closes its sheet, which would otherwise
 * cover the session it opened.
 */
export function LaunchedSessionsPanel({ work, beforeOpen }: { work: LaunchedWork; beforeOpen?: () => void }) {
  const { ids, groups } = useLaunchedWorkGroups(work);
  const campaigns = useMemo(() => new Set(work.campaignIds ?? []), [work.campaignIds]);
  const onlyFinished = groups.needsYou.length === 0 && groups.active.length === 0;
  const [finishedOpen, setFinishedOpen] = useState<boolean | null>(null);
  const showFinished = finishedOpen ?? onlyFinished;
  const finishedId = useId();
  if (ids.length === 0) {
    return (
      <State compact icon={<AssistantsIcon />} title="No Sessions Launched Yet">
        Sessions the assistant starts for this thread appear here.
      </State>
    );
  }
  const cards = (list: readonly string[]) => (
    <ul className="launched-sessions-cards">
      {list.map((sessionId) => (
        <AssistantWorkCard key={sessionId} sessionId={sessionId} campaign={campaigns.has(sessionId)} beforeOpen={beforeOpen} />
      ))}
    </ul>
  );
  return (
    <div className="launched-sessions">
      {groups.needsYou.length > 0 && (
        <section className="launched-sessions-group" aria-label="Needs You">
          <h3 className="group-label">Needs You<span className="count">{groups.needsYou.length}</span></h3>
          {cards(groups.needsYou)}
        </section>
      )}
      {groups.active.length > 0 && (
        <section className="launched-sessions-group" aria-label="Active">
          <h3 className="group-label">Active<span className="count">{groups.active.length}</span></h3>
          {cards(groups.active)}
        </section>
      )}
      {groups.finished.length > 0 && (
        <section className="launched-sessions-group" aria-label="Finished">
          <h3 className="launched-sessions-fold">
            <button
              type="button"
              className="disclosure-trigger"
              aria-expanded={showFinished}
              aria-controls={showFinished ? finishedId : undefined}
              onClick={() => setFinishedOpen(!showFinished)}
            >
              <ChevronRightIcon className="disclosure-chevron" aria-hidden="true" />
              Finished<span className="count">{groups.finished.length}</span>
            </button>
          </h3>
          {showFinished && <div id={finishedId}>{cards(groups.finished)}</div>}
        </section>
      )}
    </div>
  );
}

function AssistantWorkCard({ sessionId, campaign, beforeOpen }: { sessionId: string; campaign?: boolean; beforeOpen?: () => void }) {
  const session = useStoreSelector((state) => state.sessions.get(sessionId));
  const runnerOnline = useStoreSelector((state) => {
    const runnerId = session?.runnerId;
    return runnerId ? state.runners.get(runnerId)?.status === "online" : true;
  });
  const { navigate } = useStoreActions();
  const open = (requestId?: string) => {
    beforeOpen?.();
    navigate(requestId && session
      ? { name: "session", id: sessionId, attention: { eventEpoch: session.eventEpoch ?? 0, requestId } }
      : { name: "session", id: sessionId });
  };
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
