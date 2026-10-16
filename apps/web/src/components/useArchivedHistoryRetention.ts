import { useEffect, useState } from "react";
import type { ArchivedHistoryRetentionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";

type RetentionApi = ReturnType<typeof useApi>;

interface Entry {
  view: ArchivedHistoryRetentionView | null;
  fetchedAt: number;
  pending: Promise<void> | null;
  /** Advanced by every published policy, so a read that started before one never replaces it. */
  generation: number;
  listeners: Set<() => void>;
}

/** One answer per instance, shared by every archived session a person opens. */
const entries = new WeakMap<RetentionApi, Entry>();
/** A policy another owner changed, or a read that failed, is read again once it is this old. */
export const ARCHIVED_HISTORY_RETENTION_STALE_MS = 60_000;
/** How often an open reader checks whether its policy is stale, so it shows a change within
 * about STALE_MS plus this. */
const CHECK_MS = 15_000;

function entryFor(api: RetentionApi): Entry {
  let entry = entries.get(api);
  if (!entry) entries.set(api, entry = { view: null, fetchedAt: 0, pending: null, generation: 0, listeners: new Set() });
  return entry;
}

/** Settings › Storage hands every answer it receives to the archived sessions' notices. */
export function publishArchivedHistoryRetention(api: RetentionApi, view: ArchivedHistoryRetentionView): void {
  const entry = entryFor(api);
  entry.generation += 1;
  entry.view = view;
  entry.fetchedAt = Date.now();
  for (const listener of entry.listeners) listener();
}

function refresh(api: RetentionApi, entry: Entry): void {
  if (entry.pending || Date.now() - entry.fetchedAt < ARCHIVED_HISTORY_RETENTION_STALE_MS) return;
  const started = entry.generation;
  entry.pending = api.archivedHistoryRetention().then((next) => {
    if (entry.generation === started) publishArchivedHistoryRetention(api, next);
  }).catch(() => {
    if (entry.generation === started) entry.fetchedAt = Date.now();
  }).finally(() => {
    entry.pending = null;
  });
}

/**
 * The organization's archived-history retention, for saying when an archived session's history will
 * be pruned (#2777). Read only while `enabled`, and again while it stays enabled once the answer is
 * stale. A control plane that predates the policy, or a read that fails, leaves it null: the notice
 * then says nothing about pruning rather than guessing.
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
    refresh(api, entry);
    const timer = setInterval(() => refresh(api, entry), CHECK_MS);
    return () => {
      entry.listeners.delete(update);
      clearInterval(timer);
    };
  }, [api, enabled]);
  return enabled ? view : null;
}
