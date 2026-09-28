import React, { useEffect, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from "react";

/**
 * A tab row (docs/design-system.md §10.1): `.tabs` holding `.tab` buttons with `role="tab"` and
 * `aria-selected`. It scrolls sideways when the tabs do not fit, fading whichever side is clipped,
 * and scrolls the selected tab into view when it mounts. Keyboard behavior stays with the owner,
 * which knows how its tabs move (roving arrows, Home and End).
 */
export function TabList({
  label,
  className,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, "role"> & { label: string; children: ReactNode }) {
  const rowRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    rowRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, []);

  // The fade follows the scroll position and the row's size; tabs added or renamed re-measure too.
  const updateClip = useRef<() => void>(() => undefined);
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const update = () => {
      row.toggleAttribute("data-clip-start", row.scrollLeft > 1);
      row.toggleAttribute("data-clip-end", row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
    };
    updateClip.current = update;
    update();
    row.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(row);
    return () => {
      row.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, []);
  useEffect(() => updateClip.current());

  return (
    <div
      {...rest}
      ref={rowRef}
      role="tablist"
      aria-label={label}
      className={className ? `tabs ${className}` : "tabs"}
    >
      {children}
    </div>
  );
}
