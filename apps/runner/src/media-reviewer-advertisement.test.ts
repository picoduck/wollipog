import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDefinition, ClaudeMediaReviewerAttestation } from "@wollipog/protocol";
import { MediaReviewerAdvertisement } from "./media-reviewer-advertisement.js";

const agent = (id: string, driver = "claude-code"): AgentDefinition => ({ id, name: id, command: "claude", driver } as AgentDefinition);
const attestation = (agentId: string, namespacePolicySha256 = "a".repeat(64)) =>
  ({ agentId, namespacePolicySha256 } as unknown as ClaudeMediaReviewerAttestation);

test("an agent discovered after registration is proven and republished without a reconnect", async () => {
  let agents: AgentDefinition[] = [], published = 0, proven = new Set<string>();
  const ad = new MediaReviewerAdvertisement({ agents: () => agents, canPublish: () => true, publish: () => { published++; },
    inspect: async (id) => proven.has(id) ? { attestation: attestation(id) } : { refused: "dedicated media reviewer key is not provisioned" } });
  await ad.refresh(); // registration: discovery has not found Claude yet
  assert.equal(published, 0);
  agents = [agent("claude"), agent("codex", "codex-app-server")];
  await ad.refresh(); // discovery found Claude, but its key is not provisioned yet
  assert.equal(published, 0);
  proven = new Set(["claude", "codex"]);
  await ad.refresh(); // a later discovery pass after the operator provisioned the key
  assert.equal(published, 1);
  assert.ok(ad.attestation("claude"));
  assert.equal(ad.attestation("codex"), undefined, "only native Claude Code agents are inspected");
  await ad.refresh();
  assert.equal(published, 1, "an unchanged attestation is not republished");
  proven.clear();
  await ad.refresh();
  assert.equal(published, 2, "a lost proof withdraws the advertisement");
  assert.equal(ad.attestation("claude"), undefined);
  proven.add("claude"); await ad.refresh(); agents = [];
  await ad.refresh();
  assert.equal(ad.attestation("claude"), undefined, "a removed agent loses its attestation");
});

test("refreshes are serialized and a request during a run gets one more run over the current agents", async () => {
  let agents = [agent("claude")], inspections = 0, release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ad = new MediaReviewerAdvertisement({ agents: () => agents, canPublish: () => false, publish: () => {},
    inspect: async (id) => { inspections++; if (inspections === 1) await gate; return { attestation: attestation(id) }; } });
  const first = ad.refresh();
  agents = [agent("claude"), agent("claude-2")];
  const second = ad.refresh(), third = ad.refresh();
  release();
  await Promise.all([first, second, third]);
  assert.equal(inspections, 3, "one run over [claude], then exactly one rerun over both agents");
  assert.ok(ad.attestation("claude-2"));
});
