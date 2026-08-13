import type { SessionView } from "@wollipog/protocol";

export interface InboxShortcutRailProps {
  session: SessionView | null;
  pinned: boolean;
  busy: boolean;
  onApprove: () => void;
  onDeny: () => void;
  onReply: () => void;
  onExpand: () => void;
  onTogglePin: () => void;
  onMarkUnread: () => void;
  onArchive: () => void;
}

interface ShortcutButtonProps {
  label: string;
  shortcut: string;
  disabled: boolean;
  onClick: () => void;
}

function ShortcutButton({ label, shortcut, disabled, onClick }: ShortcutButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      title={`${label} (${shortcut})`}
      aria-label={label}
    >
      {label} <kbd aria-hidden="true">{shortcut}</kbd>
    </button>
  );
}

export function InboxShortcutRail({
  session,
  pinned,
  busy,
  onApprove,
  onDeny,
  onReply,
  onExpand,
  onTogglePin,
  onMarkUnread,
  onArchive,
}: InboxShortcutRailProps) {
  if (!session) {
    return <div className="inbox-shortcut-rail is-empty" aria-label="Selected Session Shortcuts" />;
  }

  return (
    <div className="inbox-shortcut-rail" role="group" aria-label={`Shortcuts for ${session.title}`}>
      {session.pendingApproval && (
        <span className="inbox-shortcut-context" role="group" aria-label="Approval Shortcuts">
          <ShortcutButton label="Approve" shortcut="A" disabled={busy} onClick={onApprove} />
          <ShortcutButton label="Deny" shortcut="D" disabled={busy} onClick={onDeny} />
        </span>
      )}
      <span className="inbox-shortcut-standard" role="group" aria-label="Session Shortcuts">
        <ShortcutButton label="Reply" shortcut="R" disabled={busy} onClick={onReply} />
        <ShortcutButton label="Expand" shortcut="Enter" disabled={busy} onClick={onExpand} />
        <ShortcutButton label={pinned ? "Unpin" : "Pin"} shortcut="S" disabled={busy} onClick={onTogglePin} />
        <ShortcutButton label="Unread" shortcut="U" disabled={busy} onClick={onMarkUnread} />
        <ShortcutButton label="Archive" shortcut="E" disabled={busy} onClick={onArchive} />
      </span>
    </div>
  );
}
