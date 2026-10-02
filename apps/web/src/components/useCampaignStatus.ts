import { useCallback, useEffect, useRef, useState } from "react";
import {
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
export const CAMPAIGN_WORK_PAGE_SIZE = 50;
/** The server's page ceiling (`CAMPAIGN_WORK_LEDGER_LIMITS.pageSizeMax`). */
const CAMPAIGN_WORK_RELOAD_CEILING = 100;
/** A member whose browser does not hold the root session re-reads it on this cadence. */
const ROOT_SESSION_POLL_MS = 30_000;

export type CampaignLoadStatus = "loading" | "ready" | "error";

export interface CampaignSummaryState {
  status: CampaignLoadStatus;
  summary: CampaignWorkSummary | null;
  campaign: Pick<OrchestratorCampaignProjection, "status" | "limits" | "heldChildren"> | null;
  /** The root session's title, for a member's "part of" line. */
  campaignTitle: string | null;
  error: string | null;
}

export interface CampaignListState {
  status: CampaignLoadStatus;
  items: readonly CampaignWorkItemSummary[];
  total: number | null;
  hasMore: boolean;
  loadingMore: boolean;
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

const EMPTY_LIST: CampaignListState = { status: "loading", items: [], total: null, hasMore: false, loadingMore: false, error: null };

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
}: {
  session: Pick<SessionView, "id" | "title" | "orchestratorCampaign">;
  availability: Extract<CampaignStatusAvailability, { kind: "available" }>;
  filters: CampaignWorkFilters;
  selectedItemId: string | null;
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
    const load = () => {
      api.session(rootId).then(({ session: root }) => {
        if (!cancelled) setFetchedRoot({ id: rootId, session: root, error: null });
      }).catch((cause: unknown) => {
        if (cancelled) return;
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
  const summary: CampaignSummaryState = projection?.work
    ? {
      status: "ready",
      summary: projection.work,
      campaign: projection,
      campaignTitle: root?.title ?? null,
      error: null,
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
  const listGeneration = useRef(0);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const loadedCountRef = useRef(0);
  loadedCountRef.current = list.key === listKey ? list.state.items.length : 0;

  const loadFirstPage = useCallback((limit: number) => {
    const generation = ++listGeneration.current;
    const controller = new AbortController();
    setList((current) => current.key === listKey ? current : { key: listKey, state: EMPTY_LIST, cursor: null });
    api.campaignWorkItems(session.id, campaignWorkItemsQuery(filtersRef.current, null, limit), controller.signal).then((page) => {
      if (generation !== listGeneration.current) return;
      setList({
        key: listKey,
        state: { status: "ready", items: page.items, total: page.total, hasMore: page.nextCursor !== null, loadingMore: false, error: null },
        cursor: page.nextCursor,
      });
    }).catch((cause: unknown) => {
      if (isAbort(cause) || generation !== listGeneration.current) return;
      // Rows already shown stay; the error sits above them rather than replacing them.
      setList((current) => ({
        key: listKey,
        state: { ...(current.key === listKey ? current.state : EMPTY_LIST), status: "error", loadingMore: false, error: errorMessage(cause) },
        cursor: current.key === listKey ? current.cursor : null,
      }));
    });
    return () => controller.abort();
  }, [api, listKey, session.id]);

  useEffect(() => {
    if (!online) return;
    const limit = Math.min(CAMPAIGN_WORK_RELOAD_CEILING, Math.max(CAMPAIGN_WORK_PAGE_SIZE, loadedCountRef.current));
    return loadFirstPage(limit);
  }, [loadFirstPage, online, revision, reconnects, retries]);

  const loadMore = useCallback(() => {
    const current = listRef.current;
    if (current.key !== listKey || !current.cursor || current.state.loadingMore) return;
    const generation = listGeneration.current;
    setList({ ...current, state: { ...current.state, loadingMore: true } });
    api.campaignWorkItems(session.id, campaignWorkItemsQuery(filtersRef.current, current.cursor, CAMPAIGN_WORK_PAGE_SIZE)).then((page) => {
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
            error: null,
          },
          cursor: page.nextCursor,
        };
      });
    }).catch((cause: unknown) => {
      if (generation !== listGeneration.current) return;
      if (cause instanceof ApiError && cause.status === 409 && cause.code === CAMPAIGN_WORK_REVISION_CHANGED) {
        // The ledger moved between pages. Reload what was shown, plus the page asked for, under the
        // new revision instead of appending rows from it to rows from the old one.
        loadFirstPage(Math.min(CAMPAIGN_WORK_RELOAD_CEILING, loadedCountRef.current + CAMPAIGN_WORK_PAGE_SIZE));
        return;
      }
      setList((latest) => ({ ...latest, state: { ...latest.state, loadingMore: false, error: errorMessage(cause) } }));
    });
  }, [api, listKey, loadFirstPage, session.id]);

  /* ---------------------------------------------------------------- detail */
  const detailKey = selectedItemId ? `${session.id}:${selectedItemId}` : null;
  const [detail, setDetail] = useState<{ key: string; state: CampaignDetailState } | null>(null);
  useEffect(() => {
    if (!selectedItemId || !detailKey || !online) return;
    const controller = new AbortController();
    api.campaignWorkItem(session.id, selectedItemId, controller.signal).then((response) => {
      setDetail({ key: detailKey, state: { status: "ready", detail: response.item, error: null } });
    }).catch((cause: unknown) => {
      if (isAbort(cause)) return;
      if (cause instanceof ApiError && cause.status === 404) {
        setDetail({ key: detailKey, state: { status: "missing", detail: null, error: null } });
        return;
      }
      setDetail((current) => ({
        key: detailKey,
        state: { status: "error", detail: current?.key === detailKey ? current.state.detail : null, error: errorMessage(cause) },
      }));
    });
    return () => controller.abort();
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
