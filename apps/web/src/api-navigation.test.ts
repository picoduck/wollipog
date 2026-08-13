import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionLookupPath } from "./api.js";

test("exact session lookup keeps every opaque id out of URL path normalization", () => {
  for (const id of [".", "..", "a/../foo.txt", "space / unicode ✅ %?#"]) {
    const url = new URL(sessionLookupPath(id), "https://manager.example.test");
    assert.equal(url.pathname, "/api/sessions/lookup/by-id");
    assert.equal(url.searchParams.get("id"), id);
  }
});
