import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../api.js";
import { projectLocationCreationError } from "./ProjectLocationDialog.js";

test("a bare legacy 404 explains the control-plane version mismatch", () => {
  const message = projectLocationCreationError(new ApiError("not found", 404));

  assert.match(message, /control plane/i);
  assert.match(message, /update or restart/i);
  assert.notEqual(message, "not found");
});

test("a contextual current-control-plane error is preserved", () => {
  const message = "The selected folder was not found on this Machine. It may have moved or been deleted.";

  assert.equal(projectLocationCreationError(new ApiError(message, 404)), message);
});

test("an unknown failure has a useful fallback", () => {
  assert.equal(projectLocationCreationError(null), "The Location could not be added.");
});
