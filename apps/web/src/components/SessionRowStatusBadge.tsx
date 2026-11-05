import type { SessionRowStatus } from "../session-row-status.js";
import { StatusBadge, StatusCount } from "./StatusBadge.js";

/** Lifecycle plus one secondary; the tooltip preserves the full condition details. */
export function SessionRowStatusBadge({ status }: { status: SessionRowStatus }) {
  const { lifecycle, badge, others } = status;
  return (
    <span className="row-status" title={status.details}>
      <StatusBadge meta={lifecycle.meta} title={lifecycle.title} ariaLabel={lifecycle.ariaLabel} />
      {badge && <StatusBadge meta={badge.meta} title={badge.title} ariaLabel={badge.ariaLabel}>
        {badge.count !== undefined && <StatusCount>{badge.count}</StatusCount>}
      </StatusBadge>}
      {others.length > 0 && (
        <span className="row-status-more" title={others.join("\n")}>
          <span aria-hidden="true">+{others.length}</span>
          <span className="sr-only">, {others.length} More: {others.join("; ")}</span>
        </span>
      )}
    </span>
  );
}
