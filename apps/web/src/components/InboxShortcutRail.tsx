import { useId } from "react";
import type { SessionView } from "@wollipog/protocol";
import { sessionArchiveActionLabel } from "../archive-actions.js";
import { sessionArchiveActionRefusal, sessionCommandRefusal } from "../session-command-permissions.js";
import type { ConversationForkAvailability } from "../session-actions.js";

export interface InboxShortcutRailProps {
  session: SessionView | null;
  pinned: boolean;
  busy: boolean;
  forkAvailability: ConversationForkAvailability;
  stopBeforeArchiveSupported: boolean;
  onApprove: () => void;
  onDeny: () => void;
  onReply: () => void;
  onExpand: () => void;
  onFork: () => void;
  onTogglePin: () => void;
  onMarkUnread: () => void;
  onArchive: () => void;
  onSnooze?: () => void;
}

interface ShortcutButtonProps {
  label: string;
  shortcut: string;
  disabled: boolean;
  disabledReason?: string;
  onClick: () => void;
}

function ShortcutButton({ label, shortcut, disabled, disabledReason, onClick }: ShortcutButtonProps) {
  const reasonId = useId();
  const describe = disabled && Boolean(disabledReason);
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
        title={describe ? disabledReason : `${label} (${shortcut})`}
        aria-label={label}
        aria-describedby={describe ? reasonId : undefined}
      >
        {label} <kbd aria-hidden="true">{shortcut}</kbd>
      </button>
      {/* A disabled control's tooltip is announced by nothing, so the reason is also its description. */}
      {describe && <span className="sr-only" id={reasonId}>{disabledReason}</span>}
    </>
  );
}

export function InboxShortcutRail({
  session,
  pinned,
  busy,
  forkAvailability,
  stopBeforeArchiveSupported,
  onApprove,
  onDeny,
  onReply,
  onExpand,
  onFork,
  onTogglePin,
  onMarkUnread,
  onArchive,
  onSnooze,
}: InboxShortcutRailProps) {
  if (!session) {
    return <div className="inbox-shortcut-rail is-empty" aria-label="Selected Session Shortcuts" />;
  }
  // A person the server refuses these commands (a Viewer) keeps each shortcut, disabled with the
  // reason (#1857). Busy still explains itself by being transient.
  const respondRefusal = sessionCommandRefusal(session, "respond");
  const archiveRefusal = sessionArchiveActionRefusal(session);

  return (
    <div className="inbox-shortcut-rail" role="group" aria-label={`Shortcuts for ${session.title}`}>
      {session.pendingApproval && (
        <span className="inbox-shortcut-context" role="group" aria-label="Approval Shortcuts">
          <ShortcutButton
            label="Approve"
            shortcut="A"
            disabled={busy || respondRefusal !== null}
            disabledReason={respondRefusal ?? undefined}
            onClick={onApprove}
          />
          <ShortcutButton
            label="Deny"
            shortcut="D"
            disabled={busy || respondRefusal !== null}
            disabledReason={respondRefusal ?? undefined}
            onClick={onDeny}
          />
        </span>
      )}
      <span className="inbox-shortcut-standard" role="group" aria-label="Session Shortcuts">
        <ShortcutButton label="Reply" shortcut="R" disabled={busy} onClick={onReply} />
        <ShortcutButton label="Expand" shortcut="Enter" disabled={busy} onClick={onExpand} />
        <ShortcutButton
          label="Fork"
          shortcut="F"
          disabled={busy || !forkAvailability.available}
          disabledReason={busy ? "Another session action is already in progress." : forkAvailability.available ? undefined : forkAvailability.reason}
          onClick={onFork}
        />
        <ShortcutButton label={pinned ? "Unpin" : "Pin"} shortcut="S" disabled={busy} onClick={onTogglePin} />
        <ShortcutButton label="Unread" shortcut="U" disabled={busy} onClick={onMarkUnread} />
        <ShortcutButton
          label={sessionArchiveActionLabel(session, stopBeforeArchiveSupported)}
          shortcut="E"
          disabled={busy || archiveRefusal !== null}
          disabledReason={archiveRefusal ?? undefined}
          onClick={onArchive}
        />
        {onSnooze && (
          <ShortcutButton label="Snooze" shortcut="H" disabled={busy} onClick={onSnooze} />
        )}
      </span>
    </div>
  );
}
