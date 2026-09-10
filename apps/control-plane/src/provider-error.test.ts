import assert from "node:assert/strict";
import { test } from "node:test";
import { isTransientProviderError } from "./provider-error.js";

const OAUTH_CONTENTION = "provider refusal: Failed to refresh OAuth token: another Claude Code process is " +
  "refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists " +
  "close other Claude Code processes or sign in again";

test("only provider text that names a passing condition earns another launch attempt", () => {
  // The failure this classification exists for: a concurrent process held the credential refresh.
  assert.equal(isTransientProviderError(OAUTH_CONTENTION), true);
  assert.equal(isTransientProviderError("provider refusal: Overloaded (overloaded_error); please try again later"), true);
  assert.equal(isTransientProviderError("The service is temporarily unavailable"), true);

  // A verdict on the work, a bad command, or a dead account is not worth the window a retry costs.
  assert.equal(isTransientProviderError("provider refusal"), false);
  assert.equal(isTransientProviderError("provider cancelled"), false);
  assert.equal(isTransientProviderError("I can't help with that."), false);
  assert.equal(isTransientProviderError("Invalid API key; authentication is required"), false);
  assert.equal(isTransientProviderError("Your credit balance is too low to run this request"), false);
  assert.equal(isTransientProviderError("runner shutdown is in progress"), false);

  // A durable condition wins over retry advice quoted beside it: waiting cannot fix a signed-out
  // account, and the OAuth message ends with exactly that advice for the persistent case.
  assert.equal(isTransientProviderError("Session expired. Please sign in again, or try again later."), false);
  // A revoked or expired refresh token is reported as a refresh failure too. Only the contention
  // wording outranks a durable indicator; a bare refresh failure that says to sign in does not.
  assert.equal(isTransientProviderError("Failed to refresh OAuth token; please sign in again"), false);
  assert.equal(isTransientProviderError("Failed to refresh OAuth token; retry in a minute"), true);

  // Silence is not evidence that a condition passes.
  assert.equal(isTransientProviderError(undefined), false);
  assert.equal(isTransientProviderError(""), false);
  assert.equal(isTransientProviderError("   "), false);
});
