/**
 * Wollipog-performed forge actions (#4067, protocol v283). A provider's own permission classifier
 * can refuse an approved command (Claude Code `auto` mode decides inline, so its refusal never
 * reaches the runner's permission channel). Wollipog holds the typed approval, so for the two
 * approved forge writes a campaign depends on it performs the one approved action itself, bound
 * to the decision's exact snapshot, through the child session's own forge login on its runner:
 *
 * - `branch_deletion`: an approved `merged_branch_deletion` that names its merged pull request and
 *   head. The runner proves the pull request merged that exact head from that exact branch, that
 *   no open pull request targets the branch, and deletes it with GitHub's `updateRefs` mutation
 *   pinned by `beforeOid` to the approved head. A moved tip refuses and leaves it alone.
 * - `pr_merge_enqueue`: an approved, armed GitHub `pr_merge`. The control plane re-reads the issues
 *   GitHub would close, then the runner runs the canonical `gh pr merge <url> --squash
 *   --match-head-commit <sha>` (never `--delete-branch`).
 *
 * The provider classifier is not switched off or worked around: the agent's own commands stay
 * subject to it. An approval authorizes one action and is consumed once, only on proof that the
 * action took effect; a refusal that changed nothing leaves it approved for a retry, and a refusal
 * proving the snapshot stale revokes it.
 */

export type ForgeDecisionActionKind = "branch_deletion" | "pr_merge_enqueue";

/** Why Wollipog did not perform an approved forge action. A fixed code, never forge output. */
export type ForgeDecisionActionRefusalReason =
  /** The remote branch tip is no longer the approved merged head. */
  | "tip_moved"
  /** An open pull request targets the branch. */
  | "dependent_pull_request_open"
  /** The pull request is not in the approved state: not merged (deletion), not open at the
   * approved head (enqueue), or from another repository. */
  | "pull_request_mismatch"
  /** The issues GitHub would close changed since approval. */
  | "closure_mismatch"
  /** The forge does not name the approved repository. Reserved; current runners report a mismatched
   * repository as `forge_unavailable`. */
  | "repository_mismatch"
  /** The forge refused the write itself (protection rules, mergeability) and nothing changed. */
  | "forge_refused"
  /** The forge could not be read or written (unreachable, signed out, CLI missing). */
  | "forge_unavailable"
  /** The runner could not be asked. */
  | "runner_unavailable";

export const FORGE_DECISION_ACTION_REFUSAL_REASONS: readonly ForgeDecisionActionRefusalReason[] = [
  "tip_moved", "dependent_pull_request_open", "pull_request_mismatch", "closure_mismatch",
  "repository_mismatch", "forge_refused", "forge_unavailable", "runner_unavailable",
];

/** Refusals that prove the approved snapshot no longer describes the forge: the approval is revoked
 * and a new decision is needed. Every other refusal changed nothing and leaves it approved. */
export const FORGE_DECISION_ACTION_STALE_REFUSALS: ReadonlySet<ForgeDecisionActionRefusalReason> = new Set([
  "tip_moved", "dependent_pull_request_open", "pull_request_mismatch", "closure_mismatch",
]);

/** Outcomes that prove the approved action took effect; each consumes the approval. */
export type ForgeDecisionActionSuccess =
  | "deleted" | "already_deleted"
  | "enqueued" | "already_queued" | "already_merged";

export type ForgeDecisionActionOutcome =
  | ForgeDecisionActionSuccess
  | "refused"
  /** Dispatched, but no answer proved what happened. A deletion may be retried (compare-and-delete
   * is idempotent); an enqueue is not replayed and is reconciled once the forge reads MERGED. */
  | "uncertain";

export const FORGE_DECISION_ACTION_SUCCESSES: ReadonlySet<ForgeDecisionActionOutcome> = new Set([
  "deleted", "already_deleted", "enqueued", "already_queued", "already_merged",
]);

/** Dispatch attempts one approval allows, successful or not. */
export const FORGE_DECISION_ACTION_MAX_ATTEMPTS = 5;

/** The decision's record of what Wollipog did with it (`WorkflowDecisionView.forgeAction`). */
export interface WorkflowDecisionForgeAction {
  kind: ForgeDecisionActionKind;
  attempts: number;
  /** `in_progress` while one attempt is being dispatched. */
  outcome: ForgeDecisionActionOutcome | "in_progress";
  refusal?: { reason: ForgeDecisionActionRefusalReason; summary: string };
  updatedAt: number;
}

export interface ExecuteWorkflowDecisionRequest {
  /** The decision's `resourceDigest`, as `get_workflow_decision` reports it. */
  resourceDigest: string;
}

export type ForgeDecisionAction =
  | { kind: "branch_deletion"; repository: string; branch: string; pullRequest: number; headSha: string; mergeCommitSha: string }
  | { kind: "pr_merge_enqueue"; repository: string; pullRequest: number; headSha: string };

/** Control plane to the requesting child's runner: perform exactly this approved action. */
export interface ForgeDecisionActionMessage {
  type: "forge_decision_action";
  requestId: string;
  sessionId: string;
  occurrenceId: string;
  action: ForgeDecisionAction;
}

export interface ForgeDecisionActionResultMessage {
  type: "forge_decision_action_result";
  requestId: string;
  sessionId: string;
  occurrenceId: string;
  outcome: ForgeDecisionActionOutcome;
  refusal?: { reason: ForgeDecisionActionRefusalReason; summary: string };
}

/** Longest refusal summary kept on a decision. */
export const FORGE_DECISION_ACTION_SUMMARY_LIMIT = 300;

/** A branch name Git itself accepts (`git check-ref-format --branch`, read conservatively), so every
 * branch a forge can hold is tracked and can be acted on. It only ever travels as a GraphQL variable
 * after `refs/heads/`, never as a shell word or a command-line option. Rejected: control characters
 * and space, `~ ^ : ? * [ \`, `..`, `@{`, `//`, a lone `@`, a leading `-` or `/`, a trailing `/` or
 * `.`, and any path component that starts with `.` or ends with `.lock`. */
export function forgeActionBranchName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255 &&
    !/[\x00-\x20\x7f~^:?*[\\]/u.test(value) && value !== "@" && !value.startsWith("-") && !value.startsWith("/") &&
    !value.endsWith("/") && !value.endsWith(".") && !value.includes("..") && !value.includes("//") &&
    !value.includes("@{") && !value.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"));
}

/** One merged campaign pull request's head branch on the remote (`get_campaign.mergedBranches`). */
export interface CampaignMergedBranch {
  /** The child whose approved merge landed it. */
  sessionId: string;
  /** The work item naming the pull request, when the ledger has one. */
  workItemId?: string;
  repository: string;
  pullRequest: number;
  /** Null until the forge has been read for it. */
  branch: string | null;
  /** The approved merged head. */
  headSha: string;
  /** `pending` keeps the campaign from finishing; `retained` (a handoff to a person or an outside
   * party on its work item) lets it finish as `complete_with_handoffs`. */
  state: "deleted" | "retained" | "pending";
  /** Why it is retained (the handoff's reason) or what is pending. */
  reason?: string;
  /** The latest `merged_branch_deletion` occurrence Wollipog acted on for this branch, so its
   * `forgeAction` can be read with `get_workflow_decision`. */
  decisionOccurrenceId?: string;
  /** When the forge last reported it. */
  observedAt?: number;
}

/** Merged branches `get_campaign` lists at most, pending first; the counts stay complete. */
export const CAMPAIGN_MERGED_BRANCHES_LIMIT = 50;
