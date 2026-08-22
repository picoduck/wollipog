import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTerminal, type SessionStatus, type SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import {
  archiveSessionMetadata,
  canonicalLifecycleLabel,
  filterArchiveSessions,
  mergeArchiveSessionCatalog,
  SESSION_LIFECYCLE_STATES,
  type ArchiveBrowserFilters,
} from "../archive-browser.js";
import { discardComposerDraft } from "../composer-drafts.js";
import { formatRecordedRelativeTime, formatRecordedTimestamp, statusMeta } from "../format.js";
import { useInstanceScope } from "../instance-scope.js";
import { viewPath } from "../navigation.js";
import { removeFromInstanceKeySet, SESSION_PIN_KEY } from "../pins.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { useFeedback } from "./FeedbackProvider.js";
import { InboxIcon, SearchIcon } from "./Icons.js";
import { Empty, Spinner } from "./common.js";
import { Select } from "./ui/ChoiceControls.js";

const DEFAULT_FILTERS: ArchiveBrowserFilters = {
  query: "",
  project: "all",
  location: "all",
  agent: "all",
  archive: "archived",
  lifecycle: "all",
};

function LifecycleBadge({ status }: { status: SessionStatus }) {
  const metadata = statusMeta(status);
  return (
    <span className={`status-badge ${metadata.className}`}>
      <span className={`status-dot2 ${metadata.busy ? "pulse" : ""}`} aria-hidden="true" />
      {canonicalLifecycleLabel(status)}
    </span>
  );
}

function plainSnippet(snippet: string | undefined): string | null {
  return snippet ? snippet.replace(/[⟪⟫]/g, "") : null;
}

export function ArchivedSessionsView() {
  const api = useApi();
  const instanceScope = useInstanceScope();
  const { confirm, showToast, showUndo } = useFeedback();
  const { dispatch, loadSession, navigate } = useStoreActions();
  const liveSessions = useStoreSelector((state) => state.sessions);
  const projects = useStoreSelector((state) => state.projects);
  const conn = useStoreSelector((state) => state.conn);
  const stopFailureRecoverySupported = useStoreSelector((state) => state.stopFailureRecoverySupported);
  const deletedSessionIdsRef = useRef(new Set<string>());
  const liveSessionsRef = useRef(liveSessions);
  const requestSequenceRef = useRef(0);
  liveSessionsRef.current = liveSessions;

  const [catalog, setCatalog] = useState(() => new Map<string, SessionView>());
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [facets, setFacets] = useState({ projects: [] as string[], locations: [] as string[], agents: [] as string[] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState(() => new Set<string>());
  const [transcriptHits, setTranscriptHits] = useState(() => new Map<string, string>());
  const locationNames = useMemo(() => new Map(
    [...projects.values()].flatMap((project) => project.locations.map((location) => [location.id, location.name] as const)),
  ), [projects]);

  const refreshCatalog = useCallback(async () => {
    const requestSequence = ++requestSequenceRef.current;
    setLoading(true);
    try {
      const response = await api.archiveSessionPage({
        cursor: cursors[page - 1] ?? undefined,
        project: filters.project === "all" ? undefined : filters.project,
        location: filters.location === "all" ? undefined : filters.location,
        agent: filters.agent === "all" ? undefined : filters.agent,
        archive: filters.archive,
        lifecycle: filters.lifecycle,
        q: filters.query.trim() || undefined,
      });
      const next = mergeArchiveSessionCatalog(
        new Map(response.sessions.map((session) => [session.id, session])),
        [...liveSessionsRef.current.values()].filter((session) =>
          response.sessions.some((row) => row.id === session.id)),
      );
      for (const sessionId of deletedSessionIdsRef.current) {
        next.delete(sessionId);
      }
      if (requestSequence !== requestSequenceRef.current) return;
      setCatalog(next);
      setTranscriptHits(new Map(Object.entries(response.snippets)));
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

  useEffect(() => { void refreshCatalog(); }, [refreshCatalog]);

  // Update rows already present in this bounded page. New rows are incorporated by the visibility
  // and reconnect reconciliation below so websocket arrival order cannot alter cursor membership.
  useEffect(() => {
    setCatalog((current) => {
      const next = mergeArchiveSessionCatalog(current,
        [...liveSessions.values()].filter((session) => current.has(session.id)));
      for (const sessionId of deletedSessionIdsRef.current) next.delete(sessionId);
      return new Map(filterArchiveSessions({
        sessions: next.values(), filters, locationNames,
        transcriptSessionIds: new Set(transcriptHits.keys()),
      }).map((session) => [session.id, session]));
    });
  }, [filters, liveSessions, locationNames, transcriptHits]);

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
    if (conn === "online") void refreshCatalog();
  }, [conn, refreshCatalog]);

  const pageSessions = useMemo(() => [...catalog.values()], [catalog]);
  const hasActiveFilters = Boolean(filters.query) || filters.project !== "all" || filters.location !== "all" ||
    filters.agent !== "all" || filters.lifecycle !== "all" || filters.archive !== "archived";

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
    setCatalog((current) => new Map(filterArchiveSessions({
      sessions: mergeArchiveSessionCatalog(current, [session]).values(),
      filters,
      locationNames,
      transcriptSessionIds: new Set(transcriptHits.keys()),
    }).map((item) => [item.id, item])));
    loadSession(session);
  };

  const unarchive = async (session: SessionView) => {
    setBusy(session.id, true);
    try {
      updateSession(await api.setArchived(session.id, false));
      showUndo("Session restored.", async () => updateSession(await api.setArchived(session.id, true)));
    } catch (cause) {
      showToast(`Could not unarchive session: ${(cause as Error).message}`, { tone: "error" });
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
      showToast(`Could not retry stopping session: ${(cause as Error).message}`, { tone: "error" });
    } finally {
      setBusy(session.id, false);
    }
  };

  const stop = async (session: SessionView) => {
    const approved = await confirm({
      title: "Stop this session?",
      message: "This terminates the agent process and discards every queued message. The archived session and its transcript remain available.",
      confirmLabel: "Stop Session",
      tone: "danger",
    });
    if (!approved) return;
    setBusy(session.id, true);
    try {
      updateSession(await api.stop(session.id));
      showToast("Session stopped.");
    } catch (cause) {
      showToast(`Could not stop session: ${(cause as Error).message}`, { tone: "error" });
    } finally {
      setBusy(session.id, false);
    }
  };

  const deleteSession = async (session: SessionView) => {
    const approved = await confirm({
      title: "Delete this session?",
      message: "This permanently removes the session and its history from the dashboard.",
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
      showToast(`Could not delete session: ${(cause as Error).message}`, { tone: "error" });
    } finally {
      setBusy(session.id, false);
    }
  };

  return (
    <section className="archive-view" aria-labelledby="page-title">
      <div className="archive-toolbar">
        <label className={`archive-search${filters.query ? " has-query" : ""}`}>
          <span>Search Sessions and Transcripts</span>
          <div>
            <SearchIcon size={15} aria-hidden="true" />
            <input
              type="search"
              value={filters.query}
              onChange={(event) => changeFilter("query", event.target.value)}
              placeholder="Search sessions and transcripts"
            />
          </div>
        </label>
        <fieldset className="archive-filters">
          <legend className="sr-only">Archived Session Filters</legend>
          <div className="archive-filter"><span className="field-label">Project</span><Select
            label="Project"
            value={filters.project}
            options={[{ value: "all", label: "All Projects" }, ...facets.projects.map((value) => ({ value, label: value }))]}
            onChange={(value) => changeFilter("project", value)}
          /></div>
          <div className="archive-filter"><span className="field-label">Location</span><Select
            label="Location"
            value={filters.location}
            options={[{ value: "all", label: "All Locations" }, ...facets.locations.map((value) => ({ value, label: value }))]}
            onChange={(value) => changeFilter("location", value)}
          /></div>
          <div className="archive-filter"><span className="field-label">Agent</span><Select
            label="Agent"
            value={filters.agent}
            options={[{ value: "all", label: "All Agents" }, ...facets.agents.map((value) => ({ value, label: value }))]}
            onChange={(value) => changeFilter("agent", value)}
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
            setFilters(DEFAULT_FILTERS); setPage(1); setCursors([null]);
          }}>
            Reset Filters
          </button>
        </fieldset>
      </div>

      <div className="archive-results-summary" role="status" aria-live="polite">
        Showing {pageSessions.length} Session{pageSessions.length === 1 ? "" : "s"}
      </div>

      {error && <div className="archive-error" role="alert">{error} <button className="link-button" type="button" onClick={() => void refreshCatalog()}>Try Again</button></div>}
      {loading && pageSessions.length === 0 ? (
        <div className="archive-loading" role="status"><Spinner /> Loading Archived Sessions…</div>
      ) : pageSessions.length === 0 ? (
        <Empty
          title={hasActiveFilters
            ? "No Matching Sessions"
            : "No Archived Sessions"}
          hint={hasActiveFilters
            ? "Try clearing search text or changing a filter."
            : "Archived sessions will appear here with their lifecycle state and transcript."}
          icon={<InboxIcon size={28} />}
          action={<button type="button" className="btn primary" onClick={() => {
            if (hasActiveFilters) { setFilters(DEFAULT_FILTERS); setPage(1); setCursors([null]); }
            else navigate({ name: "inbox" });
          }}>{hasActiveFilters ? "Reset Filters" : "Go to Inbox"}</button>}
        />
      ) : (
        <div className="archive-table-wrap" role="region" aria-label="Archived Sessions Table" tabIndex={0}>
          <table className="archive-table">
            <thead><tr><th scope="col">Session</th><th scope="col">State</th><th scope="col">Project</th><th scope="col">Location</th><th scope="col">Agent</th><th scope="col">Updated</th><th scope="col">Actions</th></tr></thead>
            <tbody>
              {pageSessions.map((session) => {
                const rowMetadata = archiveSessionMetadata(session, locationNames);
                const timestamp = formatRecordedTimestamp(session.updatedAt);
                const busy = busyIds.has(session.id);
                const snippet = plainSnippet(transcriptHits.get(session.id));
                const target = { name: "session" as const, id: session.id };
                const stopPending = (session as SessionView & { archiveStatus?: string }).archiveStatus === "stop_pending";
                const stopFailed = session.archiveStatus === "stop_failed";
                return (
                  <tr key={session.id}>
                    <td className="archive-session-cell">
                      <a href={viewPath(target)} onClick={(event) => {
                        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                        event.preventDefault();
                        loadSession(session);
                        navigate(target);
                      }}>{session.title || session.id}</a>
                      {snippet && filters.query.trim().length >= 3 && <small>{snippet}</small>}
                    </td>
                    <td><div className="archive-state-badges">
                      <span className={`archive-badge${session.archived ? " is-archived" : ""}`}>{session.archived ? "Archived" : "Not Archived"}</span>
                      <LifecycleBadge status={session.status} />
                      {stopFailed && <span className="archive-badge" title={session.archiveOperation?.failure?.message}>
                        Stop Failed
                      </span>}
                      {stopPending && <span className="archive-badge">Stop Pending</span>}
                    </div></td>
                    <td>{rowMetadata.project}</td>
                    <td>{rowMetadata.location}</td>
                    <td>{rowMetadata.agent}</td>
                    <td><time dateTime={timestamp?.dateTime} title={timestamp?.title}>{formatRecordedRelativeTime(session.updatedAt)}</time></td>
                    <td><div className="archive-row-actions">
                      <button type="button" className="btn ghost sm" disabled={busy} onClick={() => { loadSession(session); navigate(target); }}>Open</button>
                      {session.archived && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void unarchive(session)}>Unarchive</button>}
                      {stopPending || stopFailed
                        ? <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void retryStop(session)}>Retry Stop</button>
                        : !isTerminal(session.status) && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void stop(session)}>Stop</button>}
                      {session.archived && <button type="button" className="btn danger sm" disabled={busy} onClick={() => void deleteSession(session)}>Delete</button>}
                    </div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
