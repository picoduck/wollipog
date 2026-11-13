import type { WorkflowDecisionResourceSnapshot } from "./index.js";

/** One resource name for owner controls, campaign rows and durable return records. */
export function ownerResourceLabel(snapshot: WorkflowDecisionResourceSnapshot): string {
  const text = (() => {
    switch (snapshot.category) {
    case "pr_merge":
    case "review_round_extension": return `PR #${snapshot.pullRequest} in ${snapshot.repository}`;
    case "merged_branch_deletion": return `Branch ${snapshot.branch} in ${snapshot.repository}`;
    case "owner_decision":
    case "implementation_question": return snapshot.question;
    case "follow_up_issue_publication": return `${snapshot.sanitizedTitle} in ${snapshot.repository}`;
    case "issue_closure": return `Issue #${snapshot.issue} in ${snapshot.repository}`;
    case "campaign_repository_addition": return `Repository ${snapshot.repository}`;
    case "campaign_issue_scope": return `Issue scope in ${snapshot.repository}`;
    case "campaign_follow_up_admission": return snapshot.title;
    case "ui_evidence_approval": return `UI evidence: ${snapshot.evidence.map((item) => item.evidenceId).join(", ")}`;
    case "automation_creation": return snapshot.spec.name;
    case "location_switch": return `Repository ${snapshot.repository}`;
    }
  })().replace(/\s+/gu, " ").trim();
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** Only eligible owner-kept resources call this: a rule is retained on inherited requests;
 * otherwise their keep came from an Orchestrator handoff. Neither source implies owner action. */
export function ownerResourceKeepReason(resource: { ownerRule?: unknown }): string {
  return resource.ownerRule ? "A rule keeps this resource with you." : "The Orchestrator handed this resource to you.";
}
