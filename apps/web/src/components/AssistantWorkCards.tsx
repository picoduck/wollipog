import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode } from "react";
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
import { formatUsd } from "../guardrail-values.js";
import { relativeTime } from "../format.js";
import { approvalOptionForIntent } from "../inbox.js";
import { sessionCommandRefusal } from "../session-command-permissions.js";
import { sessionDisplayTitle } from "../session-title.js";
import { sessionStatusSignal } from "../status-meta.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { useFeedback } from "./FeedbackProvider.js";
import { AssistantsIcon, ChevronRightIcon, SearchIcon } from "./Icons.js";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";
import { sessionAgentLabel } from "./agent-options.js";
import { campaignFact } from "../session-tools.js";
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
 * again elsewhere when its session changes group, a header card leaves once its session stops
 * waiting, and a card's own request actions leave when that request is answered while another keeps
 * the card waiting. Either
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
 * What a thread is waiting on its owner for, in the thread header where a closed panel never hides it
 * (#4665, #4776): the owner confirmations bound to the thread itself first, ahead of the work they
 * would unblock, then each launched session waiting on an approval or a question, as its work card
 * with the approval inline. This is the one place a launched session's request is answered from the
 * thread: the Work tab links to the same requests, so a card being
 * answered never moves between surfaces, whether the panel is open or not.
 *
 * A card leaves once its session stops waiting, Approve Once's own card included. When focus was in
 * one that left, it moves to the header's Launched Sessions toggle, where that session now is,
 * rather than dropping to the page; a card that stays, waiting on another request, keeps it.
 */
export function AssistantWaitingWork({ work, confirmations }: {
  work: LaunchedWork;
  confirmations?: ReactNode;
}) {
  const { groups } = useLaunchedWorkGroups(work);
  const waiting = groups.needsYou;
  const campaigns = useMemo(() => new Set(work.campaignIds ?? []), [work.campaignIds]);
  const focus = useFocusRecovery<HTMLElement>(waiting.join("\n"), (sessionId, list) => cardFocusTarget(list, sessionId)
    // The thread's one Launched Sessions toggle: in its bar on desktop, under its facts on a phone.
    ?? document.querySelector<HTMLElement>(".assistant-launched-toggle"));
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

/** Stable request identity for Review. The thread's request surface owns the focus target. */
export function focusAssistantWorkRequest(sessionId: string, request: PendingApproval) {
  const requestKey = request.occurrenceId ?? request.requestId;
  const selector = `[data-session-id="${CSS.escape(sessionId)}"] [data-assistant-work-request="${CSS.escape(requestKey)}"]`;
  document.querySelector<HTMLElement>(selector)?.focus();
}

export function AssistantWorkPanel({ work, beforeReview }: { work: LaunchedWork; beforeReview: () => void }) {
  const { ids, groups } = useLaunchedWorkGroups(work);
  const [query, setQuery] = useState("");
  const [finishedOpen, setFinishedOpen] = useState<boolean | null>(null);
  const finishedId = useId();
  const needle = query.trim().toLowerCase();
  const matches = useStoreSelector((state) => !needle ? "" : ids.filter((id) => {
    const session = state.sessions.get(id);
    return session && [sessionDisplayTitle(session.title), sessionAgentLabel(session.agentName, session.driver, session.agentId)]
      .some((text) => text.toLowerCase().includes(needle));
  }).join("\n"));
  const listed = new Set(matches ? matches.split("\n") : []);
  const filtered = (group: readonly string[]) => needle ? group.filter((id) => listed.has(id)) : group;
  const waiting = filtered(groups.needsYou);
  const running = filtered(groups.active);
  const finished = filtered(groups.finished);
  const failed = useStoreSelector((state) => finished.filter((id) => state.sessions.get(id)?.status === "failed").length);
  const showFinished = finishedOpen ?? (needle !== "" && finished.length > 0);
  const focus = useFocusRecovery<HTMLDivElement>(
    `${waiting.join(",")}|${running.join(",")}|${finished.join(",")}|${showFinished}`,
    (sessionId, list) => cardFocusTarget(list, sessionId)
      ?? list?.querySelector<HTMLElement>(".launched-sessions-fold .disclosure-trigger")
      ?? document.querySelector<HTMLElement>('#right-panel [aria-selected="true"]'),
  );
  if (ids.length === 0) {
    return <State compact icon={<AssistantsIcon />} title="No Sessions Launched Yet">
      Sessions the assistant starts for this thread appear here.
    </State>;
  }
  const rows = (list: readonly string[]) => (
    <ul className="launched-sessions-rows">
      {list.map((sessionId) => <AssistantWorkRow key={sessionId} sessionId={sessionId}
        campaign={work.campaignIds?.includes(sessionId)} beforeReview={beforeReview} />)}
    </ul>
  );
  return (
    <div ref={focus.ref} className="launched-sessions" onFocus={focus.onFocus} onBlur={focus.onBlur}>
      {ids.length > 10 && <label className="input-affix">
        <span className="input-affix-text" aria-hidden="true"><SearchIcon size={14} /></span>
        <input type="search" aria-label="Filter Launched Work" placeholder="Filter launched work"
          value={query} onChange={(event) => { setQuery(event.currentTarget.value); setFinishedOpen(null); }} />
      </label>}
      {waiting.length > 0 && (
        <section className="launched-sessions-group" aria-label="Needs You">
          <h3 className="group-label">Needs You <span className="count">{waiting.length}</span></h3>
          {rows(waiting)}
        </section>
      )}
      {running.length > 0 && (
        <section className="launched-sessions-group" aria-label="Running">
          <h3 className="group-label">Running <span className="count">{running.length}</span></h3>
          {rows(running)}
        </section>
      )}
      {finished.length > 0 && (
        <section className="launched-sessions-group" aria-label="Finished">
          <h3 className="launched-sessions-fold">
            <button type="button" className="disclosure-trigger" aria-expanded={showFinished}
              aria-controls={finishedId} onClick={() => setFinishedOpen(!showFinished)}>
              <ChevronRightIcon className="disclosure-chevron" aria-hidden="true" />
              Finished <span className="count">{finished.length} · {failed} Failed</span>
            </button>
          </h3>
          <div id={finishedId} hidden={!showFinished}>{showFinished && rows(finished)}</div>
        </section>
      )}
      {waiting.length + running.length + finished.length === 0 && <State compact variant="no-results" title="No Matching Work" />}
    </div>
  );
}

function AssistantWorkRow({ sessionId, campaign, beforeReview }: {
  sessionId: string;
  campaign?: boolean;
  beforeReview: () => void;
}) {
  const session = useStoreSelector((state) => state.sessions.get(sessionId));
  const runnerOnline = useStoreSelector((state) => state.runners.get(session?.runnerId ?? "")?.status === "online");
  const { navigate } = useStoreActions();
  const request = session?.archived ? undefined : prioritizedPendingRequests(session?.pendingApproval)[0];
  const title = (session && sessionDisplayTitle(session.title)) || (campaign ? "Launched Campaign" : "Launched Session");
  const signal = session && sessionStatusSignal(session, { runnerOnline });
  const progress = session?.orchestratorCampaign?.work;
  return (
    <li className="assistant-work-row" data-session-id={sessionId}>
      <button type="button" className="assistant-work-open" title={title}
        onClick={() => navigate({ name: "session", id: sessionId })}>
        <span className="assistant-work-line">
          {signal && <StatusBadge inline meta={signal.meta} label="" title={signal.meta.label} ariaLabel={signal.meta.label} />}
          <span className="assistant-work-title">{title}</span>
          {campaign && <StatusBadge label="Campaign" noDot />}
        </span>
        <span className="assistant-work-meta">{session
          ? `${sessionAgentLabel(session.agentName, session.driver, session.agentId)} · ${relativeTime(session.createdAt)} · ${formatUsd(session.costUsd + (session.liveUsage?.costUsd ?? 0))}`
          : "Not loaded yet"}</span>
        {campaign && <span className="assistant-work-meta">{progress ? campaignFact(progress) : "Progress unavailable"}</span>}
      </button>
      {request && <div className="assistant-work-review">
        <p className="assistant-work-request-title" title={request.title}>{request.title}</p>
        <button type="button" className="btn" onClick={() => {
          beforeReview();
          focusAssistantWorkRequest(sessionId, request);
        }}>Review</button>
      </div>}
    </li>
  );
}

/**
 * A launched session waiting on its owner. Its inline card opens the session and offers the
 * request's once-only options when available.
 */
function AssistantWorkCard({ sessionId, campaign }: {
  sessionId: string;
  campaign?: boolean;
}) {
  const session = useStoreSelector((state) => state.sessions.get(sessionId));
  const runnerOnline = useStoreSelector((state) => {
    const runnerId = session?.runnerId;
    return runnerId ? state.runners.get(runnerId)?.status === "online" : true;
  });
  const { navigate } = useStoreActions();
  const open = (requestId?: string) => {
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
    <div className="assistant-work-request" data-assistant-work-request={request.occurrenceId ?? request.requestId} tabIndex={-1}>
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
