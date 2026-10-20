import { useCallback, useEffect, useRef, useState } from "react";
import { startVisiblePolling } from "../visible-polling.js";

/**
 * What the last read or action of an Automations surface left unsaid. A failed action owns its error
 * until the person acts again; a failed poll or post-action read is recovered by the next complete
 * refresh.
 */
export interface AutomationPollingError {
  source: "poll" | "mutation" | "refresh";
  message: string;
  /** The failed action's title ("Automation Not Paused"), for a mutation. */
  action?: string;
}

/**
 * The Automations list's and the automation page's polling (#2968): one read every five seconds
 * while the tab is visible, and actions whose errors outlive the polls around them.
 *
 * `load` performs one complete read and commits it only while its `current()` holds; it must be
 * stable (a `useCallback`), since a new `load` restarts polling. Polls skip a busy refresh. An action
 * waits for it and then reads its own authoritative result. Effect cleanup (Strict Mode, an API
 * change, unmount) revokes both the in-flight read and any error ownership, so an obsolete client
 * can neither publish nor clear a newer error.
 */
export function useAutomationPolling(load: (current: () => boolean) => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AutomationPollingError | null>(null);
  // A user action owns its error even if an earlier poll settles later.
  const errorRevision = useRef(0);
  const beginMutation = () => {
    const revision = ++errorRevision.current;
    setError(null);
    return revision;
  };
  const mutationFailed = (revision: number, cause: unknown, action?: string) => {
    setError((previous) => revision === errorRevision.current
      ? { source: "mutation", message: (cause as Error).message, ...(action ? { action } : {}) } : previous);
  };

  const refreshInFlight = useRef<Promise<boolean> | null>(null);
  const refreshGeneration = useRef(0);

  const refresh = useCallback(async (onlyWhileVisible = false, active?: () => boolean) => {
    while (refreshInFlight.current) {
      await refreshInFlight.current.catch(() => {});
    }
    if (active?.() === false || (onlyWhileVisible && document.visibilityState === "hidden")) return false;
    const work = (async () => {
      const generation = (refreshGeneration.current += 1);
      const current = () => generation === refreshGeneration.current;
      await load(current);
      return current();
    })();
    refreshInFlight.current = work;
    try {
      return await work;
    } finally {
      refreshInFlight.current = null;
    }
  }, [load]);

  // Only call after a write explicitly resolves successfully. A failed authoritative read is
  // recoverable by polling; a rejected/unknown-acceptance write still belongs to mutationFailed.
  const refreshAfterMutation = async (revision: number) => {
    if (revision !== errorRevision.current) return;
    try {
      await refresh(false, () => revision === errorRevision.current);
    } catch (cause) {
      setError((previous) => revision === errorRevision.current
        ? { source: "refresh", message: (cause as Error).message } : previous);
    }
  };

  // The current effect's poll, for Retry; a no-op between effects.
  const pollNow = useRef<() => void>(() => {});
  useEffect(() => {
    let active = true;
    let initialRefresh = true;
    const poll = () => {
      // A previous effect's request can still be settling after Strict Mode cleanup or an API
      // change. The new effect must refresh after it, rather than wait for the first interval.
      if (refreshInFlight.current && !initialRefresh) return;
      initialRefresh = false;
      const revision = errorRevision.current;
      void refresh(true, () => active).then((recovered) => {
        if (!active || !recovered) return;
        setError((previous) => revision === errorRevision.current &&
          (previous?.source === "poll" || previous?.source === "refresh")
          ? null : previous);
      }).catch((cause) => {
        if (!active) return;
        setError((previous) => revision === errorRevision.current && previous?.source !== "mutation"
          ? { source: "poll", message: (cause as Error).message } : previous);
      });
    };
    const stopPolling = startVisiblePolling(poll, 5_000);
    pollNow.current = poll;
    return () => {
      active = false;
      pollNow.current = () => {};
      refreshGeneration.current += 1;
      errorRevision.current += 1;
      stopPolling();
    };
  }, [refresh]);

  /**
   * Runs one action: busy while it runs, its failure titled `action`, then a fresh authoritative
   * read once it resolves. `work` commits whatever its own result shows (a revealed secret). With
   * `refresh: false` nothing is read afterwards: a delete leaves nothing to read. Resolves whether it
   * succeeded.
   */
  const mutate = async (work: () => Promise<unknown>, action: string, options: { refresh?: boolean } = {}) => {
    setBusy(true);
    const revision = beginMutation();
    try {
      await work();
      if (options.refresh !== false) await refreshAfterMutation(revision);
      return true;
    } catch (cause) {
      mutationFailed(revision, cause, action);
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** Reads again now, as the next poll would; skipped while a read is already running. */
  const retry = useCallback(() => pollNow.current(), []);

  return { busy, error, mutate, retry };
}
