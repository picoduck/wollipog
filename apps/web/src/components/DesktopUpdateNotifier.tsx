import { useEffect } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  checkForDesktopUpdate,
  DESKTOP_UPDATE_CHANNEL_CHANGED,
  confirmHeldUpdate,
  errorMessage,
  installDesktopUpdate,
  openReleasePage,
  readDesktopUpdateStatus,
  updateToastMessage,
  updateCheckMatchesStatus,
  type DesktopUpdateRuntime,
} from "../desktop-updates.js";
import { closeGuardLinks, type CloseGuardLinks } from "../desktop-close-guard.js";
import { useFeedback, type ToastOptions } from "./FeedbackProvider.js";

/** Long enough after launch that the check never competes with starting the control plane. */
export const FIRST_CHECK_DELAY_MS = 15_000;
/** A window left open for days still hears about a release. */
export const RECHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

const shell: DesktopUpdateRuntime = { isTauri, invoke, listen: (event, handler) => listen(event, (received) => handler(received.payload)) };

/**
 * #1646 — tell a desktop user a newer release exists, and let them install it from the toast.
 *
 * Mounted beside `DesktopCloseGuard`, above everything an instance switch can unmount. The check is
 * the shell's "automatic" one, so it does nothing when the user or the installation turned it off.
 * A failed background check is silent; Settings → About shows the error on a manual check.
 *
 * The toast is information with one action (§13.1); dismissing it is "later", and Settings → About
 * still offers the version. Installing from here goes through the shell's exit guard like the
 * Settings button does: a held attempt opens the same Restart to Install Update confirmation (#1975).
 */
export function DesktopUpdateNotifier({
  desktop = shell,
  links = closeGuardLinks,
  firstCheckDelayMs = FIRST_CHECK_DELAY_MS,
  recheckIntervalMs = RECHECK_INTERVAL_MS,
}: {
  desktop?: DesktopUpdateRuntime;
  /** Where the held-update confirmation finds the working sessions' titles. */
  links?: CloseGuardLinks;
  firstCheckDelayMs?: number;
  recheckIntervalMs?: number;
} = {}) {
  const { confirm, showToast, dismissToast } = useFeedback();

  useEffect(() => {
    if (!desktop.isTauri()) return;
    let disposed = false;
    let announced: string | null = null;
    let toastId: number | null = null;
    let channelGeneration = 0;
    let unlisten: (() => void) | undefined;

    const install = async (version: string): Promise<void> => {
      const result = await installDesktopUpdate(false, desktop);
      if (disposed || result.outcome !== "heldForWork") return;
      // Not awaited: the toast's action is done, and the confirmation takes the decision from here.
      void confirmHeldUpdate({ confirm, version, held: result, links, install: () => installDesktopUpdate(true, desktop) });
    };

    const check = async () => {
      const generation = channelGeneration;
      try {
        const result = await checkForDesktopUpdate(true, desktop);
        if (disposed || result?.state !== "available" || result.version === announced) return;
        const status = await readDesktopUpdateStatus(desktop);
        if (disposed || !status || generation !== channelGeneration || !updateCheckMatchesStatus(result, status)) return;
        announced = result.version;
        const inPlace = status.install.mode === "inPlace";
        const action: ToastOptions["action"] = inPlace
          ? { label: "Install and Restart", progress: "Installing the update…", run: () => install(result.version), failureLabel: "Update failed", retryLabel: "Retry Install" }
          : { label: "Open Release Page", run: () => openReleasePage(result.releaseUrl, desktop) };
        toastId = showToast(updateToastMessage(result.version, status.install), {
          tone: "info",
          durationMs: 0,
          detail: inPlace
            ? "Restarting takes a few seconds. You can also install it later from Settings."
            : "You can also open it later from Settings.",
          link: { label: "What's New", href: result.releaseUrl },
          action,
        });
      } catch (cause) {
        // Offline, rate-limited, or blocked: a background check has no one to tell.
        console.debug("[desktop] update check failed:", errorMessage(cause));
      }
    };

    void desktop.listen?.(DESKTOP_UPDATE_CHANNEL_CHANGED, () => {
      if (disposed) return;
      channelGeneration += 1;
      announced = null;
      if (toastId !== null) dismissToast(toastId);
      toastId = null;
      void check();
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; }).catch(() => undefined);

    const first = window.setTimeout(() => void check(), firstCheckDelayMs);
    const repeat = window.setInterval(() => void check(), recheckIntervalMs);
    return () => {
      disposed = true;
      window.clearTimeout(first);
      window.clearInterval(repeat);
      unlisten?.();
    };
  }, [confirm, desktop, dismissToast, firstCheckDelayMs, links, recheckIntervalMs, showToast]);

  return null;
}
