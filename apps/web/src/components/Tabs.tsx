import React, { useEffect, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from "react";

/**
 * A tab row (docs/design-system.md §10.1): `.tabs` holding `.tab` buttons with `role="tab"` and
 * `aria-selected`. It scrolls sideways when the tabs do not fit, fading whichever side is clipped,
 * and scrolls the selected tab into view whenever the selection changes, including a tab chosen by
 * a link or Back after mount. Keyboard behavior stays with the owner, which knows how its tabs move
 * (roving arrows, Home and End).
 *
 * With `links`, the tabs are routes rather than panels: the row is a `nav` landmark holding `a.tab`
 * links, the current one `aria-current="page"`, and Tab moves through them as through any links.
 */
export function TabList({
  label,
  className,
  links = false,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLElement>, "role"> & { label: string; links?: boolean; children: ReactNode }) {
  const rowRef = useRef<HTMLElement>(null);

  // After every render, since the owner decides the selection: only a change of selected tab
  // scrolls, so a re-render never pulls the row back from where the user scrolled it.
  const shownTab = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const selected = rowRef.current?.querySelector<HTMLElement>(
      links ? '.tab[aria-current="page"]' : '[role="tab"][aria-selected="true"]',
    ) ?? null;
    if (selected === shownTab.current) return;
    shownTab.current = selected;
    selected?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  });

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

  if (links) {
    return <nav {...rest} ref={rowRef} aria-label={label} className={className ? `tabs ${className}` : "tabs"}>{children}</nav>;
  }
  return (
    <div
      {...rest}
      ref={rowRef as React.RefObject<HTMLDivElement>}
      role="tablist"
      aria-label={label}
      className={className ? `tabs ${className}` : "tabs"}
    >
      {children}
    </div>
  );
}
