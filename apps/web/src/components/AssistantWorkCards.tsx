import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent } from "react";
import { prioritizedPendingRequests, type PendingApproval } from "@wollipog/protocol";
import {
  groupLaunchedWork,
  launchedWorkGroup,
  launchedWorkIds,
  type LaunchedWork,
  type LaunchedWorkGroup,
  type LaunchedWorkGroups,
} from "../assistant-launched-work.js";
import { formatUsd } from "../guardrail-values.js";
import { relativeTime } from "../format.js";
import { sessionDisplayTitle } from "../session-title.js";
import { sessionStatusSignal } from "../status-meta.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { AssistantsIcon, ChevronRightIcon, SearchIcon } from "./Icons.js";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";
import { sessionAgentLabel } from "./agent-options.js";
import { campaignFact } from "../session-tools.js";

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
 * Keeps keyboard focus when a session changes group or its Review button goes away (#4776).
 * If focus was last inside the list and the page now has none, `recover` gets the session
 * whose row last held focus and the list, and returns where focus goes.
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
  // Review can disappear while the row stays in the same group. Observe the list as well as
  // checking the groups after each render.
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

/** The session link is the row's surviving focus target. */
function cardFocusTarget(list: HTMLElement | null, sessionId: string | null): HTMLElement | null {
  if (!list || !sessionId) return null;
  const card = list.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(sessionId)}"]`);
  return card?.querySelector<HTMLElement>(".assistant-work-open") ?? null;
}

export function AssistantWorkPanel({ work, onReview }: { work: LaunchedWork; onReview: (sessionId: string, request: PendingApproval) => void }) {
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
        campaign={work.campaignIds?.includes(sessionId)} onReview={onReview} />)}
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

function AssistantWorkRow({ sessionId, campaign, onReview }: {
  sessionId: string;
  campaign?: boolean;
  onReview: (sessionId: string, request: PendingApproval) => void;
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
        <button type="button" className="btn" onClick={() => onReview(sessionId, request)}>Review</button>
      </div>}
    </li>
  );
}
