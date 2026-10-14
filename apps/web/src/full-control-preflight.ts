import type { AgentDriverKind, CampaignControl, OrchestratorDefaults, SessionView } from "@wollipog/protocol";
import { agentHarnessIdentityLabel, agentHarnessDriverLabel } from "./agent-presentation.js";
import { titleCaseLabel } from "./format.js";

export const FULL_CONTROL_PREPARATION_REASON = "Full Control activation is unavailable until repository scope, campaign allowances, native review, and evidence delivery are verified together.";

/** A display adapter, never a launch proposal or an authorization contract. Keep the original
 * server-owned control intact: final integration must compose its authority subobjects rather
 * than reconstructing a boundary from these human-readable facts. */
export interface FullControlPreparation {
  surface: "defaults" | "launch" | "campaign";
  defaults: OrchestratorDefaults;
  session?: SessionView;
  root?: { driver?: AgentDriverKind; model?: string | null; effort?: string | null; permissionMode?: string | null };
  workspace?: string | null;
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
  supported: false;
  facts: PreflightFact[];
  blockers: string[];
}

const unresolved = "Not verified";
const limit = (value: number | null | undefined) => value == null ? "No configured ceiling" : String(value);

export function fullControlPreflight(input: FullControlPreparation): FullControlPreflight {
  const { defaults, session } = input;
  const control = session?.orchestratorPolicy?.control;
  const boundary = control?.mode === "full_control" ? control.boundary : undefined;
  const scope = session?.orchestratorPolicy?.issueScope;
  const root = input.root ?? session;
  const behavior = defaults.behavior;
  const evidence = session?.orchestratorCampaign?.uiEvidenceReview;
  const budget = input.budget;
  return {
    control,
    // No fixture, five-owner preset, protocol version or prepared branch proves readiness.
    supported: false,
    facts: [
      { label: "Repository", value: scope?.repository ?? "Not established for this campaign" },
      { label: "Workspace", value: input.workspace ?? session?.workspaceName ?? "Not selected" },
      { label: "Objective", value: boundary?.objective ?? "Requires an exact human-established objective before authorization" },
      { label: "Issue Scope", value: scope ? `${scope.issueNumbers.map((n) => `#${n}`).join(", ") || "No issues"} · Revision ${scope.revision}` : "Requires a repository-qualified issue boundary" },
      { label: "Related Follow-Ups", value: `${titleCaseLabel(behavior.followUps.replaceAll("_", " "))}; publication and issue expansion bounds are ${unresolved.toLowerCase()}` },
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
      { label: "Completion", value: `${titleCaseLabel(behavior.completion.replaceAll("_", " "))}; completion reports are informational` },
      { label: "Artifact Destination", value: "Not verified; the actual destination and retention must be disclosed before authorization" },
      { label: "UI Evidence Approval", value: evidence ? `${titleCaseLabel(evidence.status)} · ${titleCaseLabel(evidence.effectiveOwner)}${evidence.reason ? `: ${evidence.reason}` : ""}. Each exact item still needs review.` : "Not verified; every exact evidence item uses the existing UI Evidence Approval gate" },
      { label: "Evidence Provider and Model", value: "Actual delivery, media quality, provider disclosure, and review capability are not verified" },
      { label: "Native Reviewer Profile", value: budget?.requiredNativeReview ? `${budget.requiredNativeReview.supported ? "Reported Supported" : "Unsupported"}: ${budget.requiredNativeReview.reason}. Exact approved admission and live proof remain required.` : "No approved native reviewer profile verified for this campaign allowance" },
      { label: "Policy Revision", value: session?.parentControlPolicy ? String(session.parentControlPolicy.revision) : "Established at authenticated launch" },
    ],
    blockers: [
      FULL_CONTROL_PREPARATION_REASON,
      "Issue expansion and closure retain their human gate until bounded issue authority is supported.",
      "A model or image capability declaration does not prove actual media delivery or quality. Unsupported or externally stored evidence retains human review.",
      "Secrets, sign-in, persistent permissions, governance, allowance changes, and tool guardrails require a human. Other mandatory provider restrictions remain in force.",
    ],
  };
}
