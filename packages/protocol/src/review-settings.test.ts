import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewModelSupported, sameReviewFamily } from "./review-settings.js";
import type { AgentCapabilities } from "./index.js";

test("same-family consent covers every discovered Claude alias across implementing harnesses", () => {
  for (const model of ["claude-opus-5-5", "opus", "fable", "fable[1m]", "claude-fable-5-1", "sonnet", "haiku"]) {
    assert.equal(sameReviewFamily("pi", model, "claude-code", null), true, model);
    assert.equal(sameReviewFamily("acp", model, "codex", "gpt-6.1-sol"), false, model);
  }
  assert.equal(sameReviewFamily("pi", "gpt-6.1-sol", "codex", null), true);
  assert.equal(sameReviewFamily("codex-app-server", null, "claude-code", null), false);
  for (const model of ["anthropic/claude-opus-5-5", "openrouter/anthropic/claude-fable-5-1", "anthropic/fable",
    "amazon-bedrock/us.anthropic.claude-opus-5-5"]) {
    assert.equal(sameReviewFamily("pi", model, "claude-code", null), true, model);
  }
  assert.equal(sameReviewFamily("pi", "openai/gpt-6.1-sol", "codex", null), true);
});

test("configured model/effort pairs must name a visible concrete discovered model", () => {
  const caps: AgentCapabilities = { models: [{ id: "default", default: true }, { id: "opus", efforts: ["high"] },
    { id: "hidden", hidden: true, efforts: ["high"] }], effortLevels: ["medium", "high"], slashCommands: [], supportsImages: false, supportsApprovals: true };
  assert.equal(reviewModelSupported(caps, "default", "high"), false);
  assert.equal(reviewModelSupported(caps, "hidden", "high"), false);
  assert.equal(reviewModelSupported(caps, "unknown", "high"), false);
  assert.equal(reviewModelSupported(caps, "opus", "medium"), false);
  assert.equal(reviewModelSupported(caps, "opus", "high"), true);
  assert.equal(reviewModelSupported(caps, undefined, "high"), true);
  assert.equal(reviewModelSupported({ ...caps, models: [{ id: "default", default: true }] }, undefined, "high"), false);
});
