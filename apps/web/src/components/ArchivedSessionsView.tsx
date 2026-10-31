import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTerminal, type ArchiveSessionMetadata, type SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { ARCHIVE_SEARCH_EVENT, pendingArchiveSearch, takeArchiveSearch } from "../archive-search-handoff.js";
import { sessionUnarchiveRestarts, unarchiveAndRestartFailureMessage } from "../archive-actions.js";
import { pendingQueuedPromptCount } from "../session-actions.js";
import { sessionCommandRefusal } from "../session-command-permissions.js";
import { deleteSessionMessage, stopArchivedSessionMessage } from "../session-confirmation-copy.js";
import {
  archiveSessionMetadata,
  canonicalLifecycleLabel,
  filterArchiveSessions,
  mergeArchiveSessionCatalog,
  SESSION_LIFECYCLE_STATES,
  type ArchiveBrowserFilters,
} from "../archive-browser.js";
import { discardComposerDraft } from "../composer-drafts.js";
import { historyPrunedTitle } from "../archived-history-retention.js";
import { formatRecordedRelativeTime, formatRecordedTimestamp } from "../format.js";
import { statusMeta } from "../status-meta.js";
import { useInstanceScope } from "../instance-scope.js";
import { destination, viewPath } from "../navigation.js";
import { removeFromInstanceKeySet, SESSION_PIN_KEY } from "../pins.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { useFeedback } from "./FeedbackProvider.js";
import { BotIcon, HistoryIcon, InboxIcon, MoreHorizontalIcon, ProjectsIcon, SearchIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuSeparator, MenuSurface } from "./Menu.js";
import { Spinner } from "./common.js";
import { PageHeader } from "./PageHeader.js";
import { StatusBadge } from "./StatusBadge.js";
import { Notice } from "./Notice.js";
import { State, stateVariant } from "./State.js";
import { Select } from "./ui/ChoiceControls.js";

const DEFAULT_FILTERS: ArchiveBrowserFilters = {
  query: "",
  project: null,
  location: null,
  agent: null,
  archive: "archived",
  lifecycle: "all",
};
const FACET_VALUE_PREFIX = "facet:";

function facetValue(value: string): string {
  return FACET_VALUE_PREFIX + encodeURIComponent(value);
}

function facetName(value: string): string {
  return decodeURIComponent(value.slice(FACET_VALUE_PREFIX.length));
}

function HighlightedSnippet({ snippet }: { snippet: string }) {
  return <>{snippet.split(/(⟪[^⟫]*⟫)/g).map((part, index) => part.startsWith("⟪")
    ? <mark key={index}>{part.slice(1, -1)}</mark> : part)}</>;
}

function locallyMatches(
  session: SessionView,
  filters: ArchiveBrowserFilters,
  locationNames: ReadonlyMap<string, string>,
  transcriptSessionIds: ReadonlySet<string>,
): boolean {
  return filterArchiveSessions({
    sessions: [session],
    filters,
    locationNames,
    transcriptSessionIds,
  }).length === 1;
}

type LocalReconciliation = "match" | "exclude" | "revalidate";

function liveRevalidationKey(session: SessionView, filters: ArchiveBrowserFilters): string {
  return JSON.stringify([
    session.updatedAt,
    filters.query.trim(),
    filters.project,
    filters.location,
    filters.agent,
    filters.archive,
    filters.lifecycle,
  ]);
}

/** Search misses are not authoritative: the server also searches resolved metadata and transcript
 * text that a websocket upsert does not carry. Scope misses are safe to remove immediately. */
function reconcileLocally(
  session: SessionView,
  filters: ArchiveBrowserFilters,
  locationNames: ReadonlyMap<string, string>,
  transcriptSessionIds: ReadonlySet<string>,
): LocalReconciliation {
  if (locallyMatches(session, filters, locationNames, transcriptSessionIds)) return "match";
  // The archive endpoint resolves a Project Location through its database join. A session upsert
  // carries only the Location id, so websocket and Project snapshot ordering can temporarily leave
  // the client unable to reproduce that facet value. Preserve the server row until one bounded
  // refresh unless another locally authoritative scope filter already excludes it.
  const projectLocationId = session.projectLocationId;
  const unresolvedLocation = filters.location !== null && (
    (projectLocationId != null && !locationNames.has(projectLocationId)) ||
    (projectLocationId == null && session.workspaceId != null && session.workspaceName == null)
  );
  if (unresolvedLocation && locallyMatches(
    session,
    { ...filters, query: "", location: null },
    locationNames,
    transcriptSessionIds,
  )) return "revalidate";
  return locallyMatches(session, { ...filters, query: "" }, locationNames, transcriptSessionIds)
    ? "revalidate"
    : "exclude";
}

export function ArchivedSessionsView() {
  const api = useApi();
  const instanceScope = useInstanceScope();
  const { confirm, showToast, showUndo } = useFeedback();
  const { dispatch, loadSession, navigate } = useStoreActions();
  const liveSessions = useStoreSelector((state) => state.sessions);
  const projects = useStoreSelector((state) => state.projects);
  const conn = useStoreSelector((state) => state.conn);
  const runners = useStoreSelector((state) => state.runners);
  const refreshCatalogRef = useRef<() => Promise<void>>(async () => {});
  const liveRevalidationTimerRef = useRef<number | null>(null);
  const revalidatedLiveVersionsRef = useRef(new Map<string, string>());
  const stopFailureRecoverySupported = useStoreSelector((state) => state.stopFailureRecoverySupported);
  const unarchiveAndRestartSupported = useStoreSelector((state) => state.unarchiveAndRestartSupported);
  const deletedSessionIdsRef = useRef(new Set<string>());
  const liveSessionsRef = useRef(liveSessions);
  const requestSequenceRef = useRef(0);
  liveSessionsRef.current = liveSessions;

  const [catalog, setCatalog] = useState(() => new Map<string, SessionView>());
  const hasBeenOnlineRef = useRef(false);
  const connectionLostRef = useRef(false);
  const revalidateAfterLoadRef = useRef(false);
  // A query handed over by the palette's "Search Archived Sessions" (#1978) is the first search.
  const [filters, setFilters] = useState(() => ({ ...DEFAULT_FILTERS, query: pendingArchiveSearch() ?? "" }));
  const [queryInput, setQueryInput] = useState(() => pendingArchiveSearch() ?? "");
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [facets, setFacets] = useState({ projects: [] as string[], locations: [] as string[], agents: [] as string[] });
  const [pageMetadata, setPageMetadata] = useState<Record<string, ArchiveSessionMetadata>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState(() => new Set<string>());
  const [transcriptHits, setTranscriptHits] = useState(() => new Map<string, string>());
  const locationNames = useMemo(() => new Map(
    [...projects.values()].flatMap((project) => project.locations.map((location) => [location.id, location.name] as const)),
  ), [projects]);
  const locationNamesRef = useRef(locationNames);
  locationNamesRef.current = locationNames;

  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const refreshCatalog = useCallback(async () => {
    const requestSequence = ++requestSequenceRef.current;
    setLoading(true);
    try {
      const response = await api.archiveSessionPage({
        cursor: cursors[page - 1] ?? undefined,
        project: filters.project ?? undefined,
        location: filters.location ?? undefined,
        agent: filters.agent ?? undefined,
        archive: filters.archive,
        lifecycle: filters.lifecycle,
        q: filters.query.trim() || undefined,
      });
      if (requestSequence !== requestSequenceRef.current) return;
      const responseSessions = new Map(response.sessions.map((session) => [session.id, session]));
      const next = new Map(responseSessions);
      const transcriptSessionIds = new Set(Object.keys(response.snippets));
      for (const session of liveSessionsRef.current.values()) {
        const responseSession = responseSessions.get(session.id);
        if (responseSession === undefined || session.updatedAt <= responseSession.updatedAt) continue;
        const reconciliation = reconcileLocally(session, filters, locationNamesRef.current, transcriptSessionIds);
        if (reconciliation !== "exclude") {
          next.set(session.id, session);
        } else {
          next.delete(session.id);
        }
        const revalidationKey = liveRevalidationKey(session, filters);
        if (reconciliation === "revalidate" &&
            revalidatedLiveVersionsRef.current.get(session.id) !== revalidationKey) {
          revalidatedLiveVersionsRef.current.set(session.id, revalidationKey);
          revalidateAfterLoadRef.current = true;
        }
      }
      for (const sessionId of deletedSessionIdsRef.current) {
        next.delete(sessionId);
      }
      setCatalog(next);
      setTranscriptHits(new Map(Object.entries(response.snippets)));
      setPageMetadata(response.metadata);
      setNextCursor(response.nextCursor);
      setFacets(response.facets);
      setError(null);
    } catch (cause) {
      if (requestSequence !== requestSequenceRef.current) return;
      setError(`Could not load archived sessions: ${(cause as Error).message}`);
    } finally {
      if (requestSequence === requestSequenceRef.current) setLoading(false);
    }
  }, [api, cursors, filters, page]);
  refreshCatalogRef.current = refreshCatalog;

  const scheduleLiveRevalidation = useCallback(() => {
    if (liveRevalidationTimerRef.current !== null) return;
    liveRevalidationTimerRef.current = window.setTimeout(() => {
      liveRevalidationTimerRef.current = null;
      void refreshCatalogRef.current();
    }, 50);
  }, []);

  useEffect(() => { void refreshCatalog(); }, [refreshCatalog]);

  useEffect(() => {
    takeArchiveSearch();
    const onArchiveSearch = () => {
      const query = takeArchiveSearch();
      if (query !== null) setQueryInput(query);
    };
    window.addEventListener(ARCHIVE_SEARCH_EVENT, onArchiveSearch);
    return () => window.removeEventListener(ARCHIVE_SEARCH_EVENT, onArchiveSearch);
  }, []);

  useEffect(() => {
    if (filters.query === queryInput) return;
    const timer = window.setTimeout(() => {
      setFilters((current) => ({ ...current, query: queryInput }));
      setPage(1);
      setCursors([null]);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [filters.query, queryInput]);

  // Update rows already present in this bounded page. New rows are incorporated by the visibility
  // and reconnect reconciliation below so websocket arrival order cannot alter cursor membership.
  useEffect(() => {
    const currentCatalog = catalogRef.current;
    const pageUpserts = [...liveSessions.values()].filter((session) => {
      const catalogSession = currentCatalog.get(session.id);
      return catalogSession !== undefined && session.updatedAt > catalogSession.updatedAt;
    });
    const transcriptSessionIds = new Set(transcriptHits.keys());
    let needsRevalidation = false;
    for (const session of pageUpserts) {
      if (reconcileLocally(session, filters, locationNames, transcriptSessionIds) === "match") continue;
      const revalidationKey = liveRevalidationKey(session, filters);
      if (revalidatedLiveVersionsRef.current.get(session.id) === revalidationKey) continue;
      revalidatedLiveVersionsRef.current.set(session.id, revalidationKey);
      needsRevalidation = true;
    }
    setCatalog((current) => {
      const next = new Map(current);
      let changed = false;
      for (const session of pageUpserts) {
        const reconciliation = reconcileLocally(session, filters, locationNames, transcriptSessionIds);
        if (reconciliation === "exclude") {
          changed = next.delete(session.id) || changed;
        } else if (next.get(session.id) !== session) {
          next.set(session.id, session);
          changed = true;
        }
      }
      for (const sessionId of deletedSessionIdsRef.current) {
        changed = next.delete(sessionId) || changed;
      }
      return changed ? next : current;
    });
    if (pageUpserts.length > 0) {
      setPageMetadata((current) => {
        const next = { ...current };
        for (const session of pageUpserts) {
          if (reconcileLocally(session, filters, locationNames, transcriptSessionIds) === "match") {
            next[session.id] = archiveSessionMetadata(session, locationNames);
          }
        }
        return next;
      });
    }
    if (needsRevalidation) scheduleLiveRevalidation();
  }, [filters, liveSessions, locationNames, scheduleLiveRevalidation, transcriptHits]);

  useEffect(() => () => {
    if (liveRevalidationTimerRef.current !== null) {
      window.clearTimeout(liveRevalidationTimerRef.current);
      liveRevalidationTimerRef.current = null;
    }
  }, []);

  // Deletions of rows that have not emitted an upsert on this socket cannot be identified by the
  // live snapshot (which omits archives). Revalidate when a client returns to the tab or reconnects.
  useEffect(() => {
    const revalidate = () => {
      if (document.visibilityState === "visible") void refreshCatalog();
    };
    document.addEventListener("visibilitychange", revalidate);
    return () => document.removeEventListener("visibilitychange", revalidate);
  }, [refreshCatalog]);
  useEffect(() => {
    if (conn === "offline" || conn === "unauthorized") {
      connectionLostRef.current = true;
      return;
    }
    if (conn === "connecting") {
      if (hasBeenOnlineRef.current) connectionLostRef.current = true;
      return;
    }
    if (!hasBeenOnlineRef.current) {
      hasBeenOnlineRef.current = true;
    }
    if (!connectionLostRef.current) return;
    connectionLostRef.current = false;
    if (loading) revalidateAfterLoadRef.current = true;
    else {
      revalidateAfterLoadRef.current = false;
      void refreshCatalog();
    }
  }, [conn, loading, refreshCatalog]);
  useEffect(() => {
    if (loading || conn !== "online" || !revalidateAfterLoadRef.current) return;
    revalidateAfterLoadRef.current = false;
    void refreshCatalog();
  }, [conn, loading, refreshCatalog]);

  const pageSessions = useMemo(() => [...catalog.values()], [catalog]);
  const hasActiveFilters = Boolean(queryInput) || filters.project !== null || filters.location !== null ||
    filters.agent !== null || filters.lifecycle !== "all" || filters.archive !== "archived";

  const changeFilter = <K extends keyof ArchiveBrowserFilters>(key: K, value: ArchiveBrowserFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
    setCursors([null]);
  };

  const setBusy = (id: string, value: boolean) => {
    setBusyIds((current) => {
      const next = new Set(current);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const updateSession = (session: SessionView) => {
    const reconciliation = reconcileLocally(
      session,
      filters,
      locationNames,
      new Set(transcriptHits.keys()),
    );
    setCatalog((current) => {
      const next = mergeArchiveSessionCatalog(current, [session]);
      if (reconciliation === "exclude") next.delete(session.id);
      return next;
    });
    if (reconciliation === "revalidate") scheduleLiveRevalidation();
    loadSession(session);
  };

  const unarchive = async (session: SessionView) => {
    setBusy(session.id, true);
    try {
      updateSession(await api.setArchived(session.id, false));
      showUndo("Session restored.", async () => {
        const restored = await api.setArchived(session.id, true);
        loadSession(restored);
        await refreshCatalogRef.current();
      });
    } catch (cause) {
      showToast(`Couldn't unarchive “${session.title || session.id}”.`, { tone: "error", detail: (cause as Error).message });
    } finally {
      setBusy(session.id, false);
    }
  };

  // No Undo: the session is running again, and re-archiving it without a Stop would hide live work.
  const unarchiveAndRestart = async (session: SessionView) => {
    setBusy(session.id, true);
    try {
      const restarted = await api.unarchiveAndRestart(session.id);
      updateSession(restarted);
      showToast("Session restored and restarting.");
      navigate({ name: "session", id: restarted.id });
    } catch (cause) {
      const failure = unarchiveAndRestartFailureMessage(cause);
      showToast(failure.ambiguous ? failure.message : `Couldn't unarchive “${session.title || session.id}”.`, {
        tone: "error", detail: (cause as Error).message,
      });
      if (failure.ambiguous) void refreshCatalogRef.current();
    } finally {
      setBusy(session.id, false);
    }
  };

  const retryStop = async (session: SessionView) => {
    setBusy(session.id, true);
    try {
      const updated = session.archiveStatus === "stop_failed" || stopFailureRecoverySupported
        ? await api.retryStop(session.id)
        : await api.setArchived(session.id, true);
      updateSession(updated);
      showToast("Stop retry requested.");
    } catch (cause) {
      showToast(`Couldn't retry the stop for “${session.title || session.id}”.`, { tone: "error", detail: (cause as Error).message });
    } finally {
      setBusy(session.id, false);
    }
  };

  const stop = async (session: SessionView, back?: ConfirmBack) => {
    // The live copy carries the runner's queue, which the archive page's REST rows can lack (a steer
    // converted to a queued prompt exists only on the runner), and it is what the session header counts.
    const queued = (liveSessionsRef.current.get(session.id) ?? session).queued;
    const approved = await confirm({
      title: "Stop Session",
      message: stopArchivedSessionMessage(session.title, pendingQueuedPromptCount(queued), session.archived),
      back,
      confirmLabel: "Stop Session",
      tone: "danger",
    });
    if (!approved) return;
    setBusy(session.id, true);
    try {
      updateSession(await api.stop(session.id));
      showToast("Session stopped.");
    } catch (cause) {
      showToast(`Couldn't stop “${session.title || session.id}”.`, { tone: "error", detail: (cause as Error).message });
    } finally {
      setBusy(session.id, false);
    }
  };

  const deleteSession = async (session: SessionView, back?: ConfirmBack) => {
    const approved = await confirm({
      title: "Delete Session",
      message: deleteSessionMessage(session.title),
      back,
      confirmLabel: "Delete Session",
      tone: "danger",
    });
    if (!approved) return;
    setBusy(session.id, true);
    try {
      await api.deleteSession(session.id);
      removeFromInstanceKeySet(SESSION_PIN_KEY, instanceScope, session.id);
      void discardComposerDraft(session.id, instanceScope);
      deletedSessionIdsRef.current.add(session.id);
      setCatalog((current) => {
        const next = new Map(current);
        next.delete(session.id);
        return next;
      });
      dispatch({ type: "msg", msg: { type: "session_removed", sessionId: session.id } });
      showToast("Session deleted.");
    } catch (cause) {
      showToast(`Couldn't delete “${session.title || session.id}”.`, { tone: "error", detail: (cause as Error).message });
    } finally {
      setBusy(session.id, false);
    }
  };

  return (
    <section className="page archive-view" aria-labelledby="page-title">
      <PageHeader title={destination("archived").name} description={destination("archived").description} />
      <div className="toolbar">
        <label className="archive-search">
          <span>Search Sessions and Transcripts</span>
          <div>
            <SearchIcon size={16} aria-hidden="true" />
            <input
              type="search"
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
              placeholder="Search sessions and transcripts"
            />
          </div>
        </label>
        <fieldset className="archive-filters">
          <legend className="sr-only">Archived Session Filters</legend>
          <div className="archive-filter"><span className="field-label">Project</span><Select
            label="Project"
            value={filters.project === null ? "all" : facetValue(filters.project)}
            options={[{ value: "all", label: "All Projects" }, ...facets.projects.map((value) => ({ value: facetValue(value), label: value }))]}
            onChange={(value) => changeFilter("project", value === "all" ? null : facetName(value))}
          /></div>
          <div className="archive-filter"><span className="field-label">Location</span><Select
            label="Location"
            value={filters.location === null ? "all" : facetValue(filters.location)}
            options={[{ value: "all", label: "All Locations" }, ...facets.locations.map((value) => ({ value: facetValue(value), label: value }))]}
            onChange={(value) => changeFilter("location", value === "all" ? null : facetName(value))}
          /></div>
          <div className="archive-filter"><span className="field-label">Agent</span><Select
            label="Agent"
            value={filters.agent === null ? "all" : facetValue(filters.agent)}
            options={[{ value: "all", label: "All Agents" }, ...facets.agents.map((value) => ({ value: facetValue(value), label: value }))]}
            onChange={(value) => changeFilter("agent", value === "all" ? null : facetName(value))}
          /></div>
          <div className="archive-filter"><span className="field-label">Archive State</span><Select<ArchiveBrowserFilters["archive"]>
            label="Archive State"
            value={filters.archive}
            options={[
              { value: "archived", label: "Archived" },
              { value: "unarchived", label: "Not Archived" },
              { value: "all", label: "All Sessions" },
            ]}
            onChange={(value) => changeFilter("archive", value)}
          /></div>
          <div className="archive-filter"><span className="field-label">Lifecycle State</span><Select<ArchiveBrowserFilters["lifecycle"]>
            label="Lifecycle State"
            value={filters.lifecycle}
            options={[
              { value: "all", label: "All Lifecycle States" },
              ...SESSION_LIFECYCLE_STATES.map((status) => ({ value: status, label: canonicalLifecycleLabel(status) })),
            ]}
            onChange={(value) => changeFilter("lifecycle", value)}
          /></div>
          <button type="button" className="btn ghost sm" onClick={() => {
            setQueryInput(""); setFilters(DEFAULT_FILTERS); setPage(1); setCursors([null]);
          }}>
            Reset Filters
          </button>
        </fieldset>
      </div>

      <div className="archive-results-summary" role="status" aria-live="polite">
        Showing {pageSessions.length} Session{pageSessions.length === 1 ? "" : "s"}
      </div>

      {error && pageSessions.length > 0 && (
        <Notice tone="danger" compact role="alert"
          actions={<button className="btn sm" type="button" onClick={() => void refreshCatalog()}>Try Again</button>}>
          {error}
        </Notice>
      )}
      {pageSessions.length === 0 && stateVariant({
        // A cold load's first attempt is not a lost connection; a retry after one is (§12.5).
        offline: conn === "offline" || conn === "unauthorized" || (conn === "connecting" && hasBeenOnlineRef.current),
        loading: loading,
        error: Boolean(error),
      }) === "offline" ? (
        <State variant="offline">Reconnecting…</State>
      ) : loading && pageSessions.length === 0 ? (
        <State variant="loading">Loading archived sessions…</State>
      ) : error && pageSessions.length === 0 ? (
        <State variant="error" title="Couldn't Load Archived Sessions"
          actions={<button className="btn sm" type="button" onClick={() => void refreshCatalog()}>Try Again</button>}>
          {error}
        </State>
      ) : pageSessions.length === 0 ? (
        <State
          variant={hasActiveFilters ? "no-results" : "empty"}
          pageLevel={!hasActiveFilters}
          title={hasActiveFilters
            ? "No Matching Sessions"
            : `No ${destination("archived").name}`}
          icon={<InboxIcon />}
          actions={<button type="button" className={hasActiveFilters ? "btn sm" : "btn primary"} onClick={() => {
            if (hasActiveFilters) { setQueryInput(""); setFilters(DEFAULT_FILTERS); setPage(1); setCursors([null]); }
            else navigate({ name: "inbox" });
          }}>{hasActiveFilters ? "Reset Filters" : "Go to Sessions"}</button>}
        >
          {hasActiveFilters
            ? "Try clearing search text or changing a filter."
            : "Archived sessions will appear here with their lifecycle state and transcript."}
        </State>
      ) : (
        <div className="surface archive-list" role="region" aria-label="Archived Session Results">
          {pageSessions.map((session) => {
            const metadata = pageMetadata[session.id] ?? archiveSessionMetadata(session, locationNames);
            const title = session.title || session.id;
            const timestamp = formatRecordedTimestamp(session.createdAt);
            const snippet = transcriptHits.get(session.id);
            const target = { name: "session" as const, id: session.id };
            const openSession = () => { loadSession(session); navigate(target); };
            const stopPending = session.archiveStatus === "stop_pending";
            const stopFailed = session.archiveStatus === "stop_failed";
            const showStop = stopPending || stopFailed || !isTerminal(session.status);
            const badge = stopFailed ? statusMeta("session", "stop_failed")
              : stopPending ? statusMeta("session", runners.get(session.runnerId)?.status === "offline" ? "stop_waiting_for_runner" : "stop_pending")
              : !session.archived ? statusMeta("session", session.status)
              : filters.archive === "all" ? statusMeta("session", "archived") : null;
            const restore: ArchiveRowAction | null = session.archived ? {
              label: sessionUnarchiveRestarts(session, unarchiveAndRestartSupported) ? "Unarchive and Restart" : "Unarchive",
              refusal: sessionCommandRefusal(session, "unarchive"),
              run: () => void (sessionUnarchiveRestarts(session, unarchiveAndRestartSupported) ? unarchiveAndRestart(session) : unarchive(session)),
            } : null;
            const retry: ArchiveRowAction = {
              label: "Retry Stop", refusal: sessionCommandRefusal(session, "stop"),
              description: stopFailed ? `The last stop attempt failed, so archiving is paused.${session.archiveOperation?.failure?.message ? ` ${session.archiveOperation.failure.message}` : ""}` : undefined,
              run: () => void retryStop(session),
            };
            const prunedDetail = session.historyPruned ? historyPrunedTitle(session.historyPruned) : undefined;
            const actions: ArchiveRowAction[] = [{ label: "Open Session", refusal: null, description: prunedDetail, run: openSession }];
            if (restore) actions.push(restore);
            if (stopPending || stopFailed) actions.push(retry);
            else if (showStop) actions.push({ label: "Stop Session…", refusal: sessionCommandRefusal(session, "stop"), run: (back) => void stop(session, back) });
            if (session.archived) actions.push({ label: "Delete Session…", danger: true, refusal: sessionCommandRefusal(session, "delete"), run: (back) => void deleteSession(session, back) });
            return <div key={session.id} className={`row row-2 archive-item${snippet ? " has-snippet" : ""}`}
              tabIndex={0} role="group" aria-label={title}
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || window.getSelection()?.toString()) return;
                if (!(event.target as HTMLElement).closest("a, button")) openSession();
              }}
              onKeyDown={(event) => { if (event.key === "Enter" && event.target === event.currentTarget) { event.preventDefault(); openSession(); } }}>
              <div className="archive-item-content">
                <div className="archive-item-heading">
                  <a id={`archive-title-${session.id}`} href={viewPath(target)} title={title} tabIndex={-1} onClick={(event) => {
                    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault(); openSession();
                  }}>{title}</a>
                  {badge && <span className="archive-item-badge"><StatusBadge meta={badge} /></span>}
                </div>
                {snippet && <div className="archive-item-snippet">Transcript: <HighlightedSnippet snippet={snippet} /></div>}
                <div className="archive-item-meta">
                  <span className="archive-project" title={metadata.project === metadata.location ? metadata.project : `${metadata.project} › ${metadata.location}`}><ProjectsIcon size={14} /> <span>{metadata.project}{metadata.project !== metadata.location && ` › ${metadata.location}`}</span></span>
                  <span className="archive-agent"><BotIcon size={14} />{metadata.agent}</span>
                  {prunedDetail && <span className="archive-history" role="img" aria-label="History Pruned" title={prunedDetail}><HistoryIcon size={14} /><span>History Pruned</span></span>}
                </div>
              </div>
              <time dateTime={timestamp?.dateTime} title={timestamp?.title}>{formatRecordedRelativeTime(session.createdAt)}</time>
              <ArchiveRowActions sessionId={session.id} title={title} actions={actions} inline={stopFailed ? retry : restore} busy={busyIds.has(session.id)} />
            </div>;
          })}
        </div>
      )}

      {(pageSessions.length > 0 || page > 1) && (
        <nav className="archive-pagination" aria-label="Archived Sessions Pagination">
          <button type="button" className="btn ghost sm" disabled={page <= 1 || loading} onClick={() => setPage((current) => current - 1)}>Previous Page</button>
          <span>Page {page}</span>
          <button type="button" className="btn ghost sm" disabled={!nextCursor || loading} onClick={() => {
            if (!nextCursor) return;
            setCursors((current) => [...current.slice(0, page), nextCursor]);
            setPage((current) => current + 1);
          }}>Next Page</button>
        </nav>
      )}
    </section>
  );
}

type ConfirmBack = { label: string; run: () => void };
interface ArchiveRowAction {
  label: string;
  refusal: string | null;
  description?: string;
  danger?: boolean;
  run: (back?: ConfirmBack) => void;
}

function ArchiveRowActions({ sessionId, title, actions, inline, busy }: {
  sessionId: string; title: string; actions: ArchiveRowAction[]; inline: ArchiveRowAction | null; busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "archive-row-menu");
  const reasonId = `archive-refusal-${sessionId}`;
  const firstDanger = actions.findIndex((action) => action.danger);
  const choose = (action: ArchiveRowAction) => {
    menu.close(false);
    menu.triggerRef.current?.focus();
    action.run({ label: "Back to More Actions", run: () => setOpen(true) });
  };
  return <div className={`archive-item-actions${inline?.label === "Retry Stop" ? " retry-visible" : ""}`} onClick={(event) => event.stopPropagation()}>
    {inline && <button type="button" className="btn ghost sm archive-inline" disabled={busy || inline.refusal !== null} title={inline.refusal ?? undefined}
      aria-describedby={`archive-title-${sessionId}${inline.refusal ? ` ${reasonId}` : ""}`} onClick={() => inline.run()}>{inline.label}</button>}
    {inline?.refusal && <span id={reasonId} className="sr-only">{inline.refusal}</span>}
    <button ref={menu.triggerRef} type="button" className="icon-btn sm" disabled={busy} onClick={menu.toggle}
      onKeyDown={menu.onTriggerKeyDown} title="More Actions" aria-label={`More Actions for ${title}`}
      aria-haspopup="menu" aria-expanded={open} aria-controls={menu.menuId}><MoreHorizontalIcon /></button>
    {open && <MenuSurface surfaceRef={menu.menuRef} anchor={{ trigger: menu.triggerRef }} id={menu.menuId} label={title}
      align="end" onDismiss={() => menu.close(true)} onKeyDown={menu.onMenuKeyDown}>
      {actions.map((action, index) => <Fragment key={action.label}>
        {index === firstDanger && index > 0 && <MenuSeparator />}
        <MenuItem danger={action.danger} disabled={action.refusal !== null} description={action.refusal ?? action.description}
          onClick={() => choose(action)}>{action.label}</MenuItem>
      </Fragment>)}
    </MenuSurface>}
  </div>;
}
