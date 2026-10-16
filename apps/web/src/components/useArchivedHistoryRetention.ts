import { useEffect, useState } from "react";
import type { ArchivedHistoryRetentionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";

type RetentionApi = ReturnType<typeof useApi>;

interface Entry {
  view: ArchivedHistoryRetentionView | null;
  fetchedAt: number;
  pending: Promise<void> | null;
  listeners: Set<() => void>;
}

/** One answer per instance, shared by every archived session a person opens. */
const entries = new WeakMap<RetentionApi, Entry>();
/** A policy another owner changed shows here within this long. */
const STALE_MS = 60_000;

function entryFor(api: RetentionApi): Entry {
  let entry = entries.get(api);
  if (!entry) entries.set(api, entry = { view: null, fetchedAt: 0, pending: null, listeners: new Set() });
  return entry;
}

/** Settings › Storage hands every answer it receives to the archived sessions' notices. */
export function publishArchivedHistoryRetention(api: RetentionApi, view: ArchivedHistoryRetentionView): void {
  const entry = entryFor(api);
  entry.view = view;
  entry.fetchedAt = Date.now();
  for (const listener of entry.listeners) listener();
}

/**
 * The organization's archived-history retention, for saying when an archived session's history will
 * be pruned (#2777). Read only while `enabled`. A control plane that predates the policy, or a read
 * that fails, leaves it null: the notice then says nothing about pruning rather than guessing.
 */
export function useArchivedHistoryRetention(enabled: boolean): ArchivedHistoryRetentionView | null {
  const api = useApi();
  const [view, setView] = useState<ArchivedHistoryRetentionView | null>(() => entryFor(api).view);
  useEffect(() => {
    if (!enabled) return;
    const entry = entryFor(api);
    const update = () => setView(entry.view);
    entry.listeners.add(update);
    update();
    if (!entry.pending && Date.now() - entry.fetchedAt >= STALE_MS) {
      entry.pending = api.archivedHistoryRetention().then((next) => {
        publishArchivedHistoryRetention(api, next);
      }).catch(() => {
        entry.fetchedAt = Date.now();
      }).finally(() => {
        entry.pending = null;
      });
    }
    return () => { entry.listeners.delete(update); };
  }, [api, enabled]);
  return enabled ? view : null;
}
