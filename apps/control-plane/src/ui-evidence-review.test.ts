import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROTOCOL_VERSION,
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  type AgentCapabilities,
  type ClaudeCodeCapabilities,
} from "@wollipog/protocol";
import { capabilitiesFor } from "../../runner/src/catalog.js";
import {
  CLAUDE_IMAGE_TOOL_RESULT_MIN_VERSION,
  claudeCapabilitiesFromProbe,
} from "../../runner/src/discovery/claude-code.js";
import { applyAgentModelDiscovery } from "../../runner/src/discovery/discover.js";
import { parseClaudeModels } from "../../runner/src/discovery/models.js";
import { evaluateUiEvidenceReviewClient, type UiEvidenceReviewClient } from "./ui-evidence-review.js";

/** What a runner publishes for a discovered Claude Code installation, built by the runner's own
 * discovery path: the live control-protocol catalog lists no input modalities for any model. */
function publishedClaudeCode(installedVersion: string, streamJsonImages = true): AgentCapabilities {
  const claudeCode: ClaudeCodeCapabilities = {
    status: "ready",
    installedVersion,
    verification: "version-help-auth-status",
    effortLevels: ["low", "medium", "high"],
    permissionModes: ["acceptEdits", "auto", "plan"],
    streamJsonInput: true,
    streamJsonImages,
    controlProtocol: true,
    forkSession: true,
    replayUserMessages: true,
    auth: { status: "authenticated", billingSource: "subscription" },
  };
  const agent = applyAgentModelDiscovery({
    id: "claude-code", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code",
    context: { kind: "native" }, source: "discovered", claudeCode,
    capabilities: claudeCapabilitiesFromProbe(capabilitiesFor("claude-code")!, claudeCode),
  }, {
    source: "live",
    models: parseClaudeModels({ models: [
      { value: "default", displayName: "Default (recommended)", resolvedModel: "claude-opus-5-5" },
      { value: "opus[1m]", displayName: "Opus (1M context)", resolvedModel: "claude-opus-5-5[1m]" },
      { value: "haiku", displayName: "Haiku", resolvedModel: "claude-haiku-4-5-20251001" },
    ] }),
  });
  return agent.capabilities!;
}

function client(overrides: Partial<UiEvidenceReviewClient> = {}): UiEvidenceReviewClient {
  return {
    savedOwner: "orchestrator",
    runnerProtocolVersion: PROTOCOL_VERSION,
    driver: "claude-code",
    capabilities: publishedClaudeCode(CLAUDE_IMAGE_TOOL_RESULT_MIN_VERSION),
    modelId: null,
    ...overrides,
  };
}

function fallbackCode(overrides: Partial<UiEvidenceReviewClient>) {
  const result = evaluateUiEvidenceReviewClient(client(overrides));
  assert.equal(result.effectiveOwner, "human");
  return result.effectiveOwner === "human" ? result.fallback : undefined;
}

test("a Claude Code Orchestrator is admitted on what its runner publishes, though no Claude model lists modalities (#1492)", () => {
  const capabilities = publishedClaudeCode(CLAUDE_IMAGE_TOOL_RESULT_MIN_VERSION);
  assert.equal(capabilities.imageToolResults, true);
  assert.ok(capabilities.models.length > 0 && capabilities.models.every((model) => model.inputModalities === undefined),
    "the premise of #1492: Claude Code's catalog never advertises input modalities");
  for (const modelId of [null, "default", "opus[1m]", "haiku"]) {
    assert.deepEqual(evaluateUiEvidenceReviewClient(client({ modelId })), { effectiveOwner: "orchestrator" }, String(modelId));
  }
  assert.deepEqual(
    evaluateUiEvidenceReviewClient(client({ capabilities: publishedClaudeCode(CLAUDE_IMAGE_TOOL_RESULT_MIN_VERSION, false) })),
    { effectiveOwner: "orchestrator" },
    "prompt-image transport does not decide it: an installation without it still shows a tool's image",
  );
});

test("prompt-image support alone no longer admits an Orchestrator", () => {
  // The pre-#1492 admission shape: prompt images plus a model that lists image input, but no
  // attestation that a tool's image reaches the model.
  const promptOnly: AgentCapabilities = {
    models: [{ id: "vision", default: true, inputModalities: ["text", "image"] }],
    effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: true,
  };
  for (const capabilities of [promptOnly, { ...promptOnly, imageToolResults: false }, undefined]) {
    const fallback = fallbackCode({ driver: "codex-app-server", capabilities });
    assert.equal(fallback?.code, "harness_unsupported");
    assert.match(fallback?.reason ?? "", /does not attest that images returned by its tools reach the model/);
  }
  const older = fallbackCode({ capabilities: publishedClaudeCode("2.1.276") });
  assert.equal(older?.code, "harness_unsupported", "an unverified Claude Code release is not admitted");
});

test("a harness outside the audited set is refused even when its runner attests image tool results", () => {
  const attested = { ...publishedClaudeCode(CLAUDE_IMAGE_TOOL_RESULT_MIN_VERSION), imageToolResults: true };
  for (const driver of ["codex", "acp", "pi", "some-future-harness", null, undefined]) {
    const fallback = fallbackCode({ driver, capabilities: attested });
    assert.equal(fallback?.code, "harness_unsupported", String(driver));
    assert.equal(fallback?.reason,
      `The ${driver ?? "unknown"} harness has no audited way to show evidence images to the Orchestrator.`);
  }
});

test("a model that cannot take images, or that the catalog does not know, falls back with its own reason", () => {
  const codexAppServer: AgentCapabilities = {
    models: [
      { id: "image-model", default: true, inputModalities: ["text", "image"] },
      { id: "text-model", inputModalities: ["text"] },
    ],
    effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: true, imageToolResults: true,
  };
  for (const modelId of [null, "image-model"]) {
    assert.deepEqual(evaluateUiEvidenceReviewClient(client({ driver: "codex-app-server", capabilities: codexAppServer, modelId })),
      { effectiveOwner: "orchestrator" });
  }
  const textOnly = fallbackCode({ driver: "codex-app-server", capabilities: codexAppServer, modelId: "text-model" });
  assert.deepEqual(textOnly, { code: "model_unsupported", reason: "The Orchestrator model \"text-model\" does not accept image input." });

  // A selected model missing from the catalog must not inherit the installation's attestation.
  const uncatalogued = fallbackCode({ modelId: "claude-custom-gateway-model" });
  assert.equal(uncatalogued?.code, "model_unsupported");
  assert.match(uncatalogued?.reason ?? "", /"claude-custom-gateway-model" is not in its installation's model catalog/);
  const noDefault = fallbackCode({ capabilities: { ...codexAppServer, models: [{ id: "text-model", inputModalities: ["text"] }] } });
  assert.equal(noDefault?.code, "model_unsupported");
  assert.match(noDefault?.reason ?? "", /"default" is not in its installation's model catalog/);
});

test("a runner that predates the attestation keeps the gate human-owned with an upgrade reason", () => {
  const required = RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorImageToolResults;
  assert.ok(required > RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorUiEvidenceReview);
  for (const runnerProtocolVersion of [required - 1, RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorUiEvidenceReview, undefined]) {
    const fallback = fallbackCode({ runnerProtocolVersion });
    assert.equal(fallback?.code, "runner_unsupported");
    assert.match(fallback?.reason ?? "", new RegExp(`requires protocol v${required}\\b`));
  }
  assert.deepEqual(evaluateUiEvidenceReviewClient(client({ runnerProtocolVersion: required })), { effectiveOwner: "orchestrator" });
});

test("a human-owned gate by choice is not a fallback", () => {
  assert.deepEqual(evaluateUiEvidenceReviewClient(client({ savedOwner: "human" })), { effectiveOwner: "human" });
  assert.deepEqual(evaluateUiEvidenceReviewClient(client({ savedOwner: "human", driver: "acp", capabilities: undefined })),
    { effectiveOwner: "human" });
});
