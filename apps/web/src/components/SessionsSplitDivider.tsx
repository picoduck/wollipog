import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useRef, useState } from "react";
import { INBOX_SPLIT_RATIO_DEFAULT } from "../inbox.js";
import {
  sessionsListHeight,
  sessionsListPercent,
  sessionsListRowRange,
  sessionsListRowsForHeight,
  sessionsRatioForRows,
  type SessionsSplitGeometry,
} from "../sessions-split.js";

/** The custom property the stacked grid's first track reads (styles.css, `.sessions-md`). */
const LIST_HEIGHT_PROPERTY = "--sessions-list-h";

/**
 * The divider between the stacked Sessions list and its preview (docs/design-system.md §6.3): a
 * hit band on the list's bottom hairline. A drag follows the pointer and snaps to the nearer whole
 * row on release; ↑/↓ move one row, Home is the fewest rows, End the most that keep the preview's
 * minimum, and Enter or a double-click restores the default. Only a release or a key stores a ratio.
 */
export function SessionsSplitDivider({
  grid,
  geometry,
  rows,
  onRatioChange,
}: {
  /** The `.sessions-md` grid. A drag sets its list track directly, without a render per move. */
  grid: RefObject<HTMLElement | null>;
  geometry: SessionsSplitGeometry;
  rows: number;
  onRatioChange: (ratio: number) => void;
}) {
  const drag = useRef<{ pointerId: number; offset: number; height: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // A drag the divider does not live to finish (B opens the board, or the window narrows to a phone)
  // must not leave its unsnapped height on the grid for the next stacked layout.
  useEffect(() => () => {
    if (drag.current) grid.current?.style.removeProperty(LIST_HEIGHT_PROPERTY);
    drag.current = null;
  }, [grid]);
  const range = sessionsListRowRange(geometry);
  const height = sessionsListHeight(rows, geometry);
  const commitRows = (next: number) => {
    onRatioChange(sessionsRatioForRows(Math.min(range.max, Math.max(range.min, next)), geometry));
  };

  const follow = (clientY: number) => {
    const state = drag.current;
    const element = grid.current;
    if (!state || !element) return;
    const top = element.getBoundingClientRect().top;
    state.height = Math.min(sessionsListHeight(range.max, geometry),
      Math.max(sessionsListHeight(range.min, geometry), clientY - state.offset - top));
    element.style.setProperty(LIST_HEIGHT_PROPERTY, `${state.height}px`);
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !grid.current) return;
    // The line stays under the pointer: a press off-centre in the band does not jump the list.
    const top = grid.current.getBoundingClientRect().top;
    drag.current = { pointerId: event.pointerId, offset: event.clientY - top - height, height };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };
  /** A release snaps and stores; a cancelled pointer puts the list back where it was. */
  const finish = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    grid.current?.style.removeProperty(LIST_HEIGHT_PROPERTY);
    if (commit) commitRows(sessionsListRowsForHeight(state.height, geometry));
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "ArrowUp") commitRows(rows - 1);
    else if (event.key === "ArrowDown") commitRows(rows + 1);
    else if (event.key === "Home") commitRows(range.min);
    else if (event.key === "End") commitRows(range.max);
    else if (event.key === "Enter") onRatioChange(INBOX_SPLIT_RATIO_DEFAULT);
    else return;
    event.preventDefault();
  };

  return (
    <div
      className="master-detail-resize"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize List and Preview"
      aria-valuemin={sessionsListPercent(sessionsListHeight(range.min, geometry), geometry)}
      aria-valuemax={sessionsListPercent(sessionsListHeight(range.max, geometry), geometry)}
      aria-valuenow={sessionsListPercent(height, geometry)}
      tabIndex={0}
      data-dragging={dragging ? "" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={(event) => {
        if (drag.current?.pointerId === event.pointerId) follow(event.clientY);
      }}
      onPointerUp={(event) => finish(event, true)}
      onPointerCancel={(event) => finish(event, false)}
      onLostPointerCapture={(event) => finish(event, true)}
      onDoubleClick={() => onRatioChange(INBOX_SPLIT_RATIO_DEFAULT)}
      onKeyDown={onKeyDown}
    />
  );
}
