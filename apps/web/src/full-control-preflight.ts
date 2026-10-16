import type { AgentDriverKind, CampaignControl, OrchestratorDefaults, SessionView } from "@wollipog/protocol";
import { agentHarnessIdentityLabel, agentHarnessDriverLabel } from "./agent-presentation.js";
import { titleCaseLabel } from "./format.js";
import { DELEGATED_UI_EVIDENCE_RETENTION_DISCLOSURE } from "./ui-evidence-disclosure.js";

export const FULL_CONTROL_PREPARATION_REASON = "Full Control activation is unavailable until an atomic authenticated human launch binds scope, campaign allowances, execution enforcement, native review, and evidence delivery together.";

/** A display adapter, never a launch proposal or an authorization contract. Keep the original
 * server-owned control intact: final integration must compose its authority subobjects rather
 * than reconstructing a boundary from these human-readable facts. */
export interface FullControlPreparation {
  surface: "defaults" | "launch" | "campaign";
  defaults: OrchestratorDefaults;
  session?: SessionView;
  root?: { driver?: AgentDriverKind; model?: string | null; effort?: string | null; permissionMode?: string | null };
  workspace?: string | null;
  objective?: string;
  /** Display-only subset of #2936's projection. Final integration supplies the original server
   * projection; this adapter neither serializes an allowance nor accepts native grants. */
  budget?: {
    authority: { costUsd?: number; toolCalls?: number; concurrency?: number; acceptedFollowUps?: number };
    sessionLimits?: { costBudgetUsd: number | null; maxToolCalls: number | null };
    rootAllocation?: { costUsd?: number; toolCalls?: number };
    actual: { costUsd: number; toolCalls: number };
    outstanding: { costUsd: number; toolCalls: number };
    requiredNativeReview?: { supported: boolean; reason: string };
  };
}

export interface PreflightFact { label: string; value: string }
export interface FullControlPreflight {
  control: CampaignControl | undefined;
  effectiveMode: "custom" | "full_control" | "unknown";
  supported: false;
  facts: PreflightFact[];
  blockers: string[];
}

const unresolved = "Not verified";
const limit = (value: number | null | undefined) => value == null ? "No configured ceiling" : String(value);

export function fullControlPreflight(input: FullControlPreparation): FullControlPreflight {
  const { defaults, session } = input;
  const projected = session?.orchestratorCampaign;
  const authoritative = projected?.control !== undefined && Number.isSafeInteger(projected.policyRevision);
  const control = authoritative ? projected.control : session?.orchestratorPolicy?.control;
  const boundary = control?.mode === "full_control" ? control.boundary : undefined;
  const scope = session?.orchestratorPolicy?.issueScope;
  const root = input.root ?? session;
  const behavior = defaults.behavior;
  const evidence = session?.orchestratorCampaign?.uiEvidenceReview;
  const budget = input.budget ?? session?.orchestratorCampaign?.budget;
  const issueAuthority = boundary?.issueAuthority;
  const stale = boundary !== undefined && (!scope || scope.repository.toLowerCase() !== boundary.repository.toLowerCase() ||
    scope.revision !== boundary.issueScopeRevision || scope.authorizedByUserId !== boundary.authorizedByUserId ||
    scope.authorizedAt > boundary.authorizedAt ||
    (authoritative ? projected.policyRevision : session?.parentSessionId ? undefined : session?.parentControlPolicy?.revision) !== boundary.revision);
  return {
    control,
    effectiveMode: authoritative ? control!.mode : session?.parentSessionId ? "unknown" : control?.mode ?? "custom",
    // No fixture, five-owner preset, protocol version or prepared branch proves readiness.
    supported: false,
    facts: [
      { label: "Repository", value: scope?.repository ?? "Not established for this campaign" },
      { label: "Workspace", value: input.workspace ?? session?.workspaceName ?? "Not selected" },
      { label: "Objective", value: boundary?.objective ?? (input.objective?.trim() || "Requires an exact human-established objective before authorization") },
      { label: "Issue Scope", value: scope ? `${scope.issueNumbers.map((n) => `#${n}`).join(", ") || "No issues"} · Revision ${scope.revision}` : "Requires a repository-qualified issue boundary" },
      { label: "Related Follow-Ups", value: `${titleCaseLabel(behavior.followUps.replaceAll("_", " "))}; ${issueAuthority && typeof issueAuthority.relatedFollowUps === "boolean"
        ? `${issueAuthority.relatedFollowUps ? "related follow-ups permitted" : "related follow-ups excluded"}; at most ${issueAuthority.maxIssues} issues; closure reasons: ${issueAuthority.closureReasons.join(", ") || "none"}`
        : `publication and issue expansion bounds are ${unresolved.toLowerCase()}`}` },
      { label: "Permitted Effects", value: boundary ? boundary.operations.map((v) => titleCaseLabel(v.replaceAll("_", " "))).join(", ") || "None" : "No Full Control effects authorized" },
      { label: "Policy Exceptions", value: boundary?.delegatablePolicyIds.join(", ") || "No named policy asks authorized" },
      { label: "Aggregate Allowance", value: budget ? `Immutable envelope: cost ${limit(budget.authority.costUsd)}; tool calls ${limit(budget.authority.toolCalls)}; concurrency ${limit(budget.authority.concurrency)}; accepted follow-ups ${limit(budget.authority.acceptedFollowUps)}` : "Not verified; a human must establish the immutable campaign envelope" },
      { label: "Session Ceilings", value: budget?.sessionLimits ? `Original cost: ${limit(budget.sessionLimits.costBudgetUsd)}; original tool calls: ${limit(budget.sessionLimits.maxToolCalls)}. Tighter Session ceilings remain enforced.` : budget ? "Original Session ceilings not reported; generated root thresholds cannot replace them" : session ? `Cost: ${limit(session.costBudgetUsd)}; tool calls: ${limit(session.maxToolCalls)}. Tighter Session ceilings remain enforced.` : "Session cost and tool ceilings remain separate from the campaign allowance" },
      { label: "Root Allocation", value: budget?.rootAllocation ? `Generated thresholds: cost ${limit(budget.rootAllocation.costUsd)}; tool calls ${limit(budget.rootAllocation.toolCalls)}` : "Not reported; allocation is separate from the original Session ceilings" },
      { label: "Spend and Reservations", value: budget ? `Spent: ${budget.actual.costUsd} USD, ${budget.actual.toolCalls} tool calls; reserved: ${budget.outstanding.costUsd} USD, ${budget.outstanding.toolCalls} tool calls` : "Managed spending and reservations not verified; external worker accounting is unsupported" },
      { label: "Maximum Concurrent Children", value: String(behavior.maximumConcurrentChildren) },
      { label: "Root Harness", value: root?.driver ? agentHarnessDriverLabel(root.driver) : "Not selected" },
      { label: "Root Model and Effort", value: `${root?.model ?? "Not selected"} · ${root?.effort ? titleCaseLabel(root.effort) : "Not selected"}` },
      { label: "Child Harness", value: behavior.childHarness ? agentHarnessIdentityLabel(behavior.childHarness) : "Automatic; actual dispatch pair requires verification" },
      { label: "Child Model and Effort", value: `${behavior.childModel ?? "Automatic"} · ${behavior.childEffort ? titleCaseLabel(behavior.childEffort) : "Automatic"}` },
      { label: "Provider Permissions", value: root?.permissionMode ? titleCaseLabel(root.permissionMode) : "Provider default; actual permissions require verification" },
      { label: "Permission Lifetime", value: root?.driver === "codex-app-server" ? "Codex permission-profile approval grants the requested permissions for the session. Command and file approvals may instead be one-time. Session grants require a human." : "Provider-declared lifetime must be verified; persistent grants require a human" },
      { label: "Strict Project Isolation", value: defaults.execution?.strictProjectIsolation === undefined ? "Not reported by this campaign" : defaults.execution.strictProjectIsolation ? "Enabled" : "Disabled" },
      { label: "Integration Isolation", value: defaults.execution?.integrationIsolation === undefined ? "Not reported by this campaign" : defaults.execution.integrationIsolation ? "Enabled" : "Disabled" },
      { label: "Completion", value: `${titleCaseLabel(behavior.completion.replaceAll("_", " "))}; actual informational completion still requires complete-flow verification` },
      { label: "Artifact Destination", value: "Wollipog Session artifacts use private control-plane storage visible to authorized users. Unmanaged external evidence retains human review. The launch destination, authorization, and retention are not yet bound." },
      { label: "UI Evidence Approval", value: evidence ? `${titleCaseLabel(evidence.status)} · ${titleCaseLabel(evidence.effectiveOwner)}${evidence.reason ? `: ${evidence.reason}` : ""}. Each exact item still needs review.` : "Not verified; every exact evidence item uses the existing UI Evidence Approval gate" },
      { label: "Evidence Provider and Model", value: `${root?.driver ? agentHarnessDriverLabel(root.driver) : "Provider not selected"} · ${root?.model ?? "Model resolved at launch; not verified"}. Actual media delivery and quality are not verified. ${DELEGATED_UI_EVIDENCE_RETENTION_DISCLOSURE}` },
      { label: "Native Reviewer Profile", value: budget?.requiredNativeReview ? `${budget.requiredNativeReview.supported ? "Reported Supported" : "Unsupported"}: ${budget.requiredNativeReview.reason}. Exact approved admission and live proof remain required.` : "No approved native reviewer profile verified for this campaign allowance" },
      { label: "Policy Revision", value: authoritative ? String(projected.policyRevision) : session?.parentSessionId
        ? "Current root revision not reported" : session?.parentControlPolicy ? String(session.parentControlPolicy.revision) : "Established at authenticated launch" },
      { label: "Authority Boundary", value: boundary ? `Revision ${boundary.revision} · ${stale ? "Stale; incompatible unused approvals cannot authorize actions" : "Current stored authority; complete launch readiness remains unverified"}` : "No Full Control authority established" },
    ],
    blockers: [
      FULL_CONTROL_PREPARATION_REASON,
      ...(stale ? ["The stored boundary does not match current repository, human scope provenance, or policy revision. Refresh and obtain current human authorization."] : []),
      issueAuthority ? "Bounded issue authority is stored; each publication, scope change, and closure must still pass its exact current admission checks."
        : "Issue expansion and closure retain their human gate until bounded issue authority is supported.",
      "Complete execution-profile enforcement of built-in tools, resource use, filesystem and API effects is not verified; selected permissions and isolation remain enforced separately.",
      "A model or image capability declaration does not prove actual media delivery or quality. Unsupported or externally stored evidence retains human review.",
      "Secrets, sign-in, persistent permissions, governance, allowance changes, and tool guardrails require a human. Other mandatory provider restrictions remain in force.",
    ],
  };
}
