import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { closeDetailRows, heldClose } from "./components/DesktopCloseGuard.js";
import { useFeedback, type ConfirmationOptions } from "./components/FeedbackProvider.js";
import { closeGuardLinks, type CloseGuardLinks } from "./desktop-close-guard.js";

/**
 * #1646 — the dashboard's side of in-place desktop updates.
 *
 * The shell does the work: it asks GitHub for the latest published release, verifies the package
 * against its compiled-in update key, and holds the restart behind the same work-in-flight guard as
 * closing the window. This file states what the shell answered, and offers what the user may do.
 */

export type DesktopUpdateInstall =
  | { mode: "inPlace" }
  | { mode: "releasePage"; reason: string };

export type DesktopUpdateCheck = (
  | { state: "current"; checkedAt: number }
  | { state: "available"; version: string; releaseUrl: string; checkedAt: number }
) & { /** Absent on older shells, which check only stable releases. */ prereleaseUpdates?: boolean };

export interface DesktopUpdateStatus {
  currentVersion: string;
  install: DesktopUpdateInstall;
  automaticChecks: boolean;
  /** Absent on older shells that do not support channel selection. */
  prereleaseUpdates?: boolean;
  /** False when the installation turned every update request off. */
  checksAllowed: boolean;
  releasesUrl: string;
  lastCheck: DesktopUpdateCheck | null;
}

/** Work is in flight; nothing was installed. `sessions` is 0 when the shell could not count, and
 * `sessionIds` names the sessions it could (#1975). An older shell sends no ids. */
export type HeldDesktopUpdate = { outcome: "heldForWork"; sessions: number; sessionIds?: string[] };

export type DesktopUpdateOutcome =
  | { outcome: "current" }
  | HeldDesktopUpdate
  | { outcome: "restarting" };

/** Emitted by the shell with the `DesktopUpdateCheck` whenever any check finishes. */
export const DESKTOP_UPDATE_CHECKED = "wollipog://desktop-update-checked";
export const DESKTOP_UPDATE_CHANNEL_CHANGED = "wollipog://desktop-update-channel-changed";

export function updateCheckMatchesStatus(check: DesktopUpdateCheck, status: DesktopUpdateStatus): boolean {
  return (check.prereleaseUpdates ?? false) === (status.prereleaseUpdates ?? false);
}

export interface DesktopUpdateRuntime {
  isTauri: () => boolean;
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  /** Subscribe to a shell event; resolves to its unsubscribe. Absent where nothing is emitted. */
  listen?: (event: string, handler: (payload: unknown) => void) => Promise<() => void>;
}

const runtime: DesktopUpdateRuntime = {
  isTauri,
  invoke,
  listen: (event, handler) => listen(event, (received) => handler(received.payload)),
};

export function readDesktopUpdateStatus(desktop: DesktopUpdateRuntime = runtime): Promise<DesktopUpdateStatus | null> {
  if (!desktop.isTauri()) return Promise.resolve(null);
  return desktop.invoke<DesktopUpdateStatus>("desktop_update_status");
}

/** `automatic` checks respect the user's setting and resolve to null when it is off. */
export function checkForDesktopUpdate(
  automatic: boolean,
  desktop: DesktopUpdateRuntime = runtime,
): Promise<DesktopUpdateCheck | null> {
  return desktop.invoke<DesktopUpdateCheck | null>("check_for_desktop_update", { automatic });
}

/**
 * `confirmed` is the "Restart Anyway" answer to the shell's work-in-flight warning. Every other
 * request is asked afresh, so a second surface's click is never taken as the confirmation.
 */
export function installDesktopUpdate(confirmed: boolean, desktop: DesktopUpdateRuntime = runtime): Promise<DesktopUpdateOutcome> {
  return desktop.invoke<DesktopUpdateOutcome>("install_desktop_update", { confirmed });
}

export function writeAutomaticUpdateChecks(enabled: boolean, desktop: DesktopUpdateRuntime = runtime): Promise<boolean> {
  return desktop.invoke<boolean>("set_automatic_update_checks", { enabled });
}

export function writePrereleaseUpdates(enabled: boolean, desktop: DesktopUpdateRuntime = runtime): Promise<DesktopUpdateStatus> {
  return desktop.invoke<DesktopUpdateStatus>("set_prerelease_updates", { enabled });
}

export function openReleasePage(url: string, desktop: DesktopUpdateRuntime = runtime): Promise<void> {
  return desktop.invoke<void>("open_external_url", { url });
}

export function availableUpdateMessage(version: string): string {
  return `Wollipog ${version} is available.`;
}

/** The update toast's sentence: an in-place install is ready now, a package install is only out. */
export function updateToastMessage(version: string, install: DesktopUpdateInstall): string {
  return install.mode === "inPlace" ? `Wollipog ${version} is ready to install.` : availableUpdateMessage(version);
}

/**
 * The held-update confirmation's body. Same rule as the close confirmation's: a count of 0 is the
 * shell saying it could not check, and never becomes an invented number.
 */
export function heldUpdateMessage(version: string | null, sessions: number): string {
  const installing = version ? `Installing Wollipog ${version}` : "Installing the update";
  const stops = sessions <= 0
    ? "restarts the app and stops any turn that is still in progress."
    : sessions === 1
      ? "restarts the app, which stops 1 session that is still working."
      : `restarts the app, which stops ${sessions} sessions that are still working.`;
  return `${installing} ${stops} You can install later from Settings.`;
}

export interface HeldUpdateRequest {
  confirm: (options: ConfirmationOptions) => Promise<boolean>;
  /** The version being installed, when the caller knows it. */
  version: string | null;
  /** The shell's answer to the unconfirmed install. */
  held: HeldDesktopUpdate;
  /** Install with the confirmation. The caller's own bookkeeping goes here. */
  install: () => Promise<DesktopUpdateOutcome>;
  /** Where the working sessions' titles come from; the local instance's, while it is open. */
  links?: CloseGuardLinks;
}

/**
 * Ask whether to restart over running work (#1975, docs/design-system.md §7.4). The one confirmation
 * both the update toast and Settings › About open, so the decision has one title and one set of
 * buttons wherever it starts.
 *
 * The working sessions are named the way the quit confirmation names them (#1965): the shell sends
 * ids, and titles come from the loaded local instance. Restart Anyway installs with the dialog open
 * and busy; a failure stays in the dialog. The shell installs the confirmation a held install asked
 * for however long the dialog was open (#2065); one that holds a confirmed install anyway (it had no
 * held install left to answer) is asked about again, with what it says now. Resolves false for
 * Install Later, which leaves the update available in Settings.
 */
export async function confirmHeldUpdate({ confirm, version, held, install, links = closeGuardLinks }: HeldUpdateRequest): Promise<boolean> {
  let asking = held;
  for (;;) {
    const answer: { heldAgain?: HeldDesktopUpdate } = {};
    const work = heldClose({ count: asking.sessions, sessionIds: asking.sessionIds });
    const { rows, overflow } = closeDetailRows(work, links);
    const confirmed = await confirm({
      title: "Restart to Install Update",
      message: heldUpdateMessage(version, work.count),
      detailRows: rows,
      detailRowsOverflow: overflow,
      confirmLabel: "Restart Anyway",
      cancelLabel: "Install Later",
      tone: "danger",
      progress: "Installing the update…",
      // Once the shell is installing there is nothing to withdraw.
      cancelWhileRunning: false,
      onConfirm: async () => {
        const outcome = await install();
        if (outcome.outcome === "heldForWork") answer.heldAgain = outcome;
        // The app is going away; the button stays busy until it does.
        else if (outcome.outcome === "restarting") await new Promise<never>(() => undefined);
      },
    });
    if (!confirmed) return false;
    if (!answer.heldAgain) return true;
    asking = answer.heldAgain;
  }
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface DesktopUpdateSetting {
  /** False in a browser or PWA: those are updated by upgrading the control plane that serves them. */
  desktop: boolean;
  status: DesktopUpdateStatus | null;
  loading: boolean;
  checking: boolean;
  installing: boolean;
  savingAutomatic: boolean;
  savingPrerelease: boolean;
  error: string | null;
  check: () => void;
  /** Install and Restart. A hold for running work opens the held-update confirmation, which is the
   * only thing that confirms. */
  install: () => void;
  openRelease: () => void;
  toggleAutomatic: () => void;
  togglePrerelease: () => void;
}

/**
 * Settings state for the Updates row.
 *
 * Reads the shell's status once, which includes the last check the background notifier made, so
 * opening Settings does not ask GitHub again. Checking is a click.
 */
export function useDesktopUpdateSetting(
  desktop: DesktopUpdateRuntime = runtime,
  links: CloseGuardLinks = closeGuardLinks,
): DesktopUpdateSetting {
  const { confirm } = useFeedback();
  const inDesktop = useMemo(() => desktop.isTauri(), [desktop]);
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);
  const [loading, setLoading] = useState(inDesktop);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [savingAutomatic, setSavingAutomatic] = useState(false);
  const [savingPrerelease, setSavingPrerelease] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!inDesktop) return;
    let disposed = false;
    const stops: Array<() => void> = [];
    // The background notifier's check lands in the shell, not here. Without this, a Settings page
    // opened at launch said "Not checked yet" for the rest of the session. Subscribed BEFORE the
    // status read, and kept aside, because a check can finish while that read is in flight: the
    // read would then land with the older answer and overwrite the newer one.
    let heard: DesktopUpdateCheck | null = null;
    let heardStatus: DesktopUpdateStatus | null = null;
    const newer = (next: DesktopUpdateStatus): DesktopUpdateStatus =>
      heard && updateCheckMatchesStatus(heard, next) && (!next.lastCheck || heard.checkedAt >= next.lastCheck.checkedAt)
        ? { ...next, lastCheck: heard } : next;
    const subscribe = (event: string, handler: (payload: unknown) => void) => desktop.listen?.(event, handler)
      .then((unlisten) => { if (disposed) unlisten(); else stops.push(unlisten); })
      .catch(() => undefined) ?? Promise.resolve();
    const subscribed = Promise.all([subscribe(DESKTOP_UPDATE_CHECKED, (payload) => {
      if (disposed || !payload || typeof payload !== "object") return;
      heard = payload as DesktopUpdateCheck;
      setStatus((current) => (current ? newer(current) : current));
    }), subscribe(DESKTOP_UPDATE_CHANNEL_CHANGED, (payload) => {
      if (disposed || !payload || typeof payload !== "object") return;
      heard = null;
      heardStatus = payload as DesktopUpdateStatus;
      setStatus(heardStatus);
    })]);
    void subscribed
      .then(() => readDesktopUpdateStatus(desktop))
      .then((next) => { if (!disposed) setStatus(next && newer(heardStatus ?? next)); })
      .catch((cause) => { if (!disposed) setError(errorMessage(cause)); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; stops.forEach((stop) => stop()); };
  }, [desktop, inDesktop]);

  const check = useCallback(() => {
    if (!status || checking || installing || savingPrerelease) return;
    setChecking(true);
    setError(null);
    checkForDesktopUpdate(false, desktop)
      .then((lastCheck) => setStatus((current) => (current && lastCheck && updateCheckMatchesStatus(lastCheck, current)
        && (!current.lastCheck || lastCheck.checkedAt >= current.lastCheck.checkedAt)
        ? { ...current, lastCheck } : current)))
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setChecking(false));
  }, [checking, desktop, installing, savingPrerelease, status]);

  const install = useCallback(() => {
    if (!status || installing || checking || savingPrerelease) return;
    const version = status.lastCheck?.state === "available" ? status.lastCheck.version : null;
    const settle = (result: DesktopUpdateOutcome) => {
      if (result.outcome === "current") {
        setStatus((current) => (current ? { ...current, lastCheck: { state: "current", checkedAt: Date.now(), prereleaseUpdates: current.prereleaseUpdates } } : current));
      }
      // "restarting": the shell is going away; leave the busy state up until it does.
      if (result.outcome !== "restarting") setInstalling(false);
    };
    setInstalling(true);
    setError(null);
    installDesktopUpdate(false, desktop)
      .then((result) => {
        settle(result);
        if (result.outcome !== "heldForWork") return;
        // Install Later leaves this row as it was: nothing here remembers the hold.
        void confirmHeldUpdate({
          confirm,
          version,
          held: result,
          links,
          install: async () => {
            setInstalling(true);
            try {
              const outcome = await installDesktopUpdate(true, desktop);
              settle(outcome);
              return outcome;
            } catch (cause) {
              // Shown in the confirmation, which stays open to try again or install later.
              setInstalling(false);
              throw cause;
            }
          },
        });
      })
      .catch((cause) => {
        setError(errorMessage(cause));
        setInstalling(false);
      });
  }, [checking, confirm, desktop, installing, links, savingPrerelease, status]);

  const openRelease = useCallback(() => {
    const url = status?.lastCheck?.state === "available" ? status.lastCheck.releaseUrl : status?.releasesUrl;
    if (!url) return;
    openReleasePage(url, desktop).catch((cause) => setError(errorMessage(cause)));
  }, [desktop, status]);

  const toggleAutomatic = useCallback(() => {
    if (!status || savingAutomatic) return;
    setSavingAutomatic(true);
    setError(null);
    writeAutomaticUpdateChecks(!status.automaticChecks, desktop)
      .then((automaticChecks) => setStatus((current) => (current ? { ...current, automaticChecks } : current)))
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setSavingAutomatic(false));
  }, [desktop, savingAutomatic, status]);

  const togglePrerelease = useCallback(() => {
    if (!status || savingPrerelease || checking || installing) return;
    setSavingPrerelease(true);
    setError(null);
    writePrereleaseUpdates(!status.prereleaseUpdates, desktop)
      .then((next) => setStatus((current) => current?.lastCheck && updateCheckMatchesStatus(current.lastCheck, next)
        && (!next.lastCheck || current.lastCheck.checkedAt >= next.lastCheck.checkedAt)
        ? { ...next, lastCheck: current.lastCheck } : next))
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setSavingPrerelease(false));
  }, [checking, desktop, installing, savingPrerelease, status]);

  return {
    desktop: inDesktop,
    status,
    loading,
    checking,
    installing,
    savingAutomatic,
    savingPrerelease,
    error,
    check,
    install,
    openRelease,
    toggleAutomatic,
    togglePrerelease,
  };
}
