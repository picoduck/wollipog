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

export interface ConfirmationOptions {
  title: string;
  message: string;
  details?: ReactNode;
  confirmLabel?: string;
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
    options.confirmLabel ?? "",
    options.tone ?? "",
    typeof options.details === "string" ? options.details : "",
  ].join("\u0000");
}

export interface ToastOptions {
  tone?: "info" | "success" | "error";
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
  const toastTimers = useRef(new Map<number, number>());
  const toastActionsInFlight = useRef(new Set<number>());

  const clearToastTimer = useCallback((id: number) => {
    const timer = toastTimers.current.get(id);
    if (timer != null) window.clearTimeout(timer);
    toastTimers.current.delete(id);
  }, []);

  const dismissToast = useCallback((id: number) => {
    if (!mounted.current) return;
    clearToastTimer(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, [clearToastTimer]);

  const showToast = useCallback((message: string, options: ToastOptions = {}) => {
    if (!mounted.current) return -1;
    const id = nextToastId.current++;
    const entry: ToastEntry = { id, message, ...options };
    setToasts((current) => {
      const kept = [...current, entry];
      const transient = kept.filter((toast) => toast.durationMs !== 0);
      const evictedTransientIds = new Set(transient.slice(0, Math.max(0, transient.length - 4)).map((toast) => toast.id));
      evictedTransientIds.forEach(clearToastTimer);
      // Persistent recovery actions remain queued until explicitly dismissed or completed. The
      // render projection below exposes the newest four and reveals older actions as space opens.
      return kept.filter((toast) => !evictedTransientIds.has(toast.id));
    });
    const duration = options.durationMs ?? (options.action ? 10_000 : options.tone === "error" ? 8_000 : 5_000);
    if (duration > 0) {
      toastTimers.current.set(id, window.setTimeout(() => dismissToast(id), duration));
    }
    return id;
  }, [clearToastTimer, dismissToast]);

  const showUndo = useCallback((message: string, undo: () => void | Promise<void>) => (
    showToast(message, {
      tone: "success",
      action: { label: "Undo", busyLabel: "Undoing…", run: undo, failureLabel: "Undo failed", retryLabel: "Retry undo" },
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
      for (const timer of toastTimers.current.values()) window.clearTimeout(timer);
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
  const visibleToasts = useMemo(() => {
    const persistent = toasts.filter((toast) => toast.durationMs === 0).slice(-4);
    const persistentIds = new Set(persistent.map((toast) => toast.id));
    const remaining = 4 - persistent.length;
    const transient = remaining > 0
      ? toasts.filter((toast) => toast.durationMs !== 0 && !persistentIds.has(toast.id)).slice(-remaining)
      : [];
    return [...persistent, ...transient].sort((left, right) => left.id - right.id);
  }, [toasts]);

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      {active && <ConfirmationDialog request={active} onSettle={settleConfirmation} />}
      <div className="toast-region" aria-label="Notifications" aria-live="polite" aria-relevant="additions text">
        {visibleToasts.map((toast) => (
          <div className={`toast toast-${toast.tone ?? "info"}`} key={toast.id} role={toast.tone === "error" ? "alert" : "status"}>
            <span>{toast.message}</span>
            <div className="toast-actions">
              {toast.action && (
                <button className="btn ghost sm" type="button" disabled={toast.actionBusy} onClick={() => void runToastAction(toast)}>
                  {toast.actionBusy ? toast.action.busyLabel ?? "Working…" : toast.action.label}
                </button>
              )}
              <button className="icon-btn" type="button" aria-label="Dismiss Notification" onClick={() => dismissToast(toast.id)}>×</button>
            </div>
          </div>
        ))}
      </div>
    </FeedbackContext.Provider>
  );
}

function ConfirmationDialog({ request, onSettle }: {
  request: ConfirmationRequest;
  onSettle: (confirmed: boolean) => void;
}) {
  const descriptionId = useId();
  return (
    <Modal className="feedback-confirmation" title={request.title} onClose={() => onSettle(false)} describedBy={descriptionId} returnFocusRef={request.returnFocus} footer={(
      <>
        <button className="btn" type="button" autoFocus onClick={() => onSettle(false)}>Cancel</button>
        <button className={`btn ${request.tone === "danger" ? "danger" : "primary"}`} type="button" onClick={() => onSettle(true)}>
          {request.confirmLabel ?? "Continue"}
        </button>
      </>
    )}>
      <div className="confirmation-copy" id={descriptionId}>
        <p>{request.message}</p>
        {request.details && <div className="confirmation-details">{request.details}</div>}
      </div>
    </Modal>
  );
}
