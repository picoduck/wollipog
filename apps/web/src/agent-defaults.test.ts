import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { loadAgentDefaults, parseAgentDefaults, saveAgentDefault } from "./agent-defaults.js";

const writes: [string, string][] = [];
const backing = new Map<string, string>();
function installStorage(): void {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push([key, value]);
      backing.set(key, value);
    },
    removeItem: (key: string) => void backing.delete(key),
  };
}

beforeEach(() => {
  writes.length = 0;
  backing.clear();
  installStorage();
});

test("parseAgentDefaults accepts only a string-to-string preference map", () => {
  assert.deepEqual(parseAgentDefaults('{"runner-1":"codex","runner-2":"codex-exec"}'), {
    "runner-1": "codex",
    "runner-2": "codex-exec",
  });
  assert.deepEqual(parseAgentDefaults('{"runner-1":3,"":"codex","ok":""}'), {});
  assert.deepEqual(parseAgentDefaults("not json"), {});
  assert.deepEqual(parseAgentDefaults(null), {});
});

test("saveAgentDefault preserves other runners and persists the explicit choice", () => {
  const next = saveAgentDefault({ old: "claude" }, "runner-1", "codex");
  assert.deepEqual(next, { old: "claude", "runner-1": "codex" });
  const scoped = writes.find(([key]) => key.startsWith("wollipog.instance.v1:"));
  assert.ok(scoped);
  assert.deepEqual(JSON.parse(scoped[1]), next);
});

test("blocked localStorage remains a best-effort preference", () => {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("quota"); },
  };
  assert.deepEqual(loadAgentDefaults(), {});
  assert.doesNotThrow(() => saveAgentDefault({ old: "claude" }, "runner-1", "codex"));
});

test("identical runner ids retain different defaults per instance", () => {
  saveAgentDefault({}, "runner-1", "codex", "local");
  saveAgentDefault({}, "runner-1", "claude", "remote-alpha");
  saveAgentDefault({}, "runner-1", "gemini", "remote-beta");
  assert.deepEqual(loadAgentDefaults("local"), { "runner-1": "codex" });
  assert.deepEqual(loadAgentDefaults("remote-alpha"), { "runner-1": "claude" });
  assert.deepEqual(loadAgentDefaults("remote-beta"), { "runner-1": "gemini" });
});

test("legacy agent defaults migrate only into Local", () => {
  backing.set("mam.newSession.agentDefaults", '{"runner-1":"codex"}');
  assert.deepEqual(loadAgentDefaults("remote-alpha"), {});
  assert.deepEqual(loadAgentDefaults("local"), { "runner-1": "codex" });
  assert.equal(backing.has("mam.newSession.agentDefaults"), true, "copy-forward retains rollback data");
  assert.ok([...backing.keys()].some((key) => key.startsWith("wollipog.instance.v1:")));
});
