import assert from "node:assert/strict";
import { test } from "node:test";
import { safeExternalHref } from "./external-href.js";

test("safeExternalHref permits only absolute http and https URLs", () => {
  assert.equal(safeExternalHref("https://github.com/picoduck/wollipog/pull/1"), "https://github.com/picoduck/wollipog/pull/1");
  assert.equal(safeExternalHref("http://github.example.test/pull/1"), "http://github.example.test/pull/1");
  for (const value of ["javascript:alert(document.domain)", "data:text/html,unsafe", "file:///etc/passwd", "/relative", "github.com/picoduck/wollipog", "not a url", null]) {
    assert.equal(safeExternalHref(value), null, String(value));
  }
});
