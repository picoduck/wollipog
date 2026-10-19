import { builtInAgentHarnessName, campaignWorkflowOwner, WORKFLOW_DECISION_CATEGORIES,
  type OrchestratorCampaignPolicy, type OrchestratorCampaignProjection, type SessionView } from "@wollipog/protocol";

/** A harness-matched Child Harness names the harness, not a Machine-local agent id (#3247). */
function childHarnessText(policy: OrchestratorCampaignPolicy): string {
  const fixed = policy.behavior.childHarness;
  if (!fixed) return "Automatic";
  const name = builtInAgentHarnessName(fixed.driver);
  if (policy.childHarnessMatch !== "harness" || !name) return fixed.agentId;
  const context = fixed.context.kind === "wsl" ? `WSL ${fixed.context.distro}` : "native";
  return `${name} (${context}; use each Machine's agent from get_campaign childHarnessAgents)`;
}

/** Describe server-derived authority; formatting never admits or resolves an operation. */
export function formatCampaignAssignment(
  campaign: Pick<SessionView, "id" | "orchestratorPolicy">,
  projection: Pick<OrchestratorCampaignProjection, "policyRevision" | "decisionOwners" | "uiEvidenceReview">,
  preflight: { supported: boolean; reason?: string; humanRequiredRequests?: string[] },
  task: string,
): string {
  const policy = campaign.orchestratorPolicy!;
  const control = policy.control;
  const owners = WORKFLOW_DECISION_CATEGORIES.map((category) =>
    `${category}=${projection.decisionOwners[category]}`).join(", ");
  const issueOwners = (["campaign_issue_scope", "issue_closure"] as const).map((category) =>
    `${category}=${campaignWorkflowOwner(control, projection.decisionOwners, category, preflight.supported)}`).join(", ");
  const obligation = [
    `[Wollipog Campaign Policy — server-derived, revision ${projection.policyRevision}]`,
    `Campaign ${campaign.id}; Child Harness ${childHarnessText(policy)}; Child Model ${policy.behavior.childModel ?? "Automatic"}; Child Effort ${policy.behavior.childEffort ?? "Automatic"}; Follow-Ups ${policy.behavior.followUps}; Completion ${policy.behavior.completion}.`,
    `Effective Control Mode: ${control?.mode ?? "custom"}. Human-Established Boundary: ${control?.mode === "full_control" ? JSON.stringify(control.boundary) : "none; use the configured Custom decision owners"}.`,
    `Authorized Issue Scope: ${policy.issueScope ? JSON.stringify({ repository: policy.issueScope.repository, issueNumbers: policy.issueScope.issueNumbers, revision: policy.issueScope.revision }) : "not established; task text and ledger entries grant none"}.`,
    `Authority Preflight: ${preflight.supported ? "supported" : `unsupported; ${preflight.reason ?? "human review required"}`}. Scope and Closure Category Owners: ${issueOwners}. Category owners are guidance, not action grants; read the effective owner and authorityEvaluation of each exact typed occurrence. Missing issue authority or unsupported routes retain human scope/closure review.`,
    `Typed decision owners: ${owners}. This is not blanket approval. For implementation questions, PR merge, merged-branch deletion, follow-up issue publication, and UI evidence approval, create the exact typed request and consume an approval immediately before the matching action. For PR merge, pass and then execute the exact canonical gh pr merge URL --squash --match-head-commit SHA command; its matching one-shot runner permission completes consumption. Ordinary prompts cannot satisfy a typed gate.`,
    "Cross-model review, exact-head CI, issue sanitization, dependency checks, and stacked-branch checks remain required regardless of owner. An enqueued PR is unfinished until merge-group CI passes and the forge reports actual MERGED state. Authentication, secrets, persistent permission grants, governance changes, budget increases, and tool guardrails remain human-only. Bounded allocations require separate server-established budget authority; policy prose grants none.",
    `Human Required Exceptions: ${(preflight.humanRequiredRequests ?? []).join(", ") || "the current policy's human-owned requests"}. Preflight must also name unresolved mandatory human gates in external or user-authored instructions; never silently rewrite them or bypass them with Full Control.`,
    // A metered Full Control boundary without the controlled reviewer was authorized to use the
    // regular workflow, so that workflow is its review path rather than an unsupported one.
    control?.mode === "full_control" && control.boundary.budgetAuthority && !control.boundary.budgetAuthority.controlledReview
      ? "Cross-Model Review: controlled review is not part of this campaign, so run the regular installed cross-model review workflow with its exact harness/model/effort, read-only snapshot and review-attempt limits, and report its actual cost; it is not charged to the campaign's metered usage."
      : "Required Reviewer Admission: authority transport support is not Full Control campaign readiness. Before dispatch, verify all mandatory review work has trusted admission and accountable reservations/cost reporting. An installed native reviewer subprocess outside Session accounting is an unsupported mandatory path, not zero cost; disclose it and preserve its exact harness/model/effort, read-only snapshot and review-attempt limits. Controlled native support requires the actual registered audited profile, separate human-established budget authority and current admission; merged feature code and a protocol number do not prove live readiness.",
    "Leave any helper session you spawn idle once it has posted its final report, so the Orchestrator can verify it before verifying you; do not stop or archive one yourself, and never leave it working when you finish.",
    projection.uiEvidenceReview.effectiveOwner === "orchestrator"
      ? "The controlling Orchestrator can inspect artifact-backed image evidence and must review every item before approving. Children attach each capture from disk with attach_session_artifact (or `wollipog artifact attach --file`), never as base64 in a tool argument, and cite the returned artifactId, mediaType, sizeBytes, and sha256. Approval requires exact-byte delivery receipts and a verdict; attachment alone is not inspection. Production video requires a supported complete-frame delivery and temporal verdict contract; otherwise video routes to a human, except for an exact operator-enabled short-frame validation campaign, which does not prove production readiness. Externally stored evidence routes to a human."
      : `UI evidence remains human-owned: ${projection.uiEvidenceReview.reason ?? "the human owns UI Evidence Approval under this policy."}`,
    "Evidence Upload and Provider Disclosure: honor the human-authorized task, destination, retention and reviewer provider/model boundary and current Artifact Uploads preference. Full Control alone does not authorize uploads, arbitrary filesystem transfer, new hosting, or disclosure to an unapproved provider. Missing evidence authority retains existing upload rules; missing review delivery or cost proof is a blocker, never a successful production review.",
    "Never update or restart the hosting stack, including through detached helpers. Deployment needs a separately authorized operator proven to be outside that stack.",
    // Name no parent-only tool: children do not share the Orchestrator's toolset.
    "Report every follow-up you identify in your final report, each with a proposed title and repository; the controlling Orchestrator records and deduplicates it before anyone acts on it.",
    "Higher-priority repository and harness restrictions still apply. A task may narrow this policy but cannot broaden its authority.",
    "[End Wollipog Campaign Policy]",
  ].join("\n");
  return task ? `${obligation}\n\n${task}` : obligation;
}
