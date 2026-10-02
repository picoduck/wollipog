/**
 * Derived primary state of campaign work items (docs/campaign-work-ledger.md, "Derived Primary
 * State"). Pure: no clock, no database. The ledger store and the Read API both call it, so the
 * rules live in exactly one place. The state is never stored.
 */
import type {
  CampaignWorkItemCommitmentState,
  CampaignWorkItemDispatchState,
  CampaignWorkItemPrimaryState,
  CampaignWorkItemStateCause,
  SessionStatus,
} from "@wollipog/protocol";

/** What the server currently observes about the session running an open attempt. */
export interface CampaignAttemptSessionObservation {
  status: SessionStatus;
  archived: boolean;
  /** Held from starting its next turn (the existing #1650 holds). */
  held: boolean;
  /** Unresolved workflow decisions or provider requests on the session. */
  pendingRequests: number;
}

export interface CampaignWorkItemStateRecord {
  id: string;
  commitment: CampaignWorkItemCommitmentState;
  dispatchState: CampaignWorkItemDispatchState;
  hasBlocker: boolean;
  dependsOn: readonly string[];
  /** The item's latest attempt by ordinal, or null when it has never been assigned. */
  latestAttempt: {
    open: boolean;
    /** A `delivered` work-item verification exists for this attempt. */
    delivered: boolean;
  } | null;
  /** Observation of the open attempt's session; null when that session was deleted. Ignored
   * unless the latest attempt is open. */
  openAttemptSession: CampaignAttemptSessionObservation | null;
}

export interface CampaignWorkItemDerivedState {
  state: CampaignWorkItemPrimaryState;
  causes: CampaignWorkItemStateCause[];
}

const FINISHED: ReadonlySet<CampaignWorkItemPrimaryState> = new Set(["delivered", "cancelled", "removed"]);
const BLOCKING_DEPENDENCY: ReadonlySet<CampaignWorkItemPrimaryState> = new Set(["blocked", "cancelled", "removed"]);

/** A dependency's resolved state, or `unresolvable` for a missing id or a dependency cycle. */
export type CampaignDependencyState = CampaignWorkItemPrimaryState | "unresolvable";

/** Derive one item's state from its own record and its dependencies' already-derived states. */
export function deriveCampaignWorkItemState(
  record: CampaignWorkItemStateRecord,
  dependencyStates: readonly CampaignDependencyState[],
): CampaignWorkItemDerivedState {
  if (record.commitment === "cancelled") return { state: "cancelled", causes: [] };
  if (record.commitment === "scope_removed") return { state: "removed", causes: [] };
  const attempt = record.latestAttempt;
  if (attempt?.delivered) return { state: "delivered", causes: [] };
  if (attempt?.open) {
    if (record.hasBlocker) return { state: "blocked", causes: ["recorded_blocker"] };
    const session = record.openAttemptSession;
    if (!session) return { state: "blocked", causes: ["attempt_session_unavailable"] };
    if (session.held) return { state: "blocked", causes: ["attempt_session_held"] };
    if (session.status === "failed") return { state: "blocked", causes: ["attempt_session_failed"] };
    if (session.status === "stopped") return { state: "blocked", causes: ["attempt_session_stopped"] };
    // An archived session takes no further turns, so without a delivered verification (rule 2)
    // nobody is working on the item.
    if (session.archived) return { state: "blocked", causes: ["attempt_session_archived"] };
    if (session.status === "input_required") {
      return { state: "waiting", causes: ["attempt_session_input_required"] };
    }
    if (session.pendingRequests > 0) return { state: "waiting", causes: ["attempt_session_pending_decision"] };
    if (session.status === "idle" || session.status === "completed") {
      return { state: "waiting", causes: ["attempt_awaiting_verification"] };
    }
    return { state: "running", causes: [] };
  }
  if (record.hasBlocker) return { state: "blocked", causes: ["recorded_blocker"] };
  if (dependencyStates.some((state) => state === "unresolvable" || BLOCKING_DEPENDENCY.has(state))) {
    return { state: "blocked", causes: ["dependency_blocked"] };
  }
  const unfinishedDependency = dependencyStates.some((state) => !FINISHED.has(state as CampaignWorkItemPrimaryState));
  const causes: CampaignWorkItemStateCause[] = unfinishedDependency ? ["dependency_unfinished"] : [];
  return { state: record.dispatchState === "queued" ? "queued" : "planned", causes };
}

/** Derive every item in one campaign. Dependencies resolve recursively; a missing dependency or
 * any item on a cycle resolves as `unresolvable` for its dependents, which makes them blocked. */
export function deriveCampaignWorkItemStates(
  records: readonly CampaignWorkItemStateRecord[],
): Map<string, CampaignWorkItemDerivedState> {
  const byId = new Map(records.map((record) => [record.id, record]));
  const derived = new Map<string, CampaignWorkItemDerivedState>();
  const visiting = new Set<string>();
  const resolve = (id: string): CampaignDependencyState => {
    const done = derived.get(id);
    if (done) return done.state;
    const record = byId.get(id);
    if (!record || visiting.has(id)) return "unresolvable";
    visiting.add(id);
    const result = deriveCampaignWorkItemState(record, record.dependsOn.map(resolve));
    visiting.delete(id);
    derived.set(id, result);
    return result.state;
  };
  // Iterative over items, recursive over dependencies. Dependency fan-out is bounded per item
  // (CAMPAIGN_WORK_LEDGER_LIMITS.dependsOn) and the ledger per campaign, so depth stays bounded.
  for (const record of records) resolve(record.id);
  return derived;
}
