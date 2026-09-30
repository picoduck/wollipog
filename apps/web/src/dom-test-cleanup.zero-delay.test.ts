import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import {
  installDomTestCleanup,
  runDomTestCleanup,
  settleZeroDelayWindowTimers,
  ZERO_DELAY_SETTLE_ROUNDS,
} from "./dom-test-cleanup.js";

/**
 * Pins #2113: happy-dom batches zero-delay window timers behind one Node timer, and an abort that
 * caught a batch pending left every later zero-delay timer in the file dead. Each case below fails
 * without the settle in `runDomTestCleanup`.
 */

const nodeSetTimeout = globalThis.setTimeout.bind(globalThis);

/** Whether a window timer of `delay` fires within a second — long enough, and short of a hang. */
function fires(target: Window, delay: number): Promise<boolean> {
  return Promise.race([
    new Promise<boolean>((resolve) => { target.setTimeout(() => resolve(true), delay); }),
    new Promise<boolean>((resolve) => { nodeSetTimeout(() => resolve(false), 1000); }),
  ]);
}

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);

// The issue's reproduction, verbatim. These two are order-dependent by design: the first leaves the
// shared window in the state the shared cleanup used to break.
test("a test that ends with a zero-delay window timer still pending", () => {
  domWindow.setTimeout(() => {}, 0);
});

test("the next test's zero-delay window timers still fire", async () => {
  assert.equal(await fires(domWindow, 1), true, "a 1ms window timer fires");
  assert.equal(await fires(domWindow, 0), true, "a zero-delay window timer fires");
});

test("a pending zero-delay timer that queues another does not strand the second", async () => {
  // Catches a settle that flushes one batch and stops: the callback opens a new batch while the
  // first one is flushing, and the abort would catch that one instead.
  const own = new Window({ url: "http://localhost/" });
  own.setTimeout(() => { own.setTimeout(() => { own.setTimeout(() => {}, 0); }, 0); }, 0);

  assert.deepEqual(await runDomTestCleanup(own, []), []);
  assert.equal(await fires(own, 0), true);
});

test("a zero-delay timer a disposer schedules is settled too", async () => {
  // The #2113 shape: a dialog's unmount queues its focus restore. The settle must come after the
  // disposers, not before them.
  const own = new Window({ url: "http://localhost/" });
  let restored = false;
  const failures = await runDomTestCleanup(own, [() => { own.setTimeout(() => { restored = true; }, 0); }]);

  assert.deepEqual(failures, []);
  assert.equal(restored, true, "the unmount's timer runs before the abort");
  assert.equal(await fires(own, 0), true);
});

test("a test that swaps the window's setTimeout for a fake still gets the real batch settled", async () => {
  // Catches reading `domWindow.setTimeout` instead of the prototype's: a fake installed after a real
  // zero-delay timer was queued would take the sentinel, and the real batch would still be aborted.
  const own = new Window({ url: "http://localhost/" });
  own.setTimeout(() => {}, 0);
  const real = own.setTimeout;
  own.setTimeout = (() => 0) as unknown as typeof own.setTimeout;

  assert.deepEqual(await runDomTestCleanup(own, []), []);
  own.setTimeout = real;
  assert.equal(await fires(own, 0), true);
});

test("a window an earlier abort already broke is reported, not waited on", async () => {
  const own = new Window({ url: "http://localhost/" });
  own.setTimeout(() => {}, 0);
  await own.happyDOM.abort();

  await assert.rejects(settleZeroDelayWindowTimers(own), /had stopped firing before this cleanup ran/u);
});

test("a zero-delay timer that keeps rescheduling itself is reported after a bounded number of rounds", async () => {
  const own = new Window({ url: "http://localhost/" });
  let runs = 0;
  const spin = () => { runs += 1; own.setTimeout(spin, 0); };
  own.setTimeout(spin, 0);

  try {
    await assert.rejects(settleZeroDelayWindowTimers(own), /still queueing more after 10 rounds/u);
    assert.equal(runs, ZERO_DELAY_SETTLE_ROUNDS);
  } finally {
    // Stops the spin even when the settle regresses, or it would hold the file open forever.
    await own.happyDOM.abort();
  }
});

test("a structural stand-in with no window prototype is left alone", async () => {
  await settleZeroDelayWindowTimers({ document: { body: { innerHTML: "" } } });
});
