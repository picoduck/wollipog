import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE,
  campaignLaunchDisclosure,
  validCampaignLaunchDisclosure,
  type CampaignLaunchCapability,
  type CampaignLaunchPreflight,
} from "./index.js";

const capabilities: CampaignLaunchCapability[] = [
  { id: "repository_scope", capability: "Repository and Issue Scope", state: "verified", reason: "Verified scope.", mandatory: true },
  { id: "native_review", capability: "Controlled Cross-Model Review", state: "informational", reason: "Regular review workflow.", mandatory: false },
  { id: "video_evidence", capability: "Video Evidence Review", state: "orchestrator_decides", reason: "Asks for screenshots.", mandatory: false },
];

function preflight(provider: boolean): Pick<CampaignLaunchPreflight, "capabilities" | "summary"> {
  return { capabilities, summary: { evidence: {
    statement: "The Orchestrator reviews screenshots.",
    destination: { kind: "private_session_artifacts", configurationId: "session_artifacts:org_secret", disclosureRevision: 1 },
    provider: provider ? { providerId: "claude-code", disclosureRevision: 1, retentionDisclosure: CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE,
      reviewer: { driver: "claude-code", model: "claude-opus-5-5" } } : null,
    envelope: false,
  } } as CampaignLaunchPreflight["summary"] };
}

test("a launch disclosure keeps every capability and the evidence handling, never the destination identifier (#2940)", () => {
  const disclosure = campaignLaunchDisclosure(preflight(true), "launch", 1_700_000_000_000);
  assert.deepEqual(disclosure, {
    version: 1, source: "launch", recordedAt: 1_700_000_000_000, capabilities,
    evidence: { statement: "The Orchestrator reviews screenshots.", destination: "private_session_artifacts",
      provider: { providerId: "claude-code", disclosureRevision: 1, retentionDisclosure: CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE,
        reviewer: { driver: "claude-code", model: "claude-opus-5-5" } } },
  });
  assert.doesNotMatch(JSON.stringify(disclosure), /org_secret/);
  assert.equal(validCampaignLaunchDisclosure(disclosure), true);
  assert.equal(validCampaignLaunchDisclosure(campaignLaunchDisclosure(preflight(false), "enable", 1)), true);
});

test("a stored launch disclosure must have exactly the recorded shape (#2940)", () => {
  const valid = campaignLaunchDisclosure(preflight(true), "launch", 5);
  const broken: Array<[string, (value: Record<string, any>) => void]> = [
    ["unknown source", (value) => { value.source = "agent"; }],
    ["extra field", (value) => { value.ready = true; }],
    ["unknown capability", (value) => { value.capabilities[0].id = "everything"; }],
    ["unknown state", (value) => { value.capabilities[0].state = "ready"; }],
    ["duplicate capability", (value) => { value.capabilities.push({ ...value.capabilities[0] }); }],
    ["empty reason", (value) => { value.capabilities[1].reason = ""; }],
    ["oversized reason", (value) => { value.capabilities[1].reason = "x".repeat(4_001); }],
    ["public destination", (value) => { value.evidence.destination = "https://example.test/bucket"; }],
    ["provider with a credential field", (value) => { value.evidence.provider.accountId = "acct"; }],
    ["no time", (value) => { value.recordedAt = 0; }],
  ];
  for (const [name, mutate] of broken) {
    const value = structuredClone(valid) as unknown as Record<string, any>;
    mutate(value);
    assert.equal(validCampaignLaunchDisclosure(value), false, name);
  }
  assert.equal(validCampaignLaunchDisclosure(null), false);
  assert.equal(validCampaignLaunchDisclosure([]), false);
});
