import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE,
  type CampaignLaunchDisclosure,
  type FullControlScopeGrant,
} from "@wollipog/protocol";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import type { CampaignAuthorityView } from "../full-control-readiness.js";
import { CampaignAuthoritySummary, FullControlReadinessNote, OBJECTIVE_PREVIEW_CHARS } from "./CampaignAuthoritySummary.js";
import { CampaignScopeGrantSection } from "./CampaignScopeGrant.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement, HTMLButtonElement: domWindow.HTMLButtonElement, Node: domWindow.Node, Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent, getComputedStyle: domWindow.getComputedStyle.bind(domWindow), React, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

async function render(element: React.ReactElement) {
  const container = domWindow.document.createElement("div") as unknown as HTMLElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return { container, unmount: () => { act(() => root.unmount()); container.remove(); } };
}

/** Each fact row of the first `dl.facts` directly under the section headed `title`. */
function facts(container: HTMLElement, title: string): Record<string, string> {
  const heading = [...container.querySelectorAll("h3, h4")].find((node) => node.textContent === title);
  assert.ok(heading, `section ${title}`);
  const section = heading.closest("section")!;
  const list = [...section.children].find((node) => node.matches("dl.facts"));
  return list ? Object.fromEntries([...list.querySelectorAll(":scope > div")].map((row) =>
    [row.querySelector("dt")!.textContent!, row.querySelector("dd")!.textContent!])) : {};
}

const disclosure: CampaignLaunchDisclosure = {
  version: 1, source: "launch", recordedAt: Date.UTC(2026, 10, 5, 12, 0),
  capabilities: [
    { id: "repository_scope", capability: "Repository and Issue Scope", state: "verified", reason: "Verified.", mandatory: true },
    { id: "native_review", capability: "Controlled Cross-Model Review", state: "informational",
      reason: "This runner does not offer the controlled reviewer; the campaign uses the regular cross-model review workflow.", mandatory: false },
    { id: "video_evidence", capability: "Video Evidence Review", state: "orchestrator_decides",
      reason: "The Orchestrator can't watch video. It asks for screenshots or denies the claim as unproven.", mandatory: false },
  ],
  evidence: { statement: "The Orchestrator reviews screenshots. For video and external evidence it asks for screenshots or denies the claim as unproven.",
    destination: "private_session_artifacts",
    provider: { providerId: "claude-code", disclosureRevision: 1, retentionDisclosure: CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE,
      reviewer: { driver: "claude-code", model: "claude-opus-5-5" } } },
};

const owners = {
  implementation_question: "orchestrator", pr_merge: "orchestrator", merged_branch_deletion: "orchestrator",
  follow_up_issue_publication: "orchestrator", ui_evidence_approval: "orchestrator", review_round_extension: "orchestrator",
} as CampaignAuthorityView["decisionOwners"];

function campaign(patch: Partial<CampaignAuthorityView> = {}, objective = "Deliver owner/repo #12."): CampaignAuthorityView {
  return {
    control: { mode: "full_control", boundary: { version: 1, revision: 4, issueScopeRevision: 1, repository: "owner/repo", objective,
      authorizedByUserId: "user", authorizedAt: Date.UTC(2026, 10, 5, 11, 0),
      operations: ["implementation_question", "pr_merge", "merged_branch_deletion", "follow_up_issue_publication", "ui_evidence_approval",
        "issue_closure", "campaign_issue_scope", "question", "tool_approval", "policy_ask"],
      delegatablePolicyIds: [],
      issueAuthority: { epics: [12], relatedFollowUps: true, maxIssues: 6, closureReasons: ["completed"] },
      budgetAuthority: { version: 1, costUsd: 40, concurrency: 3, acceptedFollowUps: 2, accounting: "managed_workers_only", unpriced: "stop" } } },
    decisionOwners: { ...owners },
    uiEvidenceReview: { status: "available", effectiveOwner: "orchestrator" },
    videoEvidenceReview: { status: "unavailable", reason: "No current live proof certifies the media-only reviewer. It asks for screenshots or denies the claim as unproven." },
    fullControlHumanRequired: ["human_required_rules"],
    recovery: { unattendedReady: true, automation: { state: "available" }, automatic: 0, waitingHuman: 0, blocked: 0, records: [], truncated: false },
    launchDisclosure: disclosure,
    maxIssuesSource: "derived",
    ...patch,
  };
}

test("the Full Control section shows the boundary, Human Required rules, recorded capabilities and evidence (#2940)", async () => {
  const { container, unmount } = await render(<CampaignAuthoritySummary campaign={campaign()} />);
  try {
    assert.equal(container.querySelector("h3")!.textContent, "Full Control");
    assert.equal(container.querySelector("section > p.section-note")!.textContent,
      "The Orchestrator runs this campaign end to end, except the decisions listed under Human Required.");
    const boundary = facts(container, "Full Control");
    assert.equal(boundary.Objective, "Deliver owner/repo #12.");
    assert.equal(boundary.Operations, "Implementation Questions, PR Merge, Merged Branch Deletion, Follow-Up Issue Publication, UI Evidence Approval, Issue Closure, Issue Scope Changes, Questions, Tool Approvals, Policy Asks");
    assert.equal(boundary["Maximum Issues"], "6 Derived");
    assert.equal(boundary["Related Follow-Ups"], "Allowed");
    assert.equal(boundary["Closure Reasons"], "Completed");
    assert.equal(boundary["Authorized Limits"], "$40.00, 3 concurrent workers, 2 accepted follow-ups");
    assert.match(boundary.Authorized!, /^Revision 4/);
    assert.deepEqual(facts(container, "Human Required"), {
      "Human Required Governance Rules": "Asks from rules you marked Human Required still come to you under Full Control.",
    });
    assert.equal([...container.querySelectorAll("h4")].some((node) => node.textContent === "Limited Capabilities"), false);
    // Only the capabilities that aren't verified are listed, each with its state and reason.
    assert.deepEqual(facts(container, "Capabilities"), {
      "Controlled Cross-Model Review": `Informational ${disclosure.capabilities[1]!.reason}`,
      "Video Evidence Review": `Orchestrator Decides ${disclosure.capabilities[2]!.reason}`,
    });
    assert.match(container.textContent!, /As recorded when Full Control was launched, .*\. 1 verified; the rest are listed here\./);
    const evidence = facts(container, "Evidence");
    assert.equal(evidence.Destination, "Private Session Artifacts");
    assert.equal(evidence["Screenshot Reviewer"], "Claude Code · claude-opus-5-5");
    assert.equal(evidence["Evidence Handling"], disclosure.evidence.statement);
    assert.equal(evidence["Provider Retention"], CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE);
    assert.equal(evidence["Screenshot Review"], "Available");
    assert.equal(evidence["Video Review"], `Unavailable${campaign().videoEvidenceReview!.reason}`);
  } finally { unmount(); }
});

test("with no Human Required rule and every capability available, the section claims end to end (#2940)", async () => {
  const { container, unmount } = await render(<CampaignAuthoritySummary campaign={campaign({ fullControlHumanRequired: [] })} />);
  try {
    assert.equal(container.querySelector("section > p.section-note")!.textContent, "The Orchestrator runs this campaign end to end.");
    assert.match(container.textContent!, /None\. Nothing in this campaign comes to you\./);
  } finally { unmount(); }
});

test("an old campaign without a recorded disclosure reads Not Recorded and still shows live evidence review (#2940)", async () => {
  const old = campaign({ launchDisclosure: undefined, maxIssuesSource: undefined, videoEvidenceReview: undefined, fullControlHumanRequired: [],
    uiEvidenceReview: { status: "unavailable", effectiveOwner: "orchestrator", reasonCode: "model_unsupported",
      reason: "The Orchestrator model \"text-only\" does not accept image input. It asks for inspectable evidence or denies the claim as unproven." } });
  const { container, unmount } = await render(<CampaignAuthoritySummary campaign={old} />);
  try {
    assert.deepEqual(facts(container, "Capabilities"), {
      Recorded: "Not RecordedThis campaign was authorized before Wollipog recorded its capabilities.",
    });
    const evidence = facts(container, "Evidence");
    assert.equal(evidence.Destination, "Not Recorded");
    assert.equal(evidence["Screenshot Reviewer"], "Not Recorded");
    assert.equal(evidence["Evidence Handling"], undefined);
    assert.equal(evidence["Provider Retention"], undefined, "no retention line while the Orchestrator reviews no images");
    assert.equal(evidence["Screenshot Review"], old.uiEvidenceReview.reason);
    assert.equal(evidence["Video Review"], "Not Reported");
    assert.equal(facts(container, "Full Control")["Maximum Issues"], "6", "no source badge without a scope grant");
    // The limited screenshot review qualifies readiness, never claiming end to end.
    assert.equal(container.querySelector("section > p.section-note")!.textContent,
      "The Orchestrator runs this campaign, but some capabilities it needs are limited, so it may not finish unattended.");
    assert.deepEqual(facts(container, "Limited Capabilities"), { "Screenshot Evidence Review": old.uiEvidenceReview.reason });
  } finally { unmount(); }
});

test("a long objective is truncated behind Show All and renders as plain text (#2940)", async () => {
  const objective = `<img src=x onerror="alert(1)"> ${"Deliver the campaign issues carefully. ".repeat(20)}End.`;
  const { container, unmount } = await render(<CampaignAuthoritySummary campaign={campaign({}, objective)} />);
  try {
    assertNoDomNode(container.querySelector("img"), "the objective's markup is text, never elements");
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Show All of the Objective"]')!;
    assert.ok(toggle, "a long objective offers Show All");
    assert.equal(toggle.textContent, "Show All");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    const text = domWindow.document.getElementById(toggle.getAttribute("aria-controls")!) as unknown as HTMLElement;
    assert.ok(text, "Show All names the text it controls");
    assert.equal(text.textContent, `${objective.slice(0, OBJECTIVE_PREVIEW_CHARS).trimEnd()}…`);
    await act(async () => { toggle.click(); });
    assert.equal(text.textContent, objective);
    assert.equal(toggle.textContent, "Show Less");
    assert.equal(toggle.getAttribute("aria-label"), "Show Less of the Objective");
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
  } finally { unmount(); }
});

test("the Controls dialog's note qualifies the line and names Campaign Status, adding no section (#2940)", async () => {
  const { container, unmount } = await render(<FullControlReadinessNote campaign={campaign()} />);
  try {
    assert.equal(container.innerHTML.replace(/ class="[^"]*"/g, ""),
      "<p>The Orchestrator runs this campaign end to end, except the decisions Campaign Status lists under Human Required.</p>");
  } finally { unmount(); }
  const ready = await render(<FullControlReadinessNote campaign={campaign({ fullControlHumanRequired: [] })} />);
  try {
    assert.equal(ready.container.textContent, "The Orchestrator runs this campaign end to end.");
  } finally { ready.unmount(); }
});

test("beside the Full Control section the Scope Grant leaves out the boundary's Maximum Issues and operations (#2940)", async () => {
  const grant: FullControlScopeGrant = { version: 1, status: "granted", reason: "Named #12.", namedIssues: [12],
    ceilings: { repositories: ["owner/repo"], maxIssues: 6, maxIssuesSource: "derived", operations: ["pr_merge"], removedOperations: ["issue_closure"] } };
  const { container, unmount } = await render(<CampaignScopeGrantSection grant={grant} ceilingsShown />);
  try {
    const rows = facts(container, "Scope Grant");
    assert.equal(rows["Maximum Issues"], undefined);
    assert.equal(rows.Operations, undefined);
    assert.equal(rows["Withheld by Your Message"], "Issue Closure", "what the message withheld is the grant's own");
    assert.equal(rows.Repository, "owner/repo");
  } finally { unmount(); }
});
