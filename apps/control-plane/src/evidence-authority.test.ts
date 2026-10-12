import assert from "node:assert/strict";
import { test } from "node:test";
import { validCampaignControl, type CampaignAuthorityBoundary } from "@wollipog/protocol";
import { mintCampaignEvidenceAuthority, campaignEvidenceDisclosuresCurrent, type EvidenceAuthorityDisclosures, type EvidenceAuthorityProposal } from "./evidence-authority.js";
import type { AuthPrincipal } from "./identity.js";
const boundary: CampaignAuthorityBoundary = {
  version: 1, revision: 4, issueScopeRevision: 1, repository: "owner/repo", objective: "Review original issue",
  authorizedByUserId: "human", authorizedAt: 1_000, operations: ["ui_evidence_approval"], delegatablePolicyIds: [],
};
const human: AuthPrincipal = {
  kind: "human", actorId: "human", userId: "human", userName: "Synthetic Human",
  organizationId: "org", organizationName: "Synthetic Org", role: "owner", deviceId: null, localBootstrap: false,
};
const proposal: EvidenceAuthorityProposal = {
  destinationConfigurationId: "private-evidence", destinationDisclosureRevision: 2,
  providers: [{ providerId: "provider", disclosureRevision: 3,
    reviewers: [{ driver: "codex-app-server", modelId: "reviewer-model" }] }],
};
const disclosures: EvidenceAuthorityDisclosures = {
  destination: () => ({ organizationId: "org", privacy: "private", disclosureRevision: 2 }),
  provider: () => ({ disclosureRevision: 3, retentionDisclosure: "Provider-local retention is disclosed by the server.",
    reviewers: [{ driver: "codex-app-server", modelId: "reviewer-model" }] }),
};

test("current admission cannot reuse a formerly approved destination or provider disclosure", () => {
  const authority = mintCampaignEvidenceAuthority(human, boundary, "root", proposal, disclosures)!;
  assert.equal(campaignEvidenceDisclosuresCurrent(authority, disclosures), true);
  assert.equal(campaignEvidenceDisclosuresCurrent(authority, undefined), false);
  for (const changed of [
    { ...disclosures, destination: () => ({ ...disclosures.destination("")!, privacy: "public" as const }) },
    { ...disclosures, provider: () => ({ ...disclosures.provider("")!, disclosureRevision: 4 }) },
    { ...disclosures, provider: () => ({ ...disclosures.provider("")!, retentionDisclosure: "Changed retention" }) },
    { ...disclosures, provider: () => ({ ...disclosures.provider("")!, reviewers: [] }) },
    { ...disclosures, provider: () => { throw new Error("Unavailable config"); } },
  ]) assert.equal(campaignEvidenceDisclosuresCurrent(authority, changed), false);
});

test("only exact human mint can compose a narrowed envelope with the existing authority boundary", () => {
  const e = mintCampaignEvidenceAuthority(human, boundary, "root", proposal, disclosures);
  assert.ok(e);
  assert.equal(e.scope, "relevant_task_evidence_only");
  assert.equal(e.revision, boundary.revision);
  assert.equal(e.authorizedByUserId, human.userId);
  assert.equal(e.authorizedAt, boundary.authorizedAt);
  assert.ok(validCampaignControl({ mode: "full_control", boundary: { ...boundary, evidenceAuthority: e } }));
  const agent: AuthPrincipal = { kind: "agent", actorId: "root", credentialSessionId: "root", orchestrator: true,
    organizationId: "org", delegatedScope: { organizationId: "org", owner: { kind: "user", userId: "human" } } };
  assert.equal(mintCampaignEvidenceAuthority(agent, boundary, "root", proposal, disclosures), null);
  assert.equal(mintCampaignEvidenceAuthority({ ...human, userId: "other" }, boundary, "root", proposal, disclosures), null);
  for (const changed of [
    { ...boundary, revision: 5 }, { ...boundary, issueScopeRevision: 2 },
    { ...boundary, objective: "Different objective" }, { ...boundary, repository: "other/repo" },
    { ...boundary, authorizedAt: 1_001 }, { ...boundary, authorizedByUserId: "other" },
  ]) {
    assert.equal(validCampaignControl({ mode: "full_control", boundary: { ...changed, evidenceAuthority: e } }), false);
  }
  assert.equal(validCampaignControl({ mode: "custom", evidenceAuthority: e }), false);
});

test("privacy, organization, disclosure revision and offered reviewer are independently checked", () => {
  for (const destination of [
    { organizationId: "org", privacy: "public" as const, disclosureRevision: 2 },
    { organizationId: "other", privacy: "private" as const, disclosureRevision: 2 },
    { organizationId: "org", privacy: "private" as const, disclosureRevision: 1 },
    null,
  ]) {
    assert.equal(mintCampaignEvidenceAuthority(human, boundary, "root", proposal,
      { ...disclosures, destination: () => destination }), null);
  }
  assert.equal(mintCampaignEvidenceAuthority(human, boundary, "root", { ...proposal,
    providers: [{ ...proposal.providers[0]!, disclosureRevision: 2 }] }, disclosures), null);
  assert.equal(mintCampaignEvidenceAuthority(human, boundary, "root", { ...proposal,
    providers: [{ ...proposal.providers[0]!, reviewers: [{ driver: "claude-code", modelId: "other-model" }] }] }, disclosures), null);
  assert.equal(mintCampaignEvidenceAuthority(human, boundary, "root", { ...proposal,
    providers: [proposal.providers[0]!, proposal.providers[0]!] }, disclosures), null);
});

test("unknown fields, arbitrary upload destination and wildcard reviewer grants cannot validate", () => {
  const e = mintCampaignEvidenceAuthority(human, boundary, "root", proposal, disclosures)!;
  for (const invalid of [
    { ...e, scope: "all_files" }, { ...e, approved: true }, { ...e, version: 2 },
    { ...e, destination: { ...e.destination, url: "https://untrusted.example" } },
    { ...e, destination: { ...e.destination, kind: "external" } },
    { ...e, providers: [{ ...e.providers[0]!, reviewers: [{ driver: "*", modelId: "*" }] }] },
  ]) {
    assert.equal(validCampaignControl({ mode: "full_control", boundary: { ...boundary, evidenceAuthority: invalid } }), false);
  }
});
