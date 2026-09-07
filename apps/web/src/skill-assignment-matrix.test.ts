import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDefinition, RunnerView } from "@wollipog/protocol";
import type { RunnerSkillsResponse } from "./skills.js";
import { skillAgentMatrixCell } from "./skill-assignment-matrix.js";
const runner = { protocolVersion: 111, os: "linux" } as RunnerView;
const agent = { id: "codex", driver: "codex", name: "Codex" } as AgentDefinition;
const state = (targeted = true): RunnerSkillsResponse => ({ desired: [{ name: "review", versionDigest: "digest", targets: targeted ? [{ agentId: "codex", invocation: "manual" }] : [] }], reported: { deployed: [{ name: "review", digest: "digest", links: [{ agentId: "codex", status: "linked" }] }] } });
test("matrix separates desired invocation from linked or older reported content", () => {
  assert.deepEqual(skillAgentMatrixCell(runner, agent, "review", state()), { desired: "Manual Only", reported: "Linked", detail: undefined });
  const older = state(); older.reported!.deployed![0]!.digest = "older";
  assert.equal(skillAgentMatrixCell(runner, agent, "review", older).reported, "Version Pending");
});
test("untargeted shared links are not reported as removed", () => {
  assert.equal(skillAgentMatrixCell(runner, agent, "review", state(false)).desired, "Not Assigned");
  assert.equal(skillAgentMatrixCell(runner, agent, "review", state(false)).reported, "Linked (Not Targeted)");
  const removed = state(false); removed.reported!.deployed = [];
  assert.equal(skillAgentMatrixCell(runner, agent, "review", removed).reported, "Not Reported");
});
test("missing or failed reads remain unknown, never empty assignments", () => {
  assert.equal(skillAgentMatrixCell(runner, agent, "review").desired, "Unknown");
  assert.equal(skillAgentMatrixCell(runner, agent, "review", { ...state(), loadError: "Request failed" }).reported, "Unknown");
});
test("unavailable platforms, contexts and old runners are explicit", () => {
  assert.equal(skillAgentMatrixCell({ ...runner, os: "windows" }, agent, "review", state()).desired, "Unavailable");
  assert.equal(skillAgentMatrixCell({ ...runner, protocolVersion: 1 }, agent, "review", state()).desired, "Unavailable");
  assert.equal(skillAgentMatrixCell(runner, { ...agent, context: { kind: "wsl", distro: "Ubuntu" } }, "review", state()).desired, "Unavailable");
});
test("link errors and conflicts remain visible", () => {
  const failed = state(); failed.reported!.deployed![0]!.links[0] = { agentId: agent.id, status: "conflict", detail: "Unmanaged directory" };
  assert.deepEqual(skillAgentMatrixCell(runner, agent, "review", failed), { desired: "Manual Only", reported: "Conflict", detail: "Unmanaged directory" });
  failed.reported!.error = "Sync failed";
  assert.equal(skillAgentMatrixCell(runner, agent, "review", failed).reported, "Error");
});
