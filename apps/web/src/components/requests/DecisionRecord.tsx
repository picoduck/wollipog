import React, { Fragment, useContext, useEffect, useId, type ReactNode } from "react";
import {
  decisionActorName,
  decisionAuditText,
  decisionRecordText,
  GovernancePolicyNamesContext,
  type DecisionNames,
  type DecisionRecordModel,
} from "../../decision-record.js";
import { formatRecordedRelativeTime } from "../../format.js";
import { ViewerIdentityContext } from "../../resolver-identity.js";
import { sessionDisplayTitle } from "../../session-title.js";
import { statusMeta, type StatusTone } from "../../status-meta.js";
import { useOptionalStoreSelector } from "../../store.js";
import { CopyButton } from "../common.js";
import {
  ChevronRightIcon,
  DecisionBlockedIcon,
  DecisionClosedIcon,
  DecisionTimedOutIcon,
  SuccessIcon,
} from "../Icons.js";

/** The 16px outcome icon for each tone (§18): CircleCheck, CircleX, ShieldX, TimerOff. */
function OutcomeIcon({ tone }: { tone: StatusTone }) {
  switch (tone) {
    case "success": return <SuccessIcon size={16} />;
    case "danger": return <DecisionBlockedIcon size={16} />;
    case "warning": return <DecisionTimedOutIcon size={16} />;
    default: return <DecisionClosedIcon size={16} />;
  }
}

/** One absolute time with seconds and its date: "Oct 5, 2026, 12:31:05 AM". */
function absoluteTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(at));
}

/** The names a row can show: the viewer (#2527), policies by id, and the parent session's title. */
function useDecisionNames(record: DecisionRecordModel): DecisionNames {
  const viewer = useContext(ViewerIdentityContext);
  const policies = useContext(GovernancePolicyNamesContext);
  const actor = record.actor;
  const wantsPolicy = actor?.kind === "policy" && Boolean(actor.policyId);
  const { load } = policies;
  useEffect(() => {
    if (wantsPolicy) load();
  }, [load, wantsPolicy]);
  const parentId = actor?.kind === "parent" ? actor.sessionId : undefined;
  const parentTitle = useSessionDisplayTitle(parentId);
  return {
    viewer,
    policyName: (policyId) => policies.names?.get(policyId),
    sessionTitle: (sessionId) => sessionId === parentId ? parentTitle : undefined,
  };
}

/** A session's one-line title from the app's store, or undefined where it is not loaded (a shared
 * page, a session this viewer cannot list). Never its id. */
export function useSessionDisplayTitle(sessionId: string | undefined): string | undefined {
  const title = useOptionalStoreSelector((state) => sessionId ? state.sessions.get(sessionId)?.title : undefined);
  return title ? sessionDisplayTitle(title) || undefined : undefined;
}

/**
 * A finished decision as one row (#2204, docs/design-system.md §5.5, §11.2): the §5.5 chevron, a
 * 16px outcome icon in its tone, the past-tense outcome, what was requested, who decided and how long
 * ago. The summary is `--control-h` tall (44px on touch). Opening it shows the facts once, Decided By
 * first and Recorded last; ids are only ever copied, through Copy Audit ID.
 *
 * The parent session's title links to that session from the Decided By fact, not from the summary,
 * so the summary stays one control.
 */
export function DecisionRecord({
  record,
  open = false,
  onToggle,
  now,
  onOpenSession,
  auditId,
  className,
}: {
  record: DecisionRecordModel;
  /** The governance audit id, as `data-audit-id`, for a row that has one. */
  auditId?: string;
  open?: boolean;
  onToggle?: () => void;
  /** The shared clock the relative time reads; the current time when absent. */
  now?: number;
  /** Opens another session; absent where the surface cannot navigate (a shared page). */
  onOpenSession?: (sessionId: string) => void;
  className?: string;
}) {
  const names = useDecisionNames(record);
  const timeId = useId();
  const meta = statusMeta("requestDecision", record.outcome);
  const by = decisionActorName(record.actor, names);
  const at = Number.isFinite(record.at) ? record.at! : undefined;
  const actor = record.actor;
  const decidedBy: ReactNode = actor?.kind === "parent" && by && onOpenSession
    ? <button type="button" className="link" onClick={() => onOpenSession(actor.sessionId)}>{by}</button>
    : by;
  return (
    <details
      className={`tl-decision disclosure${className ? ` ${className}` : ""}`}
      data-decision-outcome={record.outcome}
      data-audit-id={auditId}
      open={open}
      onToggle={(event) => {
        if (event.nativeEvent.isTrusted && event.currentTarget.open !== open) onToggle?.();
      }}
    >
      <summary
        className="tl-decision-head"
        aria-label={decisionRecordText(record, names)}
        aria-describedby={at !== undefined ? timeId : undefined}
      >
        <ChevronRightIcon size={14} className="disclosure-chevron" />
        <span className={`tl-decision-icon t-${meta.tone}`}><OutcomeIcon tone={meta.tone} /></span>
        <span className="tl-decision-line">
          <span className={`tl-decision-outcome t-${meta.tone}`}>{meta.label}</span>
          <span className="tl-decision-title">{record.title}</span>
          {by && <span className="tl-decision-by">by {by}</span>}
        </span>
        {at !== undefined && (
          <time id={timeId} className="tl-decision-time" dateTime={new Date(at).toISOString()} title={absoluteTime(at)}>
            {formatRecordedRelativeTime(at, now ?? Date.now())}
          </time>
        )}
      </summary>
      <div className="tl-decision-body">
        {record.detail && <p className="tl-decision-detail">{record.detail}</p>}
        <dl className="facts">
          {decidedBy && <><dt>Decided By</dt><dd>{decidedBy}</dd></>}
          {record.facts.map((fact) => (
            <Fragment key={fact.label}>
              <dt>{fact.label}</dt>
              {fact.code ? (
                <dd className="code-well">
                  <pre>{fact.value}</pre>
                  <CopyButton text={fact.value} iconOnly ariaLabel={`Copy ${fact.label}`} className="copy-btn icon-only-copy" />
                </dd>
              ) : <dd>{fact.value}</dd>}
            </Fragment>
          ))}
          {at !== undefined && <><dt>Recorded</dt><dd><time dateTime={new Date(at).toISOString()}>{absoluteTime(at)}</time></dd></>}
        </dl>
        {record.auditIds.length > 0 && (
          <div className="tl-decision-actions">
            <CopyButton text={decisionAuditText(record)} label="Copy Audit ID" className="btn sm ghost" />
          </div>
        )}
      </div>
    </details>
  );
}
