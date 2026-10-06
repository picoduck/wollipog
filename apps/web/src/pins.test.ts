import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { loadKeySet, removeFromInstanceKeySet, saveKeySet } from "./pins.js";

// node has no localStorage — shim the three methods the helpers use.
const backing = new Map<string, string>();
let writes = 0;
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void (writes++, backing.set(k, v)),
  removeItem: (k: string) => void backing.delete(k),
};

beforeEach(() => { backing.clear(); writes = 0; });

test("loadKeySet/saveKeySet round-trip a set", () => {
  saveKeySet("k", new Set(["a", "b"]));
  assert.deepEqual([...loadKeySet("k")].sort(), ["a", "b"]);
});

test("loadKeySet: missing key and corrupt JSON both degrade to an empty set", () => {
  assert.equal(loadKeySet("absent").size, 0);
  backing.set("bad", "{not json");
  assert.equal(loadKeySet("bad").size, 0);
});

test("removeFromInstanceKeySet drops only the named ids and persists", () => {
  saveKeySet("k", new Set(["a", "b", "c"]));
  removeFromInstanceKeySet("k", "local", "b", "nope");
  assert.deepEqual([...loadKeySet("k")].sort(), ["a", "c"]);
});

test("removeFromInstanceKeySet is a no-op write when nothing matched", () => {
  saveKeySet("k", new Set(["a"]));
  const before = writes;
  removeFromInstanceKeySet("k", "local", "zzz");
  assert.equal(writes, before, "no storage write when no id matched");
});

test("identical pins remain isolated and removable within one instance", () => {
  saveKeySet("k", new Set(["same", "local-only"]), "local");
  saveKeySet("k", new Set(["same", "alpha-only"]), "remote-alpha");
  saveKeySet("k", new Set(["same", "beta-only"]), "remote-beta");
  removeFromInstanceKeySet("k", "remote-alpha", "same");
  assert.deepEqual([...loadKeySet("k", "remote-alpha")], ["alpha-only"]);
  assert.deepEqual([...loadKeySet("k", "local")].sort(), ["local-only", "same"]);
  assert.deepEqual([...loadKeySet("k", "remote-beta")].sort(), ["beta-only", "same"]);
});

test("legacy pins copy forward only into Local", () => {
  backing.set("legacy-pins", '["legacy"]');
  assert.deepEqual([...loadKeySet("legacy-pins", "remote-alpha")], []);
  assert.deepEqual([...loadKeySet("legacy-pins", "local")], ["legacy"]);
  assert.equal(backing.has("legacy-pins"), true, "copy-forward retains rollback data");
});
