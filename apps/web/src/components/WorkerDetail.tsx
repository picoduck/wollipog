import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import type { PendingApproval, SessionView } from "@wollipog/protocol";
import { formatRecordedRelativeTime, formatRecordedTimestamp, titleCaseLabel } from "../format.js";
import { useStoreActions } from "../store.js";
import type { SubagentLifecycle } from "../subagents.js";
import type { TimelineItem } from "../timeline.js";
import { useTimelineClock } from "../timeline-clock.js";
import { isLiveWorker, workerRequestSentence, workerStatusMeta, type SubagentStatusContextValue,
  type WorkerRow } from "../worker-roster.js";
import { EventTimeline } from "./EventTimeline.js";
import { Notice } from "./Notice.js";
import { PanelScrollerContext } from "./PanelPages.js";
import { RequestCard } from "./requests/RequestCard.js";
import { SessionQuestionBanner } from "./SessionApproval.js";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";
import { WorkerRowItem } from "./WorkerRowItem.js";

/** A worker page's fixed words (#2860): labels Title Case, sentences sentence case (§17.1). */
export const WORKER_DETAIL_COPY = {
  unavailableTitle: "Can't Show This Worker",
  ambiguous: "Two recorded subagents share the same ID, so Wollipog can't tell which one you picked.",
  missing: "This subagent is no longer available in this session.",
  loading: "Loading this worker…",
  back: "Back to Agents",
  nested: "Nested Workers",
  activity: "Activity",
  request: "Pending Request",
  empty: "No output recorded yet. Activity appears here as the subagent works.",
  codex: "Codex doesn't report subagent output yet, so only this summary is available.",
  partial: "Earlier activity in this session isn't loaded, so this worker's first steps may be missing.",
} as const;

/** "600 Tokens", or "600 Tokens, 740 With Nested" when its nested workers add to it. */
export function workerTokensLabel(tokens: number | undefined, inclusiveTokens: number | undefined): string | null {
  if (tokens == null && inclusiveTokens == null) return null;
  const own = `${(tokens ?? 0).toLocaleString()} Tokens`;
  return inclusiveTokens != null && inclusiveTokens !== tokens ? `${own}, ${inclusiveTokens.toLocaleString()} With Nested` : own;
}

export interface WorkerDetailProps {
  session: SessionView;
  runnerOnline: boolean;
  /** The transcript is showing a bounded window, so the worker's earliest steps may be outside it. */
  earlierActivityUnloaded?: boolean;
  /** The worker's own roster row: the page reads its badge and facts from it, so they match the row. */
  worker?: WorkerRow;
  /** The subagent's lifecycle, which says whether its activity is still live. */
  lifecycle?: SubagentLifecycle;
  /** Why the page cannot show its worker, or that its registry entry is still loading. */
  unavailable?: "ambiguous" | "missing" | "loading";
  /** The worker that started this one. */
  parent?: WorkerRow;
  /** The workers this one started. */
  nested: readonly WorkerRow[];
  /** The worker's own activity, scoped from the session's transcript. */
  output: TimelineItem[];
  statusContext: SubagentStatusContextValue;
  /** The request this worker waits on, answered here (#2860). Never the session's own. */
  request?: PendingApproval;
  /** The Request Card's head line: "Inspect Parser, a subagent". */
  requestOwner?: string;
  /** Set to move focus to the request once it shows; reported back through `onRequestFocusHandled`. */
  requestFocus?: number;
  onRequestFocusHandled?: (focus: number) => void;
  onOpenWorker: (row: WorkerRow) => void;
  onOpenSubagent: (id: string) => void;
  onBack: () => void;
}


/**
 * One subagent as a panel page in Agents (#2860; docs/design-system.md §4.9): the row's own status
 * badge and neutral facts, the request it waits on with a notice saying what it wants, the workers
 * it started as roster rows, and its activity. The page's title, the worker's name, is the panel
 * header's; the tool that pushes the page sets it.
 */
export function WorkerDetail({
  session,
  runnerOnline,
  earlierActivityUnloaded = false,
  worker,
  lifecycle,
  unavailable,
  parent,
  nested,
  output,
  statusContext,
  request,
  requestOwner,
  requestFocus,
  onRequestFocusHandled,
  onOpenWorker,
  onOpenSubagent,
  onBack,
}: WorkerDetailProps) {
  const { loadSession } = useStoreActions();
  const scroller = useContext(PanelScrollerContext);
  const scrollRef = useMemo(() => ({ current: scroller }), [scroller]);
  // While Activity virtualizes against the panel body, the body opts out of native scroll anchoring
  // as every external host of a measured virtual list does: the list's own corrections must be the
  // only ones. Only for as long as the list is there, so other tools keep the browser's anchoring.
  const virtualActivity = scroller !== null && worker !== undefined && unavailable === undefined && output.length > 0;
  useLayoutEffect(() => {
    if (!virtualActivity || !scroller) return;
    scroller.classList.add("measured-virtual-scroll");
    return () => scroller.classList.remove("measured-virtual-scroll");
  }, [virtualActivity, scroller]);
  const now = useTimelineClock(worker !== undefined && (isLiveWorker(worker) || nested.some(isLiveWorker)));
  const idPrefix = `worker-detail-${useId().replace(/:/g, "")}`;
  const pageRef = useRef<HTMLElement>(null);
  const requestRef = useRef<HTMLDivElement>(null);
  // Whether focus is in the request, so answering it (which removes the card) keeps focus on the page.
  const requestOwnsFocus = useRef(false);
  // The intent waits while the worker is not shown yet (its registry entry still loading), so its
  // request takes focus once it is. Shown, the intent is spent whether or not there is a request to
  // land on, so a request that arrives later, or the page coming back after Back from a nested page,
  // does not take focus.
  const shown = worker !== undefined && unavailable === undefined;
  useEffect(() => {
    if (requestFocus === undefined || !shown) return;
    requestRef.current?.focus();
    onRequestFocusHandled?.(requestFocus);
  }, [requestFocus, shown, onRequestFocusHandled]);
  useLayoutEffect(() => {
    if (!requestOwnsFocus.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && pageRef.current?.contains(active)) return;
    requestOwnsFocus.current = false;
    (requestRef.current ?? pageRef.current)?.focus();
  }, [request?.requestId]);

  if (unavailable === "loading") return <State variant="loading" compact>{WORKER_DETAIL_COPY.loading}</State>;
  if (unavailable || !worker) {
    return (
      <State compact title={WORKER_DETAIL_COPY.unavailableTitle}
        actions={<button type="button" className="btn sm" onClick={onBack}>{WORKER_DETAIL_COPY.back}</button>}>
        {unavailable === "ambiguous" ? WORKER_DETAIL_COPY.ambiguous : WORKER_DETAIL_COPY.missing}
      </State>
    );
  }

  const started = formatRecordedTimestamp(worker.startedAt);
  const tokens = workerTokensLabel(worker.tokens, worker.inclusiveTokens);
  const historyKey = `${session.id}:${session.eventEpoch ?? 0}:${worker.target.id}`;
  const nestedHeading = `${idPrefix}-nested`;
  return (
    <section ref={pageRef} className="worker-detail" aria-label={worker.name} tabIndex={-1}>
      <div className="worker-detail-head">
        <StatusBadge meta={workerStatusMeta(worker)} />
        <ul className="worker-detail-meta" aria-label="Worker Facts">
          <li>{worker.role ? titleCaseLabel(worker.role) : "Subagent"}</li>
          {parent && (
            <li>
              In{" "}
              <button type="button" className="link" data-panel-page-key={parent.id} onClick={() => onOpenWorker(parent)}>
                {parent.name}
              </button>
            </li>
          )}
          {started && (
            <li>Started <time dateTime={started.dateTime} title={started.title}>{formatRecordedRelativeTime(worker.startedAt, now)}</time></li>
          )}
          {worker.toolCount != null && <li>{worker.toolCount.toLocaleString()} {worker.toolCount === 1 ? "Tool Use" : "Tool Uses"}</li>}
          {tokens && <li>{tokens}</li>}
        </ul>
      </div>
      {request && (
        <div className="worker-detail-request">
          <Notice tone="warning" compact role="status">{workerRequestSentence(request, session.worktreePath ?? undefined)}</Notice>
          <div ref={requestRef} tabIndex={-1} role="region" aria-label={WORKER_DETAIL_COPY.request}
            onFocusCapture={() => { requestOwnsFocus.current = true; }}
            onBlurCapture={(event) => {
              if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) requestOwnsFocus.current = false;
            }}
            data-session-request-id={request.requestId} data-session-request-session={session.id}>
            {request.kind === "question" ? (
              <SessionQuestionBanner key={request.requestId} sessionId={session.id} requestId={request.requestId}
                occurrenceId={request.occurrenceId} requestedAt={request.requestedAt} recoveryId={request.recoveryId}
                questions={request.questions ?? []} isAsync={request.async} recoveryReason={request.recoveryReason}
                recoveryAction={request.recoveryAction} runnerOnline={runnerOnline} onSessionUpdate={loadSession}
                showKeyHints={false} />
            ) : (
              <RequestCard key={request.requestId} session={{ ...session, pendingApproval: request }} request={request}
                runnerOnline={runnerOnline} presentation="panel" owner={requestOwner} onSessionUpdate={loadSession} />
            )}
          </div>
        </div>
      )}
      {nested.length > 0 && (
        <section className="worker-detail-section" aria-labelledby={nestedHeading}>
          <h3 className="group-label" id={nestedHeading}>{WORKER_DETAIL_COPY.nested}<span className="count">{nested.length}</span></h3>
          <div role="list" aria-label={WORKER_DETAIL_COPY.nested}>
            {nested.map((row) => <WorkerRowItem key={row.id} row={row} now={now} onOpen={onOpenWorker} />)}
          </div>
        </section>
      )}
      {/* Activity's list is a direct child of the page, after everything above it: a virtual list
          watches the siblings before it, so a request that resolves or a section that grows moves
          its scroll margin with it. */}
      <h3 className="group-label">{WORKER_DETAIL_COPY.activity}</h3>
      {earlierActivityUnloaded && <p className="worker-detail-note">{WORKER_DETAIL_COPY.partial}</p>}
      {output.length > 0 ? (
        <EventTimeline
          key={historyKey}
          items={output}
          driver={session.driver}
          scrollRef={scroller ? scrollRef : undefined}
          historyKey={historyKey}
          sessionActive={["starting", "running", "waiting"].includes(lifecycle ?? "unknown")}
          ariaLabel="Subagent Activity"
          onOpenSubagent={onOpenSubagent}
          subagentStatus={statusContext}
        />
      ) : session.driver === "codex" ? (
        <Notice tone="neutral" compact role="status">{WORKER_DETAIL_COPY.codex}</Notice>
      ) : (
        <p className="worker-detail-note">{WORKER_DETAIL_COPY.empty}</p>
      )}
    </section>
  );
}
