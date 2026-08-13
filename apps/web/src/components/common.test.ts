import assert from "node:assert/strict";
import { test } from "node:test";
import { copyResultIsCurrent } from "./common.js";

test("copy feedback is ignored after text changes, a newer request, or unmount", () => {
  const current = { mounted: true, request: 2, currentRequest: 2, copiedText: "complete", currentText: "complete" };
  assert.equal(copyResultIsCurrent(current), true);
  assert.equal(copyResultIsCurrent({ ...current, currentText: "streamed update" }), false);
  assert.equal(copyResultIsCurrent({ ...current, currentRequest: 3 }), false);
  assert.equal(copyResultIsCurrent({ ...current, mounted: false }), false);
});
