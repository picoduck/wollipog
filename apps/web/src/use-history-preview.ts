import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionEvent, SessionEventsResponse, SessionHistoryPreview } from "@wollipog/protocol";
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

type PreviewState = { key: string; source: SessionHistoryPreview; events: SessionEvent[];
  loading: "older" | "later" | "latest" | null; error: string | null };
export interface PreviewAnchor { seq: number; kind: string; offset: number }

/** A view-private coordinate space. The global store, live recovery cursor and CP identity-based
 * actions never receive these rows. A bounded proven-identity handoff retains the visible anchor;
 * omitted earlier/later rows remain reachable through the normal reader controls. */
export function useHistoryPreview(api: ApiClient, sessionId: string, eventEpoch: number,
  anchor: () => PreviewAnchor | null,
  handoff: (page: SessionEventsResponse, anchor: PreviewAnchor) => boolean, scope = "") {
  const key = `${scope}:${sessionId}:${eventEpoch}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const [state, setState] = useState<PreviewState | null>(null);
  const current = state?.key === key ? state : null;
  const currentRef = useRef(current);
  currentRef.current = current;
  const handlers = useRef({ anchor, handoff });
  handlers.current = { anchor, handoff };
  const project = useCallback((page: SessionHistoryPreview): SessionEvent[] => page.events.map(event => ({
    ...event, id: -event.seq, sessionId,
  })), [sessionId]);
  const accept = useCallback((page: SessionHistoryPreview) => {
    if (currentKey.current !== key || page.eventEpoch !== eventEpoch || !validHistoryPreview(page) ||
        (page.events.length && page.events[0]!.seq !== page.turnStartSeq)) return false;
    setState(prior => prior?.key === key ? prior : { key, source: page, events: project(page), loading: null, error: null });
    return true;
  }, [eventEpoch, key, project]);

  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      const selected = currentRef.current;
      if (!selected || selected.loading) { if (!cancelled) timer = setTimeout(check, 500); return; }
      const position = handlers.current.anchor() ?? { seq: selected.events[0]?.seq ?? 0,
        kind: selected.events[0]?.payload.kind ?? "user_message", offset: 0 };
      try {
        const response = await api.getSessionHistoryPreview(sessionId, { eventEpoch,
          logEpoch: selected.source.logEpoch, throughSeq: selected.source.throughSeq,
          turnStartSeq: selected.source.turnStartSeq, handoffSeq: position.seq });
        if (!cancelled && currentKey.current === key && currentRef.current === selected && response.handoff &&
            handlers.current.handoff(response.handoff, position)) {
          setState(null);
          return;
        }
      } catch {
        if (!cancelled) setState(prior => prior?.key === key ? { ...prior,
          error: "Full activity is not available yet. The loaded activity is still readable." } : prior);
      }
      if (!cancelled) timer = setTimeout(check, 500);
    };
    timer = setTimeout(check, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [api, key, sessionId, current?.source]);

  const load = useCallback((direction: "older" | "later" | "latest") => {
    const selected = currentRef.current;
    if (!selected || selected.loading) return false;
    const boundary = direction === "older" ? selected.events[0]?.seq : selected.events.at(-1)?.seq;
    if (boundary === undefined || (direction === "older" ? boundary <= 1 : boundary >= selected.source.throughSeq)) return false;
    const owned = { ...selected, loading: direction, error: null };
    currentRef.current = owned;
    setState(owned);
    void api.getSessionHistoryPreview(sessionId, { eventEpoch, logEpoch: selected.source.logEpoch,
      throughSeq: selected.source.throughSeq, turnStartSeq: selected.source.turnStartSeq,
      ...(direction === "older" ? { beforeSeq: boundary } : direction === "latest"
        ? { beforeSeq: selected.source.throughSeq + 1 } : { afterSeq: boundary }),
    }).then(response => {
      if (currentKey.current !== key || currentRef.current !== owned) return;
      const page = response.preview;
      if (!page || !validHistoryPreview(page) || page.logEpoch !== selected.source.logEpoch ||
          page.throughSeq !== selected.source.throughSeq || page.eventEpoch !== eventEpoch ||
          (direction === "older" ? page.events.at(-1)?.seq !== boundary - 1 : direction === "latest"
            ? page.events.at(-1)?.seq !== selected.source.throughSeq : page.events[0]?.seq !== boundary + 1)) {
        throw new Error("unavailable preview page");
      }
      setState({ ...selected, loading: null, events: direction === "older"
        ? [...project(page), ...selected.events] : direction === "latest" ? project(page) : [...selected.events, ...project(page)] });
    }).catch(() => {
      if (currentKey.current === key && currentRef.current === owned) setState({ ...selected, loading: null,
        error: `Could not load ${direction === "older" ? "earlier" : "later"} activity. Retry to continue reading.` });
    });
    return true;
  }, [api, eventEpoch, key, project, sessionId]);

  const first = current?.events[0]?.seq ?? 0;
  const end = current?.events.at(-1)?.seq ?? 0;
  const window: EventWindowState | undefined = current ? {
    eventEpoch, baseSeq: first, openingStartSeq: current.source.turnStartSeq, hasOlder: first > 1,
    complete: end === current.source.throughSeq, turnAligned: current.events[0]?.payload.kind === "user_message",
    loadingOlder: current.loading === "older", error: current.error,
    ...(end < current.source.throughSeq ? { laterGap: { afterSeq: end, beforeSeq: end + 1,
      tailSeq: current.source.throughSeq, loading: current.loading === "later" || current.loading === "latest", error: current.error,
      fence: { sessionId, eventEpoch, recoveryGeneration: -1, recoveryRevision: -1, operationId: -1, baseSeq: first },
    } } : {}),
  } : undefined;
  const loadOlder = useCallback(() => load("older"), [load]);
  const loadLater = useCallback(() => load("later"), [load]);
  const jumpLatest = useCallback(() => load("latest"), [load]);
  return { active: current !== null, events: current?.events, window, accept, loadOlder, loadLater, jumpLatest };
}
