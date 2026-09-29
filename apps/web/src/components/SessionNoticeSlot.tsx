import React, { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuSurface } from "./Menu.js";
import { ToneIcon } from "./Notice.js";

/**
 * The one notice slot between the transcript and the composer (docs/design-system.md §13.2,
 * Budget and Placement; #1966).
 *
 * A session can hold several problem states at once. Each one is an entry here rather than its own
 * banner, and the slot shows exactly one: the most severe, then the lowest rank. The others wait
 * behind a "+N More" menu in the shown notice's title row. Choosing one there shows it until the set
 * of conditions changes; any change returns the slot to the most severe.
 *
 * ADDING AN ENTRY. Every session notice above the composer belongs here, including the Composer
 * epic's composer errors, attachment notes and queued-message errors: give it a stable `key`, a
 * severity that matches the session's badge tone for the same state, a rank from
 * `SESSION_NOTICE_RANK` (add one there, so the order stays in one table), a one-line Title Case
 * `title` for the menu, and a `render` that returns one `Notice` (or a component built on it) and
 * passes the context's `trailing` to the notice's `trailing` prop, and, for an info entry,
 * `onDismiss` to its `onDismiss`. The Approvals epic's request dock takes the slot ahead of every
 * entry while a request is pending; it is not an entry.
 */

export type SessionNoticeSeverity = "danger" | "warning" | "info";

/** What the slot hands an entry's `render`. */
export interface SessionNoticeContext {
  /** The "+N More" control, or null when this is the only condition. Pass it to `Notice`'s
   * `trailing` so it sits in the title row. */
  trailing: ReactNode;
  /** Present only for an info entry: hides it for this session until the page reloads. Danger and
   * warning conditions are not dismissible by the slot; an entry with its own dismissal (the failed
   * account switch) wires that itself. */
  onDismiss?: () => void;
}

export interface SessionNoticeEntry {
  /** Stable across renders while the condition holds. */
  key: string;
  severity: SessionNoticeSeverity;
  /** The order within a severity, lowest first. Take it from `SESSION_NOTICE_RANK`. */
  rank: number;
  /** One line, Title Case: the menu item that shows this condition. */
  title: string;
  render: (context: SessionNoticeContext) => ReactNode;
}

/** Every entry's rank, in one table so the order is reviewed in one place (#1966). */
export const SESSION_NOTICE_RANK = {
  worktreeMissing: 1,
  historyQuarantine: 2,
  worktreeSetupFailed: 3,
  accountSwitchFailed: 4,
  skillsUnavailable: 8,
  setupSuggestion: 9,
} as const;

const SEVERITY_ORDER: Record<SessionNoticeSeverity, number> = { danger: 0, warning: 1, info: 2 };

/** Most severe first, then the lowest rank; the key breaks a tie so the order is total. */
export function compareSessionNotices(
  a: Pick<SessionNoticeEntry, "key" | "severity" | "rank">,
  b: Pick<SessionNoticeEntry, "key" | "severity" | "rank">,
): number {
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.rank - b.rank ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** Info dismissals, per session, for the life of the page. Module state rather than component
 * state, so leaving a session and coming back does not bring a dismissed note back. */
const dismissedInfo = new Map<string, ReadonlySet<string>>();
const dismissalListeners = new Set<() => void>();

function subscribeDismissals(listener: () => void): () => void {
  dismissalListeners.add(listener);
  return () => {
    dismissalListeners.delete(listener);
  };
}

const EMPTY: ReadonlySet<string> = new Set();

function dismissInfo(sessionId: string, key: string): void {
  dismissedInfo.set(sessionId, new Set([...(dismissedInfo.get(sessionId) ?? []), key]));
  for (const listener of [...dismissalListeners]) listener();
}

export function SessionNoticeSlot({ sessionId, entries }: {
  sessionId: string;
  entries: readonly SessionNoticeEntry[];
}) {
  const dismissed = useSyncExternalStore(
    subscribeDismissals,
    () => dismissedInfo.get(sessionId) ?? EMPTY,
    () => EMPTY,
  );
  const visible = entries
    .filter((entry) => entry.severity !== "info" || !dismissed.has(entry.key))
    .sort(compareSessionNotices);
  // The set of conditions, order-free. A choice from "+N More" holds only while it is unchanged.
  const signature = visible.map((entry) => entry.key).sort().join("\n");
  const [choice, setChoice] = useState<{ key: string; signature: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useAccessibleMenu(menuOpen, setMenuOpen, "session-notice-more");
  const focusTrigger = useRef(false);
  const slotRef = useRef<HTMLDivElement>(null);

  const shown = (choice?.signature === signature ? visible.find((entry) => entry.key === choice.key) : undefined) ??
    visible[0];
  const rest = visible.filter((entry) => entry !== shown);

  // The trigger belongs to whichever notice is shown, so after a choice it is a new button. Focus
  // follows it, rather than falling to <body> with the menu.
  useLayoutEffect(() => {
    if (!focusTrigger.current) return;
    focusTrigger.current = false;
    menu.triggerRef.current?.focus();
  });
  // A condition can resolve while its menu is open. The focused item goes with it, and when it was
  // the last one so do the menu and its trigger; focus stays in the slot rather than falling to
  // <body>. Nothing else moves focus here, so a lost focus is ours to restore.
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const document = slotRef.current?.ownerDocument;
    const focusLost = !document?.activeElement || document.activeElement === document.body;
    if (rest.length === 0) {
      setMenuOpen(false);
      if (focusLost) {
        (slotRef.current?.querySelector<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled)") ??
          slotRef.current)?.focus();
      }
    } else if (focusLost) {
      menu.menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }
  });

  if (!shown) return null;

  const trailing = rest.length === 0 ? null : (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        className="btn sm ghost session-notice-more"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menu.menuId : undefined}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
      >
        +{rest.length} More
      </button>
      {menuOpen && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label="Session Notices"
          align="end"
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          {rest.map((entry) => (
            <MenuItem
              key={entry.key}
              icon={<span className={`session-notice-tone t-${entry.severity}`}><ToneIcon tone={entry.severity} /></span>}
              onClick={() => {
                menu.close(false);
                focusTrigger.current = true;
                setChoice({ key: entry.key, signature });
              }}
            >
              {entry.title}
            </MenuItem>
          ))}
        </MenuSurface>
      )}
    </>
  );

  return (
    <div ref={slotRef} className="session-notice-slot" data-notice-key={shown.key} tabIndex={-1}>
      {shown.render({
        trailing,
        ...(shown.severity === "info" ? { onDismiss: () => dismissInfo(sessionId, shown.key) } : {}),
      })}
    </div>
  );
}
