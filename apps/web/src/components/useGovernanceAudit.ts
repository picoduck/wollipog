import { useEffect, useMemo, useRef, useState } from "react";
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
 * The endpoint is an unpaginated newest-N snapshot, so it is refetched whenever the session
 * revision moves. Audit records are append-only, so an unchanged id list means unchanged content
 * and the previous array identity is kept — without that, every session update would invalidate
 * the derived timeline and force a full row re-projection.
 */
export function useGovernanceAudit(sessionId: string, revision: string, enabled: boolean): GovernanceDecision[] {
  const api = useApi();
  const [entries, setEntries] = useState<GovernanceAuditEntry[]>(NO_ENTRIES);

  useEffect(() => {
    if (!enabled) {
      setEntries((previous) => (previous.length ? NO_ENTRIES : previous));
      return;
    }
    let active = true;
    void api.governanceAudit(sessionId, GOVERNANCE_AUDIT_LIMIT)
      .then((response) => {
        if (active) {
          setEntries((previous) => sameGovernanceSnapshot(previous, response.entries) ? previous : response.entries);
        }
      })
      .catch(() => {
        if (active) setEntries((previous) => (previous.length ? NO_ENTRIES : previous));
      });
    return () => {
      active = false;
    };
  }, [api, enabled, revision, sessionId]);

  return useMemo(() => governanceDecisions(entries), [entries]);
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
): TimelineItem[] {
  const previousRef = useRef<TimelineItem[] | null>(null);
  // Rows that have rendered once keep their anchor and are never held again (see
  // MergeGovernanceOptions.landed). Bounded by the audit snapshot: an id that has left the
  // newest-N window can never be merged again, so it is dropped here.
  const landedRef = useRef(new Map<string, number>());
  return useMemo(() => {
    const anchors = events ?? [];
    const transcriptDecisions = transcriptGovernanceDecisions(decisions, items);
    const merged = mergeGovernanceDecisions(items, transcriptDecisions, anchors, {
      holdTrailingRun: turnRunning,
      landed: landedRef.current,
    });
    const current = new Set(decisions.map((decision) => decision.auditId));
    const landed = new Map<string, number>();
    for (const [auditId, anchor] of landedRef.current) {
      if (current.has(auditId)) landed.set(auditId, anchor);
    }
    for (const [auditId, anchor] of landedGovernanceAnchors(merged)) {
      if (!landed.has(auditId) || !Number.isFinite(landed.get(auditId))) landed.set(auditId, anchor);
    }
    landedRef.current = landed;
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
  }, [decisions, events, items, turnRunning]);
}
