import assert from "node:assert/strict";
import { test } from "node:test";
import { describeTurnError, TURN_ERROR_FALLBACK } from "./turn-error.js";

test("describeTurnError says known failures in plain words", () => {
  const cases: Array<[string, string]> = [
    ["prompt failed: Rate limit reached", "The provider's usage limit was reached. Wait for it to reset, then retry."],
    ["429 Too Many Requests", "The provider's usage limit was reached. Wait for it to reset, then retry."],
    ["Claude AI usage limit reached|1791000000", "The provider's usage limit was reached. Wait for it to reset, then retry."],
    ["You exceeded your current quota, please check your plan", "The provider's usage limit was reached. Wait for it to reset, then retry."],
    ["Invalid API key · Please run /login", "The provider account needs you to sign in again."],
    ["prompt failed: 401 Unauthorized", "The provider account needs you to sign in again."],
    ["OAuth token has expired", "The provider account needs you to sign in again."],
    ["prompt failed: read ECONNRESET", "The connection to the provider was lost."],
    ["fetch failed", "The connection to the provider was lost."],
    ["Your request was flagged as potentially violating our usage policy", "The provider rejected the content of this turn."],
  ];
  for (const [message, sentence] of cases) assert.equal(describeTurnError(message), sentence, message);
});

test("describeTurnError never guesses at an unknown message", () => {
  for (const message of [
    "prompt failed: Worktree verification failed",
    "The agent provider rejected this conversation's stored history: the recorded tool call cannot be resent.",
    "Tool budget limit reached",
    "",
  ]) assert.equal(describeTurnError(message), TURN_ERROR_FALLBACK, message);
});
