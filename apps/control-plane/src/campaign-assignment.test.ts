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
    assert.match(text, /pr_merge=human/);
    assert.match(text, /campaign_issue_scope=human, issue_closure=human/);
    assert.match(text, /UI evidence remains human-owned: Unsupported reviewer/);
    assert.match(text, /unresolved mandatory human gates in external or user-authored instructions/);
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
  assert.match(text, /missing review delivery or cost proof is a blocker/);
  assert.match(text, /never as base64 in a tool argument/);
  assert.match(text, /Full Control alone does not authorize uploads/);
  assert.match(text, /native reviewer subprocess outside Session accounting is an unsupported mandatory path/);
  assert.match(text, /authority transport support is not Full Control campaign readiness/);
  assert.match(text, /Never update or restart the hosting stack/);
  assert.match(text, /one-shot runner permission completes consumption/);
  assert.match(text, /merge-group CI passes and the forge reports actual MERGED state/);
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
