import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionView } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { useStoreSelector } from "../store.js";
import {
  campaignStatusAvailability,
  campaignWorkItemsQuery,
  type CampaignStatusAvailability,
  type CampaignWorkFilters,
} from "../campaign-status.js";
import {
  campaignMembershipOf,
  campaignWorkSummaryOf,
  type CampaignWorkItem,
  type CampaignWorkItemDetail,
  type CampaignWorkSummary,
  type CampaignWorkSummaryResponse,
} from "../campaign-work-contract.js";

/** Page size for the work list. A revision change reloads at least what was already showing. */
export const CAMPAIGN_WORK_PAGE_SIZE = 50;
const CAMPAIGN_WORK_RELOAD_CEILING = 200;
/** A member viewing a campaign whose Orchestrator session is not in this browser's store polls. */
const MEMBER_SUMMARY_POLL_MS = 30_000;

export type CampaignLoadStatus = "loading" | "ready" | "error";

export interface CampaignSummaryState {
  status: CampaignLoadStatus;
  summary: CampaignWorkSummary | null;
  campaign: { title: string; status: string; limits: CampaignWorkSummaryResponse["limits"] } | null;
  error: string | null;
}

export interface CampaignListState {
  status: CampaignLoadStatus;
  items: readonly CampaignWorkItem[];
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
  return cause instanceof DOMException ? cause.name === "AbortError" : (cause as { name?: string })?.name === "AbortError";
}

/** Whether this session offers Campaign Status, from its own view and the server's capabilities. */
export function useCampaignStatusAvailability(
  session: Pick<SessionView, "id" | "orchestratorCampaign" | "parentSessionId">,
): CampaignStatusAvailability {
  const supported = useStoreSelector((s) => s.campaignWorkSupported);
  const parentCarriesCampaign = useStoreSelector((s) => session.parentSessionId
    ? s.sessions.get(session.parentSessionId)?.orchestratorCampaign != null
    : false);
  const membership = campaignMembershipOf(session);
  const membershipCampaign = membership?.campaignSessionId ?? null;
  const membershipItem = membership?.currentWorkItemId ?? null;
  const ownCampaign = session.orchestratorCampaign ?? undefined;
  const hasOwnCampaign = ownCampaign !== undefined;
  return useMemo(() => campaignStatusAvailability({
    id: session.id,
    orchestratorCampaign: ownCampaign,
    parentSessionId: session.parentSessionId,
    campaignMembership: membershipCampaign ? { campaignSessionId: membershipCampaign, currentWorkItemId: membershipItem } : null,
  }, supported, parentCarriesCampaign),
  // The projection object changes on every campaign update; only its presence matters here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [hasOwnCampaign, membershipCampaign, membershipItem, parentCarriesCampaign, session.id, session.parentSessionId, supported]);
}

/**
 * Everything Campaign Status reads, behind one hook.
 *
 * - The summary is live: the Orchestrator's session carries it in its campaign projection, so the
 *   campaign view and any member whose browser holds that session read it from the store. A member
 *   without it fetches the summary endpoint, on open, on reconnect, and on a slow poll.
 * - The work list is paginated by an opaque cursor bound to the filter and the ledger revision.
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
  session: Pick<SessionView, "id" | "orchestratorCampaign">;
  availability: Extract<CampaignStatusAvailability, { kind: "available" }>;
  filters: CampaignWorkFilters;
  selectedItemId: string | null;
}): CampaignStatusData {
  const api = useApi();
  const conn = useStoreSelector((s) => s.conn);
  const online = conn === "online";
  const rootSession = useStoreSelector((s) => availability.role === "campaign"
    ? null
    : s.sessions.get(availability.campaignSessionId) ?? null);
  const campaignProjection = availability.role === "campaign" ? session.orchestratorCampaign ?? null : rootSession?.orchestratorCampaign ?? null;
  const liveSummary = campaignWorkSummaryOf(campaignProjection);

  // Reconnecting is a reload trigger for everything fetched: events missed while offline may have
  // moved the ledger without this browser seeing the revision change.
  const [reconnects, setReconnects] = useState(0);
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) setReconnects((count) => count + 1);
    wasOnline.current = online;
  }, [online]);
  const [retries, setRetries] = useState(0);

  /* ---------------------------------------------------------------- summary (members only) */
  const [fetchedSummary, setFetchedSummary] = useState<{ key: string; state: CampaignSummaryState } | null>(null);
  const summaryKey = `${session.id}:${availability.campaignSessionId}`;
  const needsFetchedSummary = liveSummary === null;
  useEffect(() => {
    if (!needsFetchedSummary || !online) return;
    const controller = new AbortController();
    const load = () => {
      api.campaignSummary(session.id, controller.signal).then((response) => {
        setFetchedSummary({
          key: summaryKey,
          state: {
            status: "ready",
            summary: response.work,
            campaign: { title: response.campaignTitle, status: response.status, limits: response.limits },
            error: null,
          },
        });
      }).catch((cause: unknown) => {
        if (isAbort(cause)) return;
        setFetchedSummary((current) => ({
          key: summaryKey,
          state: {
            ...(current?.key === summaryKey ? current.state : { summary: null, campaign: null }),
            status: "error",
            error: errorMessage(cause),
          },
        }));
      });
    };
    load();
    const timer = window.setInterval(load, MEMBER_SUMMARY_POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [api, needsFetchedSummary, online, reconnects, retries, session.id, summaryKey]);

  const summary: CampaignSummaryState = liveSummary
    ? {
      status: "ready",
      summary: liveSummary,
      campaign: campaignProjection
        ? {
          title: availability.role === "campaign" ? "" : rootSession?.title ?? "",
          status: campaignProjection.status,
          limits: campaignProjection.limits,
        }
        : null,
      error: null,
    }
    : fetchedSummary?.key === summaryKey
      ? fetchedSummary.state
      : { status: "loading", summary: null, campaign: null, error: null };
  const revision = summary.summary?.revision ?? null;

  /* ---------------------------------------------------------------- work list */
  const listKey = JSON.stringify([session.id, filters.origin, filters.state, filters.sort]);
  const [list, setList] = useState<{ key: string; state: CampaignListState; cursor: string | null; revision: number | null }>(
    () => ({ key: listKey, state: { status: "loading", items: [], hasMore: false, loadingMore: false, error: null }, cursor: null, revision: null }),
  );
  const listRef = useRef(list);
  listRef.current = list;
  const listGeneration = useRef(0);
  const loadedCount = list.key === listKey ? list.state.items.length : 0;
  const loadedCountRef = useRef(loadedCount);
  loadedCountRef.current = loadedCount;

  const loadFirstPage = useCallback((limit: number) => {
    const generation = ++listGeneration.current;
    const controller = new AbortController();
    setList((current) => current.key === listKey
      ? current
      : { key: listKey, state: { status: "loading", items: [], hasMore: false, loadingMore: false, error: null }, cursor: null, revision: null });
    api.campaignWorkItems(session.id, campaignWorkItemsQuery(filters, null, limit), controller.signal).then((page) => {
      if (generation !== listGeneration.current) return;
      setList({
        key: listKey,
        state: { status: "ready", items: page.items, hasMore: page.nextCursor !== null, loadingMore: false, error: null },
        cursor: page.nextCursor,
        revision: page.revision,
      });
    }).catch((cause: unknown) => {
      if (isAbort(cause) || generation !== listGeneration.current) return;
      setList((current) => ({
        key: listKey,
        // Keep rows already shown; the error notice sits above them rather than replacing them.
        state: { ...(current.key === listKey ? current.state : { items: [], hasMore: false }), status: "error", loadingMore: false, error: errorMessage(cause) },
        cursor: current.key === listKey ? current.cursor : null,
        revision: current.key === listKey ? current.revision : null,
      }));
    });
    return () => controller.abort();
  // `filters` is captured through listKey.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    api.campaignWorkItems(session.id, campaignWorkItemsQuery(filters, current.cursor, CAMPAIGN_WORK_PAGE_SIZE)).then((page) => {
      if (generation !== listGeneration.current) return;
      setList((latest) => {
        const seen = new Set(latest.state.items.map((item) => item.id));
        return {
          key: listKey,
          state: {
            status: "ready",
            items: [...latest.state.items, ...page.items.filter((item) => !seen.has(item.id))],
            hasMore: page.nextCursor !== null,
            loadingMore: false,
            error: null,
          },
          cursor: page.nextCursor,
          revision: page.revision,
        };
      });
    }).catch((cause: unknown) => {
      if (generation !== listGeneration.current) return;
      if (cause instanceof ApiError && cause.status === 409 && cause.code === "revision_changed") {
        // The ledger moved between pages. Reload what was shown under the new revision instead of
        // appending rows from it to rows from the old one.
        loadFirstPage(Math.min(CAMPAIGN_WORK_RELOAD_CEILING, loadedCountRef.current + CAMPAIGN_WORK_PAGE_SIZE));
        return;
      }
      setList((latest) => ({ ...latest, state: { ...latest.state, loadingMore: false, error: errorMessage(cause) } }));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, listKey, loadFirstPage, session.id]);

  /* ---------------------------------------------------------------- detail */
  const detailKey = selectedItemId ? `${session.id}:${selectedItemId}` : null;
  const [detail, setDetail] = useState<{ key: string; state: CampaignDetailState } | null>(null);
  useEffect(() => {
    if (!selectedItemId || !detailKey || !online) return;
    const controller = new AbortController();
    api.campaignWorkItem(session.id, selectedItemId, controller.signal).then((value) => {
      setDetail({ key: detailKey, state: { status: "ready", detail: value, error: null } });
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

  const listState = list.key === listKey
    ? list.state
    : { status: "loading" as const, items: [], hasMore: false, loadingMore: false, error: null };
  const detailState: CampaignDetailState | null = detailKey
    ? detail?.key === detailKey ? detail.state : { status: "loading", detail: null, error: null }
    : null;
  return {
    summary,
    list: listState,
    detail: detailState,
    offline: !online,
    loadMore,
    retry: () => setRetries((count) => count + 1),
  };
}
