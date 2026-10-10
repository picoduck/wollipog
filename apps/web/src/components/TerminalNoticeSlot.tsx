import { SessionNoticeSlot, type SessionNoticeEntry } from "./SessionNoticeSlot.js";

/**
 * The terminal's one notice slot (docs/design-system.md §13.2; #2865): a terminal instance of
 * `SessionNoticeSlot`, built as the side panel's `PanelNoticeSlot` is, directly above the terminal.
 * The terminal's conditions (its machine offline, a shell reconnecting, the Agent TUI blocked or
 * outside Wollipog's tracking, output that may be incomplete, a failed action) show one at a time,
 * the rest behind "+N More", rather than stacking as lines around the terminal. Their ranks are in
 * `TERMINAL_NOTICE_RANK`. It holds no placement logic, so any host of the terminal renders it.
 */
export function TerminalNoticeSlot({ sessionId, entries, onFocusLost }: {
  /** Whose info dismissals these are; kept apart from the session's and the panel's. */
  sessionId: string;
  entries: readonly SessionNoticeEntry[];
  /** Where focus goes when the slot is gone while it held focus: the terminal. */
  onFocusLost?: () => void;
}) {
  return (
    <SessionNoticeSlot
      sessionId={`terminal:${sessionId}`}
      entries={entries}
      label="Terminal Notices"
      className="terminal-notice-slot"
      onFocusLost={onFocusLost}
    />
  );
}
