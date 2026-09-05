import assert from "node:assert/strict";
import test from "node:test";
import { runDomTestCleanup } from "./dom-test-cleanup.js";

/**
 * Pins the drain's failure handling directly, because round three of this PR's review found the
 * guarded-finalizer fix missing from a commit whose message claimed it: nothing in the suite could
 * tell the two states apart. Round four then found three more ways these very tests could stay
 * green while the guarantee vanished, so each case below names the mutation it is meant to catch.
 */
interface Probe {
  aborts: number;
  cleared: number;
  resets: number;
  window: { document: { body: { innerHTML: string } }; happyDOM: { abort: () => Promise<void> } };
}

function probe({ abortRejects = false, clearThrows = false } = {}): Probe {
  const state = { aborts: 0, cleared: 0, resets: 0 } as Probe;
  state.window = {
    document: {
      body: {
        set innerHTML(_value: string) {
          if (clearThrows) throw new Error("clear failed");
          state.cleared += 1;
        },
        get innerHTML() { return ""; },
      },
    },
    happyDOM: {
      // Rejects ASYNCHRONOUSLY, like the real API. A synchronous throw here would let the drain
      // drop its `await` and still pass, while a real rejection escaped the failure array entirely.
      abort: async () => {
        state.aborts += 1;
        if (abortRejects) throw new Error("abort failed");
      },
    },
  };
  return state;
}

const message = (error: unknown) => (error as Error).message;

test("a rejecting abort does not skip the body clear or the reset", async () => {
  const state = probe({ abortRejects: true });
  const failures = await runDomTestCleanup(
    state.window as never,
    [() => { throw new Error("disposer failed"); }],
    { reset: () => { state.resets += 1; } },
  );

  assert.equal(state.cleared, 1, "the body clear must run even after abort rejects");
  assert.equal(state.resets, 1, "the reset must run even after abort rejects");
  assert.deepEqual(failures.map(message), ["disposer failed", "abort failed"]);
});

test("a throwing reset adds its failure instead of replacing the ones before it", async () => {
  const state = probe();
  const failures = await runDomTestCleanup(
    state.window as never,
    [() => { throw new Error("disposer failed"); }],
    { reset: () => { throw new Error("reset failed"); } },
  );

  assert.equal(state.cleared, 1);
  assert.deepEqual(
    failures.map(message),
    ["disposer failed", "reset failed"],
    "the disposer failure must survive a later reset failure",
  );
});

test("a throwing body clear does not skip the reset or swallow earlier failures", async () => {
  // Catches removing the guard around `innerHTML = ""` specifically: the setter is the one
  // finalizer that cannot fail on its own, so nothing else here would notice.
  const state = probe({ clearThrows: true });
  const failures = await runDomTestCleanup(
    state.window as never,
    [() => { throw new Error("disposer failed"); }],
    { reset: () => { state.resets += 1; } },
  );

  assert.equal(state.resets, 1, "the reset must run even after the body clear throws");
  assert.deepEqual(failures.map(message), ["disposer failed", "clear failed"]);
});

test("every failure survives when the disposer, the abort and the reset all fail", async () => {
  const state = probe({ abortRejects: true });
  const failures = await runDomTestCleanup(
    state.window as never,
    [() => { throw new Error("disposer failed"); }],
    { reset: () => { throw new Error("reset failed"); } },
  );

  assert.equal(state.cleared, 1, "the body clear sits between two failing finalizers and must run");
  assert.deepEqual(failures.map(message), ["disposer failed", "abort failed", "reset failed"]);
});

test("one failing disposer does not strand the disposers registered before it", async () => {
  const state = probe();
  const order: string[] = [];
  const failures = await runDomTestCleanup(
    state.window as never,
    [() => { order.push("older"); }, () => { throw new Error("newer failed"); }],
    {},
  );

  assert.deepEqual(order, ["older"], "the older disposer runs even though the newer one threw");
  assert.deepEqual(failures.map(message), ["newer failed"]);
});

test("a clean drain still aborts, clears and resets", async () => {
  // Catches an implementation that finalizes only when something already failed. Every other case
  // here has a failing disposer, so without this one, abort-on-the-happy-path — the whole point of
  // the helper — would be unpinned.
  const state = probe();
  const failures = await runDomTestCleanup(state.window as never, [], { reset: () => { state.resets += 1; } });

  assert.deepEqual(failures, []);
  assert.equal(state.aborts, 1, "a clean test must still abort the window's pending tasks");
  assert.equal(state.cleared, 1);
  assert.equal(state.resets, 1);
});
