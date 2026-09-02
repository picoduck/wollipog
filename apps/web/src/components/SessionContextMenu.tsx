import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { anchoredMenuPlacement, consumeLongPressClick, handleMenuKeyDown, pointAnchorRect } from "./interactions.js";

export interface SessionContextMenuState {
  sessionId: string;
  /** Viewport coordinates of the invoking pointer or the focused row's edge. */
  anchor: { x: number; y: number };
  /** Resolves the return-focus element AT RESTORE TIME — the grid for rows, the card's open
   * button for cards — so a virtualized remount between open and close cannot strand focus. */
  restoreTarget: () => HTMLElement | null;
}

const MENU_WIDTH = 220;
const MENU_HEIGHT = 160;

/**
 * The row/card context menu (#154): one portalled `role="menu"` shared by the Sessions list and
 * the board, anchored to the invoking pointer. It manages target identity and dismissal only —
 * every action keeps its owner's confirmation, undo, and availability semantics, which is why
 * the items receive the target `sessionId` back rather than closing over view state.
 *
 * Rendering `.menu-backdrop` + `role="menu"` buys the shell behaviors for free: the app-level
 * Escape ladder clicks the backdrop, and `shortcutLayerActive` suppresses every global binding
 * (j/k, digits, `b`) while the menu is open. Collection-owned keyboard handling comes from
 * `handleMenuKeyDown`, since one hook instance per virtualized row is not an option.
 */
export function SessionContextMenu({
  state,
  sessionTitle,
  snoozeAvailable,
  onClose,
  onRename,
  onSnooze,
  onArchive,
}: {
  state: SessionContextMenuState;
  sessionTitle: string;
  snoozeAvailable: boolean;
  onClose: () => void;
  onRename: (sessionId: string) => void;
  onSnooze: (sessionId: string) => void;
  onArchive: (sessionId: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  const style = useMemo<CSSProperties>(() => {
    const placement = anchoredMenuPlacement({
      trigger: pointAnchorRect(state.anchor.x, state.anchor.y),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      desiredWidth: MENU_WIDTH,
      desiredHeight: MENU_HEIGHT,
    });
    return {
      position: "fixed",
      top: placement.top === "auto" ? "auto" : placement.top,
      bottom: placement.bottom === "auto" ? "auto" : placement.bottom,
      left: placement.left,
      right: "auto",
      width: placement.width,
      maxHeight: placement.maxHeight,
    };
  }, [state.anchor.x, state.anchor.y]);

  // The menu owns focus while open; the virtualized collections never focus their rows, so
  // initial focus goes straight to the first action.
  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [state.sessionId]);

  const close = (restoreFocus: boolean) => {
    onClose();
    if (restoreFocus) state.restoreTarget()?.focus();
  };

  // Dialog-opening actions close WITHOUT restoring focus — the dialog takes it, and its own
  // return-focus handling brings it back (the SessionHeader menu's established ordering).
  const act = (action: (sessionId: string) => void, restoreFocus: boolean) => () => {
    const target = state.sessionId;
    close(restoreFocus);
    action(target);
  };

  return createPortal(
    <>
      <div
        className="menu-backdrop"
        onClick={() => {
          // The click a long-press releases lands HERE — the backdrop mounted over the finger.
          // That click is the opening gesture, not a dismissal; consuming it once keeps the
          // NEXT backdrop click (a dismissal tap, the Escape ladder) working normally.
          if (consumeLongPressClick()) return;
          close(true);
        }}
        aria-hidden="true"
      />
      <div
        ref={menuRef}
        className="menu-pop"
        role="menu"
        aria-label={`Session Actions for ${sessionTitle}`}
        style={style}
        onKeyDown={(event) => handleMenuKeyDown(event, close)}
        onContextMenu={(event) => event.preventDefault()}
      >
        <button type="button" className="menu-item" role="menuitem" onClick={act(onRename, false)}>
          Rename Session…
        </button>
        {snoozeAvailable && (
          <button type="button" className="menu-item" role="menuitem" onClick={act(onSnooze, false)}>
            Snooze…
          </button>
        )}
        <button type="button" className="menu-item menu-danger" role="menuitem" onClick={act(onArchive, true)}>
          Archive
        </button>
      </div>
    </>,
    document.body,
  );
}
