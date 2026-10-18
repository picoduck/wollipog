import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../api.js";
import { locationNameFromFolder, projectLocationCreationError } from "./ProjectLocationDialog.js";

test("a new folder's Location Name is its folder name in Title Case (#2966)", () => {
  assert.equal(locationNameFromFolder("/home/ada/acme-storefront"), "Acme Storefront");
  assert.equal(locationNameFromFolder("/home/ada/acme-storefront/"), "Acme Storefront");
  assert.equal(locationNameFromFolder("C:\\src\\billing_service"), "Billing Service");
  assert.equal(locationNameFromFolder("/repos/state-of-the-art"), "State of the Art");
  assert.equal(locationNameFromFolder("/repos/the-end-of"), "The End Of", "first and last words are capitalized");
  assert.equal(locationNameFromFolder("/repos/iOS-app"), "IOS App", "a word keeps the rest of its casing");
  assert.equal(locationNameFromFolder("/repos/wollipog"), "Wollipog");
  assert.equal(locationNameFromFolder("/"), "Root");
});

test("a bare legacy 404 explains the control-plane version mismatch", () => {
  const message = projectLocationCreationError(new ApiError("not found", 404));

  assert.equal(message,
    "This version of Wollipog does not support creating a Location from a new folder. Update or restart Wollipog so it matches this dashboard, then try again.");
  assert.doesNotMatch(message, /control plane/i, "docs/design-system.md §17.2 retires the term");
});

test("a contextual current-control-plane error is preserved", () => {
  const message = "The selected folder was not found on this Machine. It may have moved or been deleted.";

  assert.equal(projectLocationCreationError(new ApiError(message, 404)), message);
});

test("an unknown failure has a useful fallback", () => {
  assert.equal(projectLocationCreationError(null), "The Location could not be added.");
});
