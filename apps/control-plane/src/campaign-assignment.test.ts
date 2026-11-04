import assert from "node:assert/strict";
import { test } from "node:test";
import { campaignAuthorityPreflight, campaignWorkflowOwner, DEFAULT_ORCHESTRATOR_DEFAULTS,
  HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, type CampaignControl } from "@wollipog/protocol";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { formatCampaignAssignment } from "./campaign-assignment.js";

function fixture(control?: CampaignControl) {
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  if (control) policy.control = control;
  return { id: "campaign", orchestratorPolicy: policy };
}
const full: CampaignControl = { mode: "full_control", boundary: { version: 1, revision: 7,
  issueScopeRevision: 2, repository: "owner/repo", objective: "Implement the authorized issue",
  authorizedByUserId: "human", authorizedAt: 10,
  operations: ["pr_merge", "campaign_issue_scope", "issue_closure"], delegatablePolicyIds: [] } };
const humanProjection = { policyRevision: 7, decisionOwners: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY },
  uiEvidenceReview: { status: "unavailable" as const, effectiveOwner: "human" as const, reason: "Unsupported reviewer" } };

test("absent/Custom mode retains configured owners and discloses external human gates", () => {
  for (const control of [undefined, { mode: "custom" } as const]) {
    const text = formatCampaignAssignment(fixture(control), humanProjection, { supported: true }, "Original task");
    assert.match(text, /Effective Control Mode: custom/);
    assert.match(text, /Human-Established Boundary: none/);
    assert.match(text, /Authorized Issue Scope: not established/);
    assert.match(text, /pr_merge=human/);
    assert.match(text, /campaign_issue_scope=human, issue_closure=human/);
    assert.match(text, /UI evidence remains human-owned: Unsupported reviewer/);
    assert.match(text, /unresolved mandatory human gates in external or user-authored instructions/);
    assert.match(text, /request_review_session or `wollipog review session run` without asking for admission/);
    assert.match(text, /\[End Wollipog Campaign Policy\]\n\nOriginal task$/);
  }
});

test("Full Control describes the exact boundary and effective owners without creating grants", () => {
  const projection = { ...humanProjection, decisionOwners: { ...humanProjection.decisionOwners, pr_merge: "orchestrator" as const },
    uiEvidenceReview: { status: "available" as const, effectiveOwner: "orchestrator" as const } };
  const preflight = campaignAuthorityPreflight(full, "codex-app-server", PROTOCOL_VERSION);
  const text = formatCampaignAssignment(fixture(full), projection, preflight, "");
  assert.match(text, /server-derived, revision 7/);
  assert.match(text, /Effective Control Mode: full_control/);
  assert.ok(text.includes(JSON.stringify(full.boundary)), "describe the human boundary without dropping optional contracts");
  assert.match(text, /pr_merge=orchestrator/);
  assert.match(text, /follow_up_issue_publication=human/);
  assert.ok(text.includes(`campaign_issue_scope=${campaignWorkflowOwner(full, projection.decisionOwners, "campaign_issue_scope", true)}`));
  assert.match(text, /human_required_rules/);
  assert.match(text, /exact-byte delivery receipts and a verdict/);
  assert.match(text, /artifactId, mediaType, sizeBytes, and sha256/);
  assert.match(text, /complete-frame delivery and temporal verdict/);
  assert.match(text, /exact operator-enabled short-frame validation campaign, which does not prove production readiness/);
  assert.match(text, /missing review delivery or cost proof is a blocker/);
  assert.match(text, /never as base64 in a tool argument/);
  assert.match(text, /Full Control alone does not authorize uploads/);
  assert.match(text, /native reviewer subprocess outside Session accounting/);
  assert.match(text, /not charged to that allowance/);
  assert.match(text, /actual raw cost, including invalid attempts/);
  assert.match(text, /review bridge and campaign review jobs are retired/);
  assert.match(text, /without a native fallback/);
  assert.match(text, /Never update or restart the hosting stack/);
  assert.match(text, /one-shot runner permission completes consumption/);
  assert.match(text, /merge-group CI passes and the forge reports actual MERGED state/);
});

test("campaigns use review sessions without asking for admission, including without the native adapter", () => {
  const budgetAuthority = { version: 1 as const, concurrency: 2, acceptedFollowUps: 0, accounting: "managed_workers_only" as const, unpriced: "stop" as const };
  const regular: CampaignControl = { mode: "full_control", boundary: { ...full.boundary, budgetAuthority } };
  const text = formatCampaignAssignment(fixture(regular), humanProjection, campaignAuthorityPreflight(regular, "claude-code", PROTOCOL_VERSION), "");
  assert.match(text, /review sessions are the controlled, accounted route/);
  assert.match(text, /request_review_session or `wollipog review session run` without asking for admission/);
  assert.match(text, /reserves allowance before launch and records actual Session usage against the campaign allowance/);
  assert.match(text, /exhausted, stopped or unavailable allowance refuses the review with a reason/);
  const review = { profile: "native_opus_5_5_high_read_only" as const, controllerSha256: "a".repeat(64), executableSha256: "b".repeat(64),
    cliVersion: "2.1.296" as const, accounting: "provider_list_estimate" as const, account: "runner_default_claude" as const, agentId: "claude" };
  const controlled: CampaignControl = { mode: "full_control", boundary: { ...full.boundary, budgetAuthority: { ...budgetAuthority, controlledReview: review } } };
  assert.match(formatCampaignAssignment(fixture(controlled), humanProjection, { supported: true }, ""), /Required Reviewer Admission/);
});

test("Custom assignments retain their independently authorized issue scope and revision", () => {
  const campaign = fixture({ mode: "custom" });
  campaign.orchestratorPolicy.issueScope = { repository: "owner/repo", issueNumbers: [123, 456],
    revision: 3, authorizedByUserId: "human", authorizedAt: 10 };
  const text = formatCampaignAssignment(campaign, humanProjection, { supported: true }, "");
  assert.match(text, /Effective Control Mode: custom/);
  assert.ok(text.includes('Authorized Issue Scope: {"repository":"owner/repo","issueNumbers":[123,456],"revision":3}'));
  assert.match(text, /campaign_issue_scope=human, issue_closure=human/);
});

test("unsupported or stale authority names human fallback rather than a consumable grant", () => {
  const preflight = campaignAuthorityPreflight(full, "codex-app-server", 214);
  const text = formatCampaignAssignment(fixture(full), humanProjection, preflight, "Task");
  assert.match(text, /Authority Preflight: unsupported/);
  assert.ok(text.includes(preflight.reason!));
  assert.match(text, /campaign_issue_scope=human, issue_closure=human/);
  assert.match(text, /Category owners are guidance, not action grants/);
  assert.match(text, /authorityEvaluation of each exact typed occurrence/);
});

test("modern assignments describe fixed review fields and legacy policies retain their prior prompt", () => {
  const campaign = fixture();
  Object.assign(campaign.orchestratorPolicy.behavior, { reviewHarness: "codex", reviewModel: "gpt-review", reviewEffort: "high", reviewRoundBudget: 2 });
  const modern = formatCampaignAssignment(campaign, humanProjection, { supported: true }, "Task");
  assert.match(modern, /Review Harness codex; Review Model gpt-review; Review Effort high; Review Round Budget 2/);
  assert.match(modern, /Children snapshot review settings at launch/);
  delete campaign.orchestratorPolicy.reviewPolicySnapshotVersion;
  assert.doesNotMatch(formatCampaignAssignment(campaign, humanProjection, { supported: true }, "Task"), /Review Round Budget/);
});
