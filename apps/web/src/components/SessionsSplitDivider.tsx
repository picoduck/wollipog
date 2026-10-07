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
import {
  clampSessionsListWidth,
  SESSIONS_LIST_WIDTH_DEFAULT,
  SESSIONS_LIST_WIDTH_MAX,
  SESSIONS_LIST_WIDTH_MIN,
  SESSIONS_LIST_WIDTH_STEP,
} from "../sessions-preview-layout.js";

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

/** The custom property Preview Right's list column reads (styles.css, `[data-layout="right"]`). */
const LIST_WIDTH_PROPERTY = "--sessions-list-w";

/**
 * Preview Right's vertical divider (docs/design-system.md §6, §6.3; #2219): the list column's right
 * hairline with a grip that shows on hover. A drag follows the pointer; ←/→ move 16px, Home and End
 * go to 280px and 440px, and Enter or a double-click restores 400px. Only a release or a key stores
 * a width.
 */
export function SessionsListWidthDivider({
  grid,
  width,
  onWidthChange,
}: {
  /** The `.sessions-md` grid. A drag sets its list column directly, without a render per move. */
  grid: RefObject<HTMLElement | null>;
  width: number;
  onWidthChange: (width: number) => void;
}) {
  const drag = useRef<{ pointerId: number; offset: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // An unfinished drag (the window narrows to the stacked layout, or B opens the board) must not
  // leave its width on the grid. The divider unmounts only when the grid leaves Preview Right, and
  // InboxView then stops rendering the property, so removing it here takes nothing from React.
  useEffect(() => () => {
    if (drag.current) grid.current?.style.removeProperty(LIST_WIDTH_PROPERTY);
    drag.current = null;
  }, [grid]);
  const commit = (next: number) => onWidthChange(clampSessionsListWidth(next));

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !grid.current) return;
    // The line stays under the pointer: a press off-centre in the band does not jump the column.
    const left = grid.current.getBoundingClientRect().left;
    drag.current = { pointerId: event.pointerId, offset: event.clientX - left - width, width };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };
  const follow = (clientX: number) => {
    const state = drag.current;
    const element = grid.current;
    if (!state || !element) return;
    state.width = clampSessionsListWidth(clientX - state.offset - element.getBoundingClientRect().left);
    element.style.setProperty(LIST_WIDTH_PROPERTY, `${state.width}px`);
  };
  /** A release stores the width; a cancelled pointer puts the column back where it was. */
  const finish = (event: ReactPointerEvent<HTMLDivElement>, store: boolean) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    // InboxView renders this property itself, so it is put back to the width React will render
    // rather than removed: React does not set it again when that width has not changed.
    grid.current?.style.setProperty(LIST_WIDTH_PROPERTY, `${store ? state.width : width}px`);
    if (store) commit(state.width);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "ArrowLeft") commit(width - SESSIONS_LIST_WIDTH_STEP);
    else if (event.key === "ArrowRight") commit(width + SESSIONS_LIST_WIDTH_STEP);
    else if (event.key === "Home") commit(SESSIONS_LIST_WIDTH_MIN);
    else if (event.key === "End") commit(SESSIONS_LIST_WIDTH_MAX);
    else if (event.key === "Enter") commit(SESSIONS_LIST_WIDTH_DEFAULT);
    else return;
    event.preventDefault();
  };

  return (
    <div
      className="master-detail-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize List and Preview"
      aria-valuemin={SESSIONS_LIST_WIDTH_MIN}
      aria-valuemax={SESSIONS_LIST_WIDTH_MAX}
      aria-valuenow={width}
      aria-valuetext={`List ${width}px wide`}
      tabIndex={0}
      data-dragging={dragging ? "" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={(event) => {
        if (drag.current?.pointerId === event.pointerId) follow(event.clientX);
      }}
      onPointerUp={(event) => finish(event, true)}
      onPointerCancel={(event) => finish(event, false)}
      onLostPointerCapture={(event) => finish(event, true)}
      onDoubleClick={() => commit(SESSIONS_LIST_WIDTH_DEFAULT)}
      onKeyDown={onKeyDown}
    />
  );
}
