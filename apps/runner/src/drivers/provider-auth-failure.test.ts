import assert from "node:assert/strict";
import { test } from "node:test";
import { isProviderAuthenticationFailure } from "./provider-auth-failure.js";

test("classifies provider login failures without conflating other retry classes", () => {
  for (const message of [
    "authentication_failed",
    "authentication_error",
    "stream error: unexpected status 401 Unauthorized; retrying 1/5",
    "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
    "You are not logged in. Run codex login.",
    "OAuth token expired",
    "invalid API key supplied",
    "credentials were revoked",
  ]) assert.equal(isProviderAuthenticationFailure(message), true, message);

  for (const message of [
    "connection reset by peer",
    "429 rate_limit_error",
    "403 Forbidden: permission denied",
    "runner pairing is required",
    "Wollipog account authentication failed",
    "subscription entitlement is unavailable",
    "MCP server returned 401 because its credentials expired",
    "the provider is temporarily overloaded",
  ]) assert.equal(isProviderAuthenticationFailure(message), false, message);
});
