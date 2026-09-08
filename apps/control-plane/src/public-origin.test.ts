import assert from "node:assert/strict";
import { test } from "node:test";
import { pairingUrlForOrigin, resolvePublicOrigin, validatePublicOrigin } from "./public-origin.js";

test("resolvePublicOrigin accepts bare https origins and normalizes trailing slashes", () => {
  assert.deepEqual(resolvePublicOrigin("https://wollipog.example.ts.net/"), {
    origin: "https://wollipog.example.ts.net",
    warning: null,
    error: null,
  });
  assert.deepEqual(resolvePublicOrigin("  https://host.example:8443  "), {
    origin: "https://host.example:8443",
    warning: null,
    error: null,
  });
  assert.deepEqual(resolvePublicOrigin(undefined), { origin: null, warning: null, error: null });
  assert.deepEqual(resolvePublicOrigin("   "), { origin: null, warning: null, error: null });
});

test("resolvePublicOrigin rejects paths, queries, fragments, credentials, and other schemes", () => {
  for (const value of [
    "https://host.example/dashboard",
    "https://host.example/?x=1",
    "https://host.example/#pair=abc",
    "https://user:pw@host.example",
    "wss://host.example",
    "host.example",
  ]) {
    const result = validatePublicOrigin(value);
    assert.equal(result.origin, null, value);
    assert.ok(result.error, value);
  }
});

test("resolvePublicOrigin warns about plain HTTP beyond loopback but not on loopback", () => {
  const remote = resolvePublicOrigin("http://100.64.0.10:4317");
  assert.equal(remote.origin, "http://100.64.0.10:4317");
  assert.match(remote.warning ?? "", /plain HTTP beyond loopback/u);
  assert.equal(remote.error, null);
  const local = resolvePublicOrigin("http://localhost:4317");
  assert.equal(local.origin, "http://localhost:4317");
  assert.equal(local.warning, null);
});

test("pairingUrlForOrigin embeds the token in the fragment only", () => {
  assert.equal(pairingUrlForOrigin("https://host.example", "tok_abc"), "https://host.example/#pair=tok_abc");
  assert.equal(pairingUrlForOrigin("https://host.example///", "tok_abc"), "https://host.example/#pair=tok_abc");
});
