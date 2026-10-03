import assert from "node:assert/strict";
import { test } from "node:test";
import { codexProbeAccessCredentials } from "./codex-probe-auth.js";

const now = Date.UTC(2026, 9, 3);
const access = (exp: number) => `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
const source = (exp = now / 1_000 + 7_200) => ({ auth_mode: "chatgpt", OPENAI_API_KEY: "private-api-key",
  tokens: { id_token: "existing-id", access_token: access(exp), account_id: "existing-account", refresh_token: "shared-refresh-secret" },
  last_refresh: "2026-01-01T00:00:00Z", unrelated_secret: "private-extra" });

test("isolated credentials retain the selected account and access token but cannot rotate the shared refresh token", () => {
  const original = source();
  const originalBytes = JSON.stringify(original);
  const result = codexProbeAccessCredentials(original, now);
  assert.deepEqual(result, { auth_mode: "chatgpt", tokens: { id_token: "existing-id", access_token: original.tokens.access_token,
    account_id: "existing-account", refresh_token: "" }, last_refresh: new Date(now).toISOString() });
  assert.doesNotMatch(JSON.stringify(result), /shared-refresh-secret|private-api-key|private-extra/);
  assert.equal(JSON.stringify(original), originalBytes, "the account's existing credential snapshot is untouched");
});

test("expired, near-expiry, missing, and malformed access credentials fail without exposing their values", () => {
  for (const auth of [null, {}, { auth_mode: "apikey" }, source(now / 1_000 - 1), source(now / 1_000 + 3_599),
    { ...source(), tokens: { ...source().tokens, access_token: "private-malformed-token" } },
    { ...source(), tokens: { ...source().tokens, account_id: undefined } }]) {
    assert.throws(() => codexProbeAccessCredentials(auth, now), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^existing_access_credentials_(unavailable|expiring)$/);
      assert.doesNotMatch(error.message, /private|shared-refresh/);
      return true;
    });
  }
});
