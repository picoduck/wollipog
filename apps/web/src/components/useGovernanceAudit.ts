import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GovernanceAuditEntry } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import {
  GOVERNANCE_AUDIT_LIMIT,
  governanceDecisions,
  landedGovernanceAnchors,
  mergeGovernanceDecisions,
  sameGovernanceSnapshot,
  transcriptGovernanceDecisions,
  type GovernanceAnchorEvent,
  type GovernanceDecision,
} from "../governance.js";
import { publishTimelineSnapshotDelta, type TimelineItem } from "../timeline.js";

const NO_ENTRIES: GovernanceAuditEntry[] = [];

/**
 * The session's governance audit, oldest-first and content-safe.
 *
 * Newest entries are refetched whenever the session revision moves; explicitly or automatically
 * loaded older pages stay attached beneath that moving tail. Audit ids make overlapping refetches
 * idempotent while the server cursor preserves the database's tied-timestamp ordering.
 */
export interface GovernanceAuditState {
  decisions: GovernanceDecision[];
  available: boolean;
  hasMore: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
}

interface AuditPageState {
  sessionId: string;
  entries: GovernanceAuditEntry[];
  nextBefore?: string;
  hasMore: boolean;
  loadedOlder: boolean;
  loadingOlder: boolean;
}

function mergeAuditEntries(
  older: readonly GovernanceAuditEntry[],
  newer: readonly GovernanceAuditEntry[],
): GovernanceAuditEntry[] {
  const seen = new Set<string>();
  const merged: GovernanceAuditEntry[] = [];
  for (const entry of [...older, ...newer]) {
    if (seen.has(entry.auditId)) continue;
    seen.add(entry.auditId);
    merged.push(entry);
  }
  return merged;
}

export function useGovernanceAudit(
  sessionId: string,
  revision: string,
  enabled: boolean,
  oldestTranscriptAt?: number,
): GovernanceAuditState {
  const api = useApi();
  const [page, setPage] = useState<AuditPageState>({
    sessionId: "",
    entries: NO_ENTRIES,
    hasMore: false,
    loadedOlder: false,
    loadingOlder: false,
  });
  const pageRef = useRef(page);
  pageRef.current = page;

  useEffect(() => {
    if (!enabled) {
      setPage((previous) => previous.entries.length || previous.sessionId
        ? { sessionId: "", entries: NO_ENTRIES, hasMore: false, loadedOlder: false, loadingOlder: false }
        : previous);
      return;
    }
    let active = true;
    void api.governanceAudit(sessionId, GOVERNANCE_AUDIT_LIMIT)
      .then((response) => {
        if (active) {
          setPage((previous) => {
            if (previous.sessionId !== sessionId) {
              return {
                sessionId,
                entries: response.entries,
                nextBefore: response.nextBefore,
                hasMore: response.hasMore,
                loadedOlder: false,
                loadingOlder: false,
              };
            }
            const entries = previous.loadedOlder
              ? mergeAuditEntries(previous.entries, response.entries)
              : response.entries;
            return {
              ...previous,
              entries: sameGovernanceSnapshot(previous.entries, entries) ? previous.entries : entries,
              ...(!previous.loadedOlder
                ? { nextBefore: response.nextBefore, hasMore: response.hasMore }
                : {}),
            };
          });
        }
      })
      .catch(() => {
        if (active && pageRef.current.sessionId !== sessionId) {
          setPage({ sessionId, entries: NO_ENTRIES, hasMore: false, loadedOlder: false, loadingOlder: false });
        }
      });
    return () => {
      active = false;
    };
  }, [api, enabled, revision, sessionId]);

  const loadOlder = useCallback(() => {
    const current = pageRef.current;
    if (!enabled || current.sessionId !== sessionId || current.loadingOlder || !current.hasMore || !current.nextBefore) return;
    const cursor = current.nextBefore;
    setPage((value) => value.sessionId === sessionId ? { ...value, loadingOlder: true } : value);
    void api.governanceAudit(sessionId, GOVERNANCE_AUDIT_LIMIT, cursor)
      .then((response) => {
        setPage((value) => value.sessionId === sessionId ? {
          ...value,
          entries: mergeAuditEntries(response.entries, value.entries),
          nextBefore: response.nextBefore,
          hasMore: response.hasMore,
          loadedOlder: true,
          loadingOlder: false,
        } : value);
      })
      .catch(() => {
        setPage((value) => value.sessionId === sessionId ? { ...value, loadingOlder: false } : value);
      });
  }, [api, enabled, sessionId]);

  useEffect(() => {
    if (page.sessionId !== sessionId) return;
    const oldestAuditAt = page.entries[0]?.timestamp;
    if (Number.isFinite(oldestTranscriptAt) && oldestAuditAt != null &&
        oldestAuditAt > oldestTranscriptAt! && page.hasMore && !page.loadingOlder) {
      loadOlder();
    }
  }, [loadOlder, oldestTranscriptAt, page.entries, page.hasMore, page.loadingOlder, page.sessionId, sessionId]);

  const visibleEntries = page.sessionId === sessionId ? page.entries : NO_ENTRIES;
  const decisions = useMemo(() => governanceDecisions(visibleEntries), [visibleEntries]);
  return {
    decisions,
    available: decisions.length > 0 || (page.sessionId === sessionId && page.hasMore),
    hasMore: page.sessionId === sessionId && page.hasMore,
    loadingOlder: page.sessionId === sessionId && page.loadingOlder,
    loadOlder,
  };
}

function hasParentItem(items: readonly TimelineItem[], indexes: readonly number[]): boolean {
  return indexes.some((index) => {
    const item = items[index];
    return item != null && "parentToolUseId" in item && Boolean(item.parentToolUseId);
  });
}

/**
 * The transcript with governance rows spliced in at their chronological positions.
 *
 * The row projector consumes a per-snapshot delta to avoid re-projecting the whole transcript on
 * every append. The merged array is a new array, so its delta is computed here against the
 * previous merged array and republished; an exact dirty-index set keeps the projector's
 * append/settle fast paths available for streaming turns.
 */
export function useGovernanceTimeline(
  items: TimelineItem[],
  decisions: readonly GovernanceDecision[],
  events: readonly GovernanceAnchorEvent[] | undefined,
  /** The turn is still running, so a trailing work run may keep growing. */
  turnRunning = false,
  /**
   * Identity of the event history the anchors refer to (session id plus event epoch). Sequence
   * numbers restart when the history is replaced, so frozen anchors from the old history would
   * compare against unrelated new events; they are dropped when this key changes.
   */
  historyKey = "",
): TimelineItem[] {
  const previousRef = useRef<TimelineItem[] | null>(null);
  // Rows that have rendered once keep their anchor and are never held again (see
  // MergeGovernanceOptions.landed). Bounded by the audit snapshot: an id that has left the
  // newest-N window can never be merged again, so it is dropped here.
  const landedRef = useRef<{ historyKey: string; anchors: Map<string, number> }>({ historyKey, anchors: new Map() });
  return useMemo(() => {
    const anchors = events ?? [];
    if (landedRef.current.historyKey !== historyKey) {
      landedRef.current = { historyKey, anchors: new Map() };
      previousRef.current = null;
    }
    const transcriptDecisions = transcriptGovernanceDecisions(decisions, items);
    const merged = mergeGovernanceDecisions(items, transcriptDecisions, anchors, {
      holdTrailingRun: turnRunning,
      landed: landedRef.current.anchors,
    });
    const current = new Set(decisions.map((decision) => decision.auditId));
    const landed = new Map<string, number>();
    for (const [auditId, anchor] of landedRef.current.anchors) {
      if (current.has(auditId)) landed.set(auditId, anchor);
    }
    for (const [auditId, anchor] of landedGovernanceAnchors(merged)) {
      if (!landed.has(auditId) || !Number.isFinite(landed.get(auditId))) landed.set(auditId, anchor);
    }
    landedRef.current = { historyKey, anchors: landed };
    if (merged === items) {
      previousRef.current = null;
      return items;
    }
    const previous = previousRef.current;
    if (previous) {
      const span = Math.max(previous.length, merged.length);
      const dirtyIndexes: number[] = [];
      for (let index = 0; index < span; index += 1) {
        if (previous[index] !== merged[index]) dirtyIndexes.push(index);
      }
      // Identical content behind a fresh array: keep the retained snapshot so the projector sees
      // no change at all rather than a delta-less array it would have to rebuild from scratch.
      if (!dirtyIndexes.length) return previous;
      {
        publishTimelineSnapshotDelta(merged, {
          previous,
          dirtyFrom: dirtyIndexes[0]!,
          dirtyIndexes,
          dirtyHasParentItems: hasParentItem(merged, dirtyIndexes),
        });
      }
    }
    previousRef.current = merged;
    return merged;
  }, [decisions, events, historyKey, items, turnRunning]);
}
