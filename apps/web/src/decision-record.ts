/**
 * The Decision Record (#2204): one quiet row per finished decision, the same in the transcript and
 * in the decision history (docs/design-system.md §5.5, §11.2).
 *
 * Each kind of decision (a resolved permission, a governance decision, an automated review) is
 * reduced here to one model: a past-tense outcome from the `requestDecision` vocabulary, the
 * request's title, who decided, when, and its read-only facts. Opaque ids (request, audit, policy,
 * session) are never part of what the row says; they are only copied, through Copy Audit ID.
 */
import { createContext } from "react";
import type { PermissionOption } from "@wollipog/protocol";
import { titleCaseLabel } from "./format.js";
import type { GovernanceDecision } from "./governance.js";
import { humanResolver, resolverName, type ViewerIdentity } from "./resolver-identity.js";
import { statusMeta, type StatusValue } from "./status-meta.js";
import type { TimelineItem } from "./timeline.js";

export type DecisionOutcome = StatusValue<"requestDecision">;

/** Who decided. Ids are carried only to look names up; they are never shown. */
export type DecisionActor =
  /** A person, named relative to the viewer (#2527). The user id is absent when the event names none. */
  | { kind: "member"; userId?: string }
  /** A governance policy, named by its display name. */
  | { kind: "policy"; policyId?: string }
  /** A controlling parent session, named by its title. */
  | { kind: "parent"; sessionId: string }
  /** Wollipog itself, for a request blocked fail-closed. */
  | { kind: "wollipog" }
  /** An automated reviewer. */
  | { kind: "reviewer"; name: string };

export interface DecisionFact {
  label: string;
  value: string;
  /** Shown in a code well: the command or input the request was for. */
  code?: boolean;
}

export interface DecisionRecordModel {
  outcome: DecisionOutcome;
  /** What was requested: the permission's title, the tool's name, or the kind of request. */
  title: string;
  actor?: DecisionActor;
  /** When it was decided, as the runner or the audit recorded it. */
  at?: number;
  /** One sentence about what the outcome meant, when there is one. */
  detail?: string;
  /** Read-only facts after Decided By and before Recorded: Tool, Path, Branch, the command. */
  facts: DecisionFact[];
  /** What Copy Audit ID copies, as label and id pairs. */
  auditIds: Array<readonly [string, string]>;
}

/** The lookups that turn an actor into a name. Each returns undefined when it cannot say. */
export interface DecisionNames {
  viewer: ViewerIdentity | null;
  policyName: (policyId: string) => string | undefined;
  sessionTitle: (sessionId: string) => string | undefined;
}

/**
 * The display names of the organization's governance policies, by policy id, loaded only once a row
 * asks for one. `names` is null until they load, and stays null where they cannot.
 */
export interface GovernancePolicyNames {
  names: ReadonlyMap<string, string> | null;
  /** A row needs this policy's name: loads the names, or reloads them once for a policy they lack. */
  load: (policyId: string) => void;
  /** A policy was created, renamed or removed here: reload the names a row is showing. */
  invalidate: () => void;
}

/**
 * Who settled each permission, by request id, from the session's content-safe governance audit: the
 * runner's `permission_resolved` names no one, and a policy can settle a permission as well as a
 * person. Empty where the audit is not loaded (a shared page, a collapsed preview).
 */
export const PermissionResolutionActorsContext = createContext<ReadonlyMap<string, DecisionActor>>(new Map());

export const GovernancePolicyNamesContext = createContext<GovernancePolicyNames>({
  names: null,
  load: () => {},
  invalidate: () => {},
});

/** The name of who decided, in Title Case: "You", a member's name, a policy's name, the parent
 * session's title, "Wollipog" or the reviewer. Null when it must stay unsaid: a person the viewer
 * cannot be told about (#2527). Never an id. */
export function decisionActorName(actor: DecisionActor | undefined, names: DecisionNames): string | null {
  switch (actor?.kind) {
    case undefined: return null;
    case "member": {
      const resolver = humanResolver(names.viewer, actor.userId);
      return resolver ? resolverName(resolver, { titleCase: true }) : null;
    }
    case "policy": return (actor.policyId && names.policyName(actor.policyId)) || "Policy";
    case "parent": return names.sessionTitle(actor.sessionId) || "Parent Session";
    case "wollipog": return "Wollipog";
    case "reviewer": return actor.name;
  }
}

/** The row as one line of text: "Rejected Run npm test by You". Its summary's accessible name. */
export function decisionRecordText(record: DecisionRecordModel, names: DecisionNames): string {
  const by = decisionActorName(record.actor, names);
  return [statusMeta("requestDecision", record.outcome).label, record.title, by && `by ${by}`]
    .filter(Boolean)
    .join(" ");
}

/** Copy Audit ID's text: one "Label: id" line per id. */
export function decisionAuditText(record: DecisionRecordModel): string {
  return record.auditIds.map(([label, id]) => `${label}: ${id}`).join("\n");
}

/** Runner-initiated sign-in outcomes that were never offered as a button. */
const RUNNER_RESOLUTIONS: Record<string, DecisionOutcome> = {
  "auth:automatic-retry": "rechecked_automatically",
  "auth:select-account": "another_account_selected",
};

const ALLOW_IDS = new Set(["allow", "approve", "accept", "yes"]);
const REJECT_IDS = new Set(["deny", "reject", "decline", "no"]);

/**
 * The outcome of choosing `optionId` (#2204): its kind says it (`allow_*` → Allowed, `reject_*` →
 * Rejected, `cancel` → Ended Early). A provider option with no kind falls back to the common ids,
 * then to Resolved. Never the option id itself.
 */
export function permissionOptionOutcome(
  options: ReadonlyArray<Pick<PermissionOption, "optionId" | "kind">>,
  optionId: string | null | undefined,
): DecisionOutcome {
  if (!optionId) return "dismissed";
  const option = options.find((candidate) => candidate.optionId === optionId);
  if (!option && Object.hasOwn(RUNNER_RESOLUTIONS, optionId)) return RUNNER_RESOLUTIONS[optionId]!;
  const kind = option?.kind?.toLowerCase();
  if (kind) {
    if (kind.startsWith("allow")) return "allowed";
    if (kind.startsWith("reject")) return "rejected";
    if (kind === "cancel") return "ended_early";
    return "resolved";
  }
  const id = optionId.toLowerCase();
  if (ALLOW_IDS.has(id)) return "allowed";
  if (REJECT_IDS.has(id)) return "rejected";
  if (id === "cancel") return "ended_early";
  return "resolved";
}

/** The past-tense word for a chosen option: "Allowed", "Rejected", "Rechecked Automatically". */
export function permissionResolutionLabel(
  options: ReadonlyArray<Pick<PermissionOption, "optionId" | "kind">>,
  optionId: string | null | undefined,
): string {
  return statusMeta("requestDecision", permissionOptionOutcome(options, optionId)).label;
}

type PermissionItem = Extract<TimelineItem, { kind: "permission" }>;

/** How a resolved permission ended. A parent's decision uses the same words; the parent is its actor. */
export function permissionOutcome(item: PermissionItem): DecisionOutcome {
  if (item.resolvedByParentSessionId) return permissionOptionOutcome(item.options, item.resolvedOptionId);
  switch (item.resolutionReason) {
    case "replaced": return "replaced";
    case "provider_resolved": return "provider_resolved";
    // The runner records a chosen Cancel as a dismissal; the option still says what happened.
    case "dismissed": return permissionOptionOutcome(item.options, item.resolvedOptionId) === "ended_early" ? "ended_early" : "dismissed";
    case "expired": return "expired";
    default: return permissionOptionOutcome(item.options, item.resolvedOptionId);
  }
}

/** Outcomes nobody chose: the request ended around the person rather than by them. */
const UNATTRIBUTED: ReadonlySet<DecisionOutcome> = new Set([
  "replaced", "provider_resolved", "expired", "rechecked_automatically", "another_account_selected",
]);

/**
 * A resolved permission as a Decision Record. A parent session's decision names the parent; any
 * other is named only by its audited actor (`resolvedBy`), since a policy can settle a permission
 * too. Without one the row names nobody rather than assume a person did.
 */
export function permissionDecisionRecord(item: PermissionItem, resolvedBy?: DecisionActor): DecisionRecordModel {
  const outcome = permissionOutcome(item);
  const actor: DecisionActor | undefined = item.resolvedByParentSessionId
    ? { kind: "parent", sessionId: item.resolvedByParentSessionId }
    : UNATTRIBUTED.has(outcome) ? undefined : resolvedBy;
  const context = item.context;
  const facts: DecisionFact[] = [];
  if (context?.toolName) facts.push({ label: "Tool", value: context.toolName });
  if (context?.path) facts.push({ label: "Path", value: context.path });
  if (context?.branch) facts.push({ label: "Branch", value: context.branch });
  if (context?.input) facts.push({ label: "Command", value: context.input, code: true });
  return {
    outcome,
    title: item.title,
    ...(actor ? { actor } : {}),
    ...(item.resolvedAt !== undefined ? { at: item.resolvedAt } : {}),
    facts,
    auditIds: [
      ["Request ID", item.requestId],
      ...(item.resolvedByParentSessionId ? [["Parent Session ID", item.resolvedByParentSessionId] as const] : []),
    ],
  };
}

/** A governance decision as a Decision Record. The audit is content-safe, so there is no command. */
export function governanceDecisionRecord(decision: GovernanceDecision): DecisionRecordModel {
  const facts: DecisionFact[] = [];
  if (decision.toolName) facts.push({ label: "Tool", value: decision.toolName });
  if (decision.path) facts.push({ label: "Path", value: decision.path });
  if (decision.branch) facts.push({ label: "Branch", value: decision.branch });
  return {
    outcome: decision.outcome,
    title: decision.question ? "Question" : decision.toolName ?? "Tool Request",
    ...(decision.actor ? { actor: decision.actor } : {}),
    at: decision.timestamp,
    detail: decision.detail,
    facts,
    auditIds: [
      ["Audit ID", decision.auditId],
      ["Request ID", decision.requestId],
      ...(decision.policyId ? [["Policy ID", decision.policyId] as const] : []),
    ],
  };
}

type ReviewItem = Extract<TimelineItem, { kind: "review_decision" }>;

const REVIEW_OUTCOMES: Record<ReviewItem["outcome"], DecisionOutcome> = {
  allowed: "allowed",
  denied: "rejected",
  escalated: "escalated",
  timed_out: "timed_out",
  aborted: "ended_early",
};

/** An automated review as a Decision Record. A policy reviewer's denial is a block. */
export function reviewDecisionRecord(item: ReviewItem): DecisionRecordModel {
  const policy = item.reviewer.kind === "policy";
  const actor: DecisionActor = policy
    ? { kind: "policy", ...(item.reviewer.id ? { policyId: item.reviewer.id } : {}) }
    : { kind: "reviewer", name: item.reviewer.id ? titleCaseLabel(item.reviewer.id.replace(/[-_]+/g, " ")) : "Automated Reviewer" };
  return {
    outcome: policy && item.outcome === "denied" ? "blocked" : REVIEW_OUTCOMES[item.outcome] ?? "resolved",
    title: "Automated Review",
    actor,
    ...(item.createdAt !== undefined ? { at: item.createdAt } : {}),
    ...(item.rationale ? { detail: item.rationale } : {}),
    facts: item.riskLevel ? [{ label: "Risk", value: titleCaseLabel(item.riskLevel) }] : [],
    auditIds: [["Review ID", item.reviewId]],
  };
}
