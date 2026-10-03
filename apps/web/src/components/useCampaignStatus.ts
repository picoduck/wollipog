import { useCallback, useEffect, useRef, useState } from "react";
import {
  CAMPAIGN_WORK_LEDGER_LIMITS,
  CAMPAIGN_WORK_REVISION_CHANGED,
  type CampaignWorkItemDetail,
  type CampaignWorkItemSummary,
  type CampaignWorkSummary,
  type OrchestratorCampaignProjection,
  type SessionView,
} from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { useStoreSelector } from "../store.js";
import {
  campaignStatusAvailability,
  campaignWorkItemsQuery,
  type CampaignStatusAvailability,
  type CampaignWorkFilters,
} from "../campaign-status.js";

/** Page size for the work list. A revision change reloads at least what was already showing. */
export const CAMPAIGN_WORK_PAGE_SIZE = CAMPAIGN_WORK_LEDGER_LIMITS.pageSizeDefault;
/** The most one request may ask for; a larger reload walks the pages. */
const CAMPAIGN_WORK_PAGE_CEILING = CAMPAIGN_WORK_LEDGER_LIMITS.pageSizeMax;
/** How many times one reload restarts after the ledger moves under it before reporting an error. */
const MAX_REVISION_RESTARTS = 3;
/** A member whose browser does not hold the root session re-reads it on this cadence. */
const ROOT_SESSION_POLL_MS = 30_000;

export type CampaignLoadStatus = "loading" | "ready" | "error";

export interface CampaignSummaryState {
  status: CampaignLoadStatus;
  summary: CampaignWorkSummary | null;
  campaign: Pick<OrchestratorCampaignProjection, "status" | "limits" | "heldChildren"> | null;
  /** The root session's title, for a member's "part of" line. */
  campaignTitle: string | null;
  /** Why the summary could not be loaded, or, beside a shown summary, why it could not be refreshed. */
  error: string | null;
}

export interface CampaignListState {
  status: CampaignLoadStatus;
  items: readonly CampaignWorkItemSummary[];
  total: number | null;
  hasMore: boolean;
  loadingMore: boolean;
  /** The shown rows are being reloaded (a new revision, reconnect, or retry); paging waits. */
  reloading: boolean;
  error: string | null;
}

export interface CampaignDetailState {
  status: CampaignLoadStatus | "missing";
  detail: CampaignWorkItemDetail | null;
  error: string | null;
}

export interface CampaignStatusData {
  summary: CampaignSummaryState;
  list: CampaignListState;
  detail: CampaignDetailState | null;
  /** True while the live connection is down; the last loaded content is shown as stale. */
  offline: boolean;
  loadMore: () => void;
  retry: () => void;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 403) return "You do not have access to this campaign's status.";
  if (cause instanceof ApiError && cause.status === 404) return "This Wollipog server does not serve campaign work for this session.";
  return cause instanceof Error ? cause.message : String(cause);
}

function isAbort(cause: unknown): boolean {
  return (cause as { name?: string } | null)?.name === "AbortError";
}

const EMPTY_LIST: CampaignListState = { status: "loading", items: [], total: null, hasMore: false, loadingMore: false, reloading: false, error: null };

function isRevisionChanged(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 409 && cause.code === CAMPAIGN_WORK_REVISION_CHANGED;
}

/** Whether this session offers Campaign Status, from its own view and its parent's campaign. */
export function useCampaignStatusAvailability(
  session: Pick<SessionView, "id" | "orchestratorCampaign" | "campaignMembership" | "parentSessionId">,
): CampaignStatusAvailability {
  // Re-render only when what availability reads of the parent changes, not on every parent update.
  const parent = useStoreSelector(
    (s) => session.parentSessionId ? s.sessions.get(session.parentSessionId) ?? null : null,
    (left, right) => left?.id === right?.id &&
      (left?.orchestratorCampaign == null) === (right?.orchestratorCampaign == null) &&
      (left?.orchestratorCampaign?.work == null) === (right?.orchestratorCampaign?.work == null),
  );
  return campaignStatusAvailability(session, parent);
}

/**
 * Everything Campaign Status reads, behind one hook.
 *
 * - The summary is live. It rides on the root session's campaign projection (`work`), which the
 *   server re-sends on every ledger write, so the campaign view and any member whose browser holds
 *   the root read it from the store. A member without it reads the root session once, on reconnect,
 *   and on a slow poll.
 * - The work list is paginated by an opaque cursor bound to the filter, sort, and ledger revision.
 *   A new revision reloads the rows already shown in place, and a `revision_changed` refusal on a
 *   later page restarts from the first page, so a list is never stitched from two revisions.
 * - The selected item's details reload on every revision too.
 */
export function useCampaignStatus({
  session,
  availability,
  filters,
  selectedItemId,
  restoreCount = 0,
}: {
  session: Pick<SessionView, "id" | "title" | "orchestratorCampaign">;
  availability: Extract<CampaignStatusAvailability, { kind: "available" }>;
  filters: CampaignWorkFilters;
  selectedItemId: string | null;
  /** Rows a previous mount of this list had loaded; the first load reloads at least that many. */
  restoreCount?: number;
}): CampaignStatusData {
  const api = useApi();
  const online = useStoreSelector((s) => s.conn === "online");
  const ownView = availability.campaignSessionId === session.id;
  const storedRoot = useStoreSelector((s) => ownView ? null : s.sessions.get(availability.campaignSessionId) ?? null);

  // Reconnecting reloads everything fetched: events missed while offline may have moved the ledger
  // without this browser seeing the revision change.
  const [reconnects, setReconnects] = useState(0);
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) setReconnects((count) => count + 1);
    wasOnline.current = online;
  }, [online]);
  const [retries, setRetries] = useState(0);

  /* ---------------------------------------------------------------- summary */
  const [fetchedRoot, setFetchedRoot] = useState<{ id: string; session: SessionView | null; error: string | null } | null>(null);
  const needsFetchedRoot = !ownView && storedRoot === null;
  useEffect(() => {
    if (!needsFetchedRoot || !online) return;
    const rootId = availability.campaignSessionId;
    let cancelled = false;
    // Polls can overlap when one outlives the interval. Only a response newer than the last one
    // applied may land, so a slow older read never reverts a newer summary.
    let issued = 0;
    let applied = 0;
    const load = () => {
      const sequence = ++issued;
      const current = () => !cancelled && sequence > applied;
      api.session(rootId).then(({ session: root }) => {
        if (!current()) return;
        applied = sequence;
        setFetchedRoot({ id: rootId, session: root, error: null });
      }).catch((cause: unknown) => {
        if (!current()) return;
        applied = sequence;
        setFetchedRoot((current) => ({
          id: rootId,
          session: current?.id === rootId ? current.session : null,
          error: errorMessage(cause),
        }));
      });
    };
    load();
    const timer = window.setInterval(load, ROOT_SESSION_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api, availability.campaignSessionId, needsFetchedRoot, online, reconnects, retries]);

  const root = ownView ? session : storedRoot ?? (fetchedRoot?.id === availability.campaignSessionId ? fetchedRoot.session : null);
  const projection = root?.orchestratorCampaign ?? null;
  // A fetched root that later fails to refresh keeps its last summary, with the failure beside it.
  const refreshError = !ownView && storedRoot === null && fetchedRoot?.id === availability.campaignSessionId
    ? fetchedRoot.error
    : null;
  const summary: CampaignSummaryState = projection?.work
    ? {
      status: "ready",
      summary: projection.work,
      campaign: projection,
      campaignTitle: root?.title ?? null,
      error: refreshError,
    }
    : {
      status: fetchedRoot?.error ? "error" : "loading",
      summary: null,
      campaign: projection,
      campaignTitle: root?.title ?? null,
      error: fetchedRoot?.error ?? null,
    };
  const revision = summary.summary?.revision ?? null;

  /* ---------------------------------------------------------------- work list */
  const listKey = JSON.stringify([session.id, filters.origin, filters.state, filters.sort]);
  const [list, setList] = useState<{ key: string; state: CampaignListState; cursor: string | null }>(
    () => ({ key: listKey, state: EMPTY_LIST, cursor: null }),
  );
  const listRef = useRef(list);
  listRef.current = list;
  // Every reload takes a new generation; a response from an older one is dropped even when its
  // abort arrived too late to stop it (the transport stops listening for aborts once headers land).
  const listGeneration = useRef(0);
  const reloading = useRef(false);
  // How many rows the reload in flight is loading. A reload that replaces it keeps that count, so
  // rows it was fetching (a refused page's retry, a remembered position) are not dropped.
  const reloadTarget = useRef<{ key: string; rows: number } | null>(null);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const loadedCountRef = useRef(0);
  loadedCountRef.current = list.key === listKey ? list.state.items.length : 0;
  // The page a Show More in flight asked for. A reload that starts before it lands drops its
  // response, so the reload loads those rows itself rather than swallowing the request.
  const requestedMore = useRef<{ key: string } | null>(null);

  /**
   * Load the list from its first page until at least `target` rows are shown, page by page, all at
   * one revision. A `revision_changed` refusal partway restarts the whole reload (a bounded number of
   * times), so the rows shown never mix two revisions and a reload never drops rows already shown.
   */
  const reload = useCallback((target: number) => {
    const generation = ++listGeneration.current;
    const controller = new AbortController();
    const live = () => generation === listGeneration.current && !controller.signal.aborted;
    const superseded = reloading.current && reloadTarget.current?.key === listKey ? reloadTarget.current.rows : 0;
    const want = Math.max(CAMPAIGN_WORK_PAGE_SIZE, target, superseded);
    reloadTarget.current = { key: listKey, rows: want };
    reloading.current = true;
    setList((current) => current.key === listKey
      ? { ...current, state: { ...current.state, reloading: true } }
      : { key: listKey, state: { ...EMPTY_LIST, reloading: true }, cursor: null });
    void (async () => {
      for (let restarts = 0; ; restarts += 1) {
        try {
          const rows: CampaignWorkItemSummary[] = [];
          const seen = new Set<string>();
          let cursor: string | null = null;
          let total: number | null = null;
          do {
            const limit = Math.min(CAMPAIGN_WORK_PAGE_CEILING, Math.max(1, want - rows.length));
            const page = await api.campaignWorkItems(session.id, campaignWorkItemsQuery(filtersRef.current, cursor, limit), controller.signal);
            if (!live()) return;
            const before = rows.length;
            for (const item of page.items) if (!seen.has(item.id)) { seen.add(item.id); rows.push(item); }
            total = page.total;
            cursor = page.nextCursor;
            // A page that adds nothing would repeat forever; what was shown stays, and Show More remains.
            if (rows.length === before) break;
          } while (cursor && rows.length < want);
          reloading.current = false;
          setList({
            key: listKey,
            state: { status: "ready", items: rows, total, hasMore: cursor !== null, loadingMore: false, reloading: false, error: null },
            cursor,
          });
          return;
        } catch (cause) {
          if (!live() || isAbort(cause)) return;
          if (isRevisionChanged(cause) && restarts < MAX_REVISION_RESTARTS) continue;
          reloading.current = false;
          // Rows already shown stay; the error sits above them rather than replacing them.
          setList((current) => ({
            key: listKey,
            state: { ...(current.key === listKey ? current.state : EMPTY_LIST), status: "error", loadingMore: false, reloading: false, error: errorMessage(cause) },
            cursor: current.key === listKey ? current.cursor : null,
          }));
          return;
        }
      }
    })();
    return () => controller.abort();
  }, [api, listKey, session.id]);

  // A remounted panel reloads as many rows as it last showed, so returning from an item's details
  // finds that item's row and scroll position again. Only for the list it was showing: a new
  // filter starts from one page.
  const restore = useRef({ key: listKey, count: restoreCount });
  if (restore.current.key !== listKey) restore.current.count = 0;
  useEffect(() => {
    if (!online) return;
    const pendingMore = requestedMore.current?.key === listKey ? CAMPAIGN_WORK_PAGE_SIZE : 0;
    requestedMore.current = null;
    return reload(Math.max(loadedCountRef.current + pendingMore, restore.current.count));
  }, [reload, online, revision, reconnects, retries]);

  const loadMore = useCallback(() => {
    const current = listRef.current;
    // A reload in flight would replace whatever this page adds, so paging waits for it.
    if (current.key !== listKey || !current.cursor || current.state.loadingMore || reloading.current) return;
    const generation = listGeneration.current;
    const request = { key: listKey };
    requestedMore.current = request;
    const settled = () => { if (requestedMore.current === request) requestedMore.current = null; };
    setList({ ...current, state: { ...current.state, loadingMore: true } });
    api.campaignWorkItems(session.id, campaignWorkItemsQuery(filtersRef.current, current.cursor, CAMPAIGN_WORK_PAGE_SIZE)).then((page) => {
      settled();
      if (generation !== listGeneration.current) return;
      setList((latest) => {
        const seen = new Set(latest.state.items.map((item) => item.id));
        return {
          key: listKey,
          state: {
            status: "ready",
            items: [...latest.state.items, ...page.items.filter((item) => !seen.has(item.id))],
            total: page.total,
            hasMore: page.nextCursor !== null,
            loadingMore: false,
            reloading: false,
            error: null,
          },
          cursor: page.nextCursor,
        };
      });
    }).catch((cause: unknown) => {
      settled();
      if (generation !== listGeneration.current) return;
      if (isRevisionChanged(cause)) {
        // The ledger moved between pages. Reload what was shown, plus the page asked for, under the
        // new revision instead of appending rows from it to rows from the old one.
        reload(loadedCountRef.current + CAMPAIGN_WORK_PAGE_SIZE);
        return;
      }
      setList((latest) => ({ ...latest, state: { ...latest.state, loadingMore: false, error: errorMessage(cause) } }));
    });
  }, [api, listKey, reload, session.id]);

  /* ---------------------------------------------------------------- detail */
  const detailKey = selectedItemId ? `${session.id}:${selectedItemId}` : null;
  const [detail, setDetail] = useState<{ key: string; state: CampaignDetailState } | null>(null);
  useEffect(() => {
    if (!selectedItemId || !detailKey || !online) return;
    const controller = new AbortController();
    // Aborting cannot stop a body already arriving, so a superseded response is ignored here.
    let cancelled = false;
    api.campaignWorkItem(session.id, selectedItemId, controller.signal).then((response) => {
      if (cancelled) return;
      setDetail({ key: detailKey, state: { status: "ready", detail: response.item, error: null } });
    }).catch((cause: unknown) => {
      if (cancelled || isAbort(cause)) return;
      if (cause instanceof ApiError && cause.status === 404) {
        setDetail({ key: detailKey, state: { status: "missing", detail: null, error: null } });
        return;
      }
      setDetail((current) => ({
        key: detailKey,
        state: { status: "error", detail: current?.key === detailKey ? current.state.detail : null, error: errorMessage(cause) },
      }));
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, detailKey, online, revision, reconnects, retries, selectedItemId, session.id]);

  return {
    summary,
    list: list.key === listKey ? list.state : EMPTY_LIST,
    detail: detailKey ? detail?.key === detailKey ? detail.state : { status: "loading", detail: null, error: null } : null,
    offline: !online,
    loadMore,
    retry: () => setRetries((count) => count + 1),
  };
}
