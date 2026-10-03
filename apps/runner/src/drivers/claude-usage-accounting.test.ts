import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeUsageAccounting, claudeUsageCheckpoint, claudeRestoresUsage } from "./claude-usage-accounting.js";

const model = (inputTokens: number, outputTokens: number, costUSD: number) => ({ inputTokens, outputTokens,
  cacheReadInputTokens: 200, cacheCreationInputTokens: 20, costUSD, costBasis: "list" });
const result = (a: number, b: number) => ({ total_cost_usd: a + b,
  usage: { input_tokens: 999, output_tokens: 999 }, // main-loop counters must not also be added
  modelUsage: { "model-a": model(10, 5, a), "model-b": model(3, 2, b) } });

test("whole-tree per-model totals survive driver reconstruction without rebilling ancestors", () => {
  const first = new ClaudeUsageAccounting(true);
  const events = first.result("session", result(0.02, 0.01));
  assert.equal(events.reduce((sum, e) => sum + (e.inputTokens ?? 0), 0), 13);
  assert.equal(events.reduce((sum, e) => sum + (e.costUsd ?? 0), 0), 0.03);
  const resumed = new ClaudeUsageAccounting(true, JSON.parse(JSON.stringify(first.checkpoint)));
  resumed.beginProcess();
  const delta = resumed.result("session", result(0.03, 0.01));
  assert.equal(delta.length, 1);
  assert.equal(delta[0]!.model, "model-a");
  assert.ok(Math.abs(delta[0]!.costUsd! - 0.01) < 1e-10);
  assert.equal(delta[0]!.inputTokens, 0);
  assert.equal(delta[0]!.costIsEstimate, true);
  assert.deepEqual(resumed.result("session", result(0.03, 0.01)), []);
});

test("old CLI process totals reset while a crash never resets a valid conversation baseline", () => {
  assert.equal(claudeRestoresUsage("2.1.276"), false);
  assert.equal(claudeRestoresUsage("2.1.277"), true);
  const old = new ClaudeUsageAccounting(false);
  old.result("s", result(0.02, 0.01));
  old.beginProcess();
  assert.equal(old.result("s", result(0.02, 0.01))[0]!.costUsd, 0.02);
  const modern = new ClaudeUsageAccounting(true, claudeUsageCheckpoint("s", result(0.02, 0.01))!);
  assert.deepEqual(modern.result("s", { subtype: "error_during_execution", total_cost_usd: 0, modelUsage: {} }), [{ kind: "token_usage", accountingIncomplete: true }]);
  assert.ok(Math.abs(modern.result("s", result(0.03, 0.01))[0]!.costUsd! - 0.01) < 1e-10);
});

test("fork baseline excludes inherited spending and new conversation identity resets totals", () => {
  const fork = new ClaudeUsageAccounting(true, claudeUsageCheckpoint("fork", result(0.02, 0.01))!);
  assert.ok(Math.abs(fork.result("fork", result(0.03, 0.01))[0]!.costUsd! - 0.01) < 1e-10);
  assert.equal(fork.result("new", result(0.01, 0))[0]!.costUsd, 0.01);
});

test("CLI upgrades cannot compare process-scoped or unidentified baselines to restored totals", () => {
  const old = new ClaudeUsageAccounting(false);
  old.result("s", result(0.02, 0.01));
  assert.equal(old.checkpoint!.accountingScope, "process");
  const modern = new ClaudeUsageAccounting(true, old.checkpoint!);
  assert.equal(modern.checkpoint, null, "the resume probe must seed the actual restored prefix");
  const unidentified = { ...old.checkpoint!, accountingScope: undefined };
  assert.equal(new ClaudeUsageAccounting(true, unidentified).checkpoint, null);
});
