import assert from "node:assert/strict";
import test from "node:test";
import { runDomTestCleanup } from "./dom-test-cleanup.js";

interface Probe {
  cleared: number;
  resets: number;
  window: { document: { body: { innerHTML: string } }; happyDOM: { abort: () => void } };
}

function probe({ abortFails = false }: { abortFails?: boolean } = {}): Probe {
  const state = { cleared: 0, resets: 0 } as Probe;
  state.window = {
    document: {
      body: {
        set innerHTML(_value: string) { state.cleared += 1; },
        get innerHTML() { return ""; },
      },
    },
    happyDOM: { abort: () => { if (abortFails) throw new Error("abort failed"); } },
  };
  return state;
}

const message = (error: unknown) => (error as Error).message;

test("a rejecting abort does not skip the body clear or the reset", async () => {
  const state = probe({ abortFails: true });
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

test("every failure survives when the disposer, the abort and the reset all fail", async () => {
  const state = probe({ abortFails: true });
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

test("a clean drain reports nothing and still finalizes", async () => {
  const state = probe();
  const failures = await runDomTestCleanup(state.window as never, [], { reset: () => { state.resets += 1; } });
  assert.deepEqual(failures, []);
  assert.equal(state.cleared, 1);
  assert.equal(state.resets, 1);
});
