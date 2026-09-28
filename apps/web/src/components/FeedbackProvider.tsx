import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Modal } from "./common.js";
import { CloseIcon } from "./Icons.js";
import { ToneIcon } from "./Notice.js";
import { useIsMobile } from "./useIsMobile.js";

export interface ConfirmationOptions {
  /** The action in Title Case, with no question mark: "Stop Session", "Delete Skill" (§7.4). */
  title: string;
  /** One or two sentences: what happens, to which named object, and whether it can be undone. */
  message: string;
  details?: ReactNode;
  /** Required, and repeats the title's verb. There is no generic default such as "Continue": the
   * button names the outcome it runs. */
  confirmLabel: string;
  tone?: "default" | "danger";
  /** Durable element to restore focus to after settling. Needed when the invoking control is
   * a menu item that unmounts as the confirmation opens — the activeElement snapshot below
   * would then be disconnected by the time focus can be restored. */
  returnFocus?: { current: HTMLElement | null };
}

interface ConfirmationRequest extends ConfirmationOptions {
  id: number;
  fingerprint: string;
  invoker: HTMLElement | null;
  resolve: (confirmed: boolean) => void;
}

function confirmationFingerprint(options: ConfirmationOptions): string {
  return [
    options.title,
    options.message,
    options.confirmLabel,
    options.tone ?? "",
    typeof options.details === "string" ? options.details : "",
  ].join("\u0000");
}

export interface ToastOptions {
  tone?: "info" | "success" | "warning" | "error";
  /** An optional second line under the message, in the secondary text colour. */
  detail?: string;
  /** Milliseconds before an info or success toast dismisses itself; 0 keeps it until dismissed.
   * Warnings and errors persist unless a duration is given (§13.1). */
  durationMs?: number;
  action?: {
    label: string;
    busyLabel?: string;
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

interface FeedbackContextValue {
  confirm: (options: ConfirmationOptions) => Promise<boolean>;
  showToast: (message: string, options?: ToastOptions) => number;
  showUndo: (message: string, undo: () => void | Promise<void>) => number;
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
   * focusing the stack pauses every timer; leaving it resumes each with what it had left. */
  const toastTimers = useRef(new Map<number, { timer: number | null; deadline: number; remaining: number }>());
  const toastsPaused = useRef(false);
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
    const timer = toastsPaused.current ? null : window.setTimeout(() => dismissToast(id), remaining);
    toastTimers.current.set(id, { timer, deadline, remaining });
  }, [dismissToast]);

  const pauseToastTimers = useCallback(() => {
    if (toastsPaused.current) return;
    toastsPaused.current = true;
    const now = Date.now();
    for (const entry of toastTimers.current.values()) {
      if (entry.timer != null) window.clearTimeout(entry.timer);
      entry.timer = null;
      entry.remaining = Math.max(0, entry.deadline - now);
    }
  }, []);

  const resumeToastTimers = useCallback(() => {
    if (!toastsPaused.current) return;
    toastsPaused.current = false;
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

  const showUndo = useCallback((message: string, undo: () => void | Promise<void>) => (
    showToast(message, {
      tone: "success",
      action: { label: "Undo", busyLabel: "Undoing…", run: undo, failureLabel: "Undo failed", retryLabel: "Retry Undo" },
      durationMs: 10_000,
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
    if (!toastsPaused.current || !region) return;
    if (region.contains(document.activeElement) || region.matches(":hover")) return;
    resumeToastTimers();
  }, [toasts, moreOpen, resumeToastTimers]);

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
        <span className="toast-message">{toast.message}</span>
        {toast.detail && <span className="toast-detail">{toast.detail}</span>}
      </div>
      <div className="toast-actions">
        {toast.action && (
          <button className="btn ghost sm" type="button" disabled={toast.actionBusy} onClick={() => void runToastAction(toast)}>
            {toast.actionBusy ? toast.action.busyLabel ?? "Working…" : toast.action.label}
          </button>
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
      {active && <ConfirmationDialog request={active} onSettle={settleConfirmation} />}
      <div
        ref={toastRegion}
        className="toast-region"
        aria-label="Notifications"
        aria-live="polite"
        aria-relevant="additions text"
        onMouseEnter={pauseToastTimers}
        onMouseLeave={(event) => {
          if (!event.currentTarget.contains(document.activeElement)) resumeToastTimers();
        }}
        onFocus={pauseToastTimers}
        onBlur={(event) => {
          const next = event.relatedTarget as Node | null;
          if (!next || !event.currentTarget.contains(next)) {
            if (!event.currentTarget.matches(":hover")) resumeToastTimers();
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
  const danger = request.tone === "danger";
  return (
    <Modal
      className="feedback-confirmation"
      size="sm"
      title={request.title}
      tone={danger ? "danger" : undefined}
      closeButton={false}
      onClose={() => onSettle(false)}
      describedBy={descriptionId}
      returnFocusRef={request.returnFocus}
      footer={(
        <>
          <button className="btn" type="button" autoFocus onClick={() => onSettle(false)}>Cancel</button>
          <button className={`btn ${danger ? "danger" : "primary"}`} type="button" onClick={() => onSettle(true)}>
            {request.confirmLabel}
          </button>
        </>
      )}
    >
      <div className="confirmation-copy" id={descriptionId}>
        <p>{request.message}</p>
        {request.details && <div>{request.details}</div>}
      </div>
    </Modal>
  );
}
