import { useEffect } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  availableUpdateMessage,
  checkForDesktopUpdate,
  errorMessage,
  installDesktopUpdate,
  openReleasePage,
  readDesktopUpdateStatus,
  updateWarning,
  type DesktopUpdateRuntime,
} from "../desktop-updates.js";
import { useFeedback, type ToastOptions } from "./FeedbackProvider.js";

/** Long enough after launch that the check never competes with starting the control plane. */
export const FIRST_CHECK_DELAY_MS = 15_000;
/** A window left open for days still hears about a release. */
export const RECHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

const shell: DesktopUpdateRuntime = { isTauri, invoke };

/**
 * #1646 — tell a desktop user a newer release exists, and let them install it from the toast.
 *
 * Mounted beside `DesktopCloseGuard`, above everything an instance switch can unmount. The check is
 * the shell's "automatic" one, so it does nothing when the user or the installation turned it off.
 * A failed background check is silent; Settings → About shows the error on a manual check.
 *
 * Installing from here goes through the shell's exit guard like the Settings button does: a held
 * attempt becomes a warning toast whose action is the confirmation.
 */
export function DesktopUpdateNotifier({
  desktop = shell,
  firstCheckDelayMs = FIRST_CHECK_DELAY_MS,
  recheckIntervalMs = RECHECK_INTERVAL_MS,
}: { desktop?: DesktopUpdateRuntime; firstCheckDelayMs?: number; recheckIntervalMs?: number } = {}) {
  const { showToast } = useFeedback();

  useEffect(() => {
    if (!desktop.isTauri()) return;
    let disposed = false;
    let announced: string | null = null;

    const install = async (): Promise<void> => {
      const result = await installDesktopUpdate(desktop);
      if (disposed || result.outcome !== "heldForWork") return;
      showToast(updateWarning(result.sessions), {
        tone: "error",
        durationMs: 0,
        action: { label: "Install Anyway", busyLabel: "Installing…", run: install, failureLabel: "Update failed", retryLabel: "Retry Install" },
      });
    };

    const check = async () => {
      try {
        const result = await checkForDesktopUpdate(true, desktop);
        if (disposed || result?.state !== "available" || result.version === announced) return;
        const status = await readDesktopUpdateStatus(desktop);
        if (disposed || !status) return;
        announced = result.version;
        const action: ToastOptions["action"] = status.install.mode === "inPlace"
          ? { label: "Install and Restart", busyLabel: "Installing…", run: install, failureLabel: "Update failed", retryLabel: "Retry Install" }
          : { label: "Open Release Page", run: () => openReleasePage(result.releaseUrl, desktop) };
        showToast(availableUpdateMessage(result.version), { durationMs: 0, action });
      } catch (cause) {
        // Offline, rate-limited, or blocked: a background check has no one to tell.
        console.debug("[desktop] update check failed:", errorMessage(cause));
      }
    };

    const first = window.setTimeout(() => void check(), firstCheckDelayMs);
    const repeat = window.setInterval(() => void check(), recheckIntervalMs);
    return () => {
      disposed = true;
      window.clearTimeout(first);
      window.clearInterval(repeat);
    };
  }, [desktop, firstCheckDelayMs, recheckIntervalMs, showToast]);

  return null;
}
