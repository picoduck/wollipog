import { useId, useState } from "react";
import type { ReviewReportFinding, ReviewSessionView, SourceLocation } from "@wollipog/protocol";
import { formatRecordedRelativeTime } from "../format.js";
import {
  REPORT_SEVERITY,
  reportFindingDetail,
  reportFindingLocation,
  reviewRunProblem,
  reviewRunRound,
  reviewRunState,
  reviewRunTitle,
} from "../review-run-copy.js";
import { statusMeta } from "../status-meta.js";
import { useTimelineClock } from "../timeline-clock.js";
import { ArrowUpRightIcon, ChevronRightIcon } from "./Icons.js";
import { FindingBody } from "./ReviewFindings.js";
import { StatusBadge } from "./StatusBadge.js";

function ReportFindingRow({ finding, onOpenSourceLocation }: {
  finding: ReviewReportFinding;
  onOpenSourceLocation: (location: SourceLocation) => void;
}) {
  const severity = REPORT_SEVERITY[finding.severity];
  const location = reportFindingLocation(finding);
  return (
    <article className="review-finding-row review-run-finding">
      <div className="review-finding-head">
        <StatusBadge tone={severity.tone} label={severity.label} />
        {finding.blocking && <StatusBadge tone="neutral" noDot label="Blocking" />}
        {location.source
          ? (
            <button
              type="button"
              className="review-finding-location"
              title={location.title}
              onClick={() => onOpenSourceLocation(location.source!)}
            >
              {location.label}
            </button>
          )
          : <span className="review-finding-location" title={location.title}>{location.label}</span>}
      </div>
      <p className="review-finding-body review-run-finding-title">{finding.title}</p>
      <FindingBody text={reportFindingDetail(finding)} />
    </article>
  );
}

function ReviewRunRow({ run, now, onOpenSession, onOpenSourceLocation }: {
  run: ReviewSessionView;
  now: number;
  onOpenSession?: (sessionId: string) => void;
  onOpenSourceLocation: (location: SourceLocation) => void;
}) {
  const title = reviewRunTitle(run.reviewer);
  const round = reviewRunRound(run.round);
  const problem = reviewRunProblem(run);
  const age = formatRecordedRelativeTime(run.createdAt, now);
  return (
    <>
      <article className="review-finding-row" aria-label={round ? `${title}, ${round}` : title}>
        <div className="review-finding-head">
          <span className="review-run-title">{title}</span>
          <StatusBadge meta={statusMeta("reviewRun", reviewRunState(run))} />
          {run.stale && (
            <StatusBadge tone="neutral" noDot label="Stale" title="A newer review covers a later head of this pull request." />
          )}
        </div>
        {problem && <p className="review-findings-reason">{problem}</p>}
        <div className="review-finding-foot">
          <p className="review-finding-meta">
            {round && <span>{round}</span>}
            <span title={run.headSha}>Head {run.headSha.slice(0, 7)}</span>
            {age && <span>{age}</span>}
          </p>
          {onOpenSession && (
            <div className="review-finding-row-actions">
              <button type="button" className="btn sm ghost" onClick={() => onOpenSession(run.reviewSessionId)}>
                <ArrowUpRightIcon size={14} aria-hidden="true" />
                Open Transcript
              </button>
            </div>
          )}
        </div>
      </article>
      {run.findings.map((finding, index) => (
        <ReportFindingRow key={index} finding={finding} onOpenSourceLocation={onOpenSourceLocation} />
      ))}
    </>
  );
}

/**
 * Review's Cross-Model Reviews (#3369; docs/design-system.md §5.2, §11.1, §11.2): the reviews this
 * session requested of the other model family, newest first, under one disclosure beside Findings.
 * Each says which reviewer, its round, its one state badge and Stale once a newer review covers
 * another head; a valid report's findings follow it as rows, each opening its file in Files; and
 * Open Transcript goes to the review session itself. Read-only: the implementer adjudicates.
 */
export function ReviewRuns({ runs, onOpenSession, onOpenSourceLocation }: {
  /** Newest first. */
  runs: ReviewSessionView[];
  onOpenSession?: (sessionId: string) => void;
  onOpenSourceLocation: (location: SourceLocation) => void;
}) {
  const bodyId = `${useId().replace(/:/g, "")}-review-runs`;
  const [expanded, setExpanded] = useState(true);
  const active = runs.some((run) => !run.terminal);
  const now = useTimelineClock(runs.length > 0);
  const latest = runs[0];
  if (!latest) return null;
  return (
    <section className="review-findings" aria-label="Cross-Model Reviews">
      <div className="review-findings-head">
        <button
          type="button"
          className="disclosure-trigger"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronRightIcon className="disclosure-chevron" size={14} aria-hidden="true" />
          Cross-Model Reviews
          <span className="review-findings-count">{runs.length}</span>
        </button>
        {/* The newest review's state is the section's summary; while one runs, that is Reviewing. */}
        <StatusBadge meta={statusMeta("reviewRun", active ? "running" : reviewRunState(latest))} />
      </div>
      <div id={bodyId} hidden={!expanded}>
        <div className="review-findings-list">
          {runs.map((run) => (
            <ReviewRunRow
              key={run.reviewSessionId}
              run={run}
              now={now}
              {...(onOpenSession ? { onOpenSession } : {})}
              onOpenSourceLocation={onOpenSourceLocation}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
