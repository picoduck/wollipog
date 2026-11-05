/**
 * Campaign activity (#4146, protocol v297). A campaign's status answers two questions for its
 * owner: is anything happening, and must they act. It follows facts the server already tracks,
 * checked in this order, the first that applies winning:
 *
 * 1. `waiting_human` (Waiting for You): a request, decision or recovery item waits on the owner.
 * 2. `active` (Campaign Active): at least one kind of `CampaignLiveWorkKind` is live. An idle root,
 *    idle children and nothing scheduled never read Active.
 * 3. `complete_needs_cleanup` (Complete, Needs Cleanup): all delivery is verified, nothing is live,
 *    and housekeeping remains (`cleanup`). Terminal, informational.
 * 4. `verified_complete` (Campaign Complete): all delivery is verified and nothing is owed.
 * 5. `stuck` (Campaign Stuck): committed work is undelivered, nothing is live, and nothing is
 *    scheduled to wake anyone (`stuck`). A warning: the campaign needs a person. It is derived
 *    from facts, unlike the time-based Stalled warning.
 *
 * Before a campaign reads Complete, Needs Cleanup or Campaign Stuck the server tries, once for each
 * distinct set of leftovers, to settle them itself within existing authority (`activity.repair`):
 * it re-reads the forge, performs approved merged-branch deletions, and wakes the root Orchestrator
 * once with a campaign continuation naming what is left. The campaign reads Active while that runs.
 *
 * Dashboards older than `campaignActivityStatus` receive `complete_needs_cleanup` as
 * `complete_with_handoffs` (and, below `campaignHandoffs`, as `waiting_human`), and `stuck` as
 * `blocked`: existing values, none of which reads as active work.
 */

/** What can make a campaign Campaign Active, in the order the projection lists them. */
export type CampaignLiveWorkKind =
  /** The root Orchestrator's turn is running, starting or queued. */
  | "root_turn"
  /** A campaign child's turn is running, starting or queued. */
  | "child_turn"
  /** An unfinished managed background job belongs to the root or a child, within the stall bound. */
  | "background_job"
  /** A campaign continuation is pending or running. */
  | "continuation"
  /** A pull request waits in a merge queue or on its required checks with a wake registered for the
   * outcome (a parked enqueue, #4071), or such a wake is still owed to its session. */
  | "merge_queue_wait"
  /** The server is settling leftovers itself: its automatic repair, or a Wollipog-performed
   * merged-branch deletion in flight. */
  | "server_repair";

export const CAMPAIGN_LIVE_WORK_KINDS: readonly CampaignLiveWorkKind[] = [
  "root_turn", "child_turn", "background_job", "continuation", "merge_queue_wait", "server_repair",
];

/** The server's automatic attempt to settle an idle campaign's leftovers. One attempt is made for
 * each distinct set of leftovers; `attempted` means it finished and the set has not changed since. */
export interface CampaignRepairView {
  state: "running" | "attempted";
  startedAt: number;
  finishedAt?: number;
  /** The attempt woke the root Orchestrator with a campaign continuation naming what is left. */
  continuation: boolean;
}

export interface CampaignActivityView {
  /** The kinds of live work, in CAMPAIGN_LIVE_WORK_KINDS order; empty when nothing is live. */
  live: CampaignLiveWorkKind[];
  repair?: CampaignRepairView;
}

/** What settles one cleanup item. `delete_merged_branches`: Wollipog can perform an approved
 * `merged_branch_deletion` itself through the existing forge action, so Campaign Status offers
 * **Delete Merged Branches**. `command`: the exact command a person runs. `automatic`: nothing is
 * needed from anyone; Wollipog settles it when the named condition clears. `person`: the next
 * action a handoff names, in its own words. */
export type CampaignCleanupAction =
  | { kind: "delete_merged_branches"; occurrenceId: string }
  | { kind: "command"; command: string }
  | { kind: "automatic"; text: string }
  | { kind: "person"; text: string };

export type CampaignCleanupItem =
  | {
    kind: "merged_branch";
    /** The child whose approved merge landed it. */
    sessionId: string;
    repository: string;
    pullRequest: number;
    /** Null until the forge has been read for it. */
    branch: string | null;
    state: "pending" | "retained";
    reason: string;
    action: CampaignCleanupAction;
  }
  | {
    kind: "worktree";
    sessionId: string;
    path: string;
    status: "pending" | "deferred" | "refused";
    reason: string;
    action: CampaignCleanupAction;
  }
  | {
    kind: "handoff";
    workItemId: string;
    title: string | null;
    issue: import("./campaign-work-ledger.js").CampaignIssueRef | null;
    responsibleActor: import("./campaign-work-ledger.js").CampaignResponsibleActor;
    reason: string;
    action: CampaignCleanupAction;
  };

/** Cleanup items the projection lists at most; `total` keeps the full count. */
export const CAMPAIGN_CLEANUP_ITEMS_LIMIT = 50;

/** One piece of undelivered committed work behind Campaign Stuck. */
export type CampaignStuckItem =
  | { kind: "unverified_child"; sessionId: string; status: string; reason: string }
  | { kind: "orchestrator_request"; sessionId: string; occurrenceId: string; reason: string }
  | {
    kind: "work_item";
    workItemId: string;
    issue: import("./campaign-work-ledger.js").CampaignIssueRef | null;
    reason: string;
  }
  /** Original scoped work the ledger cannot name item by item: no child was started for issues in
   * scope, or the recovery check found scoped work undelivered. */
  | { kind: "scope"; reason: string }
  | { kind: "continuation"; state: "failed" | "missing_result" | "held"; reason: string };

/** Stuck items the projection lists at most; `total` keeps the full count. */
export const CAMPAIGN_STUCK_ITEMS_LIMIT = 50;

/** The exact command that deletes one merged branch from GitHub. Branch names are validated by
 * `forgeActionBranchName` before they are tracked; the name is still single-quoted for the shell. */
export function mergedBranchDeletionCommand(repository: string, branch: string | null, pullRequest: number): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  if (branch !== null) return `gh api -X DELETE ${quote(`repos/${repository}/git/refs/heads/${branch}`)}`;
  // The forge has not reported the branch yet: name it from the pull request in the same command.
  return `gh api -X DELETE "repos/${repository}/git/refs/heads/$(gh pr view ${pullRequest} -R ${quote(repository)} ` +
    `--json headRefName -q .headRefName)"`;
}

/** The exact command that removes one retained child worktree on its machine. Git itself refuses
 * a worktree with uncommitted changes, so nothing is discarded without the person's own choice. */
export function worktreeRemovalCommand(path: string): string {
  return `git worktree remove '${path.replaceAll("'", "'\\''")}'`;
}
