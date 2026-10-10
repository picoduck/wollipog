import React from "react";
import type { PendingApproval, PermissionOption } from "@wollipog/protocol";
import {
  CostIcon,
  ImageIcon,
  QuestionIcon,
  ShieldIcon,
  SignInIcon,
  ToolIcon,
  WorkflowDecisionsIcon,
} from "../Icons.js";

/**
 * What a pending request asks for, as the Request Card names it (docs/design-system.md §13.2; #2179).
 * One table, so the card's head line, the dock's waiting rows and their summary use the same words
 * and the same icon for a kind.
 */
export type RequestKind =
  | "permission"
  | "budget"
  | "tool_calls"
  | "workflow_decision"
  | "ui_evidence"
  | "sign_in"
  | "question";

export interface RequestKindMeta {
  kind: RequestKind;
  /** Title Case: the head line's kind label. */
  label: string;
}

const META: Record<RequestKind, RequestKindMeta> = {
  permission: { kind: "permission", label: "Permission" },
  budget: { kind: "budget", label: "Budget" },
  tool_calls: { kind: "tool_calls", label: "Tool Calls" },
  workflow_decision: { kind: "workflow_decision", label: "Workflow Decision" },
  ui_evidence: { kind: "ui_evidence", label: "UI Evidence" },
  sign_in: { kind: "sign_in", label: "Sign-In" },
  question: { kind: "question", label: "Question" },
};

export function requestKindMeta(request: Pick<PendingApproval, "kind" | "workflowDecision">): RequestKindMeta {
  switch (request.kind) {
    case "question":
      return META.question;
    case "authentication":
      return META.sign_in;
    case "cost_budget":
    case "cost_checkpoint":
    case "cost_unpriced":
    case "daily_budget":
      return META.budget;
    case "max_tool_calls":
      return META.tool_calls;
    case "workflow_decision":
      return request.workflowDecision?.category === "ui_evidence_approval" ? META.ui_evidence : META.workflow_decision;
    default:
      // A provider permission, and a policy's ask about one (`policy_hook`).
      return META.permission;
  }
}

/** The kind's 16px icon (§18), one per kind. It takes the colour of the words beside it. */
export function RequestKindIcon({ request }: { request: Pick<PendingApproval, "kind" | "workflowDecision"> }) {
  switch (requestKindMeta(request).kind) {
    case "budget": return <CostIcon />;
    case "tool_calls": return <ToolIcon />;
    case "workflow_decision": return <WorkflowDecisionsIcon />;
    case "ui_evidence": return <ImageIcon />;
    case "sign_in": return <SignInIcon />;
    case "question": return <QuestionIcon />;
    case "permission": return <ShieldIcon />;
  }
}

export interface RequestCardActions {
  /** A quiet option at the footer's far left, apart from the others (§3.2): a sign-in's Dismiss
   * Recovery. */
  tertiary: PermissionOption | null;
  /** `reject_*` options, in the provider's order: secondary buttons before the menu. */
  secondary: PermissionOption[];
  /** `allow_always` beside an `allow_once`, and every other option: the ⋯ menu before the primary. */
  menu: PermissionOption[];
  /** The card's only primary, last: the first `allow_once`, or the first allow option when none is. */
  primary: PermissionOption | null;
}

/**
 * The footer's order (§3.2; #2179): secondary options, then the ⋯ menu when there are extra
 * options, then the one primary, last. The order never follows the provider's: a reject is always a
 * secondary, any option without a kind waits in the menu with its description, and the first
 * `allow_once` is the primary, with an `allow_always` beside it in the menu. A request whose only
 * allow is `allow_always` (worktree setup trust, Pi project trust) makes that its primary, so
 * whatever lets the work continue is never hidden (#2641). Budget and tool-call pauses map the same
 * way, so their Stop comes before Continue.
 */
export function requestCardActions(options: readonly PermissionOption[]): RequestCardActions {
  const primary = options.find((option) => option.kind === "allow_once")
    ?? options.find((option) => option.kind === "allow_always")
    ?? null;
  const secondary = options.filter((option) => option.kind === "reject_once" || option.kind === "reject_always");
  const menu = options.filter((option) => option !== primary && !secondary.includes(option));
  return { tertiary: null, secondary, menu, primary };
}

export interface SignInCardActions extends RequestCardActions {
  /** `auth:revalidate` when it is not the primary: the Last Checked fact's Check Again. */
  recheck: PermissionOption | null;
  /** An agent's sign-in methods, when it offers several: one is chosen, then Start Sign-In. */
  methods: PermissionOption[];
}

const SIGN_IN_OPTION = {
  acceptCurrent: "auth:accept-current",
  login: "auth:login",
  revalidate: "auth:revalidate",
  dismiss: "auth:dismiss",
  cancel: "auth:cancel",
} as const;

/**
 * A sign-in card's footer (#2198): one primary for the state the session is in, whatever else the
 * runner offers. Labels stay the runner's option names, which its messages refer to.
 *
 * - Signed in as a different account: Use Current Account. Signed out: Start Sign-In. When the runner
 *   can do neither here, Recheck Authentication is the primary; otherwise it is the Last Checked
 *   fact's Check Again (`recheck`) and not in the footer.
 * - Dismiss Recovery is the tertiary at the far left, unless it is the only choice (the
 *   retained-messages follow-up), where it is the secondary a lone reject always is.
 * - While a sign-in runs, Cancel Sign-In is the only button.
 * - An agent with several sign-in methods (an ACP agent such as OpenCode) lists them as `methods`, and
 *   the card's one Start Sign-In uses the chosen one; its own cancel stays a secondary.
 */
export function signInCardActions(options: readonly PermissionOption[]): SignInCardActions {
  const find = (optionId: string) => options.find((option) => option.optionId === optionId) ?? null;
  const cancel = find(SIGN_IN_OPTION.cancel);
  if (cancel) return { tertiary: null, secondary: [cancel], menu: [], primary: null, recheck: null, methods: [] };
  if (!options.some((option) => option.optionId.startsWith("auth:"))) {
    const methods = options.filter((option) => option.kind === "allow_once");
    if (methods.length > 1) {
      return {
        tertiary: null,
        secondary: options.filter((option) => !methods.includes(option)),
        menu: [],
        primary: null,
        recheck: null,
        methods,
      };
    }
    return { ...requestCardActions(options), recheck: null, methods: [] };
  }
  const revalidate = find(SIGN_IN_OPTION.revalidate);
  const primary = find(SIGN_IN_OPTION.acceptCurrent) ?? find(SIGN_IN_OPTION.login) ?? revalidate;
  const recheck = primary === revalidate ? null : revalidate;
  const dismiss = find(SIGN_IN_OPTION.dismiss);
  // Anything else the runner offers (Start Sign-In beside Use Current Account) is a visible secondary,
  // never a second primary and never hidden behind a menu.
  const rest = options.filter((option) => option !== primary && option !== recheck && option !== dismiss);
  const alone = !primary && rest.length === 0;
  return {
    tertiary: dismiss && !alone ? dismiss : null,
    secondary: dismiss && alone ? [dismiss] : rest,
    menu: [],
    primary,
    recheck,
    methods: [],
  };
}

/** The one-key intent a keycap names, only where exactly one option has that kind (as the Inbox's A
 * and D, `approvalOptionForIntent`), so a key never guesses between two choices. A acts only on an
 * `allow_once` and D only on a `reject_once`: a lasting grant or refusal (a trust request's primary)
 * takes a click, never one key (#2641). */
export function requestOptionForIntent(
  options: readonly PermissionOption[],
  intent: "approve" | "deny",
): PermissionOption | null {
  const kind = intent === "approve" ? "allow_once" : "reject_once";
  const matches = options.filter((option) => option.kind === kind);
  return matches.length === 1 ? matches[0]! : null;
}

/** "9:42", or "1:05:09" past an hour: the time left before a policy ask rejects itself. */
export function formatRequestCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/**
 * The Request Card's and dock's own words (§17), in one table the copy test classifies: labels and
 * names are Title Case, foot-notes and progress are sentences.
 */
export const REQUEST_CARD_COPY = {
  expandDecision: "Expand Decision",
  collapseDecision: "Collapse Decision",
  moreChoices: "More Choices",
  copyDetails: "Copy Request Details",
  requestDetails: "Request Details",
  policyMatch: "Policy Match Context",
  pendingRequests: "Pending Requests",
  waitingRequests: "Waiting Requests",
  pendingRequestTitle: "Pending Request",
  expand: "Expand",
  expandRequest: "Expand Request",
  runnerOffline: "Decisions are unavailable until the runner reconnects.",
  signInOwner: "Only a machine owner or organization admin can sign in on this machine.",
  notSent: "Your decision wasn't sent.",
  sending: "Sending your decision…",
} as const;

/** The dock's disclosure: "+1 More Request", "+2 More Requests". */
export function moreRequestsLabel(count: number): string {
  return `+${count} More ${count === 1 ? "Request" : "Requests"}`;
}

/** The reading-back strip's position of the expanded request among the docked ones: "1 of 3". */
export function requestPositionLabel(position: number, count: number): string {
  return `${position} of ${count}`;
}

/** The menu item that brings the dock back while a notice is shown in its place. */
export function pendingRequestsTitle(count: number): string {
  return count === 1 ? REQUEST_CARD_COPY.pendingRequestTitle : `${count} ${REQUEST_CARD_COPY.pendingRequests}`;
}

/** A policy ask's line under the title: who asked, and how long until it rejects itself. */
export function requestPolicyLine(policyName: string | null, remainingMs: number | null): string {
  return [
    policyName ? `Asked by ${policyName}` : null,
    remainingMs !== null ? `Rejects automatically in ${formatRequestCountdown(remainingMs)}` : null,
  ].filter(Boolean).join(" · ");
}

/** The dock's "+N More Requests" summary names the waiting kinds once each, in priority order. */
export function waitingRequestKinds(requests: readonly Pick<PendingApproval, "kind" | "workflowDecision">[]): string {
  return [...new Set(requests.map((request) => requestKindMeta(request).label))].join(", ");
}
