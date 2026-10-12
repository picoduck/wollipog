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

test("live requests are display-only and the next cumulative result closes their window unchanged", () => {
  const accounting = new ClaudeUsageAccounting(true, claudeUsageCheckpoint("s", { total_cost_usd: 0, modelUsage: {} })!);
  const live = accounting.request({ model: "claude-opus-5", inputTokens: 10, outputTokens: 4,
    cacheReadInputTokens: 150, cacheCreationInputTokens: 20, serviceTier: "standard" });
  assert.deepEqual(live, { kind: "token_usage", model: "claude-opus-5", inputTokens: 10, outputTokens: 4, cachedInputTokens: 150,
    cacheCreationInputTokens: 20, pricingContext: { requestInputTokens: 180, serviceTier: "standard" }, liveUsage: "provisional" });
  assert.equal(accounting.request({ model: "claude-opus-5", inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }), null);
  const settled = accounting.result("s", { total_cost_usd: 0.05, modelUsage: {
    "claude-opus-5[1m]": { ...model(13, 6, 0.04), canonicalModel: "claude-opus-5", thinkingTokens: 4 },
    "claude-haiku-5": model(3, 2, 0.01),
  } });
  assert.deepEqual(settled.map((event) => [event.model, event.inputTokens, event.outputTokens, event.reasoningOutputTokens, event.costUsd, event.liveUsage]), [
    ["claude-opus-5", 13, 6, 4, 0.04, undefined],
    ["claude-haiku-5", 3, 2, undefined, 0.01, "settled"],
  ], "the full deltas, exactly as without live records");
  const next = accounting.result("s", { total_cost_usd: 0.06, modelUsage: {
    "claude-opus-5[1m]": { ...model(14, 6, 0.05), canonicalModel: "claude-opus-5" }, "claude-haiku-5": model(3, 2, 0.01) } });
  assert.deepEqual(next.map((event) => [event.inputTokens, event.liveUsage]), [[1, undefined]], "a turn without live records keeps legacy payloads");
});

test("a baseline that cannot cover live requests republishes each as an ordinary record", () => {
  const request = { model: "claude-opus-5", inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 0 };
  const old = new ClaudeUsageAccounting(false);
  const published = old.request(request)!;
  const { liveUsage: _live, ...ordinary } = published;
  assert.deepEqual(old.beginProcess(), [{ ...ordinary, liveUsage: "settled" }], "an old CLI's next process restarts its totals");
  assert.deepEqual(old.beginProcess(), []);
  const modern = new ClaudeUsageAccounting(true, undefined, [published]);
  assert.deepEqual(modern.beginProcess(), [], "a conversation-scoped total may still cover them");
  assert.deepEqual(modern.adoptBaseline(claudeUsageCheckpoint("s", result(0, 0))), [{ ...ordinary, liveUsage: "settled" }]);
  assert.deepEqual(modern.adoptBaseline(null), [], "nothing is left to account");
});

test("a crash or a lower total leaves live requests open for the next checkpoint to decide", () => {
  const request = { model: "model-a", inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  const accounting = new ClaudeUsageAccounting(true, claudeUsageCheckpoint("s", result(0.02, 0.01))!);
  accounting.request(request);
  assert.deepEqual(accounting.result("s", { subtype: "error_during_execution", total_cost_usd: 0, modelUsage: {} }),
    [{ kind: "token_usage", accountingIncomplete: true }]);
  assert.deepEqual(accounting.result("s", result(0.01, 0.01)), []);
  // The restored prefix contains the work: it is accounted once, by the checkpoint.
  const covered = accounting.result("s", { total_cost_usd: 0.04, modelUsage: { "model-a": model(20, 10, 0.03), "model-b": model(3, 2, 0.01) } });
  assert.deepEqual(covered.map((event) => [event.inputTokens, event.outputTokens, event.liveUsage]), [[10, 5, "settled"]]);
  // Or it does not, and the request is accounted as observed.
  const lost = new ClaudeUsageAccounting(true, claudeUsageCheckpoint("s", result(0.02, 0.01))!);
  lost.request(request);
  lost.result("s", { subtype: "error_during_execution", total_cost_usd: 0, modelUsage: {} });
  assert.deepEqual(lost.adoptBaseline(claudeUsageCheckpoint("s", result(0.02, 0.01))).map((event) => [event.inputTokens, event.liveUsage]), [[10, "settled"]]);
});
