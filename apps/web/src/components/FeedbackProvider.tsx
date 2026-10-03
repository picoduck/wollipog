import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Modal } from "./common.js";
import { CloseIcon } from "./Icons.js";
import { useMenuOpen } from "./Menu.js";
import { Notice, ToneIcon } from "./Notice.js";
import { StatusBadge } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";
import type { StatusMeta } from "../status-meta.js";
import { useIsMobile } from "./useIsMobile.js";

/** One thing a confirmation affects, drawn as a dense row under its body (§7.4). */
export interface ConfirmationDetailRow {
  /** The affected object's name, such as a session title. One line, truncated, with the full text in
   * a tooltip. */
  label: string;
  /** A short neutral fact, trailing in `--text-faint` (§11.3). */
  meta?: string;
  /** Drawn as the shared inline status badge, normally `statusMeta(domain, value)` (§11.1). */
  status?: StatusMeta;
}

/** Confirmation copy and behaviour (docs/design-system.md §7.4). Every field after the required ones
 * is optional, so a caller that does not use a field compiles unchanged when one is added. A new
 * field that changes what the dialog shows or offers also joins `confirmationFingerprint`, so two
 * requests that differ only in that field are never merged. */
export interface ConfirmationOptions {
  /** The action in Title Case, with no question mark: "Stop Session", "Delete Skill" (§7.4). */
  title: string;
  /** One or two sentences: what happens, to which named object, and whether it can be undone. */
  message: string;
  /** Content under the body that is not a list of affected objects, such as a mono preview. A list
   * uses `detailRows`. */
  details?: ReactNode;
  /** What the action affects, as one surface of dense rows under the body. At most
   * `MAX_CONFIRMATION_DETAIL_ROWS` show; the rest are counted in "and N more". The rows are part of
   * the dialog's accessible description. */
  detailRows?: readonly ConfirmationDetailRow[];
  /** Affected objects the caller knows of but cannot list (the server withheld them), added to the
   * "and N more" count. */
  detailRowsOverflow?: number;
  /** Required, and repeats the title's verb. There is no generic default such as "Continue": the
   * button names the outcome it runs. */
  confirmLabel: string;
  /** Title Case, replacing "Cancel" when the safe choice has a better name: "Keep Open", "Install
   * Later". The button keeps the secondary style, and choosing it, Escape, the backdrop and Back all
   * resolve false. */
  cancelLabel?: string;
  /** A harmless extra choice, drawn as a ghost button before Cancel (§3.2): "Show Sessions".
   * Choosing it closes the dialog, runs `run` and resolves false. It is not shown on a phone, whose
   * sheet footer holds two buttons (§7.5), so the caller must not depend on it there. */
  secondaryAction?: {
    /** Title Case. */
    label: string;
    run: () => void;
  };
  /** `danger` draws the danger confirm button and tone icon, and opens with focus on the cancel
   * button. Any other tone opens with focus on the confirm button (§7.4). */
  tone?: "default" | "danger";
  /** The text the person must type before the confirm button enables, normally the affected
   * object's name, for an irreversible action that affects many things (§7.4): Delete Group. The
   * dialog shows a field for it, opens with focus there rather than on Cancel, and compares exactly
   * (case and spaces included). */
  typeToConfirm?: string;
  /** Durable element to restore focus to after settling. Needed when the invoking control is
   * a menu item that unmounts as the confirmation opens — the activeElement snapshot below
   * would then be disconnected by the time focus can be restored. */
  returnFocus?: { current: HTMLElement | null };
  /** For a caller that waits on the action before closing: confirming runs this with the dialog
   * still open and the confirm button busy (§3.1), and `confirm()` resolves true once it succeeds.
   * A failure stays in the dialog as a danger notice, so the person can try again or cancel.
   * Cancelling while it runs aborts `signal` and resolves false. */
  onConfirm?: (signal: AbortSignal) => Promise<void>;
  /** Sentence case, announced while `onConfirm` runs: "Stopping the session…". */
  progress?: string;
  /** Cancel, Escape and the backdrop stay available while `onConfirm` runs unless this is false, for
   * an action that cannot be withdrawn once it has started. */
  cancelWhileRunning?: boolean;
}

interface ConfirmationRequest extends ConfirmationOptions {
  id: number;
  fingerprint: string;
  invoker: HTMLElement | null;
  resolve: (confirmed: boolean) => void;
}

/** At most this many detail rows show; the rest are counted in "and N more". */
export const MAX_CONFIRMATION_DETAIL_ROWS = 5;

function confirmationFingerprint(options: ConfirmationOptions): string {
  return [
    options.title,
    options.message,
    options.confirmLabel,
    options.tone ?? "",
    typeof options.details === "string" ? options.details : "",
    JSON.stringify((options.detailRows ?? []).map((row) => [row.label, row.meta ?? "", row.status?.label ?? "", row.status?.tone ?? ""])),
    String(options.detailRowsOverflow ?? 0),
    options.cancelLabel ?? "",
    options.secondaryAction?.label ?? "",
    options.typeToConfirm ?? "",
  ].join("\u0000");
}

function detailRowsOverflowCount(rows: readonly ConfirmationDetailRow[], overflow: number | undefined): number {
  const unlisted = Number.isFinite(overflow) ? Math.max(0, Math.floor(overflow!)) : 0;
  return Math.max(0, rows.length - MAX_CONFIRMATION_DETAIL_ROWS) + unlisted;
}

export interface ToastOptions {
  /** Live content for a message whose display preference can change while the toast is open. */
  messageContent?: ReactNode;
  tone?: "info" | "success" | "warning" | "error";
  /** An optional second line under the message, in the secondary text colour. */
  detail?: string;
  /** `mono` sets the detail line in the monospace face, for text the person may copy, such as a
   * URL. It wraps anywhere, so the whole of it stays visible. */
  detailStyle?: "mono";
  /** A link under the message, such as What's New. Title Case. On desktop it opens in the system
   * browser like every external link. */
  link?: { label: string; href: string };
  /** Milliseconds before an info or success toast dismisses itself; 0 keeps it until dismissed.
   * Warnings and errors persist unless a duration is given (§13.1). */
  durationMs?: number;
  action?: {
    /** Title Case. It stays on the button while the action runs, beside a spinner (§3.1). */
    label: string;
    /** Sentence case, announced while the action runs: "Installing the update…". */
    progress?: string;
    run: () => void | Promise<void>;
    failureLabel?: string;
    retryLabel?: string;
  };
}

interface ToastEntry extends ToastOptions {
  id: number;
  message: string;
  actionBusy?: boolean;
}

/** An Undo toast's tone. A change that went through is a success; one with a caveat, such as an
 * archive whose stop failed or is still running, is not (#2333). A warning stays until dismissed. */
export type UndoTone = "success" | "info" | "warning";

export type ShowUndo = (message: string, undo: () => void | Promise<void>, tone?: UndoTone) => number;

interface FeedbackContextValue {
  confirm: (options: ConfirmationOptions) => Promise<boolean>;
  showToast: (message: string, options?: ToastOptions) => number;
  showUndo: ShowUndo;
  dismissToast: (id: number) => void;
}

const unavailableFeedback: FeedbackContextValue = {
  // Components also render in isolated SSR/unit-test contexts. A missing provider must fail safe:
  // destructive actions are cancelled, while optional status messages become no-ops.
  confirm: async () => false,
  showToast: () => -1,
  showUndo: () => -1,
  dismissToast: () => undefined,
};

/**
 * Exported so a test can supply a recording implementation.
 *
 * Asserting that a toast is still on screen a moment after it appears does not test "it does not
 * auto-dismiss" — the check has to see the duration the caller asked for.
 */
export const FeedbackContext = createContext<FeedbackContextValue>(unavailableFeedback);

export function useFeedback(): FeedbackContextValue {
  return useContext(FeedbackContext);
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ConfirmationRequest | null>(null);
  const activeRef = useRef<ConfirmationRequest | null>(null);
  const confirmationQueue = useRef<ConfirmationRequest[]>([]);
  const pendingConfirmationFingerprints = useRef(new Set<string>());
  const stableConfirmationInvoker = useRef<HTMLElement | null>(null);
  const nextConfirmationId = useRef(1);
  const mounted = useRef(true);
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextToastId = useRef(1);
  /** Each auto-dismissing toast's pending timer and the time it still has left. Hovering or
   * focusing the stack pauses every timer, and so does a phone menu hiding it; once no reason is
   * left, each resumes with what it had left. */
  const toastTimers = useRef(new Map<number, { timer: number | null; deadline: number; remaining: number }>());
  const toastPauses = useRef(new Set<"interaction" | "hidden">());
  const toastRegion = useRef<HTMLDivElement | null>(null);
  const toastActionsInFlight = useRef(new Set<number>());

  const clearToastTimer = useCallback((id: number) => {
    const entry = toastTimers.current.get(id);
    if (entry?.timer != null) window.clearTimeout(entry.timer);
    toastTimers.current.delete(id);
  }, []);

  const dismissToast = useCallback((id: number) => {
    if (!mounted.current) return;
    clearToastTimer(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, [clearToastTimer]);

  const armToastTimer = useCallback((id: number, remaining: number) => {
    const deadline = Date.now() + remaining;
    const timer = toastPauses.current.size > 0 ? null : window.setTimeout(() => dismissToast(id), remaining);
    toastTimers.current.set(id, { timer, deadline, remaining });
  }, [dismissToast]);

  const pauseToastTimers = useCallback((reason: "interaction" | "hidden" = "interaction") => {
    const alreadyPaused = toastPauses.current.size > 0;
    toastPauses.current.add(reason);
    if (alreadyPaused) return;
    const now = Date.now();
    for (const entry of toastTimers.current.values()) {
      if (entry.timer != null) window.clearTimeout(entry.timer);
      entry.timer = null;
      entry.remaining = Math.max(0, entry.deadline - now);
    }
  }, []);

  const resumeToastTimers = useCallback((reason: "interaction" | "hidden" = "interaction") => {
    if (!toastPauses.current.delete(reason) || toastPauses.current.size > 0) return;
    for (const [id, entry] of toastTimers.current) armToastTimer(id, entry.remaining);
  }, [armToastTimer]);

  const showToast = useCallback((message: string, options: ToastOptions = {}) => {
    if (!mounted.current) return -1;
    const id = nextToastId.current++;
    const entry: ToastEntry = { id, message, ...options };
    // Every toast stays in state until it expires or is dismissed: the stack shows the newest few
    // and the rest wait behind "+N More", so no recovery action is ever evicted out of reach.
    setToasts((current) => [...current, entry]);
    const persistsByDefault = options.tone === "error" || options.tone === "warning";
    const duration = options.durationMs ?? (persistsByDefault ? 0 : options.action ? 10_000 : 5_000);
    if (duration > 0) armToastTimer(id, duration);
    return id;
  }, [armToastTimer]);

  const showUndo = useCallback((message: string, undo: () => void | Promise<void>, tone: UndoTone = "success") => (
    showToast(message, {
      tone,
      action: { label: "Undo", progress: "Undoing the change…", run: undo, failureLabel: "Undo failed", retryLabel: "Retry Undo" },
      // A warning stays until dismissed (§13.1), so the problem it reports is not missed (#2333).
      durationMs: tone === "warning" ? 0 : 10_000,
    })
  ), [showToast]);

  const presentNext = useCallback(() => {
    if (!mounted.current || activeRef.current) return;
    const next = confirmationQueue.current.shift() ?? null;
    activeRef.current = next;
    setActive(next);
  }, []);

  const confirm = useCallback((options: ConfirmationOptions) => new Promise<boolean>((resolve) => {
    if (!mounted.current) {
      resolve(false);
      return;
    }
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const stableCandidate = activeElement &&
      activeElement !== document.body &&
      !activeElement.closest(".feedback-confirmation")
      ? activeElement
      : null;
    if (stableCandidate) stableConfirmationInvoker.current = stableCandidate;
    const invoker = stableCandidate ?? stableConfirmationInvoker.current;
    // Fail closed: a confirmation that cannot name its outcome never runs it.
    if (typeof options.confirmLabel !== "string" || !options.confirmLabel.trim()) {
      resolve(false);
      return;
    }
    const fingerprint = confirmationFingerprint(options);
    if (pendingConfirmationFingerprints.current.has(fingerprint)) {
      resolve(false);
      return;
    }
    pendingConfirmationFingerprints.current.add(fingerprint);
    confirmationQueue.current.push({
      ...options,
      id: nextConfirmationId.current++,
      fingerprint,
      invoker,
      resolve,
    });
    presentNext();
  }), [presentNext]);

  const settleConfirmation = useCallback((confirmed: boolean) => {
    const request = activeRef.current;
    if (!request) return;
    activeRef.current = null;
    pendingConfirmationFingerprints.current.delete(request.fingerprint);
    setActive(null);
    request.resolve(confirmed);
    window.setTimeout(() => {
      if (!mounted.current || activeRef.current) return;
      if (confirmationQueue.current.length > 0) {
        presentNext();
        return;
      }
      // Focus that has moved on is left where it is: a dialog the outcome opened (a secondary action
      // such as Snooze Instead… opening Snooze) has taken it, or the person moved to another control
      // (a phone sheet's Back) before this task ran (#2397). Only focus the confirmation dropped, or
      // still holds, goes back to the invoker. The confirmation's own panel can still be mounted here.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused !== document.body && focused.isConnected &&
          !focused.closest(".feedback-confirmation")) {
        stableConfirmationInvoker.current = null;
        return;
      }
      // Try each candidate and verify it actually took focus — a connected target can still
      // refuse (it may have been disabled by the action the confirmation approved).
      const explicit = request.returnFocus?.current;
      if (explicit?.isConnected) explicit.focus();
      if (document.activeElement !== explicit && request.invoker?.isConnected) {
        request.invoker.focus();
      }
      stableConfirmationInvoker.current = null;
    }, 0);
  }, [presentNext]);

  const runToastAction = useCallback(async (toast: ToastEntry) => {
    if (!toast.action || toast.actionBusy || toastActionsInFlight.current.has(toast.id)) return;
    toastActionsInFlight.current.add(toast.id);
    clearToastTimer(toast.id);
    setToasts((current) => current.map((entry) => entry.id === toast.id ? { ...entry, actionBusy: true } : entry));
    try {
      await toast.action.run();
      if (!mounted.current) return;
      dismissToast(toast.id);
    } catch (cause) {
      if (!mounted.current) return;
      const detail = cause instanceof Error ? cause.message : String(cause);
      dismissToast(toast.id);
      showToast(`${toast.action.failureLabel ?? `${toast.action.label} failed`}: ${detail}`, {
        tone: "error",
        durationMs: 0,
        action: {
          ...toast.action,
          label: toast.action.retryLabel ?? "Retry",
        },
      });
    } finally {
      toastActionsInFlight.current.delete(toast.id);
    }
  }, [clearToastTimer, dismissToast, showToast]);

  useEffect(() => {
    // StrictMode runs setup → cleanup → setup in development; re-arm after its simulated cleanup.
    mounted.current = true;
    return () => {
      mounted.current = false;
      const pending = [activeRef.current, ...confirmationQueue.current].filter(
        (request): request is ConfirmationRequest => request != null,
      );
      activeRef.current = null;
      stableConfirmationInvoker.current = null;
      confirmationQueue.current = [];
      pendingConfirmationFingerprints.current.clear();
      pending.forEach((request) => request.resolve(false));
      for (const entry of toastTimers.current.values()) if (entry.timer != null) window.clearTimeout(entry.timer);
      toastTimers.current.clear();
      toastActionsInFlight.current.clear();
    };
  }, []);

  const value = useMemo<FeedbackContextValue>(() => ({ confirm, showToast, showUndo, dismissToast }), [
    confirm,
    dismissToast,
    showToast,
    showUndo,
  ]);
  const isPhone = useIsMobile();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreListId = useId();
  // Newest on top. Three are visible on desktop and one on a phone (§13.1); older ones wait behind
  // "+N More", whose list opens upward, so a persistent recovery toast is always reachable.
  const newestFirst = useMemo(() => [...toasts].sort((left, right) => right.id - left.id), [toasts]);
  const visibleCount = isPhone ? 1 : 3;
  const visibleToasts = newestFirst.slice(0, visibleCount);
  const olderToasts = newestFirst.slice(visibleCount);
  useEffect(() => {
    if (olderToasts.length === 0) setMoreOpen(false);
  }, [olderToasts.length]);
  useToastClearance(toasts.length > 0);

  // Dismissing the focused toast removes the element that held focus, and a removed element fires
  // no blur, so the pause it started would never end. After every change to the stack, resume
  // unless the pointer or focus is still inside it.
  useEffect(() => {
    const region = toastRegion.current;
    if (!toastPauses.current.has("interaction") || !region) return;
    if (region.contains(document.activeElement) || region.matches(":hover")) return;
    resumeToastTimers("interaction");
  }, [toasts, moreOpen, resumeToastTimers]);

  // On a phone an open menu or popover hides the stack (§13.1), so nothing may expire unseen: every
  // timer pauses while a menu is open and resumes with the time it had left once it closes.
  const menuOpen = useMenuOpen();
  const hiddenByMenu = isPhone && menuOpen;
  useLayoutEffect(() => {
    if (!hiddenByMenu) return;
    pauseToastTimers("hidden");
    return () => resumeToastTimers("hidden");
  }, [hiddenByMenu, pauseToastTimers, resumeToastTimers]);

  const renderToast = (toast: ToastEntry) => (
    <div
      className={`toast ${toast.tone === "success" ? "t-success"
        : toast.tone === "warning" ? "t-warning"
          : toast.tone === "error" ? "t-danger"
            : "t-info"}`}
      key={toast.id}
      role={toast.tone === "error" ? "alert" : "status"}
    >
      <span className="toast-icon" aria-hidden="true">
        <ToneIcon tone={toast.tone === "error" ? "danger" : toast.tone ?? "info"} />
      </span>
      <div className="toast-copy">
        <span className="toast-message">{toast.messageContent ?? toast.message}</span>
        {toast.detail && <span className={toast.detailStyle === "mono" ? "toast-detail mono" : "toast-detail"}>{toast.detail}</span>}
        {toast.link && (
          <a className="toast-link" href={toast.link.href} target="_blank" rel="noreferrer">{toast.link.label}</a>
        )}
      </div>
      <div className="toast-actions">
        {toast.action && (
          <BusyButton className="btn ghost sm" busy={toast.actionBusy === true} progress={toast.action.progress ?? "Working…"}
            onClick={() => void runToastAction(toast)}>
            {toast.action.label}
          </BusyButton>
        )}
        <button className="icon-btn sm" type="button" aria-label="Dismiss Notification" title="Dismiss Notification"
          onClick={() => dismissToast(toast.id)}>
          <CloseIcon />
        </button>
      </div>
    </div>
  );

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      {active && <ConfirmationDialog key={active.id} request={active} onSettle={settleConfirmation} />}
      <div
        ref={toastRegion}
        className={hiddenByMenu ? "toast-region under-menu" : "toast-region"}
        aria-label="Notifications"
        aria-live="polite"
        aria-relevant="additions text"
        onMouseEnter={() => pauseToastTimers("interaction")}
        onMouseLeave={(event) => {
          if (!event.currentTarget.contains(document.activeElement)) resumeToastTimers("interaction");
        }}
        onFocus={() => pauseToastTimers("interaction")}
        onBlur={(event) => {
          const next = event.relatedTarget as Node | null;
          if (!next || !event.currentTarget.contains(next)) {
            if (!event.currentTarget.matches(":hover")) resumeToastTimers("interaction");
          }
        }}
      >
        {moreOpen && olderToasts.length > 0 && (
          <ul className="toast-more-list" id={moreListId} aria-label="Older Notifications">
            {[...olderToasts].reverse().map((toast) => <li key={toast.id}>{renderToast(toast)}</li>)}
          </ul>
        )}
        {olderToasts.length > 0 && (
          <button type="button" className="btn sm toast-more" aria-expanded={moreOpen} aria-controls={moreListId}
            onClick={() => setMoreOpen((open) => !open)}>
            {moreOpen ? "Show Fewer" : `+${olderToasts.length} More`}
          </button>
        )}
        {visibleToasts.map(renderToast)}
      </div>
    </FeedbackContext.Provider>
  );
}

/**
 * Publishes --toast-clear: the height docked at the bottom of the view that toasts must sit above —
 * the phone tab bar, a session's composer, a sheet's footer (docs/design-system.md §13.1). Docked
 * chrome stacks (a phone session's composer sits on its tab bar), so the measurement walks up from
 * the bottom of the app through every visible candidate whose bottom edge touches the stack so far.
 * A candidate taller than half the app is skipped: the desktop rail spans the full height and sits
 * beside the stack, not under it. A dialog footer in the lower half also counts when it shares the
 * toast column, even if it floats above the bottom edge (a full-height desktop dialog ends 24px up):
 * toasts sit above dialogs, so they would otherwise cover its buttons. Measured only while a toast
 * is showing, whenever the docked chrome mounts, unmounts or resizes.
 */
function useToastClearance(active: boolean) {
  useEffect(() => {
    const root = document.documentElement;
    if (!active) {
      root.style.removeProperty("--toast-clear");
      return;
    }
    const measure = () => {
      const app = document.getElementById("root") ?? document.body;
      const bottom = app.getBoundingClientRect().bottom;
      const boxes = [...document.querySelectorAll<HTMLElement>(".app-rail, .composer, .modal-foot")]
        .map((element) => element.getBoundingClientRect())
        .filter((box) => box.width > 0 && box.height > 0 && box.height <= bottom / 2)
        .sort((left, right) => right.bottom - left.bottom);
      let stackTop = bottom;
      for (const box of boxes) {
        if (Math.abs(box.bottom - stackTop) > 2) continue;
        stackTop = Math.min(stackTop, box.top);
      }
      const column = document.querySelector(".toast-region")?.getBoundingClientRect();
      for (const foot of document.querySelectorAll<HTMLElement>(".modal-foot")) {
        const box = foot.getBoundingClientRect();
        if (box.width === 0 || box.height === 0 || box.top < bottom / 2) continue;
        if (column && (box.right <= column.left || box.left >= column.right)) continue;
        stackTop = Math.min(stackTop, box.top);
      }
      root.style.setProperty("--toast-clear", `${Math.ceil(bottom - stackTop)}px`);
    };
    // Event-driven rather than polled: the docked chrome changes when it mounts or unmounts (a
    // route change, a modal opening) or when it resizes (the composer growing with its draft).
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    const resizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    const observeChrome = () => {
      if (!resizes) return;
      resizes.disconnect();
      resizes.observe(document.documentElement);
      for (const element of document.querySelectorAll(".app-rail, .composer, .modal-foot")) resizes.observe(element);
    };
    const mutations = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
      observeChrome();
      schedule();
    });
    mutations?.observe(document.body, { childList: true, subtree: true });
    observeChrome();
    measure();
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      mutations?.disconnect();
      resizes?.disconnect();
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      root.style.removeProperty("--toast-clear");
    };
  }, [active]);
}

function ConfirmationDialog({ request, onSettle }: {
  request: ConfirmationRequest;
  onSettle: (confirmed: boolean) => void;
}) {
  const descriptionId = useId();
  const detailsId = useId();
  const rowsId = useId();
  const moreId = useId();
  const danger = request.tone === "danger";
  const isPhone = useIsMobile();
  const rows = request.detailRows ?? [];
  const shownRows = rows.slice(0, MAX_CONFIRMATION_DETAIL_ROWS);
  const moreRows = detailRowsOverflowCount(rows, request.detailRowsOverflow);
  const describedBy = [
    descriptionId,
    request.details ? detailsId : null,
    shownRows.length > 0 ? rowsId : null,
    moreRows > 0 ? moreId : null,
  ].filter(Boolean).join(" ");
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const typeToConfirm = request.typeToConfirm;
  const [typed, setTyped] = useState("");
  const typedId = useId();
  /** Until the typed text matches, the confirm button is disabled and confirming does nothing. */
  const typedMismatch = typeToConfirm !== undefined && typed !== typeToConfirm;
  /** The running `onConfirm`, if any. Cleared before settling, so a finished action is never aborted
   * by the dialog unmounting after it. */
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);

  const cancelLocked = running && request.cancelWhileRunning === false;
  const cancel = () => {
    if (cancelLocked) return;
    inFlight.current?.abort();
    inFlight.current = null;
    onSettle(false);
  };
  /** Set once the secondary action has run: a second click in the same batch, before the dialog
   * unmounts, must not run it again. */
  const secondaryRan = useRef(false);
  const runSecondary = () => {
    if (running || secondaryRan.current || !request.secondaryAction) return;
    secondaryRan.current = true;
    const { run } = request.secondaryAction;
    onSettle(false);
    run();
  };
  // Crossing to a phone removes the secondary action (§7.5). A removed button takes focus with it
  // to the page behind the dialog, so if it was the last thing focused and focus has fallen to the
  // page, the safe choice takes it. Only a move to another element clears the flag: whether a
  // removed element fires blur differs between browsers.
  const secondaryFocused = useRef(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!isPhone || !secondaryFocused.current) return;
    secondaryFocused.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) cancelButton.current?.focus();
  }, [isPhone]);
  const confirm = async () => {
    if (typedMismatch) return;
    if (!request.onConfirm) {
      onSettle(true);
      return;
    }
    if (inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setRunning(true);
    setFailure(null);
    try {
      await request.onConfirm(controller.signal);
      if (controller.signal.aborted) return;
      inFlight.current = null;
      onSettle(true);
    } catch (cause) {
      if (controller.signal.aborted) return;
      inFlight.current = null;
      setRunning(false);
      setFailure(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <Modal
      className="feedback-confirmation"
      size="sm"
      title={request.title}
      tone={danger ? "danger" : undefined}
      closeButton={false}
      onClose={cancel}
      describedBy={describedBy}
      returnFocusRef={request.returnFocus}
      footer={(
        <>
          {/* A phone sheet's footer holds two buttons (§7.5), so the extra action is desktop-only. */}
          {request.secondaryAction && !isPhone && (
            <button className="btn ghost" type="button" disabled={running} onClick={runSecondary}
              onFocus={() => { secondaryFocused.current = true; }}
              onBlur={(event) => { if (event.relatedTarget) secondaryFocused.current = false; }}>
              {request.secondaryAction.label}
            </button>
          )}
          {/* A destructive confirmation opens on its safe choice; any other opens on its primary (§7.4).
              One that asks for typed text opens on its field instead. */}
          <button ref={cancelButton} className="btn" type="button" autoFocus={danger && typeToConfirm === undefined}
            disabled={cancelLocked} onClick={cancel}>
            {request.cancelLabel ?? "Cancel"}
          </button>
          <BusyButton className={`btn ${danger ? "danger" : "primary"}`} autoFocus={!danger && typeToConfirm === undefined}
            busy={running} disabled={typedMismatch} progress={request.progress ?? "Working…"} onClick={() => void confirm()}>
            {request.confirmLabel}
          </BusyButton>
        </>
      )}
    >
      <p className="confirmation-message" id={descriptionId}>{request.message}</p>
      {request.details && <div id={detailsId}>{request.details}</div>}
      {shownRows.length > 0 && (
        <ul className="surface confirmation-rows" id={rowsId}>
          {shownRows.map((row, index) => (
            <li className="row dense" key={index}>
              <span className="row-body">
                <span className="row-title" title={row.label}>{row.label}</span>
              </span>
              {row.meta && <span className="row-trail">{row.meta}</span>}
              {row.status && <StatusBadge meta={row.status} inline />}
            </li>
          ))}
        </ul>
      )}
      {moreRows > 0 && <p className="confirmation-rows-more" id={moreId}>and {moreRows} more</p>}
      {typeToConfirm !== undefined && (
        <label className="field" htmlFor={typedId}>
          <span>Type {typeToConfirm} to Confirm</span>
          {/* Focused on open, on every pointer: nothing else can happen until the text is typed (§7.4). */}
          <input id={typedId} autoFocus value={typed} autoComplete="off" spellCheck={false} readOnly={running}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              // An input method's commit Enter is not a confirmation; some report it only as keyCode 229.
              if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
              event.preventDefault();
              void confirm();
            }} />
        </label>
      )}
      {failure && <Notice tone="danger" compact role="alert">{failure}</Notice>}
    </Modal>
  );
}
