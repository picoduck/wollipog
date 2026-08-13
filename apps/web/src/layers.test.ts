import assert from "node:assert/strict";
import { test } from "node:test";
import { pickTopmost } from "./layers.js";

test("pickTopmost: highest z wins regardless of document order", () => {
  const items = [
    { name: "settings", z: 40 },
    { name: "proj-menu", z: 30 },
  ];
  assert.equal(pickTopmost(items, (i) => i.z)?.name, "settings");
  assert.equal(pickTopmost([...items].reverse(), (i) => i.z)?.name, "settings");
});

test("pickTopmost: equal z → the LATER element wins (siblings stack in document order)", () => {
  const items = [
    { name: "first", z: 40 },
    { name: "second", z: 40 },
  ];
  assert.equal(pickTopmost(items, (i) => i.z)?.name, "second");
});

test("pickTopmost: empty → null; unparseable z treated as provided", () => {
  assert.equal(pickTopmost([], () => 0), null);
  assert.equal(pickTopmost([{ z: 0 }, { z: -1 }], (i) => i.z)?.z, 0);
});
