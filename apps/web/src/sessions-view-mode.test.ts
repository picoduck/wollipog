import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  loadSessionsViewMode,
  saveSessionsViewMode,
  sessionsDestination,
  sessionsViewModeForView,
} from "./sessions-view-mode.js";

/** instance-storage reads the bare `localStorage` global; give the suite an isolated one. */
const priorLocalStorage = (globalThis as Record<string, unknown>)["localStorage"];
const backing = new Map<string, string>();
before(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
      removeItem: (key: string) => void backing.delete(key),
    },
  });
});
after(() => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: priorLocalStorage });
});

test("the persisted mode defaults to list and round-trips per instance", () => {
  backing.clear();
  assert.equal(loadSessionsViewMode(), "list", "an absent preference is the pre-#499 list behavior");
  assert.deepEqual(sessionsDestination(), { name: "inbox" });

  saveSessionsViewMode("board");
  assert.equal(loadSessionsViewMode(), "board");
  assert.deepEqual(sessionsDestination(), { name: "board" });
  assert.equal(loadSessionsViewMode("remote-1"), "list", "instances do not share the preference");

  saveSessionsViewMode("list", "remote-1");
  saveSessionsViewMode("board");
  assert.equal(loadSessionsViewMode("remote-1"), "list");
  assert.deepEqual(sessionsDestination("remote-1"), { name: "inbox" });
});

test("a corrupt stored value falls back to list", () => {
  backing.clear();
  saveSessionsViewMode("board");
  for (const [key, value] of backing) {
    if (value === "board") backing.set(key, "kanban");
  }
  assert.equal(loadSessionsViewMode(), "list");
});

test("only the two Sessions modes record a last-used mode", () => {
  assert.equal(sessionsViewModeForView({ name: "inbox" }), "list");
  assert.equal(sessionsViewModeForView({ name: "board" }), "board");
  // An expanded session records nothing: opening a session from the board must not flip the
  // preference and strand the eventual back-navigation in the list.
  assert.equal(sessionsViewModeForView({ name: "session" }), null);
  assert.equal(sessionsViewModeForView({ name: "projects" }), null);
  assert.equal(sessionsViewModeForView({ name: "settings" }), null);
});
