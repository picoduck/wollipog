import assert from "node:assert/strict";
import { test } from "node:test";
import type { CampaignAuthorityOperation, OrchestratorCampaignProjection } from "@wollipog/protocol";
import { campaignActiveDescription, FULL_CONTROL_LINE, fullControlReadiness, type ReadinessCampaign } from "./full-control-readiness.js";

const ALL_OPERATIONS: CampaignAuthorityOperation[] = ["implementation_question", "pr_merge", "merged_branch_deletion",
  "follow_up_issue_publication", "ui_evidence_approval", "issue_closure", "campaign_issue_scope", "question", "tool_approval", "policy_ask"];
const orchestratorOwners = {
  implementation_question: "orchestrator", pr_merge: "orchestrator", merged_branch_deletion: "orchestrator",
  follow_up_issue_publication: "orchestrator", ui_evidence_approval: "orchestrator", review_round_extension: "orchestrator",
} as OrchestratorCampaignProjection["decisionOwners"];

/** A ready Full Control campaign as the server projects it; each test changes one fact. */
function campaign(patch: Partial<ReadinessCampaign> = {}, operations = ALL_OPERATIONS): ReadinessCampaign {
  return {
    control: { mode: "full_control", boundary: { version: 1, revision: 3, issueScopeRevision: 1, repository: "owner/repo", objective: "Deliver",
      authorizedByUserId: "user", authorizedAt: 1, operations, delegatablePolicyIds: [],
      issueAuthority: { epics: [1], relatedFollowUps: true, maxIssues: 4, closureReasons: ["completed"] } } },
    decisionOwners: { ...orchestratorOwners },
    uiEvidenceReview: { status: "available", effectiveOwner: "orchestrator" },
    fullControlHumanRequired: [],
    recovery: { unattendedReady: true, automation: { state: "available" }, automatic: 0, waitingHuman: 0, blocked: 0, records: [], truncated: false },
    ...patch,
  };
}

test("only a campaign whose live facts all hold reads as running end to end (#2940)", () => {
  const ready = fullControlReadiness(campaign());
  assert.deepEqual(ready, { state: "unattended", humanRequired: [], limited: [], line: FULL_CONTROL_LINE, elsewhereLine: FULL_CONTROL_LINE });
  assert.equal(campaignActiveDescription(campaign()), "This Full Control campaign continues automatically. Its intermediate results are informational.");
  // Video the Orchestrator can't watch is not a limit: it asks for screenshots instead.
  assert.equal(fullControlReadiness({ ...campaign(), videoEvidenceReview: { status: "unavailable", reason: "No proof." } } as ReadinessCampaign).state, "unattended");
});

test("a Human Required rule qualifies the line and is listed with its reason (#2940)", () => {
  const readiness = fullControlReadiness(campaign({ fullControlHumanRequired: ["human_required_rules"] }));
  assert.equal(readiness.state, "qualified");
  assert.equal(readiness.line, "The Orchestrator runs this campaign end to end, except the decisions listed under Human Required.");
  assert.equal(readiness.elsewhereLine, "The Orchestrator runs this campaign end to end, except the decisions Campaign Status lists under Human Required.");
  assert.deepEqual(readiness.humanRequired.map((fact) => [fact.label, fact.reason]),
    [["Human Required Governance Rules", "Asks from rules you marked Human Required still come to you under Full Control."]]);
  assert.match(campaignActiveDescription(campaign({ fullControlHumanRequired: ["human_required_rules"] })),
    /^This Full Control campaign continues automatically, except the decisions and limits Campaign Status lists under Full Control\./);
});

test("a decision the boundary leaves out, or one Wollipog can't delegate now, is Human Required (#2940)", () => {
  const narrowed = fullControlReadiness(campaign({ decisionOwners: { ...orchestratorOwners, pr_merge: "human", merged_branch_deletion: "human" } },
    ALL_OPERATIONS.filter((operation) => operation !== "pr_merge" && operation !== "issue_closure")));
  assert.deepEqual(narrowed.humanRequired.map((fact) => fact.label), ["PR Merge Approval", "Merged Branch Deletion", "Issue Closure"]);
  assert.match(narrowed.humanRequired[0]!.reason, /authorization leaves it out/);
  assert.match(narrowed.humanRequired[1]!.reason, /can't currently enforce Full Control/);
  const noIssueAuthority = campaign();
  if (noIssueAuthority.control?.mode !== "full_control") throw new Error("Full Control expected");
  delete noIssueAuthority.control.boundary.issueAuthority;
  assert.deepEqual(fullControlReadiness(noIssueAuthority).humanRequired.map((fact) => [fact.label, fact.reason]), [
    ["Issue Closure", "This campaign has no issue authority, so it comes to you."],
    ["Issue Scope Changes", "This campaign has no issue authority, so it comes to you."],
  ]);
  const extensions = fullControlReadiness(campaign({ decisionOwners: { ...orchestratorOwners, review_round_extension: "human" } }));
  assert.deepEqual(extensions.humanRequired.map((fact) => fact.label), ["Review Round Extensions"]);
});

test("a boundary that leaves out questions, tool approvals or policy asks lists them as Human Required (#2940 review)", () => {
  for (const [operation, label] of [["question", "Questions"], ["tool_approval", "Tool Approvals"], ["policy_ask", "Policy Asks"]] as const) {
    const readiness = fullControlReadiness(campaign({}, ALL_OPERATIONS.filter((item) => item !== operation)));
    assert.equal(readiness.state, "qualified", operation);
    assert.deepEqual(readiness.humanRequired.map((fact) => [fact.label, fact.reason]),
      [[label, "This campaign's Full Control authorization leaves these requests out, so they come to you."]], operation);
  }
});

test("recovery waiting for the person or blocked never reads as unattended, even with automation available (#2940 review)", () => {
  const ready = campaign().recovery!;
  const waiting = fullControlReadiness(campaign({ recovery: { ...ready, unattendedReady: false, waitingHuman: 2 } }));
  assert.equal(waiting.state, "qualified");
  assert.deepEqual(waiting.humanRequired.map((fact) => [fact.label, fact.reason]),
    [["Recovery Waiting for You", "2 recovery items need your input; Campaign Status shows each one."]]);
  const blocked = fullControlReadiness(campaign({ recovery: { ...ready, unattendedReady: false, blocked: 1 } }));
  assert.equal(blocked.state, "qualified");
  assert.deepEqual(blocked.limited.map((fact) => [fact.label, fact.reason]),
    [["Blocked Recovery", "1 recovery item is blocked; Campaign Status shows why."]]);
  assert.equal(blocked.line, "The Orchestrator runs this campaign, but some capabilities it needs are limited, so it may not finish unattended.");
});

test("limited screenshot review or recovery qualifies the line without claiming unattended readiness (#2940)", () => {
  const images = fullControlReadiness(campaign({ uiEvidenceReview: { status: "unavailable", effectiveOwner: "orchestrator",
    reasonCode: "model_unsupported", reason: "The model can't read images. It asks for inspectable evidence or denies the claim as unproven." } }));
  assert.equal(images.state, "qualified");
  assert.equal(images.line, "The Orchestrator runs this campaign, but some capabilities it needs are limited, so it may not finish unattended.");
  assert.equal(images.elsewhereLine, `${images.line} Campaign Status lists them.`);
  assert.deepEqual(images.limited.map((fact) => fact.label), ["Screenshot Evidence Review"]);
  const recovery = fullControlReadiness(campaign({ fullControlHumanRequired: ["human_required_rules"],
    recovery: { unattendedReady: false, automation: { state: "unsupported_capability", reason: "Update the runner." }, automatic: 0,
      waitingHuman: 0, blocked: 0, records: [], truncated: false } }));
  assert.deepEqual(recovery.limited.map((fact) => [fact.label, fact.reason]), [["Automatic Recovery", "Update the runner."]]);
  assert.equal(recovery.line, "The Orchestrator runs this campaign, except the decisions listed under Human Required, and some capabilities it needs are limited, so it may not finish unattended.");
  // A held lifecycle (a finished campaign) or a budget hold is state, not a missing capability.
  assert.equal(fullControlReadiness(campaign({ recovery: { ...campaign().recovery!, automation: { state: "lifecycle_held" } } })).state, "unattended");
});

test("a server that doesn't report the facts never reads as ready (#2940)", () => {
  for (const [name, value] of [
    ["no projection", undefined],
    ["Custom", { ...campaign(), control: { mode: "custom" } }],
    ["no Human Required report", { ...campaign(), fullControlHumanRequired: undefined }],
    ["no owners", { ...campaign(), decisionOwners: undefined }],
    ["no recovery", { ...campaign(), recovery: undefined }],
    ["no recovery automation", { ...campaign(), recovery: { ...campaign().recovery!, automation: undefined } }],
  ] as Array<[string, ReadinessCampaign | undefined]>) {
    const readiness = fullControlReadiness(value);
    assert.equal(readiness.state, "unknown", name);
    assert.notEqual(readiness.line, FULL_CONTROL_LINE, name);
    assert.doesNotMatch(campaignActiveDescription(value), /continues automatically\. Its/, name);
  }
});
