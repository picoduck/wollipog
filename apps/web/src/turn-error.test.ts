import assert from "node:assert/strict";
import { test } from "node:test";
import { agentLaunchFailure, describeTurnError, isAutomaticTurnsHeld, isBackgroundResultsHeld, TURN_ERROR_FALLBACK } from "./turn-error.js";

test("an agent's setup failures are told apart from failed turns, on the runner's exact wording (#4779)", () => {
  assert.deepEqual(
    agentLaunchFailure("agent init failed: Google Antigravity could not be started on this machine. Check its setup in Connections."),
    { kind: "start", agent: "Google Antigravity", text: "Google Antigravity could not be started on this machine. Check its setup in Connections." },
  );
  assert.equal(agentLaunchFailure("agent init failed: Google Antigravity needs sign-in on this machine. Sign in from Connections, then try again.")?.kind, "sign_in");
  // A prompt rejected for sign-in is a failed turn: it keeps Retry Turn and still says to sign in.
  for (const rejected of ["Google Antigravity needs sign-in on this machine. Sign in from Connections, then try again.",
    "prompt failed: Google Antigravity needs sign-in on this machine. Sign in from Connections, then try again."]) {
    assert.equal(agentLaunchFailure(rejected), null);
    assert.equal(describeTurnError(rejected), "The provider account needs you to sign in again.");
  }
  assert.equal(agentLaunchFailure("agent init failed: Google Antigravity could not resume this conversation, so its history here is read-only. Start a new session to continue.")?.kind, "resume");
  // A real turn error, an unrelated launch error, and text naming another agent are not setup failures.
  assert.equal(agentLaunchFailure("Google Antigravity could not complete this turn: Quota exhausted for [account]"), null);
  assert.equal(agentLaunchFailure("agent init failed: ACP session resume failed"), null);
  assert.equal(agentLaunchFailure("agent init failed: Evil Agent could not be started on this machine. Check its setup in Connections."), null);
});

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
    ["agent process could not be created: This provider HOME no longer holds the profile that this account or session recorded, so it was not used. Restore the original directory or adopt the replacement explicitly.",
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

test("the runner's background-results hold is recognised for one job or many, with or without a provider error (#3542)", () => {
  const held = (results: string, error = "") =>
    `The automatic turn that returns ${results} failed to start 3 times in a row, before the provider accepted it` +
    `${error ? `: ${error}` : ""}. Wollipog stopped retrying it and kept the results. Restart the session to deliver ` +
    "them in a fresh provider process; a message the provider accepts also retries it.";
  assert.equal(isBackgroundResultsHeld(held("the result of 1 finished background job")), true);
  assert.equal(isBackgroundResultsHeld(held("the results of 12 finished background jobs",
    "bwrap: Can't find source path /tmp/worktrees/old: No such file or directory")), true);
  assert.equal(isBackgroundResultsHeld(`prompt failed: ${held("the results of 2 finished background jobs")}`), true);
  assert.equal(isAutomaticTurnsHeld(held("the result of 1 finished background job")), false);
  assert.equal(isBackgroundResultsHeld("Claude resume accounting baseline could not be recovered."), false);
  assert.equal(isBackgroundResultsHeld(`Earlier: ${held("the result of 1 finished background job")}`), false,
    "only the runner's own sentence, at the start, is the hold");
});

test("describeTurnError never guesses at an unknown message", () => {
  for (const message of [
    "prompt failed: Worktree verification failed",
    "The agent provider rejected this conversation's stored history: the recorded tool call cannot be resent.",
    "Tool budget limit reached",
    "",
  ]) assert.equal(describeTurnError(message), TURN_ERROR_FALLBACK, message);
});

test("plain-language account recovery errors retain their account-specific transcript explanation", () => {
  for (const message of [
    "Wollipog can't check whether another program is still using this account. Choose another account for now, or save your work and restart the machine before trying again.",
    "A program from an earlier session is still using this account. Wait for that work to finish, then try again, or choose another account.",
    "Wollipog can't read or verify this account's recovery records. Choose another account and ask the person who manages this machine to check the recovery details.",
  ]) assert.equal(describeTurnError(`provider account unavailable: ${message}`),
    "The runner couldn't use this session's provider account, so the agent didn't start.");
});
