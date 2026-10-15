import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { RETURN_QUIET_MS } from "./history-position.js";
import { registerLeaveGuard } from "./leave-guard.js";
import { BrowserNavigation, viewFromPath, viewPath, type View } from "./navigation.js";
import { Store } from "./store.js";
import { TestBrowserHistory } from "./test-browser-history.js";

const EDITOR = "/settings/orchestrator";
const OTHERS = ["/usage", "/runs", "/pods", "/automations", "/archived", "/skills", "/projects"];

/** One step: the person presses Back or Forward `delta` entries, or the browser lands the app's next move, or time passes. */
type Step = { kind: "person"; delta: number } | { kind: "land" } | { kind: "wait" };

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.integer({ min: -3, max: 3 }).filter((delta) => delta !== 0).map((delta) => ({ kind: "person" as const, delta })),
  fc.constant({ kind: "land" as const }),
  fc.constant({ kind: "wait" as const }),
);

test("however the person's moves and the app's interleave, a dirty editor never leaves unasked and the history settles (#3218)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  fc.assert(fc.property(
    fc.integer({ min: 2, max: OTHERS.length }),
    fc.nat(),
    fc.boolean(),
    fc.array(step, { maxLength: 14 }),
    fc.boolean(),
    (count, at, reload, steps, discard) => {
      const editorIndex = at % (count + 1);
      const paths = [...OTHERS.slice(0, count)];
      paths.splice(editorIndex, 0, EDITOR);
      const browser = new TestBrowserHistory(paths[0]!);
      let navigation = new BrowserNavigation(browser.window);
      let store = new Store(navigation.current(), (view) => navigation.push(view));
      for (const path of paths.slice(1)) store.navigate(viewFromPath(path)!);
      let stop = navigation.listen((view, traversal) => store.navigateFromHistory(view, traversal));
      browser.traverse(editorIndex - (paths.length - 1));
      if (reload) {
        // A reload keeps the entries and their positions; the new page cannot see the ones ahead.
        stop();
        navigation = new BrowserNavigation(browser.window);
        store = new Store(navigation.current(), (view) => navigation.push(view));
        stop = navigation.listen((view, traversal) => store.navigateFromHistory(view, traversal));
      }
      const current = store;
      assert.equal(browser.path, EDITOR);
      assert.equal(viewPath(current.getState().view), EDITOR);

      const asks: Array<() => void> = [];
      const release = registerLeaveGuard((leave) => {
        // Not also "no move of the app's still on its way": a move of the person's that lands exactly
        // where the app's would is indistinguishable from it. The app's move then arrives as a new
        // move, which is held in turn, so the editor still never leaves unasked.
        assert.equal(browser.path, EDITOR, "asked on the editor's own entry");
        asks.push(leave);
      });
      const editorShown = () => assert.equal(viewPath(current.getState().view), EDITOR, "the editor stays until the person leaves");
      try {
        for (const next of steps) {
          if (next.kind === "person") browser.traverse(next.delta);
          else if (next.kind === "land") { const delta = browser.pending.shift(); if (delta !== undefined) browser.traverse(delta); }
          else t.mock.timers.tick(RETURN_QUIET_MS);
          editorShown();
        }
        // Let everything land, waiting out any move that lands nowhere.
        for (let round = 0; round < 200; round += 1) {
          if (browser.pending.length > 0) browser.traverse(browser.pending.shift()!);
          else t.mock.timers.tick(RETURN_QUIET_MS);
          editorShown();
        }
        assert.deepEqual(browser.pending, [], "the history settles");
        assert.equal(browser.path, EDITOR, "back on the editor's entry");
        if (steps.some((next) => next.kind === "person" && editorIndex + next.delta >= 0 && editorIndex + next.delta <= count)) {
          assert.ok(asks.length > 0, "a move away was asked about");
        }
        if (discard && asks.length > 0) {
          asks[0]!();
          for (let round = 0; round < 200 && browser.pending.length > 0; round += 1) browser.traverse(browser.pending.shift()!);
          assert.equal(viewPath(current.getState().view), browser.path, "leaving shows where the history went");
        }
      } finally {
        release();
        stop();
        // Settle anything still running so no timer outlives this run.
        for (let round = 0; round < 200; round += 1) {
          if (browser.pending.length > 0) browser.traverse(browser.pending.shift()!);
          else t.mock.timers.tick(RETURN_QUIET_MS);
        }
      }
    },
  ), { numRuns: 400 });
});
