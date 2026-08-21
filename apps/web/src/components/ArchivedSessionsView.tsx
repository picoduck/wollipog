import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTerminal, type SessionStatus, type SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import {
  archiveSessionMetadata,
  canonicalLifecycleLabel,
  filterArchiveSessions,
  mergeArchiveSessionCatalog,
  pageArchiveSessions,
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
import { SearchIcon } from "./Icons.js";
import { Empty, Spinner } from "./common.js";

const DEFAULT_FILTERS: ArchiveBrowserFilters = {
  query: "",
  project: "all",
  location: "all",
  agent: "all",
  archive: "archived",
  lifecycle: "all",
};

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

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
  const { loadSession, navigate } = useStoreActions();
  const liveSessions = useStoreSelector((state) => state.sessions);
  const projects = useStoreSelector((state) => state.projects);
  const conn = useStoreSelector((state) => state.conn);
  const liveSessionsRef = useRef(liveSessions);
  liveSessionsRef.current = liveSessions;

  const [catalog, setCatalog] = useState(() => new Map(liveSessions));
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState(() => new Set<string>());
  const [transcriptHits, setTranscriptHits] = useState(() => new Map<string, string>());
  const [transcriptSearching, setTranscriptSearching] = useState(false);

  const refreshCatalog = useCallback(async () => {
    try {
      const response = await api.listAllSessions();
      setCatalog(mergeArchiveSessionCatalog(
        new Map(response.sessions.map((session) => [session.id, session])),
        liveSessionsRef.current.values(),
      ));
      setError(null);
    } catch (cause) {
      setError(`Could not load archived sessions: ${(cause as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void refreshCatalog(); }, [refreshCatalog]);

  // Authorized websocket upserts include archived sessions, so lifecycle and archive changes made
  // by another client replace their catalog rows without waiting for another REST request.
  useEffect(() => {
    setCatalog((current) => mergeArchiveSessionCatalog(current, liveSessions.values()));
  }, [liveSessions]);

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

  useEffect(() => {
    const query = filters.query.trim();
    if (query.length < 3) {
      setTranscriptHits(new Map());
      setTranscriptSearching(false);
      return;
    }
    let cancelled = false;
    setTranscriptSearching(true);
    const timer = window.setTimeout(() => {
      api.search(query).then((response) => {
        if (cancelled) return;
        const next = new Map<string, string>();
        for (const hit of response.results) {
          if (!next.has(hit.sessionId)) next.set(hit.sessionId, hit.snippet);
        }
        setTranscriptHits(next);
      }).catch(() => {
        if (!cancelled) setTranscriptHits(new Map());
      }).finally(() => {
        if (!cancelled) setTranscriptSearching(false);
      });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, filters.query]);

  const locationNames = useMemo(() => new Map(
    [...projects.values()].flatMap((project) => project.locations.map((location) => [location.id, location.name] as const)),
  ), [projects]);
  const metadata = useMemo(
    () => [...catalog.values()].map((session) => archiveSessionMetadata(session, locationNames)),
    [catalog, locationNames],
  );
  const projectOptions = useMemo(() => sortedUnique(metadata.map((item) => item.project)), [metadata]);
  const locationOptions = useMemo(() => sortedUnique(metadata.map((item) => item.location)), [metadata]);
  const agentOptions = useMemo(() => sortedUnique(metadata.map((item) => item.agent)), [metadata]);
  const filtered = useMemo(() => filterArchiveSessions({
    sessions: catalog.values(),
    filters,
    locationNames,
    transcriptSessionIds: new Set(transcriptHits.keys()),
  }), [catalog, filters, locationNames, transcriptHits]);
  const pageResult = useMemo(() => pageArchiveSessions(filtered, page), [filtered, page]);

  useEffect(() => {
    if (pageResult.page !== page) setPage(pageResult.page);
  }, [page, pageResult.page]);

  const changeFilter = <K extends keyof ArchiveBrowserFilters>(key: K, value: ArchiveBrowserFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
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
    setCatalog((current) => mergeArchiveSessionCatalog(current, [session]));
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
      setCatalog((current) => {
        const next = new Map(current);
        next.delete(session.id);
        return next;
      });
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
          <label><span>Project</span><select value={filters.project} onChange={(event) => changeFilter("project", event.target.value)}>
            <option value="all">All Projects</option>
            {projectOptions.map((value) => <option key={value} value={value}>{value}</option>)}
          </select></label>
          <label><span>Location</span><select value={filters.location} onChange={(event) => changeFilter("location", event.target.value)}>
            <option value="all">All Locations</option>
            {locationOptions.map((value) => <option key={value} value={value}>{value}</option>)}
          </select></label>
          <label><span>Agent</span><select value={filters.agent} onChange={(event) => changeFilter("agent", event.target.value)}>
            <option value="all">All Agents</option>
            {agentOptions.map((value) => <option key={value} value={value}>{value}</option>)}
          </select></label>
          <label><span>Archive State</span><select value={filters.archive} onChange={(event) => changeFilter("archive", event.target.value as ArchiveBrowserFilters["archive"])}>
            <option value="archived">Archived</option>
            <option value="unarchived">Not Archived</option>
            <option value="all">All Sessions</option>
          </select></label>
          <label><span>Lifecycle State</span><select value={filters.lifecycle} onChange={(event) => changeFilter("lifecycle", event.target.value as ArchiveBrowserFilters["lifecycle"])}>
            <option value="all">All Lifecycle States</option>
            {SESSION_LIFECYCLE_STATES.map((status) => <option key={status} value={status}>{canonicalLifecycleLabel(status)}</option>)}
          </select></label>
          <button type="button" className="btn ghost sm" onClick={() => { setFilters(DEFAULT_FILTERS); setPage(1); }}>
            Reset Filters
          </button>
        </fieldset>
      </div>

      <div className="archive-results-summary" role="status" aria-live="polite">
        {transcriptSearching ? "Searching transcripts… " : ""}
        {pageResult.total} Session{pageResult.total === 1 ? "" : "s"}
      </div>

      {error && <div className="archive-error" role="alert">{error} <button className="link-button" type="button" onClick={() => void refreshCatalog()}>Try Again</button></div>}
      {loading && catalog.size === 0 ? (
        <div className="archive-loading" role="status"><Spinner /> Loading Archived Sessions…</div>
      ) : pageResult.total === 0 ? (
        <Empty
          title={filters.query || filters.project !== "all" || filters.location !== "all" || filters.agent !== "all" || filters.lifecycle !== "all" || filters.archive !== "archived"
            ? "No Matching Sessions"
            : "No Archived Sessions"}
          hint={filters.query || filters.project !== "all" || filters.location !== "all" || filters.agent !== "all" || filters.lifecycle !== "all" || filters.archive !== "archived"
            ? "Try clearing search text or changing a filter."
            : "Archived sessions will appear here with their lifecycle state and transcript."}
        />
      ) : (
        <div className="archive-table-wrap">
          <table className="archive-table">
            <thead><tr><th>Session</th><th>State</th><th>Project</th><th>Location</th><th>Agent</th><th>Updated</th><th>Actions</th></tr></thead>
            <tbody>
              {pageResult.sessions.map((session) => {
                const rowMetadata = archiveSessionMetadata(session, locationNames);
                const timestamp = formatRecordedTimestamp(session.updatedAt);
                const busy = busyIds.has(session.id);
                const snippet = plainSnippet(transcriptHits.get(session.id));
                const target = { name: "session" as const, id: session.id };
                const stopPending = (session as SessionView & { archiveStatus?: string }).archiveStatus === "stop_pending";
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
                      {stopPending && <span className="archive-badge">Stop Pending</span>}
                    </div></td>
                    <td>{rowMetadata.project}</td>
                    <td>{rowMetadata.location}</td>
                    <td>{rowMetadata.agent}</td>
                    <td><time dateTime={timestamp?.dateTime} title={timestamp?.title}>{formatRecordedRelativeTime(session.updatedAt)}</time></td>
                    <td><div className="archive-row-actions">
                      <button type="button" className="btn ghost sm" disabled={busy} onClick={() => { loadSession(session); navigate(target); }}>Open</button>
                      {session.archived && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void unarchive(session)}>Unarchive</button>}
                      {!isTerminal(session.status) && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void stop(session)}>Stop</button>}
                      {session.archived && <button type="button" className="btn danger sm" disabled={busy} onClick={() => void deleteSession(session)}>Delete</button>}
                    </div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pageResult.total > 0 && (
        <nav className="archive-pagination" aria-label="Archived Sessions Pagination">
          <button type="button" className="btn ghost sm" disabled={pageResult.page <= 1} onClick={() => setPage((current) => current - 1)}>Previous Page</button>
          <span>Page {pageResult.page} of {pageResult.pageCount}</span>
          <button type="button" className="btn ghost sm" disabled={pageResult.page >= pageResult.pageCount} onClick={() => setPage((current) => current + 1)}>Next Page</button>
        </nav>
      )}
    </section>
  );
}
