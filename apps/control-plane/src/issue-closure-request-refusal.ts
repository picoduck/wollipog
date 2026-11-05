import type { SessionView } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { issueBoundary } from "./campaign-issue-authority.js";
import { scopeCompatibility, scopeParticipants } from "./campaign-issue-scope.js";

/** Why the server refused an issue-closure request before it inspected anything (#3382). A malformed
 * request, a campaign with no authorized issue scope, and an issue outside a non-empty scope are
 * different problems with different fixes, so each has its own code and sentence. */
export type IssueClosureRequestRefusalCode =
  | "issue_closure_request_invalid"
  | "campaign_issue_scope_missing"
  | "campaign_issue_outside_scope";

/** How the scope can come to name the issue, as `errorDetails.recovery`. Both available routes start
 * with a campaign owner in Campaign Status. `owner_scope_review_or_proposal`: the agent may also file a
 * proposal a person decides. `owner_scope_review_or_lineage`: the agent's proposal is admitted only
 * with the lineage the campaign's Full Control issue authority accepts. `unavailable`: no scope
 * change can be made right now, by anyone, for the reason the sentence names. */
export type IssueClosureScopeRecovery =
  | "owner_scope_review_or_proposal"
  | "owner_scope_review_or_lineage"
  | "unavailable";

export interface IssueClosureRequestRefusal {
  ok: false;
  status: number;
  error: string;
  errorDetails: Record<string, string | number>;
}

const SCOPE_LISTED = 20;

/** A non-blank string of at most `max` characters without control characters other than tab and
 * line breaks: the bound every workflow-decision text field shares. */
export function boundedDecisionString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

/** The request fields that are missing or invalid, in a fixed order; empty for a well-formed request.
 * The limits are the ones the closure route has always enforced. */
export function issueClosureRequestInvalidFields(request: unknown): string[] {
  if (!request || typeof request !== "object" || Array.isArray(request)) return ["requestId", "issue", "reason", "explanation", "evidence"];
  const r = request as Record<string, unknown>;
  const fields: string[] = [];
  if (!boundedDecisionString(r.requestId, 256)) fields.push("requestId");
  if (typeof r.issue !== "number" || !Number.isSafeInteger(r.issue) || r.issue < 1) fields.push("issue");
  if (r.reason !== "completed" && r.reason !== "not_planned") fields.push("reason");
  if (!boundedDecisionString(r.explanation, 4000)) fields.push("explanation");
  if (!Array.isArray(r.evidence) || r.evidence.length < 1 || r.evidence.length > 32 ||
      r.evidence.some((item) => !boundedDecisionString(item, 4000))) fields.push("evidence");
  if (r.comment !== undefined && !boundedDecisionString(r.comment, 65_536)) fields.push("comment");
  return fields;
}

export function issueClosureRequestInvalid(fields: string[]): IssueClosureRequestRefusal {
  return { ok: false, status: 400, errorDetails: { code: "issue_closure_request_invalid", fields: fields.join(",") },
    error: `The closure request is malformed: ${fields.join(", ")} ${fields.length === 1 ? "is" : "are"} missing or invalid. ` +
      "A closure needs requestId (up to 256 characters), issue (a positive issue number), reason (completed or not_planned), " +
      "explanation (up to 4000 characters), evidence (1 to 32 items of up to 4000 characters each), and optionally comment " +
      "(up to 65536 characters). Correct the request and retry; nothing was inspected or requested." };
}

/** Why the campaign's issue scope cannot change right now, or null when a scope change can be
 * proposed. The same checks a scope proposal runs before it does anything else. */
function scopeChangeUnavailable(db: ControlPlaneDb, root: SessionView): string | null {
  const requirement = scopeCompatibility(db, root);
  if (requirement) return requirement.error;
  if (scopeParticipants(db, root).some((member) => !db.campaignSharesRepositoryWorkspace(root, member))) {
    return "Every active Orchestrator participant must use the campaign's runner and repository workspace before its issue scope can change; " +
      "move or finish the other participants first.";
  }
  return null;
}

/** The refusal for a well-formed closure of an issue the campaign's authorized scope does not name, or
 * null when the scope names it. It reads only saved state: no runner call, no decision, no comment.
 * The sentences name who can change the scope and never suggest the agent can widen it on its own. */
export function issueClosureScopeRefusal(db: ControlPlaneDb, root: SessionView, issue: number): IssueClosureRequestRefusal | null {
  const numbers = root.orchestratorPolicy?.issueNumbers ?? [];
  if (numbers.includes(issue)) return null;
  const scope = root.orchestratorPolicy?.issueScope;
  const revision = scope?.revision ?? 0;
  const code: IssueClosureRequestRefusalCode = numbers.length ? "campaign_issue_outside_scope" : "campaign_issue_scope_missing";
  const where = scope?.repository ? ` in ${scope.repository}` : "";
  const listed = numbers.slice(0, SCOPE_LISTED).map((n) => `#${n}`).join(", ") +
    (numbers.length > SCOPE_LISTED ? `, and ${numbers.length - SCOPE_LISTED} more` : "");
  const refusal = numbers.length
    ? `Issue #${issue} is outside this campaign's authorized issue scope (revision ${revision}${where}: ${listed}), so no closure was requested.`
    : `This campaign has no authorized issue scope, so it cannot close issue #${issue} and no closure was requested.`;
  const unavailable = scopeChangeUnavailable(db, root);
  let recovery: IssueClosureScopeRecovery;
  let next: string;
  if (unavailable) {
    recovery = "unavailable";
    next = `Its issue scope cannot change right now: ${unavailable} Until it can, leave issue #${issue} open and report it for the campaign's owner.`;
  } else if (issueBoundary(root)?.operations.includes("campaign_issue_scope")) {
    recovery = "owner_scope_review_or_lineage";
    next = `A campaign owner can add issue #${issue} in Campaign Status under Issue Scope. request_campaign_issue_scope_change admits ` +
      "an addition only with the lineage this campaign's Full Control issue authority accepts, such as a verified member of an " +
      "authorized epic or an approved follow-up's published issue; without it, only a campaign owner can add the issue. " +
      "Once the issue is in scope, request the closure again; it still needs its own closure decision.";
  } else {
    recovery = "owner_scope_review_or_proposal";
    next = `A campaign owner can add issue #${issue} in Campaign Status under Issue Scope, or you can propose the addition with ` +
      "request_campaign_issue_scope_change for a person to approve. Once the issue is in scope, request the closure again; " +
      "it still needs its own closure decision.";
  }
  return { ok: false, status: 403, error: `${refusal} ${next}`, errorDetails: { code, issue, scopeRevision: revision, recovery } };
}
