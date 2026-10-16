import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { secureDashboardUrl } from "./remote-access-navigation.js";

test("secure navigation preserves session routes and never carries credentials or an injected authority", () => {
  fc.assert(fc.property(fc.string(), (path) => {
    const result = secureDashboardUrl("https://secure.example.test:8443", { pathname: path });
    assert.ok(result);
    const url = new URL(result);
    assert.equal(url.origin, "https://secure.example.test:8443");
    assert.equal(url.username, ""); assert.equal(url.password, "");
    assert.equal(url.search, ""); assert.equal(url.hash, "");
  }));
  assert.equal(secureDashboardUrl("https://secure.example.test", { pathname: "/sessions/example" }), "https://secure.example.test/sessions/example");
  assert.equal(secureDashboardUrl("https://other.example.test/#pair=secret", { pathname: "/" }), null);
  assert.equal(secureDashboardUrl("http://other.example.test", { pathname: "/" }), null);
});
