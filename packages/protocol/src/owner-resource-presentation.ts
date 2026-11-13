import type { WorkflowDecisionResourceSnapshot } from "./index.js";

/** One resource name for owner controls, campaign rows and durable return records. */
export function ownerResourceLabel(snapshot: WorkflowDecisionResourceSnapshot, fallback: string): string {
  switch (snapshot.category) {
    case "pr_merge": return `PR #${snapshot.pullRequest} in ${snapshot.repository}`;
    case "merged_branch_deletion": return `Branch ${snapshot.branch} in ${snapshot.repository}`;
    case "implementation_question": return snapshot.question;
    case "follow_up_issue_publication": return `${snapshot.sanitizedTitle} in ${snapshot.repository}`;
    default: return fallback;
  }
}

/** Only eligible owner-kept resources call this: a rule is retained on inherited requests;
 * otherwise their keep came from an Orchestrator handoff. Neither source implies owner action. */
export function ownerResourceKeepReason(resource: { ownerRule?: unknown }): string {
  return resource.ownerRule ? "A rule keeps this resource with you." : "The Orchestrator handed this resource to you.";
}
