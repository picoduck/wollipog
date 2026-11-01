import assert from "node:assert/strict";
import test from "node:test";
import type { DeviceView } from "@wollipog/protocol";
import {
  canAdminister,
  deviceCountLabel,
  devicesByPerson,
  isOwnRow,
  personRowAction,
  revokeDeviceMessage,
} from "./people-device-rows.js";

test("your own row is yours whatever your role, and never managed from the list", () => {
  for (const role of ["owner", "admin", "operator", "viewer"] as const) {
    const context = { userId: "me", role };
    assert.equal(isOwnRow({ userId: "me" }, context), true);
    assert.equal(isOwnRow({ userId: "other" }, context), false);
    assert.equal(personRowAction({ userId: "me", role }, context), "you");
  }
});

test("only owners change owners, and only owners and admins manage anyone", () => {
  assert.equal(personRowAction({ userId: "o", role: "owner" }, { userId: "me", role: "owner" }), "manage");
  assert.equal(personRowAction({ userId: "o", role: "owner" }, { userId: "me", role: "admin" }), "owner-locked");
  assert.equal(personRowAction({ userId: "a", role: "admin" }, { userId: "me", role: "admin" }), "manage");
  assert.equal(personRowAction({ userId: "v", role: "viewer" }, { userId: "me", role: "operator" }), "none");
  assert.equal(personRowAction({ userId: "v", role: "viewer" }, { userId: "me", role: "viewer" }), "none");
  assert.deepEqual(["owner", "admin", "operator", "viewer"].map((role) => canAdminister({ role: role as never })),
    [true, true, false, false]);
});

test("device counts and the revoke sentence read as the issue words them", () => {
  assert.deepEqual([0, 1, 3].map(deviceCountLabel), ["No devices", "1 device", "3 devices"]);
  assert.equal(revokeDeviceMessage("Pixel 9", "Pat"), "“Pixel 9” stops working for Pat right away. To use it again, pair it again.");
  const device = (userId: string) => ({ userId }) as DeviceView;
  assert.deepEqual([...devicesByPerson([device("a"), device("b"), device("a")])], [["a", 2], ["b", 1]]);
});
