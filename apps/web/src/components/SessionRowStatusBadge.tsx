import type { SessionRowStatus } from "../session-row-status.js";
import { StatusBadge, StatusCount } from "./StatusBadge.js";

/**
 * A row's one status (#2209, `sessionRowStatus()`): the badge, and a neutral "+N" when other kinds
 * need the person, with their list in its tooltip. Renders nothing for a row with no badge (Awaiting
 * Prompt). Sessions rows use it, and Board cards are meant to.
 */
export function SessionRowStatusBadge({ status }: { status: SessionRowStatus }) {
  const { badge, others } = status;
  if (!badge) return null;
  return (
    <span className="row-status">
      <StatusBadge meta={badge.meta} title={badge.title} ariaLabel={badge.ariaLabel}>
        {badge.count !== undefined && <StatusCount>{badge.count}</StatusCount>}
      </StatusBadge>
      {others.length > 0 && (
        <span className="row-status-more" title={others.join("\n")}>
          <span aria-hidden="true">+{others.length}</span>
          <span className="sr-only">, {others.length} More: {others.join("; ")}</span>
        </span>
      )}
    </span>
  );
}
