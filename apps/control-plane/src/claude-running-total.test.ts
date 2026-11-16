import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClaudeUsageCheckpoint, SessionEventPayload } from "@wollipog/protocol";
import { claudeTurnRunningTotal } from "./claude-running-total.js";

import { ControlPlaneDb } from "./db.js";

type Usage = Extract<SessionEventPayload, { kind: "token_usage" }>;

const checkpoint = (totalCostUsd: number, cacheReads: number, scope: "process" | "conversation" = "process", sessionId = "conversation"): ClaudeUsageCheckpoint => ({
  sessionId, totalCostUsd, accountingScope: scope,
  models: { "claude-opus-5": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: cacheReads, cacheCreationInputTokens: 10, costUSD: totalCostUsd } },
});
const turn = (costUsd: number, closing: ClaudeUsageCheckpoint): Usage =>
  ({ kind: "token_usage", model: "claude-opus-5", costUsd, costIsEstimate: true, claudeUsageCheckpoint: closing });
/** Exercise the live SQL baseline lookup and accumulation on each append. */
const flags = (records: Usage[]) => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    db.registerRunner({ runnerId: "r", hostname: "fixture", os: "linux", version: "fixture", agents: [], workspaces: [] }, 1);
    db.createSession({ id: "s", runnerId: "r", workspaceId: null, agentId: "claude", title: "Fixture", useWorktree: false,
      driver: "claude-code", config: {}, now: 2 });
    return records.map((record, index) => {
      db.appendEvent("s", record, index + 3, { accrueUsage: true });
      const row = db.raw().prepare(`SELECT cost_microusd FROM usage_claude_running_totals
        WHERE event_id=(SELECT MAX(id) FROM session_events WHERE session_id='s')`).get() as { cost_microusd: number } | undefined;
      return row ? row.cost_microusd / 1_000_000 : null;
    });
  } finally { db.close(); }
};

test("the live turn predicate compares accrued cost and checkpoints without granting certainty (#4069)", () => {
  const prior = checkpoint(4, 500);
  assert.equal(claudeTurnRunningTotal(turn(7, checkpoint(9, 900)), 2, prior), 9);
  assert.equal(claudeTurnRunningTotal(turn(5, checkpoint(9, 900)), 0, prior), null);
  assert.equal(claudeTurnRunningTotal(turn(9, checkpoint(9, 100)), 0, prior), null);
  assert.equal(claudeTurnRunningTotal(turn(9, checkpoint(9, 900, "process", "other")), 0, prior), null);
  assert.equal(claudeTurnRunningTotal(turn(9, checkpoint(9, 900)), 0, null), null);
  assert.equal(claudeTurnRunningTotal({ ...turn(9, checkpoint(9, 900)), liveUsage: "provisional" }, 0, prior), null);
});

test("turns that billed their conversation's running total are found, and exact deltas are not (#4069)", () => {
  // The issue's sequence: a conversation-scoped history, then a resume whose process-scoped records
  // each billed the whole restored total, then a correct delta after the runner was redeployed.
  const records: Usage[] = [
    turn(15.78, checkpoint(15.78, 70_000_000, "conversation")),
    { kind: "token_usage", model: "claude-opus-5", inputTokens: 3, outputTokens: 9, liveUsage: "provisional" },
    { kind: "token_usage", model: "claude-opus-5", inputTokens: 3, outputTokens: 9, liveUsage: "republished" },
    turn(20.34, checkpoint(20.34, 74_135_354)),
    turn(24.90, checkpoint(24.90, 75_251_686)),
    turn(29.34, checkpoint(29.34, 75_821_698)),
    turn(34.56, checkpoint(34.56, 79_201_832)),
    turn(4.65, checkpoint(39.21, 79_787_781)),
  ];
  assert.deepEqual(flags(records), [null, null, null, 20.34, 24.90, 29.34, 34.56, null]);
});

test("a turn's per-model records and provider fees are summed against its total", () => {
  const closing: ClaudeUsageCheckpoint = { sessionId: "conversation", totalCostUsd: 9, accountingScope: "process", models: {
    "claude-opus-5": { inputTokens: 200, outputTokens: 80, cacheReadInputTokens: 900, cacheCreationInputTokens: 10, costUSD: 7 },
    "claude-haiku-5": { inputTokens: 40, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 1.5 } } };
  const records: Usage[] = [
    turn(4, checkpoint(4, 500)),
    { kind: "token_usage", model: "claude-haiku-5", costUsd: 1.5, costIsEstimate: true },
    { kind: "token_usage", model: "<provider-fees>", costUsd: 0.5, costIsEstimate: true },
    { kind: "token_usage", model: "claude-opus-5", costUsd: 2, costIsEstimate: true, parentToolUseId: "task" }, // display only
    turn(7, closing),
  ];
  assert.equal(claudeTurnRunningTotal(turn(7, closing), 2, checkpoint(4, 500)), 9);
  assert.equal(flags(records).at(-1), 9);
});

test("new conversations, zero baselines, and totals that do not cover the earlier one are not flagged", () => {
  // A new conversation's first total is its own.
  assert.deepEqual(flags([turn(5, checkpoint(5, 900)), turn(2, checkpoint(2, 100, "process", "other"))]), [null, null]);
  // A zero baseline is skipped; with no earlier non-zero total there is nothing to repeat.
  assert.deepEqual(flags([turn(0, checkpoint(0, 0)), turn(3, checkpoint(3, 300))]), [null, null]);
  // An old CLI's new process that used less than the previous one restarted from zero.
  assert.deepEqual(flags([turn(5, checkpoint(5, 900)), turn(6, checkpoint(6, 100))]), [null, null]);
  // Conversation-scoped totals are differences by construction.
  assert.deepEqual(flags([turn(5, checkpoint(5, 900)), turn(6, checkpoint(6, 1000, "conversation"))]), [null, null]);
});

test("display-only checkpoints and zero checkpoints do not hide an accrued baseline", () => {
  assert.deepEqual(flags([
    turn(4, checkpoint(4, 500)),
    { ...turn(100, checkpoint(100, 9000)), liveUsage: "provisional" },
    { ...turn(100, checkpoint(100, 9000)), parentToolUseId: "display" },
    turn(0, checkpoint(0, 0)),
    turn(9, checkpoint(9, 900)),
  ]), [null, null, null, null, 9]);
  assert.equal(flags([
    turn(4, checkpoint(4, 500)),
    { kind: "token_usage", model: "claude-haiku-5", costUsd: 2, parentToolUseId: "task", independentUsage: true },
    turn(7, checkpoint(9, 900)),
  ]).at(-1), 9, "independently billed task usage counts");
});
