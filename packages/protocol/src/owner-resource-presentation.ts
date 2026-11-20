import type { WorkflowDecisionCategory, WorkflowDecisionResourceSnapshot } from "./index.js";

/** One resource name for owner controls, campaign rows and durable return records. */
export function ownerResourceLabel(snapshot: WorkflowDecisionResourceSnapshot): string {
  const text = (() => {
    switch (snapshot.category) {
    case "pr_merge":
    case "review_round_extension": return `PR #${snapshot.pullRequest} in ${snapshot.repository}`;
    case "ci_rerun": return `CI run ${snapshot.runId} in ${snapshot.repository}`;
    case "release_tag":
    case "release_publish": return `Release ${snapshot.tag} in ${snapshot.repository}`;
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

/** What a request card calls the kept resource in its ownership line (#4713): "this PR", "this branch". */
export function ownerResourceNoun(category: WorkflowDecisionCategory): string {
  switch (category) {
  case "pr_merge":
  case "review_round_extension": return "PR";
  case "ci_rerun": return "CI run";
  case "release_tag":
  case "release_publish": return "release";
  case "merged_branch_deletion": return "branch";
  case "follow_up_issue_publication": return "publication";
  case "issue_closure": return "issue";
  case "owner_decision":
  case "implementation_question": return "question";
  case "campaign_repository_addition":
  case "location_switch": return "repository";
  case "campaign_issue_scope": return "issue scope";
  case "campaign_follow_up_admission": return "follow-up";
  case "ui_evidence_approval": return "evidence";
  case "automation_creation": return "automation";
  }
}

/** Only eligible owner-kept resources call this: a rule is retained on inherited requests;
 * otherwise their keep came from an Orchestrator handoff. Neither source implies owner action.
 * `noun` names the resource where the reader already sees which one it is (a request card). */
export function ownerResourceKeepReason(resource: { ownerRule?: unknown }, noun = "resource"): string {
  return resource.ownerRule ? `A rule keeps this ${noun} with you.` : `The Orchestrator handed this ${noun} to you.`;
}
