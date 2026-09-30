import { useEffect, useRef } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { sessionAttentionStatus } from "@wollipog/protocol";
import { statusMeta, type StatusMeta } from "../status-meta.js";
import { closeGuardLinks, WORK_IN_FLIGHT, type CloseGuardLinks, type CloseGuardSession } from "../desktop-close-guard.js";
import { useFeedback, type ConfirmationDetailRow } from "./FeedbackProvider.js";

/** The event the shell emits when it holds a close back. */
export const CLOSE_WOULD_STOP_WORK = "wollipog://close-would-stop-work";

/** The shell command behind Quit Anyway: it exits without holding the close a second time. */
export const QUIT_AFTER_CONFIRMATION = "quit_after_confirmation";

export interface CloseGuardShell {
  isTauri(): boolean;
  /** Subscribe to a shell event; resolves to its unsubscribe. */
  listen(event: string, handler: (payload: unknown) => void): Promise<() => void>;
  /** Quit Wollipog without asking again. */
  quit(): Promise<void>;
}

/** The real shell. Injected as a prop so the component is testable without a Tauri webview. */
const shell: CloseGuardShell = {
  isTauri,
  listen: (event, handler) => listen(event, (received) => handler(received.payload)),
  quit: () => invoke<void>(QUIT_AFTER_CONFIRMATION),
};

/** What the shell said when it held the close: how many sessions have a turn open, and which. */
export interface HeldClose {
  /** 0 when the shell could not get a count. */
  count: number;
  sessionIds: string[];
}

/**
 * Read the shell's payload: `{ count, sessionIds }`, or the bare count an older shell sends. Anything
 * else is a count the shell could not give, which is what 0 already means.
 */
export function heldClose(payload: unknown): HeldClose {
  const countOf = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  if (typeof payload === "number") return { count: countOf(payload), sessionIds: [] };
  if (!payload || typeof payload !== "object") return { count: 0, sessionIds: [] };
  const { count, sessionIds } = payload as { count?: unknown; sessionIds?: unknown };
  return {
    count: countOf(count),
    sessionIds: Array.isArray(sessionIds) ? sessionIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [],
  };
}

/**
 * The confirmation's body: "2 sessions are still working. …" — and a count of zero means the shell
 * could not get one.
 *
 * The shell holds the close when the control plane is up but unanswerable, because a needless
 * question costs a keypress and a missed one costs an agent turn. It has no number to report then,
 * and inventing one would be worse than saying so.
 */
export function closeWarning(count: number): string {
  if (count <= 0) return "Wollipog couldn't check whether agents are still working. Quitting stops any turn that is in progress.";
  return count === 1
    ? "1 session is still working. Quitting stops its current turn; you can continue it after you reopen Wollipog."
    : `${count} sessions are still working. Quitting stops their current turns; you can continue them after you reopen Wollipog.`;
}

/**
 * A row's badge: the attention a person owes the session, otherwise its lifecycle. The shell lists a
 * session with a pending approval whatever its status, so an idle one badged "Awaiting Prompt" would
 * contradict "still working" and hide why it is listed (#2057). Attention is the shared human-owned
 * projection, as in the Inbox and the archive confirmation: a request only the Orchestrator owns
 * does not claim the row, and a campaign's human-owned requests do (#2100). A row has no room for the
 * owner the full attention label names, so it shows its kind's shared label.
 *
 * Attention always addresses the person, so a row listed only for an Orchestrator-owned request
 * keeps its lifecycle while that is work in flight. A settled one says "Awaiting Input": true, since
 * the request holds it open on a decision, and it does not say the person must act. A bare
 * "input_required" status with no request behind it is the projection's legacy fallback, which the
 * lifecycle already says as "Awaiting Input".
 */
export function closeRowStatus(session: CloseGuardSession): StatusMeta {
  const attention = sessionAttentionStatus(session);
  const legacyInput = attention?.kind === "input_required" && !session.pendingApproval &&
    !session.orchestratorCampaign?.pendingRequests?.human;
  if (attention && !legacyInput) return statusMeta("attention", attention.kind);
  if (session.pendingApproval && !WORK_IN_FLIGHT[session.status]) return statusMeta("session", "input_required");
  return statusMeta("session", session.status);
}

/**
 * The working sessions the local instance can name, and how many it cannot. With none named, the
 * count sentence stands alone rather than above an "and 2 more" that names nothing.
 */
export function closeDetailRows(held: HeldClose, links: CloseGuardLinks): { rows: ConfirmationDetailRow[]; overflow: number } {
  const { session } = links.current();
  if (held.count <= 0 || !session) return { rows: [], overflow: 0 };
  const rows: ConfirmationDetailRow[] = [];
  for (const id of new Set(held.sessionIds)) {
    const known = session(id);
    if (known) rows.push({ label: known.title || "Untitled Session", status: closeRowStatus(known) });
  }
  if (rows.length === 0) return { rows: [], overflow: 0 };
  return { rows, overflow: Math.max(0, held.count - rows.length) };
}

/**
 * §23.1 — quitting the desktop app kills in-flight agent work, so ask once before it does (#1965).
 *
 * The shell decides: at close time it asks the local control plane what is in flight, because that
 * is what exit destroys, and holds the close. This turns that into a decision: Keep Open, Show
 * Sessions, or Quit Anyway, which quits through a command the shell does not hold a second time.
 * Closing the window again while this is open still quits — the shell's own escape hatch, for a
 * webview that cannot answer.
 *
 * Renders nothing itself, and does nothing at all in a browser.
 */
export function DesktopCloseGuard({ desktop = shell, links = closeGuardLinks }: {
  desktop?: CloseGuardShell;
  links?: CloseGuardLinks;
} = {}) {
  const { confirm } = useFeedback();
  /** One question at a time: a close held again while it is open is already being asked about. */
  const asking = useRef(false);

  useEffect(() => {
    if (!desktop.isTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void desktop.listen(CLOSE_WOULD_STOP_WORK, (payload) => {
      if (asking.current) return;
      asking.current = true;
      const held = heldClose(payload);
      const { rows, overflow } = closeDetailRows(held, links);
      const { showSessions } = links.current();
      void confirm({
        title: "Quit Wollipog",
        message: closeWarning(held.count),
        detailRows: rows,
        detailRowsOverflow: overflow,
        confirmLabel: "Quit Anyway",
        cancelLabel: "Keep Open",
        ...(showSessions ? { secondaryAction: { label: "Show Sessions", run: showSessions } } : {}),
        tone: "danger",
        onConfirm: () => desktop.quit(),
        progress: "Quitting Wollipog…",
        cancelWhileRunning: false,
      }).finally(() => { asking.current = false; });
    }).then((unlisten) => {
      // `listen` can resolve after an unmount; drop the subscription rather than leak it.
      if (disposed) unlisten();
      else stop = unlisten;
    }).catch(() => {
      // An older shell emits nothing, so there is nothing to listen for and nothing to repair.
    });
    return () => { disposed = true; stop?.(); };
  }, [confirm, desktop, links]);

  return null;
}
