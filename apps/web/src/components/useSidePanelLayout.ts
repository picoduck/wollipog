import { useLayoutEffect, useRef, useState } from "react";
import { clampRightPanelWidth, rightPanelDragCeiling, rightPanelOverlays } from "../right-panel.js";

/** Measure the shared row before paint. Its width is independent of the panel's presentation. */
export function useSidePanelLayout(open: boolean, phone: boolean, preferredWidth: number) {
  const asideRef = useRef<HTMLElement>(null);
  const [columnsWidth, setColumnsWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const columns = asideRef.current?.parentElement;
    if (!open || !columns) return;
    const measure = () => setColumnsWidth(columns.getBoundingClientRect().width || null);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(columns);
    return () => observer.disconnect();
  }, [open]);

  const ceiling = rightPanelDragCeiling(columnsWidth);
  const effectiveWidth = clampRightPanelWidth(preferredWidth, ceiling);
  const overlaysAtWidth = !phone && columnsWidth !== null && rightPanelOverlays(columnsWidth, effectiveWidth);
  return { asideRef, ceiling, effectiveWidth, overlaysAtWidth };
}
