import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionAnsweredBy, decisionCostText, decisionModelName, decisionTokenTotal } from "./decision-model.js";

test("token totals count cache reads and cache writes as well as uncached input and output", () => {
  const cached = { inputTokens: 210, outputTokens: 48, cacheReadInputTokens: 0, cacheCreationInputTokens: 3_208, costUsd: 0.0052 };
  assert.equal(decisionTokenTotal(cached), 3_466);
  assert.equal(decisionCostText(cached), "3,466 tokens, $0.0052");
  const campaign = { inputTokens: 420, outputTokens: 96, cacheReadInputTokens: 0, cacheCreationInputTokens: 6_416, costUsd: 0.0104 };
  assert.equal(decisionCostText(campaign), "6,932 tokens, $0.0104");
  const reads = { inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 1_000, cacheCreationInputTokens: 0, costUsd: null };
  assert.equal(decisionTokenTotal(reads), 1_012);
  assert.equal(decisionCostText(reads), "1,012 tokens, cost unknown");
});

test("a record names the models that answered, without repeats, and none when no attempt reported one", () => {
  const attempt = (n: number, model?: string) => ({ attempt: n, latencyMs: 1, ...(model ? { model } : {}) });
  assert.equal(decisionAnsweredBy({ attempts: [] }), "");
  assert.equal(decisionAnsweredBy({ attempts: [attempt(1)] }), "");
  assert.equal(decisionAnsweredBy({ attempts: [attempt(1), attempt(2, "claude-haiku-5-5")] }), "claude-haiku-5-5");
  assert.equal(decisionAnsweredBy({ attempts: [attempt(1, "claude-sonnet-5-5"), attempt(2, "claude-sonnet-5-5")] }), "claude-sonnet-5-5");
  assert.equal(decisionAnsweredBy({ attempts: [attempt(1, "claude-sonnet-5-5"), attempt(2, "claude-haiku-5-5")] }), "claude-sonnet-5-5, claude-haiku-5-5");
});

test("the model reads by its display name, as Settings shows it", () => {
  assert.equal(decisionModelName({ model: "haiku", modelName: "Haiku" }), "Haiku");
  assert.equal(decisionModelName({ model: "gpt-5.4-mini" }), "gpt-5.4-mini");
});
