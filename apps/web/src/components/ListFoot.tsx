import type { ReactNode } from "react";

/**
 * An entry after a list's last row that leads somewhere else, such as an Orphaned Copies entry or a
 * Show More row (docs/design-system.md §5.6). It is set off from the rows by a hairline.
 */
export function ListFoot({ children }: { children: ReactNode }) {
  return <div className="list-foot">{children}</div>;
}
