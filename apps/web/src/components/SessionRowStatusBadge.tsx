import type { SessionRowStatus } from "../session-row-status.js";
import { StatusBadge, StatusCount } from "./StatusBadge.js";

/**
 * Lifecycle plus one secondary; the tooltip preserves the full condition details.
 *
 * `collapsible` is the phone card's (#4791): it also renders the count the secondary folds into when
 * the status line runs out of room. The count stays hidden until the line's fit asks for it, and then
 * it stands in for both the secondary badge and the ordinary "+N", naming everything it covers.
 */
export function SessionRowStatusBadge({ status, collapsible = false }: { status: SessionRowStatus; collapsible?: boolean }) {
  const { lifecycle, badge, others } = status;
  const folded = badge ? [badge.ariaLabel, ...others] : [];
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
      {collapsible && badge && (
        <span className="row-status-collapsed" title={folded.join("\n")}>
          <span aria-hidden="true">+{folded.length}</span>
          <span className="sr-only">, {folded.length} More: {folded.join("; ")}</span>
        </span>
      )}
    </span>
  );
}
