import type { ReactNode } from "react";

/**
 * Numbered instructions (docs/design-system.md §8.7): a real sequence the reader follows in order.
 * Each child is one `<li>` step; the stylesheet draws its number. `horizontal` lays short steps
 * side by side (a first-run explainer), and they stack again on a phone.
 */
export function Steps({
  horizontal = false,
  className,
  children,
}: {
  horizontal?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ol className={`steps${horizontal ? " horizontal" : ""}${className ? ` ${className}` : ""}`}>
      {children}
    </ol>
  );
}
