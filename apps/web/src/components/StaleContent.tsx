import type { ReactNode } from "react";

/**
 * Last-known content kept on screen while its source is unreachable (docs/design-system.md §12.5).
 * Stale content is dimmed but stays readable, scrollable and focusable; the Reconnecting line
 * beside it says why, so this never carries the explanation itself.
 */
export function StaleContent({ stale, children }: { stale: boolean; children: ReactNode }) {
  return <div className={stale ? "is-stale" : undefined} data-stale={stale || undefined}>{children}</div>;
}
