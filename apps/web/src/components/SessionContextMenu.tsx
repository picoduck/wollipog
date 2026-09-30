import { useEffect, useRef } from "react";
import type { SessionReminderView } from "@wollipog/protocol";
import { reminderMenuActionLabel } from "../session-reminders.js";
import { consumeLongPressClick, handleMenuKeyDown } from "./interactions.js";
import { MenuItem, MenuNote, MenuSeparator, MenuSurface } from "./Menu.js";

export interface SessionContextMenuState {
  sessionId: string;
  /** Viewport coordinates of the invoking pointer or the focused row's edge. */
  anchor: { x: number; y: number };
  /** Resolves the return-focus element AT RESTORE TIME — the grid for rows, the card's open
   * button for cards — so a virtualized remount between open and close cannot strand focus. */
  restoreTarget: () => HTMLElement | null;
}

/**
 * The row/card context menu (#154): one portalled `role="menu"` shared by the Sessions list and
 * the board, anchored to the invoking pointer. It manages target identity and dismissal only —
 * every action keeps its owner's confirmation, undo, and availability semantics, which is why
 * the items receive the target `sessionId` back rather than closing over view state.
 *
 * Rendering the shared MenuSurface (`.menu-backdrop` + `role="menu"`) buys the shell behaviors
 * for free: the app-level Escape ladder clicks the backdrop, and `shortcutLayerActive` suppresses every global binding
 * (j/k, digits, `b`) while the menu is open. Collection-owned keyboard handling comes from
 * `handleMenuKeyDown`, since one hook instance per virtualized row is not an option.
 */
export function SessionContextMenu({
  state,
  sessionTitle,
  pinned,
  snoozeAvailable,
  reminder,
  onClose,
  onRename,
  onTogglePin,
  onSnooze,
  onDismissReminder,
  onArchive,
  renameRefusal = null,
  archiveRefusal = null,
}: {
  state: SessionContextMenuState;
  sessionTitle: string;
  pinned: boolean;
  snoozeAvailable: boolean;
  reminder?: SessionReminderView;
  onClose: () => void;
  onRename: (sessionId: string) => void;
  onTogglePin: (sessionId: string) => void;
  onSnooze: (sessionId: string) => void;
  onDismissReminder?: (sessionId: string) => void;
  onArchive: (sessionId: string) => void;
  /** Why the signed-in person may not rename or archive the session (#1857). The item then stays
   * listed, disabled and described by the reason. */
  renameRefusal?: string | null;
  archiveRefusal?: string | null;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  // The menu owns focus while open; the virtualized collections never focus their rows, so
  // initial focus goes straight to the first action.
  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
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

  // One refusal that covers both Rename and Archive is said once, above them, not under each.
  const sharedRefusal = renameRefusal !== null && renameRefusal === archiveRefusal ? renameRefusal : null;
  const sharedRefusalId = `session-menu-refusal-${state.sessionId}`;

  return (
    <MenuSurface
      surfaceRef={menuRef}
      anchor={{ point: state.anchor }}
      label={`Session Actions for ${sessionTitle}`}
      onDismiss={() => {
        // The click a long-press releases lands on the backdrop — mounted over the finger. That
        // click is the opening gesture, not a dismissal; consuming it once keeps the NEXT backdrop
        // click (a dismissal tap, the Escape ladder) working normally.
        if (consumeLongPressClick()) return;
        close(true);
      }}
      // On a phone the menu is a bottom sheet, which can mount under the finger that long-pressed
      // a low row: the click its release synthesizes lands on the sheet, not on the backdrop. That
      // click is the opening gesture, so the sheet consumes it at capture and it runs nothing —
      // wherever it lands. Left to an item, a release on the title row or grabber went unspent and
      // its grace swallowed the next real tap on an item (#2082).
      onClickCapture={(event) => {
        if (!consumeLongPressClick()) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => handleMenuKeyDown(event, close)}
      onContextMenu={(event) => event.preventDefault()}
    >
      {sharedRefusal !== null && <MenuNote id={sharedRefusalId}>{sharedRefusal}</MenuNote>}
      <MenuItem
        disabled={renameRefusal !== null}
        description={sharedRefusal === null ? renameRefusal ?? undefined : undefined}
        aria-describedby={sharedRefusal === null ? undefined : sharedRefusalId}
        title={renameRefusal ?? undefined}
        onClick={act(onRename, false)}
      >
        Rename Session…
      </MenuItem>
      <MenuItem onClick={act(onTogglePin, true)}>
        {pinned ? "Unpin Session" : "Pin Session"}
      </MenuItem>
      {snoozeAvailable && (
        <MenuItem onClick={act(onSnooze, false)}>
          {reminderMenuActionLabel(reminder)}
        </MenuItem>
      )}
      {reminder?.state === "fired" && onDismissReminder && (
        <MenuItem onClick={act(onDismissReminder, true)}>
          Dismiss Reminder
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem
        danger
        disabled={archiveRefusal !== null}
        description={sharedRefusal === null ? archiveRefusal ?? undefined : undefined}
        aria-describedby={sharedRefusal === null ? undefined : sharedRefusalId}
        title={archiveRefusal ?? undefined}
        onClick={act(onArchive, true)}
      >
        Archive
      </MenuItem>
    </MenuSurface>
  );
}
