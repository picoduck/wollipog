import assert from "node:assert/strict";
import { test } from "node:test";
import { describeTurnError, isAutomaticTurnsHeld, TURN_ERROR_FALLBACK } from "./turn-error.js";

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
    ["agent process could not be created: Provider HOME is already in use; retry after the current owner or publication finishes.",
      "The runner couldn't use this session's provider account, so the agent didn't start."],
    ["Provider-HOME lease helper unavailable; preserve all evidence and restore the fixed helper and executable staging directory before retrying.",
      "The runner couldn't use this session's provider account, so the agent didn't start."],
    ["provider account unavailable: This provider profile is not granted to this control plane. An Owner or Admin must grant access on this Machine before it can be used.",
      "The runner couldn't use this session's provider account, so the agent didn't start."],
  ];
  for (const [message, sentence] of cases) assert.equal(describeTurnError(message), sentence, message);
});

test("the runner's rejection hold is recognised whatever provider error it quotes (#3100)", () => {
  const held = (error: string) =>
    `Codex rejected two turns in a row with the same error: ${error}. ` +
    "Automatic turns are held until you send a message or restart the session.";
  assert.equal(isAutomaticTurnsHeld(held("turn/start failed: Invalid request")), true);
  assert.equal(isAutomaticTurnsHeld(held("turn/start failed: 429 Too Many Requests")), true);
  assert.equal(isAutomaticTurnsHeld("prompt failed: Rate limit reached"), false);
  assert.equal(isAutomaticTurnsHeld("Automatic turns are held until you send a message or restart the session. Then more"), false);
});

test("describeTurnError never guesses at an unknown message", () => {
  for (const message of [
    "prompt failed: Worktree verification failed",
    "The agent provider rejected this conversation's stored history: the recorded tool call cannot be resent.",
    "Tool budget limit reached",
    "",
  ]) assert.equal(describeTurnError(message), TURN_ERROR_FALLBACK, message);
});
