/**
 * Derived primary state of campaign work items (docs/campaign-work-ledger.md, "Derived Primary
 * State"). Pure: no clock, no database. The ledger store and the Read API both call it, so the
 * rules live in exactly one place. The state is never stored.
 */
import type {
  CampaignMergeDependencyStatus,
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
  /** A recorded delivery (#4070) exists and no attempt was opened on the item after it. Omitted
   * means none. */
  recordedDelivery?: boolean;
  /** Server-proven completed epic closure finishes only an item with no delivery work. */
  epicTrackingClosed?: boolean;
  /** #4120: the status of each merge dependency, a prerequisite in another repository. Omitted
   * means none; dependencies within one repository are only in `dependsOn`. */
  mergeDependencies?: readonly CampaignMergeDependencyStatus[];
  /** #4120: every pull request the item names is observed MERGED (it names at least one). Only read
   * for an item verified delivered that has merge dependencies. Omitted means not known to be. */
  ownPullRequestsMerged?: boolean;
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
  // #4120: a prerequisite in another repository that can no longer merge means this item's merge is
  // never attempted, whether or not a child is working on it.
  const mergeDependencyFailed = record.mergeDependencies?.includes("failed") ?? false;
  // A recorded delivery (#4070) is a merge into the default branch, so it is delivered whatever its
  // prerequisites do. A verified report is not a merge: until the item's own pull requests are
  // observed MERGED, its merge still waits on its prerequisites, so it is unfinished, blocked for good
  // when one can never merge, and otherwise waiting on the merge.
  if (record.recordedDelivery) return { state: "delivered", causes: [] };
  if (record.epicTrackingClosed && !attempt?.open) return { state: "delivered", causes: [] };
  if (attempt?.delivered) {
    if (record.ownPullRequestsMerged || !record.mergeDependencies?.some((status) => status !== "merged")) return { state: "delivered", causes: [] };
    return mergeDependencyFailed ? { state: "blocked", causes: ["dependency_blocked"] } : { state: "waiting", causes: ["dependency_unmerged"] };
  }
  if (attempt?.open) {
    if (record.hasBlocker) return { state: "blocked", causes: ["recorded_blocker"] };
    if (mergeDependencyFailed) return { state: "blocked", causes: ["dependency_blocked"] };
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
      // Its merge is held on the prerequisite (#4120); a verification may still be owed, so it stays listed.
      return record.mergeDependencies?.includes("unmerged")
        ? { state: "waiting", causes: ["dependency_unmerged", "attempt_awaiting_verification"] }
        : { state: "waiting", causes: ["attempt_awaiting_verification"] };
    }
    return { state: "running", causes: [] };
  }
  if (record.hasBlocker) return { state: "blocked", causes: ["recorded_blocker"] };
  if (mergeDependencyFailed || dependencyStates.some((state) => state === "unresolvable" || BLOCKING_DEPENDENCY.has(state))) {
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
