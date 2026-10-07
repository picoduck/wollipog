import type { PendingApproval, PermissionOption } from "@wollipog/protocol";

/**
 * A Board card's decision pair (#2222, docs/design-system.md §3.1): Approve is the first allow
 * option and Deny the first reject or deny option, whatever the agent calls them, so the card agrees
 * with the list's Approve and Deny and its A and D keys. Only one-time choices are relabeled: an
 * `*_always` option grants or refuses for good, and a card's plain "Approve" must never hide that,
 * so a persistent option stays in the session with every other option. Either may be null: a request
 * without a one-time allow option shows only the Deny it has.
 */
export interface BoardCardDecisions {
  approve: PermissionOption | null;
  deny: PermissionOption | null;
}

const ONE_TIME_ALLOW: ReadonlySet<string> = new Set(["allow_once", "allow"]);
const ONE_TIME_REJECT: ReadonlySet<string> = new Set(["reject_once", "reject", "deny_once", "deny"]);
const isAllow = (option: PermissionOption) => option.kind?.startsWith("allow") === true;
const isReject = (option: PermissionOption) =>
  option.kind?.startsWith("reject") === true || option.kind?.startsWith("deny") === true;

export function boardCardDecisions(options: readonly PermissionOption[]): BoardCardDecisions {
  return {
    approve: options.find((option) => option.kind !== undefined && ONE_TIME_ALLOW.has(option.kind)) ?? null,
    deny: options.find((option) => option.kind !== undefined && ONE_TIME_REJECT.has(option.kind)) ?? null,
  };
}

export interface BoardCardSignInItem {
  option: PermissionOption;
  /** The method's name, or Cancel Sign-In for an option that cancels the sign-in. */
  label: string;
  danger: boolean;
}

/** Wollipog's own cancellation, and an agent's option whose name says it cancels ("Cancel sign-in"). */
const isCancellation = (option: PermissionOption) => option.optionId === "auth:cancel" || /^cancel\b/iu.test(option.name.trim());

/**
 * A sign-in card's one Sign In menu (#2222, §9.1): each method (every `allow*` option, in the
 * runner's order) as a two-line item with its description, then the `reject*` items last in the
 * danger style. A cancellation reads Cancel Sign-In, in the app's casing; any other reject option
 * (Dismiss Recovery) keeps its own name, so an item never says it does something it does not.
 * Options without a kind wait in the session, as the decision pair's extras do.
 */
export function boardCardSignInItems(options: readonly PermissionOption[]): BoardCardSignInItem[] {
  const methods = options.filter(isAllow).map((option) => ({ option, label: option.name, danger: false }));
  const rejects = options.filter(isReject);
  // Cancel Sign-In is last whatever order the runner lists its reject options in.
  const others = rejects.filter((option) => !isCancellation(option)).map((option) => ({ option, label: option.name, danger: true }));
  const cancels = rejects.filter(isCancellation).map((option) => ({ option, label: "Cancel Sign-In", danger: true }));
  return [...methods, ...others, ...cancels];
}

/**
 * The request's code line, when it has one: the first non-empty line of the command or input the
 * driver rendered. A workflow decision carries no tool input, so it has none.
 */
export function boardCardRequestCode(request: Pick<PendingApproval, "context" | "workflowDecision">): string | null {
  if (request.workflowDecision) return null;
  const line = request.context?.input?.split(/\r?\n/u).map((part) => part.trim()).find(Boolean);
  return line || null;
}
