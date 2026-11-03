/** Conservative screening is supplementary to the exact sanitized-payload review. Unknown
 * public content must go through human review, rather than being silently rewritten. */
export function campaignPublicationSafe(title: string, body: string, labels: string[]): boolean {
  const text = [title, body, ...labels].join("\n");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text) ||
      /(?:\b(?:sk-[a-z0-9]{12,}|gh[pousr]_[a-z0-9]{12,})\b|\bBearer\s+\S+|(?:password|api[_ -]?key|secret|access[_ -]?token)\s*[:=]\s*(?!<)[^\s]+|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:\/home\/|\/Users\/|[A-Z]:\\Users\\)|https?:\/\/(?:localhost|127\.|10\.|192\.168\.|[^\s/]+\.internal\b))/iu.test(text)) return false;
  const headings = [...body.matchAll(/^## (.+)$/gmu)].map((m) => m[1]);
  const feature = ["Problem", "Proposed Behavior", "Acceptance Criteria", "Security and Compatibility"];
  const bug = ["Problem", "Reproduction Steps", "Actual Behavior", "Expected Behavior", "Environment", "Acceptance Criteria"];
  return [feature, bug].some((required) => required.every((heading, i) => headings.indexOf(heading) >= 0 &&
    (i === 0 || headings.indexOf(heading) > headings.indexOf(required[i - 1]!)))) && /^\s*-\s+(?:\[[ xX]\]\s+)?\S/mu.test(body);
}

const collapsedTitle = (title: string) => title.normalize("NFKC").trim().replace(/\s+/gu, " ");

/** The subject a title names. One leading issue-form type tag, such as GitHub's prefilled
 * "[Bug]: ", classifies the issue rather than naming it, so drafts and recommendations that differ
 * only by that tag compare equal (#2940). Duplicate inspection searches and compares by it. */
export function campaignPublicationSubject(title: string): string {
  return collapsedTitle(title).replace(/^\[[^[\]]{1,32}\]:? (?=\S)/u, "");
}

export function campaignPublicationTitle(title: string): string {
  return campaignPublicationSubject(title).toLowerCase();
}

/** Why the server did not admit a follow-up publication. Recorded on the human-owned decision's
 * authority evaluation and the admission log, or returned as the refusal of a correctable request
 * (#4065); it grants nothing. `recommendation_missing`: the request named no recommendation.
 * `authority_unavailable`: no bounded admission held on the current campaign authority. */
export type CampaignPublicationAdmissionFailure =
  | "no_issue_boundary" | "requester_outside_campaign" | "unsafe_payload" | "recommendation_not_found"
  | "recommendation_not_accepted" | "recommendation_spent" | "title_mismatch" | "origin_outside_scope"
  | "capacity_exhausted" | "inspection_failed" | "evidence_changed" | "recommendation_missing" | "authority_unavailable";

/** Failures the requester can correct in one step (#4065). Under Full Control such a request is
 * refused with its fixed sentence: no decision is created, nobody is asked, and nothing is granted. */
export const CAMPAIGN_PUBLICATION_CORRECTABLE_FAILURES: ReadonlySet<CampaignPublicationAdmissionFailure> =
  new Set(["title_mismatch", "recommendation_not_found", "recommendation_not_accepted", "recommendation_spent"]);

/** One fixed sentence per failure: what failed and the route that resolves it. Correctable ones are
 * the refusal returned to the requester; the rest are recorded beside the code on the person's
 * decision. None carries request or issue content. */
export const CAMPAIGN_PUBLICATION_ADMISSION_MESSAGES: Readonly<Record<CampaignPublicationAdmissionFailure, string>> = {
  title_mismatch: "title_mismatch: the title's subject differs from the accepted recommendation's title. Use that title exactly " +
    "(one leading issue-form tag such as \"[Bug]: \" may differ) and request the publication again. Nothing was created.",
  recommendation_not_found: "recommendation_not_found: no recommendation in this campaign has this recommendationId in this repository. " +
    "Name the accepted recommendation's recommendationId and request the publication again. Nothing was created.",
  recommendation_not_accepted: "recommendation_not_accepted: the named recommendation is not accepted, or is a duplicate. Ask the " +
    "Orchestrator to accept it, or name the accepted recommendation, then request the publication again. Nothing was created.",
  recommendation_spent: "recommendation_spent: the named recommendation was already published or is no longer awaiting publication. " +
    "Do not publish it again; name a different accepted recommendation if another issue is needed. Nothing was created.",
  recommendation_missing: "recommendation_missing: this publication names no accepted recommendation, so a person reviews it. Naming the " +
    "accepted recommendation's recommendationId would let the Orchestrator review it instead.",
  capacity_exhausted: "capacity_exhausted: publishing this follow-up would exceed this campaign's Maximum Issues, the issue limit its Full " +
    "Control authorization set, so a person reviews it. Only the person who authorized Full Control can raise it: in Campaign Status, " +
    "raise the Follow-Up Limit, which raises Maximum Issues by as much, or choose No Limit. An Orchestrator can't raise it.",
  unsafe_payload: "unsafe_payload: the payload failed the server's public-content screening or repeats a label, so a person reviews it.",
  origin_outside_scope: "origin_outside_scope: the recommendation's origin work is not in this campaign's issue scope, so a person reviews it.",
  no_issue_boundary: "no_issue_boundary: this campaign's authority does not cover related follow-up publication, so a person reviews it.",
  requester_outside_campaign: "requester_outside_campaign: the requester's gates are not controlled by this campaign's root, so a person reviews it.",
  inspection_failed: "inspection_failed: the root's runner could not complete the duplicate and content inspection, so a person reviews it.",
  evidence_changed: "evidence_changed: the campaign's recommendation or scope changed during inspection, so a person reviews it.",
  authority_unavailable: "authority_unavailable: the current campaign authority could not own this publication, so a person reviews it.",
};
