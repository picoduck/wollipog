import { formatDuration } from "../format.js";
import { isLiveWorker, workerStatusMeta, type WorkerRow } from "../worker-roster.js";
import { ArrowUpRightIcon, ChevronRightIcon } from "./Icons.js";
import { StatusBadge } from "./StatusBadge.js";

/** The tooltip on a row that opens another session. */
export function opensSessionLabel(title: string): string {
  return `Opens ${title}`;
}

/**
 * One worker as a roster row (#2857; §5.2): line 1 is the name and the one status badge; line 2 is
 * what the worker is doing, with its elapsed time trailing. A trailing chevron opens a page here, an
 * arrow another session. The Agents roster and a worker page's Nested Workers (#2860) share it.
 */
export function WorkerRowItem({
  row,
  now,
  selected = false,
  nested = false,
  lastNested = false,
  sessionTitle,
  onOpen,
}: {
  row: WorkerRow;
  now: number;
  selected?: boolean;
  nested?: boolean;
  lastNested?: boolean;
  /** The member session's own title, for the tooltip of a row that opens it. */
  sessionTitle?: string;
  onOpen: (row: WorkerRow) => void;
}) {
  const end = row.completedAt ?? (isLiveWorker(row) ? now : row.lastActivityAt);
  const elapsed = row.startedAt != null && end != null ? formatDuration(Math.max(0, end - row.startedAt)) : "";
  const opensSession = row.target.kind === "session";
  return (
    <div role="listitem" className={`worker-row-item${nested ? " nested" : ""}${lastNested ? " nested-last" : ""}`}>
      <button type="button" className={`row row-2 worker-row${selected ? " is-selected" : ""}`}
        aria-current={selected ? "true" : undefined}
        title={opensSession ? opensSessionLabel(sessionTitle ?? row.name) : undefined}
        data-panel-page-key={opensSession ? undefined : row.id}
        onClick={() => onOpen(row)}>
        <span className="row-body">
          <span className="row-line">
            <span className="row-title">{row.name}</span>
            <StatusBadge meta={workerStatusMeta(row)} />
          </span>
          <span className="row-line">
            <span className="row-sub">{row.activity}</span>
            {elapsed && <span className="row-trail">{elapsed}</span>}
          </span>
        </span>
        <span className="row-icon" aria-hidden="true">
          {opensSession ? <ArrowUpRightIcon size={16} /> : <ChevronRightIcon size={16} />}
        </span>
      </button>
    </div>
  );
}
