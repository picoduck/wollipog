import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

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

export type DesktopUpdateCheck =
  | { state: "current"; checkedAt: number }
  | { state: "available"; version: string; releaseUrl: string; checkedAt: number };

export interface DesktopUpdateStatus {
  currentVersion: string;
  install: DesktopUpdateInstall;
  automaticChecks: boolean;
  /** False when the installation turned every update request off. */
  checksAllowed: boolean;
  releasesUrl: string;
  lastCheck: DesktopUpdateCheck | null;
}

export type DesktopUpdateOutcome =
  | { outcome: "current" }
  /** Work is in flight; nothing was installed. `sessions` is 0 when the shell could not count. */
  | { outcome: "heldForWork"; sessions: number }
  | { outcome: "restarting" };

export interface DesktopUpdateRuntime {
  isTauri: () => boolean;
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
}

const runtime: DesktopUpdateRuntime = { isTauri, invoke };

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

export function installDesktopUpdate(desktop: DesktopUpdateRuntime = runtime): Promise<DesktopUpdateOutcome> {
  return desktop.invoke<DesktopUpdateOutcome>("install_desktop_update");
}

export function writeAutomaticUpdateChecks(enabled: boolean, desktop: DesktopUpdateRuntime = runtime): Promise<boolean> {
  return desktop.invoke<boolean>("set_automatic_update_checks", { enabled });
}

export function openReleasePage(url: string, desktop: DesktopUpdateRuntime = runtime): Promise<void> {
  return desktop.invoke<void>("open_external_url", { url });
}

/** The install button's warning. Same rule as the close warning, different gesture. */
export function updateWarning(sessions: number): string {
  if (sessions <= 0) return "Agent work may still be running. Installing restarts Wollipog and will stop it.";
  return sessions === 1
    ? "1 session still has work running. Installing restarts Wollipog and will stop it."
    : `${sessions} sessions still have work running. Installing restarts Wollipog and will stop them.`;
}

export function availableUpdateMessage(version: string): string {
  return `Wollipog ${version} is available.`;
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
  /** Set when the last install attempt was held because work is in flight. */
  heldSessions: number | null;
  error: string | null;
  check: () => void;
  install: () => void;
  dismissHold: () => void;
  openRelease: () => void;
  toggleAutomatic: () => void;
}

/**
 * Settings state for the Updates row.
 *
 * Reads the shell's status once, which includes the last check the background notifier made, so
 * opening Settings does not ask GitHub again. Checking is a click.
 */
export function useDesktopUpdateSetting(desktop: DesktopUpdateRuntime = runtime): DesktopUpdateSetting {
  const inDesktop = useMemo(() => desktop.isTauri(), [desktop]);
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);
  const [loading, setLoading] = useState(inDesktop);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [savingAutomatic, setSavingAutomatic] = useState(false);
  const [heldSessions, setHeldSessions] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!inDesktop) return;
    let disposed = false;
    readDesktopUpdateStatus(desktop)
      .then((next) => { if (!disposed) setStatus(next); })
      .catch((cause) => { if (!disposed) setError(errorMessage(cause)); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [desktop, inDesktop]);

  const check = useCallback(() => {
    if (!status || checking || installing) return;
    setChecking(true);
    setError(null);
    setHeldSessions(null);
    checkForDesktopUpdate(false, desktop)
      .then((lastCheck) => setStatus((current) => (current ? { ...current, lastCheck } : current)))
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setChecking(false));
  }, [checking, desktop, installing, status]);

  const install = useCallback(() => {
    if (!status || installing || checking) return;
    setInstalling(true);
    setError(null);
    installDesktopUpdate(desktop)
      .then((result) => {
        if (result.outcome === "heldForWork") {
          setHeldSessions(result.sessions);
        } else if (result.outcome === "current") {
          setHeldSessions(null);
          setStatus((current) => (current ? { ...current, lastCheck: { state: "current", checkedAt: Date.now() } } : current));
        }
        // "restarting": the shell is going away; leave the busy state up until it does.
        if (result.outcome !== "restarting") setInstalling(false);
      })
      .catch((cause) => {
        setError(errorMessage(cause));
        setInstalling(false);
      });
  }, [checking, desktop, installing, status]);

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

  const dismissHold = useCallback(() => setHeldSessions(null), []);

  return {
    desktop: inDesktop,
    status,
    loading,
    checking,
    installing,
    savingAutomatic,
    heldSessions,
    error,
    check,
    install,
    dismissHold,
    openRelease,
    toggleAutomatic,
  };
}
