import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  LOCAL_INSTANCE_SCOPE,
  instanceResourceKey,
  instanceStorageKey,
  legacyBrowserStorageKey,
  legacyInstanceResourceKey,
  legacyInstanceStorageKey,
  loadBrowserStorageValue,
  loadInstanceStorageValue,
  removeBrowserStorageValue,
  removeInstanceStorageValue,
  saveBrowserStorageValue,
  saveInstanceStorageValue,
  type KeyValueStorage,
} from "./instance-storage.js";

class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, string>();
  readonly reads = new Map<string, number>();

  getItem(key: string): string | null {
    this.reads.set(key, (this.reads.get(key) ?? 0) + 1);
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const tuple = (...parts: string[]) => parts.map((part) => `${part.length}:${part}`).join("");
const oldMarker = (currentLogicalKey: string) =>
  `mam.instance-migration.v1:${tuple(legacyBrowserStorageKey(currentLogicalKey))}`;

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
});

test("key construction uses Wollipog identities and exposes exact rollback keys", () => {
  assert.equal(instanceStorageKey("wollipog.sessions.pinned"), instanceStorageKey("wollipog.sessions.pinned", LOCAL_INSTANCE_SCOPE));
  assert.equal(instanceResourceKey("session-1"), instanceResourceKey("session-1", LOCAL_INSTANCE_SCOPE));
  assert.equal(instanceStorageKey("settings", "remote-a"), "wollipog.instance.v1:8:remote-a8:settings");
  assert.equal(legacyInstanceStorageKey("wollipog.sessions.seen", "remote-a"),
    "mam.instance.v1:8:remote-a17:mam.sessions.seen");
  assert.equal(instanceResourceKey("session-1", "remote-a"), "wollipog.resource.v1:8:remote-a9:session-1");
  assert.equal(legacyInstanceResourceKey("session-1", "remote-a"), "mam.resource.v1:8:remote-a9:session-1");
  assert.throws(() => instanceStorageKey("", "remote-a"), /logical key must not be empty/);
  assert.throws(() => instanceResourceKey("session-1", ""), /instance scope must not be empty/);
});

test("length-prefixed composite identities cannot collide through embedded delimiters", () => {
  assert.notEqual(instanceStorageKey("c", "a:b"), instanceStorageKey("b:c", "a"));
  assert.notEqual(instanceResourceKey("c", "a:b"), instanceResourceKey("b:c", "a"));
  assert.notEqual(instanceResourceKey(":2:x", "remote"), instanceResourceKey("x", "remote:2:"));
});

test("legacy scoped values copy forward independently for Local and remote instances", () => {
  const logicalKey = "wollipog.sessions.seen";
  storage.values.set(legacyInstanceStorageKey(logicalKey, "local"), "local-value");
  storage.values.set(legacyInstanceStorageKey(logicalKey, "instance-alpha"), "alpha-value");
  storage.values.set(legacyInstanceStorageKey(logicalKey, "instance-beta"), "beta-value");

  assert.equal(loadInstanceStorageValue(logicalKey, "local", storage), "local-value");
  assert.equal(loadInstanceStorageValue(logicalKey, "instance-alpha", storage), "alpha-value");
  assert.equal(loadInstanceStorageValue(logicalKey, "instance-beta", storage), "beta-value");
  assert.equal(storage.values.get(instanceStorageKey(logicalKey, "local")), "local-value");
  assert.equal(storage.values.get(instanceStorageKey(logicalKey, "instance-alpha")), "alpha-value");
  assert.equal(storage.values.get(instanceStorageKey(logicalKey, "instance-beta")), "beta-value");
  assert.equal(storage.values.get(legacyInstanceStorageKey(logicalKey, "instance-alpha")), "alpha-value",
    "copy-forward retains the rollback generation");
});

test("an unscoped legacy value migrates only into Local and remains available to a rollback", () => {
  const logicalKey = "wollipog.sessions.pinned";
  const legacyKey = legacyBrowserStorageKey(logicalKey);
  storage.values.set(legacyKey, '["legacy-session"]');

  assert.equal(loadInstanceStorageValue(logicalKey, "instance-alpha", storage), null);
  assert.equal(loadInstanceStorageValue(logicalKey, LOCAL_INSTANCE_SCOPE, storage), '["legacy-session"]');
  assert.equal(storage.values.get(legacyKey), '["legacy-session"]');
  assert.equal(storage.values.get(instanceStorageKey(logicalKey)), '["legacy-session"]');
  assert.ok([...storage.values.keys()].some((key) => key.startsWith("wollipog.instance-migration.v1:")));
});

test("an old completion marker prevents stale unscoped data from being resurrected", () => {
  const logicalKey = "wollipog.newSession.agentDefaults";
  storage.values.set(legacyBrowserStorageKey(logicalKey), "stale");
  storage.values.set(oldMarker(logicalKey), "1");

  assert.equal(loadInstanceStorageValue(logicalKey, LOCAL_INSTANCE_SCOPE, storage), null);
  assert.equal(storage.reads.get(legacyBrowserStorageKey(logicalKey)) ?? 0, 0);
});

test("an old completion marker still permits its scoped value to copy forward", () => {
  const logicalKey = "wollipog.sessions.seen";
  storage.values.set(legacyInstanceStorageKey(logicalKey), "scoped-before-rename");
  storage.values.set(oldMarker(logicalKey), "1");

  assert.equal(loadInstanceStorageValue(logicalKey, LOCAL_INSTANCE_SCOPE, storage), "scoped-before-rename");
  assert.equal(storage.values.get(instanceStorageKey(logicalKey)), "scoped-before-rename");
  assert.equal(storage.values.get(oldMarker(logicalKey)), "1", "the old marker is read-only input");
  assert.ok([...storage.values.keys()].some((key) => key.startsWith("wollipog.instance-migration.v1:")),
    "the marker prefix itself copies forward");
});

test("new values win conflicts, including the explicit empty string", () => {
  const logicalKey = "wollipog.sessions.seen";
  storage.values.set(instanceStorageKey(logicalKey), "");
  storage.values.set(legacyInstanceStorageKey(logicalKey), "legacy");
  storage.values.set(legacyBrowserStorageKey(logicalKey), "older");

  assert.equal(loadInstanceStorageValue(logicalKey, LOCAL_INSTANCE_SCOPE, storage), "");
  assert.equal(storage.values.get(legacyInstanceStorageKey(logicalKey)), "legacy");
});

test("a denied current write preserves the legacy read and retries migration later", () => {
  const logicalKey = "wollipog.sessions.seen";
  const legacyKey = legacyInstanceStorageKey(logicalKey);
  storage.values.set(legacyKey, '{"session-1":42}');
  let denyCurrentWrite = true;
  const flaky: KeyValueStorage = {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => {
      if (denyCurrentWrite && key === instanceStorageKey(logicalKey)) throw new Error("quota");
      storage.setItem(key, value);
    },
    removeItem: (key) => storage.removeItem(key),
  };

  assert.equal(loadInstanceStorageValue(logicalKey, LOCAL_INSTANCE_SCOPE, flaky), '{"session-1":42}');
  assert.equal(storage.values.has(instanceStorageKey(logicalKey)), false);
  denyCurrentWrite = false;
  assert.equal(loadInstanceStorageValue(logicalKey, LOCAL_INSTANCE_SCOPE, flaky), '{"session-1":42}');
  assert.equal(storage.values.get(instanceStorageKey(logicalKey)), '{"session-1":42}');
});

test("fresh instance writes use only Wollipog names and deletion tombstones legacy input", () => {
  const logicalKey = "wollipog.sessions.pinned";
  saveInstanceStorageValue(logicalKey, "current", LOCAL_INSTANCE_SCOPE, storage);
  assert.equal(storage.values.get(instanceStorageKey(logicalKey)), "current");
  assert.equal(storage.values.has(legacyInstanceStorageKey(logicalKey)), false);
  assert.equal([...storage.values.keys()].some((key) => key.startsWith("mam.")), false);

  removeInstanceStorageValue(logicalKey, LOCAL_INSTANCE_SCOPE, storage);
  assert.equal(storage.values.has(instanceStorageKey(logicalKey)), false);
  assert.equal(storage.values.has(legacyInstanceStorageKey(logicalKey)), false);
  storage.values.set(legacyInstanceStorageKey(logicalKey), "stale-after-delete");
  assert.equal(loadInstanceStorageValue(logicalKey, LOCAL_INSTANCE_SCOPE, storage), null);
});

test("deletion still removes every stored generation when a new migration marker exceeds quota", () => {
  const browserKey = "wollipog.deviceToken";
  const logicalKey = "wollipog.composer.draft.remote-session";
  storage.values.set(browserKey, "current-token");
  storage.values.set(legacyBrowserStorageKey(browserKey), "legacy-token");
  storage.values.set(instanceStorageKey(logicalKey, "remote-a"), "current-draft");
  storage.values.set(legacyInstanceStorageKey(logicalKey, "remote-a"), "legacy-draft");
  const quotaLimited: KeyValueStorage = {
    getItem: (key) => storage.getItem(key),
    setItem: () => { throw new Error("quota"); },
    removeItem: (key) => storage.removeItem(key),
  };

  removeBrowserStorageValue(browserKey, quotaLimited);
  removeInstanceStorageValue(logicalKey, "remote-a", quotaLimited);

  assert.equal(storage.values.has(browserKey), false);
  assert.equal(storage.values.has(legacyBrowserStorageKey(browserKey)), false);
  assert.equal(storage.values.has(instanceStorageKey(logicalKey, "remote-a")), false);
  assert.equal(storage.values.has(legacyInstanceStorageKey(logicalKey, "remote-a")), false);
});

test("a denied marker and legacy removal retain the current generation", () => {
  const logicalKey = "wollipog.composer.draft.remote-session";
  const currentKey = instanceStorageKey(logicalKey, "remote-a");
  const legacyKey = legacyInstanceStorageKey(logicalKey, "remote-a");
  storage.values.set(currentKey, "current-draft");
  storage.values.set(legacyKey, "legacy-draft");
  const denied: KeyValueStorage = {
    getItem: (key) => storage.getItem(key),
    setItem: () => { throw new Error("quota"); },
    removeItem: (key) => {
      if (key === legacyKey) throw new Error("denied");
      storage.removeItem(key);
    },
  };

  removeInstanceStorageValue(logicalKey, "remote-a", denied);

  assert.equal(storage.values.get(currentKey), "current-draft");
  assert.equal(storage.values.get(legacyKey), "legacy-draft");
});

test("global keys migrate new-first while later writes use only the current name", () => {
  const key = "wollipog.deviceToken";
  const legacyKey = legacyBrowserStorageKey(key);
  storage.values.set(legacyKey, "legacy-token");

  assert.equal(loadBrowserStorageValue(key, storage), "legacy-token");
  assert.equal(storage.values.get(key), "legacy-token");
  assert.equal(storage.values.get(legacyKey), "legacy-token");
  storage.values.set(key, "new-wins");
  assert.equal(loadBrowserStorageValue(key, storage), "new-wins");

  saveBrowserStorageValue(key, "rotated", storage);
  assert.equal(storage.values.get(key), "rotated");
  assert.equal(storage.values.get(legacyKey), "legacy-token", "legacy compatibility input is read-only");
  removeBrowserStorageValue(key, storage);
  assert.equal(storage.values.has(key), false);
  assert.equal(storage.values.has(legacyKey), false);
  storage.values.set(legacyKey, "stale-after-delete");
  assert.equal(loadBrowserStorageValue(key, storage), null);
});

test("a clean global write introduces no MAM key", () => {
  assert.equal(saveBrowserStorageValue("wollipog.theme", "dark", storage), true);
  assert.equal(storage.values.get("wollipog.theme"), "dark");
  assert.equal([...storage.values.keys()].some((key) => key.startsWith("mam.")), false);
});

test("a failed replacement write preserves a legacy source until migration can retry", () => {
  const replacementKey = "wollipog.shelldock.visible";
  const oldPreferenceKey = "wollipog.shelldock.collapsed";
  const legacyOldPreferenceKey = legacyBrowserStorageKey(oldPreferenceKey);
  storage.values.set(legacyOldPreferenceKey, "0");
  const quotaLimited: KeyValueStorage = {
    getItem: (key) => storage.getItem(key),
    setItem: () => { throw new Error("quota"); },
    removeItem: (key) => storage.removeItem(key),
  };

  if (saveBrowserStorageValue(replacementKey, "1", quotaLimited)) {
    removeBrowserStorageValue(oldPreferenceKey, quotaLimited);
  }

  assert.equal(storage.values.get(legacyOldPreferenceKey), "0");
  assert.equal(storage.values.has(replacementKey), false);
});

test("instance writes report whether the current value was persisted", () => {
  assert.equal(saveInstanceStorageValue("wollipog.sessions.seen", "{}", "local", storage), true);
  const blocked: KeyValueStorage = {
    getItem: () => null,
    setItem: () => { throw new Error("quota"); },
    removeItem: () => {},
  };
  assert.equal(saveInstanceStorageValue("wollipog.sessions.seen", "{}", "local", blocked), false);
});

test("blocked storage remains best-effort", () => {
  const blocked: KeyValueStorage = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("quota"); },
    removeItem: () => { throw new Error("blocked"); },
  };

  assert.equal(loadBrowserStorageValue("wollipog.theme", blocked), null);
  assert.equal(loadInstanceStorageValue("wollipog.sessions.seen", LOCAL_INSTANCE_SCOPE, blocked), null);
  assert.equal(saveBrowserStorageValue("wollipog.theme", "dark", blocked), false);
  assert.doesNotThrow(() => removeBrowserStorageValue("wollipog.theme", blocked));
  assert.equal(saveInstanceStorageValue("wollipog.sessions.seen", "{}", LOCAL_INSTANCE_SCOPE, blocked), false);
  assert.doesNotThrow(() => removeInstanceStorageValue("wollipog.sessions.seen", LOCAL_INSTANCE_SCOPE, blocked));
});
