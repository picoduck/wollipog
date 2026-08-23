import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_EXPERIMENT_FLAGS,
  EXPERIMENT_TITLES,
  EXPERIMENTS_STORAGE_KEY,
  experimentForViewName,
  getExperimentFlags,
  parseExperimentFlags,
  resetExperimentFlagsForTest,
  setExperimentFlag,
  subscribeExperimentFlags,
} from "./experiments.js";
import { instanceStorageKey } from "./instance-storage.js";
import { GLOBAL_VIEW_ITEMS, SETTINGS_SECTIONS, viewFromPath, viewPath } from "./navigation.js";

/**
 * Experimental-feature flags.
 *
 * The contract that matters is CURRENT INSTALLS DO NOT CHANGE: with nothing stored, with
 * garbage stored, and with a value written by a future release that knows more flags, every
 * flag this release knows must come back at its default rather than off.
 */

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
}

beforeEach(() => {
  resetExperimentFlagsForTest();
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
});

test("nothing stored means every experiment stays at its default", () => {
  assert.deepEqual(parseExperimentFlags(null), DEFAULT_EXPERIMENT_FLAGS);
});

test("defaults preserve current behavior: everything the app renders today stays on", () => {
  // The flags EXISTING must not change what an untouched install shows. A default that hides
  // a surface would make this release a silent regression for everyone who never opens the tab.
  for (const [id, enabled] of Object.entries(DEFAULT_EXPERIMENT_FLAGS)) {
    assert.equal(enabled, true, `${id} must default on`);
  }
});

test("garbage and non-object payloads fall back to the defaults without throwing", () => {
  for (const raw of ["", "not json", "42", "\"pods\"", "null", "[]"]) {
    assert.deepEqual(parseExperimentFlags(raw), DEFAULT_EXPERIMENT_FLAGS, JSON.stringify(raw));
  }
});

test("unknown keys are ignored and missing keys keep their defaults", () => {
  // A DOWNGRADE path: a future release stores a flag this one does not know, alongside one it
  // does. The known flag must be honored and the unknown one must not corrupt the rest.
  const flags = parseExperimentFlags(JSON.stringify({ pods: false, warpDrive: false }));
  assert.equal(flags.pods, false);
  assert.equal(flags.multiAgent, true);
  assert.equal(flags.conductor, true);
});

test("non-boolean values for known keys are rejected key-by-key", () => {
  const flags = parseExperimentFlags(JSON.stringify({ pods: "off", multiAgent: false }));
  assert.equal(flags.pods, true, "a string is not a decision to hide a surface");
  assert.equal(flags.multiAgent, false);
});

test("a write round-trips through storage and notifies subscribers exactly once", () => {
  let notified = 0;
  const unsubscribe = subscribeExperimentFlags(() => { notified += 1; });
  setExperimentFlag("pods", false);
  assert.equal(notified, 1);
  assert.equal(getExperimentFlags().pods, false);
  const stored = localStorage.getItem(instanceStorageKey(EXPERIMENTS_STORAGE_KEY));
  assert.ok(stored, "the choice must survive a reload");
  assert.equal(parseExperimentFlags(stored).pods, false);
  unsubscribe();
  setExperimentFlag("pods", true);
  assert.equal(notified, 1, "an unsubscribed listener must not fire");
});

test("the snapshot is referentially stable between writes", () => {
  // useSyncExternalStore re-renders on every snapshot identity change; an unstable getter is an
  // infinite render loop, so stability is part of the store's contract rather than a nicety.
  assert.equal(getExperimentFlags(), getExperimentFlags());
  const before = getExperimentFlags();
  setExperimentFlag("conductor", false);
  assert.notEqual(getExperimentFlags(), before, "a write must produce a new snapshot");
});

test("flags are scoped per control-plane instance", () => {
  setExperimentFlag("pods", false, "local");
  assert.equal(getExperimentFlags("remote-instance").pods, true,
    "a remote instance must not inherit this device's local choices");
});

test("the list and detail views of a feature gate together", () => {
  assert.equal(experimentForViewName("runs"), "multiAgent");
  assert.equal(experimentForViewName("run"), "multiAgent");
  assert.equal(experimentForViewName("pods"), "pods");
  assert.equal(experimentForViewName("pod"), "pods");
  // Hiding /runs while /runs/~id still rendered would not be "off"; the inverse — gating a
  // view that has no experiment — would hide Inbox behind a switch nobody created.
  for (const name of ["inbox", "board", "projects", "session", "automations", "usage", "runners", "archived", "settings"] as const) {
    assert.equal(experimentForViewName(name), null, name);
  }
});

test("every gated global destination has a settings row title", () => {
  for (const item of GLOBAL_VIEW_ITEMS) {
    const experiment = experimentForViewName(item.name);
    if (experiment !== null) {
      assert.ok(EXPERIMENT_TITLES[experiment], `${item.name} needs a name the settings row can use`);
    }
  }
});

/**
 * The gating CONSUMERS, pinned at the source like settings-route.test.ts pins its topology.
 *
 * The behavioral tests above stay green if every gate is deleted, because the store and the
 * map are correct in isolation. What ties the flags to the UI is a handful of call sites, and
 * each one below failed a mental revert: remove it and a hidden feature quietly reappears on
 * that one surface while every other test still passes.
 */
const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

test("every surface that exposes a gated feature consults the flags", () => {
  const consumers: ReadonlyArray<[string, RegExp, string]> = [
    ["./components/Rail.tsx", /experimentForViewName/,
      "the rail must filter destinations, or a hidden feature keeps its row"],
    ["./components/CommandPalette.tsx", /experimentForViewName/,
      "the palette must filter destinations, or search reaches what the rail hides"],
    ["./App.tsx", /experimentForViewName\(destination\.name\)/,
      "the numbered shortcuts must consult the flags, or a hidden view stays one keypress away"],
    ["./App.tsx", /disabledExperimentView/,
      "a direct route into a hidden feature must render the notice, not the feature"],
    ["./App.tsx", /flags\.multiAgent[\s\S]{0,200}New Multi-Agent Run/,
      "the topbar create button is a creation surface and gates with its view"],
    ["./components/NewSessionDialog.tsx", /conductorExperimentEnabled/,
      "the conductor preset must gate, or New Session re-exposes the hidden experiment"],
    ["./components/AutomationsView.tsx", /multiAgentEnabled \|\| form\.actionKind === "workflow_run"/,
      "Automations must not OFFER workflow runs while multi-agent is off, but an automation already using one keeps rendering truthfully"],
    ["./components/Board.tsx", /multiAgentEnabled/,
      "the Board's empty-state hint must not point at a control the flags removed"],
    ["./components/ShortcutReference.tsx", /experimentFlags/,
      "the reference must mark a dead binding unavailable rather than advertise it"],
    ["./shortcuts.ts", /EXPERIMENT_SHORTCUT_IDS/,
      "the dead-binding map is the one list the reference reads"],
  ];
  for (const [path, pattern, why] of consumers) {
    assert.match(read(path), pattern, `${path}: ${why}`);
  }
});

test("conductor availability requires an ONLINE runner", () => {
  // The store keeps a disconnected runner's advertised agents; a row calling the conductor
  // available on the strength of a runner that cannot start anything would be a false claim.
  assert.match(read("./App.tsx"),
    /runner\.status === "online" && conductorAgentId/,
    "the availability predicate must not count offline runners");
});

test("the Experimental section is a route like its siblings", () => {
  assert.ok(SETTINGS_SECTIONS.some((section) => section.id === "experimental"),
    "the section must exist in the one list the nav, routes, and palette derive from");
  assert.equal(viewPath({ name: "settings", section: "experimental" }), "/settings/experimental");
  assert.deepEqual(viewFromPath("/settings/experimental"), { name: "settings", section: "experimental" });
});
