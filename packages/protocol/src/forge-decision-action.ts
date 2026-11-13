/**
 * Wollipog-performed forge actions (#4067, protocol v284). A provider's own permission classifier
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
 * - `issue_publication` (v327, #4119): an approved `follow_up_issue_publication` in another of the
 *   campaign's repositories. The control plane sends it to the runner of a Location of that
 *   repository, which creates the issue with its own forge login, with no session of its own. That
 *   is the only route for such a publication: its requester's own login is never used.
 *   Since v373 the requester may also choose this route for its own campaign repository. A
 *   successful exact-payload forge readback is recorded for the follow-up's ledger-link exemption.
 *
 * The provider classifier is not switched off or worked around: the agent's own commands stay
 * subject to it. An approval authorizes one action and is consumed once, only on proof that the
 * action took effect; a refusal that changed nothing leaves it approved for a retry, and a refusal
 * proving the snapshot stale revokes it.
 */

export type ForgeDecisionActionKind = "branch_deletion" | "pr_merge_enqueue" | "issue_publication";

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
  | "runner_unavailable"
  /** A publication's fresh evidence or duplicate inspection no longer holds; nothing was created. */
  | "publication_refused"
  /** #4120: the merge gained a cross-repository hold while it was being prepared; nothing was
   * enqueued and the approval stands. Recorded by the control plane only, never by a runner, so it
   * is not in `FORGE_DECISION_ACTION_REFUSAL_REASONS`. */
  | "merge_held";

/** The reasons a runner may report. */
export const FORGE_DECISION_ACTION_REFUSAL_REASONS: readonly ForgeDecisionActionRefusalReason[] = [
  "tip_moved", "dependent_pull_request_open", "pull_request_mismatch", "closure_mismatch",
  "repository_mismatch", "forge_refused", "forge_unavailable", "runner_unavailable", "publication_refused",
];

/** Refusals that prove the approved snapshot no longer describes the forge: the approval is revoked
 * and a new decision is needed. Every other refusal changed nothing and leaves it approved. */
export const FORGE_DECISION_ACTION_STALE_REFUSALS: ReadonlySet<ForgeDecisionActionRefusalReason> = new Set([
  "tip_moved", "dependent_pull_request_open", "pull_request_mismatch", "closure_mismatch",
]);

/** Outcomes that prove the approved action took effect; each consumes the approval. */
export type ForgeDecisionActionSuccess =
  | "deleted" | "already_deleted"
  | "enqueued" | "already_queued" | "already_merged"
  | "published" | "already_published"
  | "open_unqueued";

export type ForgeDecisionActionOutcome =
  | ForgeDecisionActionSuccess
  | "refused"
  /** Dispatched, but no answer proved what happened. A deletion may be retried (compare-and-delete
   * is idempotent); an enqueue is not replayed and is reconciled once the forge reads MERGED; a
   * publication is never created again, and a later attempt only looks for the issue. */
  | "uncertain";

export const FORGE_DECISION_ACTION_SUCCESSES: ReadonlySet<ForgeDecisionActionOutcome> = new Set([
  "deleted", "already_deleted", "enqueued", "already_queued", "already_merged", "published", "already_published",
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
  /** A publication's result (v327): the issue created in the snapshot's repository, and the runner
   * whose forge login created it. */
  publishedIssue?: number;
  /** v373: the exact issue returned by this occurrence's successful create response, retained
   * across failed readback and observation. A title/body search alone cannot establish creation. */
  publicationCreatedIssue?: number;
  /** v373: the server read this created issue back from its forge and verified the exact approved
   * title, body and labels. Older success records alone grant no ledger-link exemption. */
  publicationVerified?: boolean;
  performedByRunnerId?: string;
  updatedAt: number;
}

export interface ExecuteWorkflowDecisionRequest {
  /** The decision's `resourceDigest`, as `get_workflow_decision` reports it. */
  resourceDigest: string;
}

export type ForgeDecisionAction =
  | { kind: "temporary_branch_create"; repository: string; branch: string; headSha: string }
  | { kind: "temporary_branch_deletion"; repository: string; branch: string; headSha: string }
  | { kind: "branch_deletion"; repository: string; branch: string; pullRequest: number; headSha: string; mergeCommitSha: string }
  | { kind: "pr_merge_enqueue"; repository: string; pullRequest: number; headSha: string }
  /** Read the pull request only, never enqueue: proof for reconciling an enqueue Wollipog already
   * performed. `already_merged` means GitHub merged exactly `headSha`; anything else refuses. Its own
   * kind, never a flag on the enqueue, so a runner that does not know it refuses it as unknown
   * instead of running an enqueue. */
  | { kind: "pr_merge_retirement_observe"; repository: string; pullRequest: number; headSha: string }
  | { kind: "pr_merge_observe"; repository: string; pullRequest: number; headSha: string }
  /** Create the approved issue, once, through the Location named by the message. */
  | { kind: "issue_publication"; repository: string; title: string; body: string; labels: string[] }
  /** Look for that issue only, never create it: after a publication that may have run, its own kind
   * for the same reason as `pr_merge_observe`. `already_published` means an issue with exactly this
   * title and body exists; anything else stays `uncertain`. */
  | { kind: "issue_publication_observe"; repository: string; title: string; body: string;
      /** v373: observe this known creation receipt instead of searching for a matching copy. */
      issue?: number };

/** The Location whose runner performs a publication (v327). Resolved by the control plane. */
export interface ForgeDecisionActionLocation {
  workspaceId: string;
  workspacePath: string;
  repository: string;
}

/** Control plane to the runner that performs this approved action: the requesting child's, or for a
 * publication the runner of `location`, which holds no session for it. */
export interface ForgeDecisionActionMessage {
  type: "forge_decision_action";
  requestId: string;
  sessionId: string;
  occurrenceId: string;
  action: ForgeDecisionAction;
  location?: ForgeDecisionActionLocation;
}

export interface ForgeDecisionActionResultMessage {
  type: "forge_decision_action_result";
  requestId: string;
  sessionId: string;
  occurrenceId: string;
  outcome: ForgeDecisionActionOutcome;
  refusal?: { reason: ForgeDecisionActionRefusalReason; summary: string };
  /** With `published` or `already_published`. */
  issue?: number;
  /** v376: immutable default-head containment read that preceded create-only publication. */
  temporaryBranchProof?: { defaultBranch: string; defaultHeadSha: string };
}

/** Created only after the runner's create-only remote mutation succeeds. No client assertion or
 * historical Git metadata can mint one. The control plane binds its immutable campaign/member. */
export interface TemporaryBranchReceipt {
  id: string;
  campaignId: string;
  sessionId: string;
  repository: string;
  branch: string;
  headSha: string;
  createdAt: number;
  defaultBranch?: string;
  defaultHeadSha?: string;
}

export function matchingTemporaryBranchReceipt(receipts: readonly TemporaryBranchReceipt[] | undefined,
  campaignId: string, sessionId: string, snapshot: { repository: string; branch: string; headSha?: string; temporaryReceiptId?: string }): boolean {
  return Boolean(snapshot.temporaryReceiptId && receipts?.some((receipt) => receipt.id === snapshot.temporaryReceiptId &&
    receipt.defaultBranch && receipt.defaultHeadSha &&
    receipt.campaignId === campaignId && receipt.sessionId === sessionId && receipt.repository === snapshot.repository.toLowerCase() &&
    receipt.branch === snapshot.branch && receipt.headSha === snapshot.headSha));
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
  /** `pending` or `retained` (a handoff to a person or an outside party on its work item) is cleanup
   * the campaign owes: a delivered, idle campaign reads `complete_needs_cleanup` (v297, #4146;
   * older control planes keep it `active` or finish as `complete_with_handoffs`). */
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
