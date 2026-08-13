import assert from "node:assert/strict";
import test from "node:test";
import { sensitiveEnvironmentName } from "./env-security.js";

test("sensitiveEnvironmentName scrubs both product prefixes without relying on secret-shaped suffixes", () => {
  assert.equal(sensitiveEnvironmentName("WOLLIPOG_PLAIN"), true);
  assert.equal(sensitiveEnvironmentName("wollipog_plain"), true);
  assert.equal(sensitiveEnvironmentName("MAM_PLAIN"), true);
  assert.equal(sensitiveEnvironmentName("mam_plain"), true);
  assert.equal(sensitiveEnvironmentName("UNRELATED_PLAIN"), false);
});

test("sensitiveEnvironmentName retains the credential-shaped defense for unrelated prefixes", () => {
  for (const name of ["GITHUB_TOKEN", "clientSecret", "API-KEY", "session_cookie", "Authorization"]) {
    assert.equal(sensitiveEnvironmentName(name), true, name);
  }
});
