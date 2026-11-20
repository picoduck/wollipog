import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FocusEvent, type ReactNode } from "react";
import { pendingRequests, prioritizedPendingRequests, type PendingApproval, type SessionView } from "@wollipog/protocol";
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
 * Keeps keyboard focus when the control holding it leaves a list of cards (#4776). A card is drawn
 * again elsewhere when its session changes group or leaves the header for the panel, and a card's own
 * request actions leave when that request is answered while another keeps the card waiting. Either
 * way the focused element is removed. If focus was last inside the list and the page now has none,
 * `recover` gets the session whose card last held focus and the list, and returns where focus goes.
 * The check runs after each change named by `changeKey`, which can remove the list itself, and after
 * any removal inside the list, which a card's own render makes. A removed element takes focus
 * without a blur naming where it went, so only a blur to somewhere else clears the record.
 */
function useFocusRecovery<T extends HTMLElement>(
  changeKey: string,
  recover: (sessionId: string | null, list: T | null) => HTMLElement | null | undefined,
) {
  const ref = useRef<T | null>(null);
  const within = useRef(false);
  const lastSession = useRef<string | null>(null);
  const recoverRef = useRef(recover);
  recoverRef.current = recover;
  const check = useRef(() => {
    if (!within.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) {
      if (!ref.current?.contains(active)) within.current = false;
      return;
    }
    within.current = false;
    recoverRef.current(lastSession.current, ref.current)?.focus();
  }).current;
  useLayoutEffect(check, [changeKey, check]);
  // The list element comes and goes (the header's region renders only while something waits), so the
  // observer follows whichever element the ref holds after each render.
  const observed = useRef<{ element: T; observer: MutationObserver } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (observed.current?.element === element) return;
    observed.current?.observer.disconnect();
    observed.current = null;
    if (!element) return;
    const observer = new MutationObserver((records) => {
      if (records.some((record) => record.removedNodes.length > 0)) check();
    });
    observer.observe(element, { childList: true, subtree: true });
    observed.current = { element, observer };
  });
  // Cleared as well as disconnected, so a remount of the same element (Strict Mode replays effects)
  // observes it again rather than finding it already recorded.
  useEffect(() => () => {
    observed.current?.observer.disconnect();
    observed.current = null;
  }, []);
  return {
    ref,
    onFocus: (event: FocusEvent<T>) => {
      within.current = true;
      lastSession.current = event.target.closest("[data-session-id]")?.getAttribute("data-session-id") ?? null;
    },
    onBlur: (event: FocusEvent<T>) => {
      const next = event.relatedTarget;
      if (next instanceof Node && !event.currentTarget.contains(next)) within.current = false;
    },
  };
}

/** Where focus lands on a session's card in `list`: its request's last action (Open Session) while
 * it still shows one, else the card itself. */
function cardFocusTarget(list: HTMLElement | null, sessionId: string | null): HTMLElement | null {
  if (!list || !sessionId) return null;
  const card = list.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(sessionId)}"]`);
  return card?.querySelector<HTMLElement>(".assistant-work-request-actions > button:last-child")
    ?? card?.querySelector<HTMLElement>(".assistant-work-open") ?? null;
}

/**
 * A card's answer to a request, by session and request occurrence (#4776): Approve Once or Deny in
 * flight, then `answered` once the control plane accepted it. A card is a separate mount in the
 * header and in the panel, so the answer outlives the card: the same request's card elsewhere keeps
 * both actions disabled and never sends a second answer.
 *
 * The card never applies the answer's response. The control plane publishes the answered session on
 * the session stream, which the cards follow for everything else, while a response read earlier or
 * later than another change can't be ordered against the stream and could hide a newer request or
 * restore an answered one.
 *
 * The response only decides whether the actions stay disabled meanwhile. They do when it no longer
 * lists the request and the store still holds the session exactly as it was when the answer was
 * clicked (`against`): the stream hasn't caught up, and its next session is the answer's own. Any
 * later session is the stream's word, and whatever it lists is answerable. A response that still
 * lists the request (an authentication Retry, which the runner may raise again under the same id)
 * leaves it answerable at once. An answer is kept only while some card shows its request, so the
 * record never outlives the cards. A provider may reuse a request id for a new request, so the key
 * is the occurrence where there is one.
 */
type ResponseState =
  | { state: "approve" | "deny" }
  | { state: "answered"; against: SessionView | undefined };
const respondingTo = new Map<string, ResponseState>();
const respondingListeners = new Set<() => void>();
function setResponding(key: string, state: ResponseState | null) {
  if (state) respondingTo.set(key, state);
  else respondingTo.delete(key);
  for (const listener of respondingListeners) listener();
}
function subscribeResponding(listener: () => void) {
  respondingListeners.add(listener);
  return () => { respondingListeners.delete(listener); };
}
/** How many mounted cards show each request. */
const respondingReaders = new Map<string, number>();
function useResponding(key: string): ResponseState | null {
  useEffect(() => {
    respondingReaders.set(key, (respondingReaders.get(key) ?? 0) + 1);
    return () => {
      const left = (respondingReaders.get(key) ?? 1) - 1;
      if (left > 0) {
        respondingReaders.set(key, left);
        return;
      }
      respondingReaders.delete(key);
      // A card moving between the header and the panel unmounts and mounts in one commit; only an
      // answer no card picked up again is dropped. One still in flight settles on its own.
      queueMicrotask(() => {
        if (!respondingReaders.has(key) && respondingTo.get(key)?.state === "answered") setResponding(key, null);
      });
    };
  }, [key]);
  return useSyncExternalStore(subscribeResponding, () => respondingTo.get(key) ?? null);
}
function requestKey(sessionId: string, request: Pick<PendingApproval, "requestId" | "occurrenceId">): string {
  return `${sessionId}\n${request.occurrenceId ?? request.requestId}`;
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
 * rather than dropping to the page; a card that stays, waiting on another request, keeps it.
 */
export function AssistantWaitingWork({ work, confirmations, showSessions }: {
  work: LaunchedWork;
  confirmations?: ReactNode;
  showSessions: boolean;
}) {
  const { groups } = useLaunchedWorkGroups(work);
  const waiting = showSessions ? groups.needsYou : [];
  const campaigns = useMemo(() => new Set(work.campaignIds ?? []), [work.campaignIds]);
  const focus = useFocusRecovery<HTMLElement>(waiting.join("\n"), (sessionId, list) => cardFocusTarget(list, sessionId)
    ?? document.querySelector<HTMLElement>(".assistant-thread-head .assistant-launched-toggle"));
  if (waiting.length === 0 && !confirmations) return null;
  return (
    <section ref={focus.ref} className="assistant-work" aria-label="Waiting for You" onFocus={focus.onFocus} onBlur={focus.onBlur}>
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
 * `beforeOpen` runs before a card opens its session: a panel covering the conversation closes, so it
 * doesn't cover the session it opened.
 *
 * When a card changes group, answering its approval for example, focus follows it to its new place;
 * in a folded Finished group it lands on Finished, and otherwise on the panel's tool switcher.
 */
export function LaunchedSessionsPanel({ work, beforeOpen }: { work: LaunchedWork; beforeOpen?: () => void }) {
  const { ids, groups } = useLaunchedWorkGroups(work);
  const campaigns = useMemo(() => new Set(work.campaignIds ?? []), [work.campaignIds]);
  const onlyFinished = groups.needsYou.length === 0 && groups.active.length === 0;
  const [finishedOpen, setFinishedOpen] = useState<boolean | null>(null);
  const showFinished = finishedOpen ?? onlyFinished;
  const finishedId = useId();
  const focus = useFocusRecovery<HTMLDivElement>(
    `${groups.needsYou.join(",")}|${groups.active.join(",")}|${groups.finished.join(",")}|${showFinished}`,
    (sessionId, list) => cardFocusTarget(list, sessionId)
      ?? list?.querySelector<HTMLElement>(".launched-sessions-fold .disclosure-trigger")
      ?? document.querySelector<HTMLElement>("#right-panel .rpanel-switcher"),
  );
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
    <div ref={focus.ref} className="launched-sessions" onFocus={focus.onFocus} onBlur={focus.onBlur}>
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
      <li className="assistant-work-card" data-session-id={sessionId}>
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
    <li className="assistant-work-card" data-session-id={sessionId} data-needs-you={request ? "" : undefined}>
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
      {request && (
        // Keyed by occurrence: a new request reusing the provider's id starts with nothing carried over.
        <WorkCardRequest key={request.occurrenceId ?? request.requestId} session={session} requestId={request.requestId}
          onOpen={() => open(request.requestId)} />
      )}
    </li>
  );
}

/** A launched session's waiting request, inline on its card: Approve Once / Deny / Open Session. */
function WorkCardRequest({ session, requestId, onOpen }: { session: SessionView; requestId: string; onOpen: () => void }) {
  const api = useApi();
  const { beginSessionDetailLoad, getSession } = useStoreActions();
  const { showToast } = useFeedback();
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
  const respondingKey = requestKey(session.id, listed ?? { requestId });
  const entry = useResponding(respondingKey);
  // Drop an answer the stream has moved past, now that it no longer holds anything.
  useEffect(() => {
    const current = respondingTo.get(respondingKey);
    if (current?.state === "answered" && current.against !== session) setResponding(respondingKey, null);
  }, [respondingKey, session]);
  // An answer the stream has moved past no longer holds the request (see `ResponseState`).
  const answer = entry?.state === "answered" && entry.against !== session ? null : entry?.state ?? null;
  if (!request) return null;
  // Only a request with exactly one once-only option per intent is decided from the card; anything
  // richer (a question, a choice of scopes) is answered in the session, where its context is.
  const approve = approvalOptionForIntent(request, "approve");
  const deny = approvalOptionForIntent(request, "deny");
  const refusal = sessionCommandRefusal(session, "respond");
  const decide = async (intent: "approve" | "deny") => {
    const option = intent === "approve" ? approve : deny;
    const key = respondingKey;
    if (!option || respondingTo.has(key)) return;
    const clicked = session;
    setResponding(key, { state: intent });
    try {
      const updated = await api.approve(session.id, { requestId: request.requestId, optionId: option.optionId });
      const cleared = !pendingRequests(updated.pendingApproval).some((candidate) => requestKey(session.id, candidate) === key);
      // The stream brings the answered session. Until then, with nothing newer in the store, the
      // request stays answered; otherwise it is the stream's to show (see `ResponseState`).
      const behind = cleared && getSession(session.id) === clicked && respondingReaders.has(key);
      setResponding(key, behind ? { state: "answered", against: clicked } : null);
    } catch (cause) {
      setResponding(key, null);
      showToast(intent === "approve" ? "Couldn't approve the request." : "Couldn't deny the request.", {
        tone: "error",
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };
  return (
    <div className="assistant-work-request">
      <p className="assistant-work-request-title">{request.title}</p>
      <div className="assistant-work-request-actions">
        {approve && deny && (
          <>
            <BusyButton className="btn sm primary" busy={answer === "approve"} progress="Approving…"
              disabled={answer !== null || refusal !== null} title={refusal ?? undefined}
              onClick={() => void decide("approve")}>
              Approve Once
            </BusyButton>
            <BusyButton className="btn sm" busy={answer === "deny"} progress="Denying…"
              disabled={answer !== null || refusal !== null} title={refusal ?? undefined}
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
