import React, { useEffect, useRef, type ReactNode } from "react";
import type { SessionView } from "@wollipog/protocol";
import type { ConnState } from "../store.js";
import type { TimelineItem } from "../timeline.js";
import { isTimelineSessionActive } from "../timeline-clock.js";
import type { TranscriptPresentation } from "../transcript-presentation.js";
import { EventTimeline } from "./EventTimeline.js";
import { ArrowUpRightIcon } from "./Icons.js";
import { ActionsMenu, type PageMenuAction } from "./PageHeader.js";
import { SessionStatusIndicators } from "./common.js";
import { State } from "./State.js";
import { TranscriptSkeleton, transcriptLoadingSentence } from "./TranscriptSkeleton.js";
import { TranscriptEmptyState, TranscriptHistoryNotice, transcriptEmptyKind } from "./TranscriptReadingStates.js";

/**
 * The comparison column recipe (#2975, component-local `.compare`, docs/design-system.md §19.4):
 * flush member columns separated by hairlines that fill the page's height, each with a one-line
 * head, one meta line and a body that scrolls on its own. A Run lays its members out with it; a Pod
 * can lay out its members the same way.
 */

/**
 * The row of columns. Each column is at least 320px wide and they share the rest; when they do not
 * fit, the row scrolls sideways and fades its right edge while columns lie beyond it. The compact
 * tier shows two columns at a time.
 */
export function CompareRow({ label, children }: { label: string; children: ReactNode }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const updateClip = useRef<() => void>(() => undefined);
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const update = () => {
      row.toggleAttribute("data-clip-end", row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
    };
    updateClip.current = update;
    update();
    row.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(row);
    return () => {
      row.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, []);
  // A column added or removed changes the scroll width without resizing the row.
  useEffect(() => { updateClip.current(); });
  return <div ref={rowRef} className="compare" role="group" aria-label={label}>{children}</div>;
}

/**
 * A column's head, one row that never wraps: the agent (ending in an ellipsis), with an optional dim
 * sub-line under it, its status at its full width, a visible Open Session when the column offers
 * one, and ⋯. On a phone it is the member bar under the member tabs.
 */
export function CompareMemberHead({ agent, sub, session, runnerOnline, onOpenSession, menu }: {
  agent: string;
  /** What the member is for, after the agent: a pod member's "<Role> · <task>" (#2983). */
  sub?: string;
  session: SessionView;
  runnerOnline: boolean;
  /** A visible Open Session button; without it, Open Session is the first item in ⋯. */
  onOpenSession?: () => void;
  /** The member's ⋯ items. */
  menu: PageMenuAction[];
}) {
  return (
    <div className="compare-member-head">
      {sub ? (
        <span className="compare-member-name">
          <span className="compare-member-agent" title={agent}>{agent}</span>
          <span className="compare-member-sub" title={sub}>{sub}</span>
        </span>
      ) : (
        <span className="compare-member-agent" title={agent}>{agent}</span>
      )}
      <SessionStatusIndicators session={session} disconnected={!runnerOnline} />
      {onOpenSession && (
        <button type="button" className="icon-btn sm" title="Open Session" aria-label="Open Session" onClick={onOpenSession}>
          <ArrowUpRightIcon size={16} aria-hidden="true" />
        </button>
      )}
      <ActionsMenu size="sm" label={`${agent} Actions`} items={menu} />
    </div>
  );
}

/**
 * The column's reading states (§12.5's reading-column table, #2172): one history notice in a band
 * above the body (failed with Retry, or cached while disconnected), then skeleton turns while
 * loading, the compact empty state once the history is known to be empty, or the timeline.
 */
export function CompareMemberBody({
  agent,
  session,
  items,
  presentation,
  conn,
  loaded,
  onRetry,
}: {
  agent: string;
  session: SessionView;
  items: TimelineItem[];
  presentation: TranscriptPresentation;
  conn: ConnState;
  /** Events this device holds for the member. */
  loaded: number;
  onRetry: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const notice = presentation.notice === "error" || presentation.notice === "stale" ? presentation.notice : null;
  return (
    <>
      {notice && (
        <div className="compare-member-notice">
          <TranscriptHistoryNotice
            kind={notice}
            error={presentation.error}
            loaded={loaded}
            total={session.messageCount > 0 ? session.messageCount : undefined}
            canRetry={conn === "online" && !presentation.busy}
            onRetry={onRetry}
          />
        </div>
      )}
      <div
        className="compare-member-body measured-virtual-scroll"
        ref={scrollRef}
        role="region"
        aria-label={`${agent} Activity`}
        aria-busy={presentation.busy}
        tabIndex={0}
      >
        {presentation.body === "skeleton" ? (
          <TranscriptSkeleton label={`Loading ${agent} Activity`} sentence={transcriptLoadingSentence(session.messageCount)} />
        ) : presentation.body === "unavailable" ? (
          // A failed load is the notice above, alone; only a disconnected or unpaired device with
          // nothing cached still needs a state here.
          !presentation.error && (
            <State compact variant="offline" title={conn === "unauthorized" ? "Pair to Load Activity" : "Activity Unavailable"}>
              {conn === "unauthorized" ? "Pair this device with Wollipog to load this activity." : "Reconnect to load this activity."}
            </State>
          )
        ) : presentation.body === "empty" ? (
          // Offline and error outrank empty (§12): a once-empty history with a notice is the notice alone.
          !notice && <TranscriptEmptyState kind={transcriptEmptyKind(session)} agent={agent} project={session.workspaceName ?? undefined} />
        ) : (
          <EventTimeline
            items={items}
            driver={session.driver}
            sessionActive={isTimelineSessionActive(session.status)}
            scrollRef={scrollRef}
            historyKey={`${session.id}:${session.eventEpoch ?? 0}`}
          />
        )}
      </div>
    </>
  );
}
