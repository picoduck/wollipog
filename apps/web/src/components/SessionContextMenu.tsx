import { useEffect, useRef, type ReactNode } from "react";
import type { SessionReminderView, SessionView } from "@wollipog/protocol";
import { sessionArchiveControlLabel } from "../archive-actions.js";
import type { ConversationForkAvailability } from "../session-actions.js";
import { reminderMenuActionLabel } from "../session-reminders.js";
import { sessionDisplayTitle } from "../session-title.js";
import { shortcutAriaKeys, shortcutDisplay, type ShortcutId } from "../shortcuts.js";
import { consumeLongPressClick, handleMenuKeyDown } from "./interactions.js";
import {
  AlarmClockIcon,
  ArchiveIcon,
  DismissReminderIcon,
  EditIcon,
  MarkReadIcon,
  MarkUnreadIcon,
  PinIcon,
  ReplyIcon,
  ThreadForkIcon,
  UnpinIcon,
} from "./Icons.js";
import { MenuItem, MenuNote, MenuSeparator, MenuSurface } from "./Menu.js";
import { useIsCoarsePointer } from "./useIsMobile.js";

export interface SessionContextMenuState {
  sessionId: string;
  /** Viewport coordinates of the invoking pointer or the focused row's edge. */
  anchor: { x: number; y: number };
  /** Resolves the return-focus element AT RESTORE TIME — the grid for rows, the card's open
   * button for cards — so a virtualized remount between open and close cannot strand focus. */
  restoreTarget: () => HTMLElement | null;
}

/**
 * The session context menu (#154, #2214): one portalled `role="menu"` shared by a Sessions row's ⋯,
 * right-click and long-press, the preview bar's ⋯ and a board card, anchored to whatever opened it.
 * It is where every session action without a place of its own lives (docs/design-system.md §3.3),
 * in one order: Reply, Rename Session…, Pin, Mark Unread, Fork Conversation…, the reminder items,
 * then the archive item after a separator. It manages target identity and dismissal only — every
 * action keeps its owner's confirmation, undo, and availability semantics, which is why the items
 * receive the target `sessionId` back rather than closing over view state.
 *
 * Each item leads with its 16px icon, and an item with a Sessions list key shows the keycap in its
 * trailing slot (§9.1, §11.5) when `showKeys` says the key would act on this session.
 *
 * Rendering the shared MenuSurface (`.menu-backdrop` + `role="menu"`) buys the shell behaviors
 * for free: the app-level Escape ladder clicks the backdrop, and `shortcutLayerActive` suppresses every global binding
 * (j/k, digits, `b`) while the menu is open. Collection-owned keyboard handling comes from
 * `handleMenuKeyDown`, since one hook instance per virtualized row is not an option.
 */
export function SessionContextMenu({
  state,
  session,
  pinned,
  unread,
  snoozeAvailable,
  reminder,
  stopBeforeArchiveSupported,
  forkAvailability,
  showKeys = false,
  onClose,
  onReply,
  onRename,
  onTogglePin,
  onToggleUnread,
  onFork,
  onSnooze,
  onDismissReminder,
  onArchive,
  renameRefusal = null,
  archiveRefusal = null,
}: {
  state: SessionContextMenuState;
  session: Pick<SessionView, "title" | "archiveStatus" | "archived" | "status">;
  pinned: boolean;
  unread: boolean;
  snoozeAvailable: boolean;
  reminder?: SessionReminderView;
  stopBeforeArchiveSupported: boolean;
  /** Fork Conversation's availability (#2161). Absent, or not offered, leaves the item out; a
   * temporary block keeps it, disabled, with the reason as its second line. */
  forkAvailability?: ConversationForkAvailability;
  /** Whether the Sessions list keys act on this session, so the items may show their keycaps. */
  showKeys?: boolean;
  onClose: () => void;
  onReply: (sessionId: string) => void;
  onRename: (sessionId: string) => void;
  onTogglePin: (sessionId: string) => void;
  onToggleUnread: (sessionId: string) => void;
  onFork?: (sessionId: string) => void;
  onSnooze: (sessionId: string) => void;
  onDismissReminder?: (sessionId: string) => void;
  onArchive: (sessionId: string) => void;
  /** Why the signed-in person may not rename or archive the session (#1857). The item then stays
   * listed, disabled and described by the reason. */
  renameRefusal?: string | null;
  archiveRefusal?: string | null;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  // Keycaps are for a hardware keyboard: a coarse pointer hides them (§11.5).
  const coarsePointer = useIsCoarsePointer();
  const keys = showKeys && !coarsePointer;

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

  /** The keycap and its `aria-keyshortcuts`, when the list's key acts on this session. */
  const key = (id: ShortcutId): { trail?: ReactNode; "aria-keyshortcuts"?: string } => keys
    ? { trail: <kbd>{shortcutDisplay(id)}</kbd>, "aria-keyshortcuts": shortcutAriaKeys(id) }
    : {};

  // One refusal that covers both Rename and Archive is said once, above them, not under each.
  const sharedRefusal = renameRefusal !== null && renameRefusal === archiveRefusal ? renameRefusal : null;
  const sharedRefusalId = `session-menu-refusal-${state.sessionId}`;
  const forkOffered = forkAvailability !== undefined && onFork !== undefined &&
    (forkAvailability.available || forkAvailability.offered);
  const forkReason = forkAvailability?.available === false ? forkAvailability.reason : null;
  const title = sessionDisplayTitle(session.title);

  return (
    <MenuSurface
      surfaceRef={menuRef}
      anchor={{ point: state.anchor }}
      label={`Session Actions for ${title}`}
      // On a phone the bottom sheet is titled with the session's one-line title (#2214).
      sheetTitle={title}
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
      <MenuItem icon={<ReplyIcon />} {...key("inbox-reply")} onClick={act(onReply, false)}>
        Reply
      </MenuItem>
      <MenuItem
        icon={<EditIcon />}
        disabled={renameRefusal !== null}
        description={sharedRefusal === null ? renameRefusal ?? undefined : undefined}
        aria-describedby={sharedRefusal === null ? undefined : sharedRefusalId}
        title={renameRefusal ?? undefined}
        onClick={act(onRename, false)}
      >
        Rename Session…
      </MenuItem>
      <MenuItem icon={pinned ? <UnpinIcon /> : <PinIcon />} {...key("inbox-pin")} onClick={act(onTogglePin, true)}>
        {pinned ? "Unpin Session" : "Pin Session"}
      </MenuItem>
      <MenuItem icon={unread ? <MarkReadIcon /> : <MarkUnreadIcon />} {...key("inbox-unread")} onClick={act(onToggleUnread, true)}>
        {unread ? "Mark Read" : "Mark Unread"}
      </MenuItem>
      {forkOffered && (
        <MenuItem
          icon={<ThreadForkIcon />}
          disabled={forkReason !== null}
          description={forkReason ?? undefined}
          {...key("inbox-fork")}
          // The fork's confirmation takes focus and returns it to the list.
          onClick={forkReason === null ? act(onFork!, false) : undefined}
        >
          Fork Conversation…
        </MenuItem>
      )}
      {snoozeAvailable && (
        <MenuItem icon={<AlarmClockIcon />} {...key("inbox-snooze")} onClick={act(onSnooze, false)}>
          {reminderMenuActionLabel(reminder)}
        </MenuItem>
      )}
      {reminder?.state === "fired" && onDismissReminder && (
        <MenuItem icon={<DismissReminderIcon />} onClick={act(onDismissReminder, true)}>
          Dismiss Reminder
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem
        icon={<ArchiveIcon />}
        danger
        disabled={archiveRefusal !== null}
        description={sharedRefusal === null ? archiveRefusal ?? undefined : undefined}
        aria-describedby={sharedRefusal === null ? undefined : sharedRefusalId}
        title={archiveRefusal ?? undefined}
        {...key("inbox-archive")}
        onClick={act(onArchive, true)}
      >
        {sessionArchiveControlLabel(session, stopBeforeArchiveSupported)}
      </MenuItem>
    </MenuSurface>
  );
}
