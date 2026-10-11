import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionEvent, SessionEventsResponse, SessionHistoryHandoff, SessionHistoryPreview } from "@wollipog/protocol";
import type { ApiClient } from "./api.js";
import type { EventWindowState } from "./store.js";

export function validHistoryPreview(page: SessionHistoryPreview): boolean {
  if (!page || !Array.isArray(page.events)) return false;
  const { events, eventEpoch, logEpoch, throughSeq, turnStartSeq, nextAfterSeq } = page;
  return [eventEpoch, logEpoch, throughSeq, turnStartSeq, nextAfterSeq].every(value => Number.isSafeInteger(value) && value >= 0) &&
    turnStartSeq <= throughSeq && nextAfterSeq <= throughSeq && page.hasMore === (nextAfterSeq < throughSeq) &&
    events.length <= 200 && events.every((event, index) => event && event.payload && typeof event.payload.kind === "string" && Number.isSafeInteger(event.seq) && event.seq > 0 &&
      Number.isSafeInteger(event.ts) && event.ts >= 0 && event.seq <= throughSeq &&
      (index === 0 || event.seq === events[index - 1]!.seq + 1)) &&
    nextAfterSeq === (events.at(-1)?.seq ?? 0);
}

type PreviewState = { key: string; viewRevision: number; source: SessionHistoryPreview; events: SessionEvent[];
  loading: "older" | "later" | "latest" | null; error: string | null };
export interface PreviewHandoff extends SessionHistoryHandoff { pages: SessionHistoryHandoff[] }
export interface PreviewAnchor { seq: number; kind: string; offset: number; rowKind?: string; rowKey?: string }

/** A view-private coordinate space. The global store, live recovery cursor and CP identity-based
 * actions never receive these rows. A bounded proven-identity handoff retains the visible anchor;
 * the entire explicitly loaded range is converted before changing coordinate spaces. */
export function useHistoryPreview(api: ApiClient, sessionId: string, eventEpoch: number,
  anchor: () => PreviewAnchor | null,
  handoff: (page: PreviewHandoff, anchor: PreviewAnchor) => boolean, scope = "",
  refreshOpening?: (page: SessionEventsResponse) => boolean) {
  const key = `${scope}:${sessionId}:${eventEpoch}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const [state, setState] = useState<PreviewState | null>(null);
  const current = state?.key === key ? state : null;
  const currentRef = useRef(current);
  currentRef.current = current;
  const olderRead = useRef<Promise<void> | null>(null);
  const handlers = useRef({ anchor, handoff, refreshOpening });
  handlers.current = { anchor, handoff, refreshOpening };
  const project = useCallback((page: SessionHistoryPreview): SessionEvent[] => page.events.map(event => ({
    ...event, id: -event.seq, sessionId,
  })), [sessionId]);
  const accept = useCallback((page: SessionHistoryPreview) => {
    if (currentKey.current !== key || page.eventEpoch !== eventEpoch || !validHistoryPreview(page) ||
        (page.events.length && page.events[0]!.seq !== page.turnStartSeq)) return false;
    setState(prior => prior?.key === key ? prior : { key, viewRevision: 0, source: page, events: project(page), loading: null, error: null });
    return true;
  }, [eventEpoch, key, project]);

  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let conversion: { owner: PreviewState; position: PreviewAnchor; page: PreviewHandoff } | null = null;
    let retryDelay = 500;
    const samePosition = (a: PreviewAnchor, b: PreviewAnchor) => a.seq === b.seq && a.kind === b.kind &&
      a.offset === b.offset && a.rowKey === b.rowKey && a.rowKind === b.rowKind;
    const check = async () => {
      const selected = currentRef.current;
      const position = handlers.current.anchor();
      if (!selected || selected.loading || !position) {
        conversion = null;
        if (!cancelled) timer = setTimeout(check, 500);
        return;
      }
      if (conversion && (conversion.owner !== selected || !samePosition(conversion.position, position))) conversion = null;
      try {
        // One bounded conversion page per poll. Reader movement or paging revokes the chain; no
        // partial chain can replace rows already read in the private coordinate space.
        const response = await api.getSessionHistoryPreview(sessionId, { eventEpoch,
          logEpoch: selected.source.logEpoch, throughSeq: selected.source.throughSeq,
          turnStartSeq: selected.source.turnStartSeq, handoffSeq: position.seq,
          handoffFirstSeq: selected.events[0]!.seq, handoffLastSeq: selected.events.at(-1)!.seq,
          ...(conversion ? { handoffAfter: conversion.page.nextAfter } : {}) });
        if (cancelled || currentKey.current !== key || currentRef.current !== selected ||
            !samePosition(position, handlers.current.anchor() ?? { seq: 0, kind: "", offset: 0 })) {
          conversion = null;
          if (!cancelled) timer = setTimeout(check, 500);
          return;
        }
        const page = response.handoff;
        if (!page) { conversion = null; retryDelay = Math.min(5_000, retryDelay * 2); }
        else {
          retryDelay = 500;
          const previous = conversion?.page;
          const after = previous?.nextAfter ?? page.windowStartSeq - 1;
          if (page.eventEpoch !== eventEpoch || page.cacheComplete !== true || !page.events.length ||
              page.events.length > 200 || page.events.some((event, i) => event.seq !== after + i + 1 || event.id <= 0) ||
              page.nextAfter !== page.events.at(-1)!.seq || page.nextAfter > page.windowEndSeq ||
              page.hasMoreHandoff !== (page.nextAfter < page.windowEndSeq) ||
              (previous && (previous.windowStartSeq !== page.windowStartSeq || previous.windowEndSeq !== page.windowEndSeq ||
                previous.anchorSeq !== page.anchorSeq))) throw new Error("invalid identity conversion");
          const joined = previous ? { ...page, events: [...previous.events, ...page.events],
            identities: [...previous.identities, ...page.identities], pages: [...previous.pages, page],
            turnAligned: previous.turnAligned } : { ...page, pages: [page] };
          conversion = { owner: selected, position, page: joined };
          if (!page.hasMoreHandoff) {
            const identities = new Map(joined.identities.map(identity => [identity.runnerSeq, identity.seq]));
            const cpEvents = new Map(joined.events.map(event => [event.seq, event]));
            if (joined.events[0]?.seq !== joined.windowStartSeq || selected.events.some(event => {
              const cp = cpEvents.get(identities.get(event.seq) ?? -1);
              return !cp || cp.payload.kind !== event.payload.kind;
            }) || identities.get(position.seq) !== joined.anchorSeq) throw new Error("incomplete identity conversion");
            if (handlers.current.handoff(joined, position)) { setState(null); return; }
            conversion = null;
          }
        }
      } catch {
        conversion = null; retryDelay = Math.min(5_000, retryDelay * 2);
        if (!cancelled) setState(prior => prior?.key === key ? { ...prior,
          error: "Full activity is not available yet. The loaded snapshot is still readable." } : prior);
      }
      if (!cancelled) timer = setTimeout(check, retryDelay);
    };
    timer = setTimeout(check, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [api, key, sessionId, current?.source]);

  const load = useCallback((direction: "older" | "later") => {
    const selected = currentRef.current;
    if (!selected || selected.loading) return false;
    const boundary = direction === "older" ? selected.events[0]?.seq : selected.events.at(-1)?.seq;
    if (boundary === undefined || (direction === "older" ? boundary <= 1 : boundary >= selected.source.throughSeq)) return false;
    const owned = { ...selected, loading: direction, error: null };
    currentRef.current = owned;
    setState(owned);
    const pending = api.getSessionHistoryPreview(sessionId, { eventEpoch, logEpoch: selected.source.logEpoch,
      throughSeq: selected.source.throughSeq, turnStartSeq: selected.source.turnStartSeq,
      ...(direction === "older" ? { beforeSeq: boundary } : { afterSeq: boundary }),
    }).then(response => {
      if (currentKey.current !== key || currentRef.current !== owned) return;
      const page = response.preview;
      if (!page || !validHistoryPreview(page) || page.logEpoch !== selected.source.logEpoch ||
          page.throughSeq !== selected.source.throughSeq || page.eventEpoch !== eventEpoch ||
          (direction === "older" ? page.events.at(-1)?.seq !== boundary - 1 : page.events[0]?.seq !== boundary + 1)) {
        throw new Error("unavailable preview page");
      }
      setState({ ...selected, loading: null, events: direction === "older"
        ? [...project(page), ...selected.events] : [...selected.events, ...project(page)] });
    }).catch(() => {
      if (currentKey.current === key && currentRef.current === owned) setState({ ...selected, loading: null,
        error: `Could not load ${direction === "older" ? "earlier" : "later"} activity. Retry to continue reading.` });
    });
    if (direction === "older") {
      olderRead.current = pending;
      void pending.finally(() => { if (olderRead.current === pending) olderRead.current = null; });
    }
    return true;
  }, [api, eventEpoch, key, project, sessionId]);

  const refresh = useCallback(() => {
    const selected = currentRef.current;
    if (!selected || selected.loading) return false;
    const owned = { ...selected, loading: "latest" as const, error: null };
    currentRef.current = owned; setState(owned);
    void api.getSessionTurnStartPage(sessionId, eventEpoch).then(response => {
      if (currentKey.current !== key || currentRef.current !== owned) return;
      const page = response.preview;
      if (!page) {
        if (response.eventEpoch === eventEpoch && response.cacheComplete === true && handlers.current.refreshOpening?.(response)) {
          setState(null); return;
        }
        setState({ ...selected, loading: null,
          error: "Recent activity is not available to refresh yet. The loaded snapshot is still readable." });
        return;
      }
      if (page.eventEpoch !== eventEpoch || !validHistoryPreview(page) ||
          (page.events.length && page.events[0]!.seq !== page.turnStartSeq)) throw new Error("unavailable snapshot");
      setState({ key, viewRevision: selected.viewRevision + 1, source: page, events: project(page), loading: null, error: null });
    }).catch(() => {
      if (currentKey.current === key && currentRef.current === owned) setState({ ...selected, loading: null,
        error: "Could not refresh recent activity. The loaded snapshot is still readable." });
    });
    return true;
  }, [api, eventEpoch, key, project, sessionId]);

  const first = current?.events[0]?.seq ?? 0;
  const end = current?.events.at(-1)?.seq ?? 0;
  const window: EventWindowState | undefined = current ? {
    eventEpoch, baseSeq: first, openingStartSeq: current.source.turnStartSeq, hasOlder: first > 1,
    complete: false, turnAligned: current.events[0]?.payload.kind === "user_message",
    loadingOlder: current.loading === "older", error: current.error,
    laterGap: { afterSeq: end, beforeSeq: end + 1,
      tailSeq: current.source.throughSeq, loading: current.loading === "later" || current.loading === "latest", error: current.error,
      fence: { sessionId, eventEpoch, recoveryGeneration: -1, recoveryRevision: -1, operationId: -1, baseSeq: first },
    },
  } : undefined;
  // Navigation waits on the owner that actually issued the read, without sharing CP cursors.
  const isLoadingOlder = useCallback(() => currentRef.current?.loading === "older", []);
  const waitForOlder = useCallback(() => olderRead.current ?? Promise.resolve(), []);
  const loadOlder = useCallback(() => load("older"), [load]);
  const loadLater = useCallback(() => load("later"), [load]);
  const jumpLatest = refresh;
  return { active: current !== null, viewRevision: current?.viewRevision ?? 0, canLoadLater: !!current && end < current.source.throughSeq, events: current?.events, window, accept, loadOlder, loadLater, jumpLatest, isLoadingOlder, waitForOlder };
}
