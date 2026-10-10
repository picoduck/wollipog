import React, { useContext, useEffect, useId, useState } from "react";
import { governanceDecisionRecord } from "../decision-record.js";
import type { GovernanceDecision } from "../governance.js";
import { viewPath } from "../navigation.js";
import { useHasStore, useStoreActions } from "../store.js";
import { humanResolver, ViewerIdentityContext, type ViewerIdentity } from "../resolver-identity.js";
import { ShieldCheckIcon } from "./Icons.js";
import { DecisionRecord } from "./requests/DecisionRecord.js";
import { State } from "./State.js";
import { useRerenderIn } from "./RelativeTime.js";
import { BusyButton } from "./ui/BusyButton.js";
import { SegmentedControl } from "./ui/ChoiceControls.js";

export type DecisionHistoryFilter = "all" | "you" | "policies";

const FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "you", label: "You" },
  { value: "policies", label: "Policies" },
] as const;

/** Nothing new renders for a load that settles this quickly (§12.3). */
export const DECISION_HISTORY_SKELETON_DELAY_MS = 300;

/**
 * A decision the viewer made: exactly the rows that read "by You" (#2527). In a single-member
 * installation every person's decision is the viewer's; while the viewer is unknown, or in a shared
 * organization for a decision that names no member, none is, as the row stays neutral too.
 */
function decidedByViewer(decision: GovernanceDecision, viewer: ViewerIdentity | null): boolean {
  if (decision.actor?.kind !== "member") return false;
  return humanResolver(viewer, decision.actor.userId)?.kind === "viewer";
}

/** Decisions the viewer's approval policies made, or Wollipog made for them: everything not a person's. */
function decidedByPolicy(decision: GovernanceDecision): boolean {
  return decision.actor?.kind !== "member";
}

export function filterDecisions(
  decisions: readonly GovernanceDecision[],
  filter: DecisionHistoryFilter,
  viewer: ViewerIdentity | null,
): GovernanceDecision[] {
  if (filter === "you") return decisions.filter((decision) => decidedByViewer(decision, viewer));
  if (filter === "policies") return decisions.filter(decidedByPolicy);
  return [...decisions];
}

function startOfDay(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** The group header for a day (§5.2): "Today", "Yesterday", then the date. */
/** How long until the local day after `now`'s begins. */
export function untilNextLocalDay(now: number): number {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return next.getTime() - now;
}

export function decisionDayLabel(at: number, now: number): string {
  const today = startOfDay(now);
  const day = startOfDay(at);
  if (day === today) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === yesterday.getTime()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(at));
}

/** Newest-first decisions grouped by the day they were made. */
export function groupDecisionsByDay(
  decisions: readonly GovernanceDecision[],
  now: number,
): Array<{ day: number; label: string; decisions: GovernanceDecision[] }> {
  const groups: Array<{ day: number; label: string; decisions: GovernanceDecision[] }> = [];
  for (const decision of [...decisions].reverse()) {
    const day = startOfDay(decision.timestamp);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.decisions.push(decision);
    else groups.push({ day, label: decisionDayLabel(decision.timestamp, now), decisions: [decision] });
  }
  return groups;
}

function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = window.setTimeout(() => setShown(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);
  return active && shown;
}

const APPROVALS_SETTINGS = { name: "settings", section: "approvals" } as const;

/** The empty state's next step (§12.1): the policies that decide for you, in Settings › Approvals
 * (#2158). A real link, so it opens in a new tab too; in the app a plain click navigates in place. */
function ApprovalPoliciesLink() {
  const hasStore = useHasStore();
  return hasStore ? <StoreApprovalPoliciesLink /> : (
    <a className="btn sm" href={viewPath(APPROVALS_SETTINGS)}>Approval Policies</a>
  );
}

function StoreApprovalPoliciesLink() {
  const { navigate } = useStoreActions();
  return (
    <a
      className="btn sm"
      href={viewPath(APPROVALS_SETTINGS)}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(APPROVALS_SETTINGS);
      }}
    >
      Approval Policies
    </a>
  );
}

function ShowInTranscript({ itemId, onShow }: { itemId: number | undefined; onShow?: (itemId: number) => void }) {
  const reasonId = useId();
  const available = itemId !== undefined && onShow !== undefined;
  return (
    <>
      <button
        type="button"
        className="btn sm ghost"
        aria-disabled={available ? undefined : true}
        aria-describedby={available ? undefined : reasonId}
        onClick={() => {
          if (available) onShow(itemId);
        }}
      >
        Show in Transcript
      </button>
      {!available && <span className="decision-history-reason" id={reasonId}>Not in the loaded transcript.</span>}
    </>
  );
}

/**
 * Decision History (#2213): every decision in the session, by the person and by their approval
 * policies, as the same Decision Record rows the transcript shows (#2204), newest first and grouped
 * by day. A secondary review surface in the side panel (a full-screen drawer on phones); the
 * transcript remains the primary chronological record.
 */
export function DecisionHistoryPanel({
  decisions,
  status = "ready",
  onRetry,
  hasMore = false,
  loadingOlder = false,
  onLoadOlder,
  transcriptItemFor,
  onShowInTranscript,
  now,
}: {
  /** Every decision loaded so far, oldest first. */
  decisions: readonly GovernanceDecision[];
  status?: "loading" | "error" | "ready";
  onRetry?: () => void;
  hasMore?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  /** The transcript row that shows this decision's request, when that row is loaded. */
  transcriptItemFor?: (decision: GovernanceDecision) => number | undefined;
  onShowInTranscript?: (itemId: number) => void;
  /** The clock the day headers are relative to; the render time by default. */
  now?: number;
}) {
  const viewer = useContext(ViewerIdentityContext);
  const [filter, setFilter] = useState<DecisionHistoryFilter>("all");
  const [openAuditId, setOpenAuditId] = useState<string | null>(null);
  const showSkeleton = useDelayedFlag(status === "loading", DECISION_HISTORY_SKELETON_DELAY_MS);
  // Today's decisions become yesterday's at midnight (#2872).
  useRerenderIn(now === undefined ? untilNextLocalDay(Date.now()) : null);

  if (status === "loading") {
    return showSkeleton ? (
      <div className="skeleton decision-history-skeleton" role="status" aria-live="polite">
        <span className="sr-only">Loading decisions…</span>
        {Array.from({ length: 4 }, (_, index) => <div aria-hidden="true" className="skeleton-row" key={index} />)}
      </div>
    ) : null;
  }
  if (status === "error") {
    return (
      <State
        variant="error"
        compact
        title="Couldn't Load Decisions"
        actions={onRetry && <button type="button" className="btn sm" onClick={onRetry}>Retry</button>}
      >
        The decision history for this session could not be loaded.
      </State>
    );
  }
  if (!decisions.length && !hasMore) {
    return (
      <State compact icon={<ShieldCheckIcon size={24} />} title="No Decisions Yet" actions={<ApprovalPoliciesLink />}>
        Decisions you and your approval policies make in this session appear here.
      </State>
    );
  }

  const shown = filterDecisions(decisions, filter, viewer);
  const groups = groupDecisionsByDay(shown, now ?? Date.now());
  return (
    <div className="decision-history">
      <SegmentedControl
        className="block"
        label="Filter Decisions"
        options={FILTER_OPTIONS}
        value={filter}
        onChange={setFilter}
      />
      {groups.length ? groups.map((group) => (
        <section key={group.day} aria-label={group.label}>
          <h3 className="decision-history-day-label">{group.label}</h3>
          <ol className="decision-history-list">
            {group.decisions.map((decision) => (
              <li key={decision.auditId}>
                <DecisionRecord
                  record={governanceDecisionRecord(decision)}
                  auditId={decision.auditId}
                  open={openAuditId === decision.auditId}
                  onToggle={() => setOpenAuditId((current) => current === decision.auditId ? null : decision.auditId)}
                  actions={<ShowInTranscript itemId={transcriptItemFor?.(decision)} onShow={onShowInTranscript} />}
                />
              </li>
            ))}
          </ol>
        </section>
      )) : (
        <State variant="no-results" compact>
          {decisions.length
            ? filter === "you" ? "No decisions by you are loaded." : "No decisions by your approval policies are loaded."
            : "No decisions are loaded yet."}
        </State>
      )}
      {hasMore && (
        <BusyButton
          busy={loadingOlder}
          progress="Loading older decisions…"
          className="btn sm decision-history-more"
          onClick={onLoadOlder}
        >
          Load Older Decisions
        </BusyButton>
      )}
    </div>
  );
}
