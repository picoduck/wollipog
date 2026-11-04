/** Fixed diagnostics only: never retain forge output or subprocess errors. */
export const DELIVERY_VERIFICATION_CHECKS = ["default_branch_read", "pull_request_read", "merged_state", "head", "base", "merge_commit", "comparison_read", "containment", "runner_unavailable", "runner_response", "issue_changed", "delivery_missing"] as const;
export interface DeliveryVerificationFailure {
  check: typeof DELIVERY_VERIFICATION_CHECKS[number];
  pullRequest?: number;
}
export function normalizeDeliveryVerificationFailure(value: unknown): DeliveryVerificationFailure | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!DELIVERY_VERIFICATION_CHECKS.includes(v.check as DeliveryVerificationFailure["check"]) ||
      v.pullRequest !== undefined && (!Number.isSafeInteger(v.pullRequest) || (v.pullRequest as number) < 1)) return null;
  return { check: v.check as DeliveryVerificationFailure["check"], ...(v.pullRequest === undefined ? {} : { pullRequest: v.pullRequest as number }) };
}

/**
 * Why a Full Control root's closure of an in-scope issue failed delegated proof (#4058).
 *
 * The closure still becomes a person's decision, under the authority reason
 * `closure_proof_incomplete` rather than `outside_boundary`, and its snapshot lists every gap the
 * server found. Each gap names its work item and pull requests where it has them, and maps to one
 * fixed action: the one that would let a new request become Orchestrator-owned and supersede the
 * person's, or `person_decides` when no campaign action can. Gaps are derived by the server from
 * the ledger and the runner's forge read, never from the request's explanation or evidence.
 *
 * New proof conditions add a code here and map it to an existing action, or add an action, as the
 * epic source (#4060) does. Consumers that meet an unknown code from a newer peer read it as
 * `delivery_unverified`.
 */

/** One member of an epic as the runner read it at closure time (#4060), from the same forge sources
 * scope admission accepts: GitHub sub-issues and the epic's member checklist. `completed` is closed
 * with the forge's completed reason; `closed_not_completed` is any other closure, including one the
 * forge records no reason for; `unreadable` is a checklist member the runner could not read. */
export type IssueClosureEpicMemberState = "open" | "completed" | "closed_not_completed" | "unreadable";

/** The most members an epic closure reads; a larger epic is unreadable rather than partly read. */
export const ISSUE_CLOSURE_EPIC_MEMBERS_MAX = 100;

export interface IssueClosureEpicMembers {
  /** False when the sub-issues or member checklist could not be read in full; `members` is then empty. */
  readable: boolean;
  /** Ascending by number, without the epic itself. Empty for an issue with no members. */
  members: Array<{ number: number; state: IssueClosureEpicMemberState }>;
}

const EPIC_MEMBER_STATES: ReadonlySet<string> = new Set<IssueClosureEpicMemberState>(["open", "completed", "closed_not_completed", "unreadable"]);

/** A received or stored member read, rebuilt canonically; null when it is not a bounded, sorted,
 * duplicate-free read. */
export function normalizeIssueClosureEpicMembers(value: unknown): IssueClosureEpicMembers | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.readable !== "boolean" || !Array.isArray(record.members) || record.members.length > ISSUE_CLOSURE_EPIC_MEMBERS_MAX ||
      !record.readable && record.members.length) return null;
  const members: IssueClosureEpicMembers["members"] = [];
  for (const raw of record.members) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const member = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(member.number) || (member.number as number) < 1 || typeof member.state !== "string" ||
        !EPIC_MEMBER_STATES.has(member.state) || members.length && members.at(-1)!.number >= (member.number as number)) return null;
    members.push({ number: member.number as number, state: member.state as IssueClosureEpicMemberState });
  }
  return { readable: record.readable, members };
}

export const ISSUE_CLOSURE_DELIVERY_GAP_CODES = [
  /** Open pull requests GitHub relates to the issue; `pullRequests` names each. */
  "open_related_pull_requests",
  /** No campaign work item tracks the issue. */
  "no_work_item",
  /** A work item the issue's fixed-by plan names no longer exists. */
  "missing_work_item",
  /** A work item the issue's fixed-by plan names tracks an issue outside the campaign's scope. */
  "work_item_outside_scope",
  /** The item's open attempt has a completed report the root has not verified. */
  "attempt_awaiting_verification",
  /** The item has an open attempt that has not reported. */
  "attempt_open",
  /** The item has no delivered verification with an exact report digest. */
  "no_delivered_verification",
  /** The item has a delivered verification but is not in the delivered state. */
  "work_item_not_delivered",
  /** No pull request the item names or a consumed merge approval binds has merged. */
  "no_merged_delivery_pull_request",
  /** Pull requests the item names have neither merged nor closed; `pullRequests` names each. */
  "unmerged_pull_request",
  /** The forge observation of these pull requests is not fresh. */
  "stale_pull_request",
  /** The item names pull requests outside the campaign's repository. */
  "pull_request_outside_repository",
  /** These pull requests merged at a head no consumed merge approval for the item names. */
  "delivery_not_verified_at_exact_head",
  /** The runner did not confirm these merges at the verified head into the default branch. */
  "delivery_merge_unconfirmed",
  /** The issue has a fixed-by plan, which proves only a completed closure. */
  "fixed_by_completion_only",
  /** A not-planned closure's cancellation, scope removal or named recommendation is not recorded. */
  "disposition_unverified",
  /** The closing comment did not pass publication sanitization. */
  "comment_unsafe",
  /** Delivery could not be proven for a reason no other code names. */
  "delivery_unverified",
  /** Epic source (#4060): these members are open on the forge; `members` names each. */
  "epic_member_open",
  /** Epic source: these members were closed, but not as completed; `members` names each. */
  "epic_member_not_completed",
  /** Epic source: these members are outside the campaign's scope; `members` names each. */
  "epic_member_outside_scope",
  /** Epic source: the runner could not read these members; `members` names each. */
  "epic_member_unreadable",
  /** Epic source: the runner could not read the issue's sub-issues or member checklist in full. */
  "epic_members_unreadable",
] as const;

export type IssueClosureDeliveryGapCode = typeof ISSUE_CLOSURE_DELIVERY_GAP_CODES[number];

export const ISSUE_CLOSURE_GAP_ACTIONS = [
  "wait_for_pull_requests", "verify_child", "finish_attempt", "deliver_work_item", "record_delivery_pull_requests",
  "request_again", "record_disposition", "revise_comment", "close_members", "person_decides",
] as const;

export type IssueClosureGapAction = typeof ISSUE_CLOSURE_GAP_ACTIONS[number];

/** The most gaps one closure snapshot records. */
export const ISSUE_CLOSURE_DELIVERY_GAPS_MAX = 32;

export interface IssueClosureDeliveryGap {
  code: IssueClosureDeliveryGapCode;
  verificationFailure?: DeliveryVerificationFailure;
  /** The work item the gap belongs to, when it belongs to one. */
  workItemId?: string;
  /** The pull or merge requests the gap names, ascending; omitted when it names none. */
  pullRequests?: number[];
  /** The epic's member issues the gap names, ascending (#4060); omitted when it names none. */
  members?: number[];
  /** Derived from `code`: what would let a new request become Orchestrator-owned. */
  action: IssueClosureGapAction;
  /** One or two sentences derived from the fields above, for agents and the Inbox. */
  summary: string;
}

const GAP_ACTION: Record<IssueClosureDeliveryGapCode, IssueClosureGapAction> = {
  open_related_pull_requests: "wait_for_pull_requests",
  no_work_item: "deliver_work_item",
  missing_work_item: "person_decides",
  work_item_outside_scope: "person_decides",
  attempt_awaiting_verification: "verify_child",
  attempt_open: "finish_attempt",
  no_delivered_verification: "deliver_work_item",
  work_item_not_delivered: "deliver_work_item",
  no_merged_delivery_pull_request: "record_delivery_pull_requests",
  unmerged_pull_request: "wait_for_pull_requests",
  stale_pull_request: "request_again",
  pull_request_outside_repository: "record_delivery_pull_requests",
  delivery_not_verified_at_exact_head: "person_decides",
  delivery_merge_unconfirmed: "request_again",
  fixed_by_completion_only: "person_decides",
  disposition_unverified: "record_disposition",
  comment_unsafe: "revise_comment",
  delivery_unverified: "person_decides",
  epic_member_open: "close_members",
  epic_member_not_completed: "person_decides",
  epic_member_outside_scope: "person_decides",
  epic_member_unreadable: "request_again",
  epic_members_unreadable: "request_again",
};

const ACTION_TEXT: Record<IssueClosureGapAction, string> = {
  wait_for_pull_requests: "It blocks delegated closure until each named pull request merges or closes; then request the closure again.",
  verify_child: "Verify the child's completed report with verify_campaign_child, passing this work item, then request the closure again.",
  finish_attempt: "Wait for its child to report and verify it with verify_campaign_child; if the attempt cannot deliver, end it with " +
    "update_campaign_work_item and deliver the item again. Then request the closure again.",
  deliver_work_item: "Deliver the work through a child attempt and verify its report with verify_campaign_child, then request the closure again.",
  record_delivery_pull_requests: "Record exactly the pull requests that delivered the item in its reported stage with update_campaign_work_item " +
    "(stage.pullRequests), then request the closure again.",
  request_again: "Request the closure again; each request reads the forge again.",
  record_disposition: "Record each work item's cancellation or scope removal with a reason and end any open attempt; a named recommendation " +
    "must be rejected or a duplicate, with a reason, and cite the item. Then request the closure again.",
  revise_comment: "Remove the unsafe text from the comment, or omit it, and request the closure again.",
  close_members: "Close each named member as completed through its own closure request, which is Orchestrator-owned when its " +
    "delivery is proven, then request this closure again.",
  person_decides: "No campaign action makes a new request Orchestrator-owned; the person decides this one.",
};

const CODES: ReadonlySet<string> = new Set(ISSUE_CLOSURE_DELIVERY_GAP_CODES);

export function isIssueClosureDeliveryGapCode(value: unknown): value is IssueClosureDeliveryGapCode {
  return typeof value === "string" && CODES.has(value);
}

const named = (pullRequests: readonly number[] | undefined) => pullRequests?.length
  ? pullRequests.map((number) => `#${number}`).join(", ") : "";

function gapText(code: IssueClosureDeliveryGapCode, item: string, prs: string, members: string): string {
  const of = item ? ` for work item ${item}` : "";
  switch (code) {
    case "open_related_pull_requests": return `Related pull requests are open: ${prs || "unnamed"}. One whose title and body no longer mention ` +
      "the issue still counts while GitHub's timeline cross-references it";
    case "no_work_item": return "No campaign work item tracks this issue";
    case "missing_work_item": return `Work item ${item || "unnamed"}, which the issue's fixed-by plan names, no longer exists`;
    case "work_item_outside_scope": return `Work item ${item || "unnamed"}, which the issue's fixed-by plan names, tracks an issue outside the campaign's scope`;
    case "attempt_awaiting_verification": return `Work item ${item || "unnamed"} has a completed report awaiting verification`;
    case "attempt_open": return `Work item ${item || "unnamed"} has an attempt that has not reported`;
    case "no_delivered_verification": return `Work item ${item || "unnamed"} has no delivered verification`;
    case "work_item_not_delivered": return `Work item ${item || "unnamed"} is not in the delivered state`;
    case "no_merged_delivery_pull_request": return `No merged delivery pull request is recorded${of}`;
    case "unmerged_pull_request": return `Pull requests${of} have not merged: ${prs || "unnamed"}`;
    case "stale_pull_request": return `The forge observation of pull requests${of} is not fresh: ${prs || "unnamed"}`;
    case "pull_request_outside_repository": return `Work item ${item || "unnamed"} names pull requests outside the campaign's repository`;
    case "delivery_not_verified_at_exact_head": return `Pull requests${of} merged at a head no consumed merge approval names: ${prs || "unnamed"}`;
    case "delivery_merge_unconfirmed": return `The runner did not confirm that pull requests${of} merged at the verified head into the default branch: ` +
      `${prs || "unnamed"}. If one did not, a person decides`;
    case "fixed_by_completion_only": return "The issue's fixed-by plan proves only a completed closure";
    case "disposition_unverified": return `The not-planned disposition${of} is not recorded`;
    case "comment_unsafe": return "The closing comment did not pass publication sanitization";
    case "delivery_unverified": return "Delivery could not be proven";
    case "epic_member_open": return `Members of this epic are open: ${members || "unnamed"}`;
    case "epic_member_not_completed": return `Members of this epic were closed, but not as completed: ${members || "unnamed"}`;
    case "epic_member_outside_scope": return `Members of this epic are outside the campaign's scope: ${members || "unnamed"}`;
    case "epic_member_unreadable": return `The runner could not read these members of this epic: ${members || "unnamed"}`;
    case "epic_members_unreadable": return "The runner could not read this issue's sub-issues and member checklist in full";
  }
}

function pullRequestNumbers(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = [...new Set(value.filter((item): item is number => Number.isSafeInteger(item) && item > 0))]
    .sort((a, b) => a - b).slice(0, 100);
  return numbers.length ? numbers : undefined;
}

/** The one canonical gap for a code; its action and summary are always derived, never accepted. */
export function issueClosureDeliveryGap(
  code: IssueClosureDeliveryGapCode,
  details: { workItemId?: string; pullRequests?: readonly number[]; members?: readonly number[]; verificationFailure?: DeliveryVerificationFailure } = {},
): IssueClosureDeliveryGap {
  const pullRequests = pullRequestNumbers(details.pullRequests);
  const members = pullRequestNumbers(details.members);
  const workItemId = typeof details.workItemId === "string" && details.workItemId ? details.workItemId.slice(0, 256) : undefined;
  const action = GAP_ACTION[code];
  const failure = code === "delivery_merge_unconfirmed" ? normalizeDeliveryVerificationFailure(details.verificationFailure) : null;
  return { code, ...(failure ? { verificationFailure: failure } : {}), ...(workItemId ? { workItemId } : {}), ...(pullRequests ? { pullRequests } : {}), ...(members ? { members } : {}), action,
    summary: `${failure ? `Delivery verification failed at ${failure.check}${failure.pullRequest ? ` for #${failure.pullRequest}` : ""}. ` : ""}${gapText(code, workItemId ?? "", named(pullRequests), named(members))}. ${ACTION_TEXT[action]}` };
}

/** Stored gaps, rebuilt canonically; null when the value is not a bounded gap list. An unknown
 * code reads as `delivery_unverified`, whose action is `person_decides`. */
export function normalizeIssueClosureDeliveryGaps(value: unknown): IssueClosureDeliveryGap[] | null {
  if (!Array.isArray(value) || !value.length || value.length > ISSUE_CLOSURE_DELIVERY_GAPS_MAX) return null;
  const gaps: IssueClosureDeliveryGap[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (record.workItemId !== undefined && (typeof record.workItemId !== "string" || !record.workItemId || record.workItemId.length > 256)) return null;
    if (record.pullRequests !== undefined && (!Array.isArray(record.pullRequests) || record.pullRequests.length > 100)) return null;
    if (record.members !== undefined && (!Array.isArray(record.members) || record.members.length > 100)) return null;
    gaps.push(issueClosureDeliveryGap(isIssueClosureDeliveryGapCode(record.code) ? record.code : "delivery_unverified", {
      ...(record.verificationFailure === undefined ? {} : { verificationFailure: normalizeDeliveryVerificationFailure(record.verificationFailure) ?? undefined }),
      ...(record.workItemId === undefined ? {} : { workItemId: record.workItemId as string }),
      ...(record.pullRequests === undefined ? {} : { pullRequests: record.pullRequests as number[] }),
      ...(record.members === undefined ? {} : { members: record.members as number[] }),
    }));
  }
  return gaps;
}

/** The longest `deliveryFailure` a closure snapshot keeps. */
export const ISSUE_CLOSURE_DELIVERY_FAILURE_MAX = 512;

/** The compact `deliveryFailure` line: `code[:workItemId][:#n,#m]` per gap, joined by "; ", naming
 * at most ten pull requests, or epic members, per gap (no code names both). Gaps that would pass
 * the bound are left out and counted, so the line never cuts a name in half; `deliveryGaps` keeps
 * them all. */
export function issueClosureDeliveryFailure(gaps: readonly IssueClosureDeliveryGap[]): string {
  const parts = gaps.map((gap) => {
    const prs = gap.pullRequests ?? gap.members ?? [];
    const listed = prs.slice(0, 10).map((number) => `#${number}`).join(",") + (prs.length > 10 ? `,+${prs.length - 10}` : "");
    return [gap.code, ...(gap.workItemId ? [gap.workItemId] : []), ...(listed ? [listed] : [])].join(":");
  });
  let line = "";
  for (let index = 0; index < parts.length; index++) {
    const next = line ? `${line}; ${parts[index]}` : parts[index]!;
    const rest = parts.length - index - 1;
    // The previous step reserved room for exactly this count, so the omission always fits.
    if (next.length + (rest ? `; +${rest} more`.length : 0) > ISSUE_CLOSURE_DELIVERY_FAILURE_MAX) {
      return line ? `${line}; +${parts.length - index} more` : `+${parts.length} more`;
    }
    line = next;
  }
  return line;
}

/** What a closure request returns beside a person-owned decision that failed delegated proof. */
export interface IssueClosureProofGapNotice {
  reason: "closure_proof_incomplete";
  gaps: IssueClosureDeliveryGap[];
  /** One paragraph for agents: who decides now, and how a new request can supersede it. */
  summary: string;
}

export function issueClosureProofGapNotice(gaps: readonly IssueClosureDeliveryGap[]): IssueClosureProofGapNotice {
  const fixable = gaps.every((gap) => gap.action !== "person_decides");
  return {
    reason: "closure_proof_incomplete",
    gaps: gaps.map((gap) => ({ ...gap })),
    summary: "This issue is in the campaign's scope, but its closure failed delegated proof, so a person decides this request. " +
      (fixable
        ? "Fix every gap below and request the closure again: a request that passes the proof is Orchestrator-owned and supersedes this one."
        : "At least one gap below is one only a person can resolve; leave this request for the person rather than requesting it again."),
  };
}
