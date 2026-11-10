import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDefinition } from "@wollipog/protocol";
import { providerReadinessObservation } from "./provider-readiness.js";
import { ProviderHomeLeaseError } from "./provider-home-lease-worker-protocol.js";

const installed: AgentDefinition = { id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server",
  codexAppServer: { status: "supported", appServerAvailable: true } };

test("discovery distinguishes busy, restricted, unverified ownership and signed-out without parsing messages", () => {
  for (const code of ["holder_alive", "boundary_survivor", "process_survivor", "busy"] as const) {
    const report = providerReadinessObservation(installed, "unknown", new ProviderHomeLeaseError(code), 123);
    assert.deepEqual(report, { checkedAt: 123, installation: "compatible", authentication: "unknown", reason: "in_use" });
  }
  assert.equal(providerReadinessObservation(installed, "unknown", new ProviderHomeLeaseError("profile_not_granted")).reason, "restricted");
  for (const error of [new ProviderHomeLeaseError("foreign_owner"), new Error("Sign in required; account missing; busy")]) {
    assert.equal(providerReadinessObservation(installed, "unknown", error).reason, "unknown");
  }
  assert.equal(providerReadinessObservation(installed, "unauthenticated").reason, "sign_in_required");
  assert.equal(providerReadinessObservation({ ...installed, codexAppServer: undefined }, "unknown").installation, "unknown");
});

test("a missing Claude host prerequisite is not classified as an updateable installation", () => {
  const agent: AgentDefinition = { ...installed, driver: "claude-code", codexAppServer: undefined,
    claudeCode: { status: "unsupported", failure: { code: "unsupported_mode", message: "Native Claude Code requires Git for Windows Bash.", retryable: false },
      effortLevels: [], permissionModes: [], streamJsonInput: false, streamJsonImages: false, controlProtocol: false, forkSession: false,
      replayUserMessages: false, auth: { status: "unknown", billingSource: "unknown" } } };
  assert.equal(providerReadinessObservation(agent, "unknown").installation, "unknown");
});
