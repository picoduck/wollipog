import { afterEach } from "node:test";

/**
 * Minimal shape of the happy-dom window these tests build. Typed structurally rather than imported
 * so this helper does not force a happy-dom dependency on anything that only needs the contract.
 */
interface DomTestWindow {
  document: { body: { innerHTML: string } };
  happyDOM: { abort: () => Promise<void> | void };
}

// Captured at import, like happy-dom's own timer table, so a test that swaps or mocks the global
// `setTimeout` cannot change which clock the settle below reads. It must be the SAME Node clock
// happy-dom schedules on: the settle's reasoning rests on two 0ms Node timers firing in the order
// they were created.
const nodeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nodeTick = () => new Promise<void>((resolve) => { nodeSetTimeout(resolve, 0); });

/** Rounds of zero-delay timers queued by zero-delay timers before the settle gives up. */
export const ZERO_DELAY_SETTLE_ROUNDS = 10;

/**
 * The window's real `setTimeout`, read from its prototype rather than the instance: tests swap
 * `domWindow.setTimeout` for a fake (`EventTimeline.anchor-race.dom.test.tsx` does so for the whole
 * file), and only the real method holds the zero-delay batch the settle has to flush. A structural
 * stand-in with no such method has no batch, and gets `undefined`.
 */
function realWindowSetTimeout(domWindow: object): ((callback: () => void) => void) | undefined {
  const method: unknown = Reflect.get(Object.getPrototypeOf(domWindow) ?? {}, "setTimeout");
  if (typeof method !== "function") return undefined;
  return (callback) => { method.call(domWindow, callback, 0); };
}

/**
 * Wraps the window's own `setTimeout` (the real one, or a test's fake) so every zero-delay call
 * through it is reported, until the returned function puts it back. The delay test is happy-dom's
 * own, `!delay`, so exactly the calls it would batch are counted. A test that swapped in another
 * `setTimeout` meanwhile keeps it.
 */
function countZeroDelayCalls(domWindow: object, onZeroDelay: () => void): () => void {
  const original = Object.getOwnPropertyDescriptor(domWindow, "setTimeout");
  if (!original || typeof original.value !== "function" || !original.writable) return () => {};
  const inner = original.value as (...args: unknown[]) => unknown;
  function counted(this: unknown, ...args: unknown[]): unknown {
    if (!args[1]) onZeroDelay();
    return inner.apply(this, args);
  }
  Object.defineProperty(domWindow, "setTimeout", { ...original, value: counted });
  return () => {
    if (Object.getOwnPropertyDescriptor(domWindow, "setTimeout")?.value === counted) {
      Object.defineProperty(domWindow, "setTimeout", original);
    }
  };
}

/**
 * Lets every pending zero-delay window timer fire, so that the abort after it cannot strand one.
 *
 * happy-dom 20 groups zero-delay `setTimeout` calls into one batch behind a single Node timer, and
 * forgets the batch only when that timer fires. `abort()` clears the timer but not the batch, so
 * after an abort that caught one pending, every later zero-delay timer joins a batch nothing will
 * ever flush — for the rest of the file, since these files share one window. Timers of 1ms or more
 * take another path and survive, which is why this read as a flaky test and not a dead clock
 * (#2113). The batch is private, so the only repair is to never abort while one is pending.
 *
 * Each round schedules a Node tick and THEN a zero-delay sentinel. Both are 0ms Node timers, which
 * fire in creation order, so if the sentinel has fired by the tick, it joined a batch that was
 * already pending, and that batch has now flushed — but its callbacks may have queued another, so
 * go round again. If it has not, nothing was pending and the sentinel opened a batch of its own,
 * which must flush too before the abort, or the settle strands the very thing it guards against.
 * A sentinel that still has not fired after that joined a batch some earlier abort already killed.
 *
 * The settle yields to the event loop, so other work runs meanwhile: an animation frame, a 2ms
 * timer, I/O. Whatever of it queues zero-delay work may join the sentinel's own batch, or open a
 * new one after it, so a flush of the sentinel's batch alone proves nothing (cross-model review
 * rounds 1 and 2). The batch is private and cannot be probed without opening one, so the settle
 * counts instead: it wraps the window's own `setTimeout` for its duration, and a round is quiet only
 * if its sentinel opened the batch and no one queued zero-delay work until that batch flushed. Any
 * other round goes again. Only a caller holding a `setTimeout` it read before the settle, and using
 * it during the settle, gets past the count.
 *
 * The pending callbacks RUN rather than being cancelled: the batch holds them privately, so there is
 * no way to cancel one without its `Timeout`. It is also what a browser does after an unmount, and
 * why this runs after the disposers — a dialog's focus restore scheduled by its own unmount is
 * exactly the kind of timer that was being stranded.
 */
export async function settleZeroDelayWindowTimers(domWindow: object): Promise<void> {
  const setZeroDelay = realWindowSetTimeout(domWindow);
  if (!setZeroDelay) return;
  let queued = 0;
  const stopCounting = countZeroDelayCalls(domWindow, () => { queued += 1; });
  try {
    for (let round = 0; round < ZERO_DELAY_SETTLE_ROUNDS; round += 1) {
      queued = 0;
      let fired = false;
      let markFlushed!: () => void;
      const flushed = new Promise<boolean>((resolve) => { markFlushed = () => resolve(true); });
      const tick = nodeTick();
      setZeroDelay(() => { fired = true; markFlushed(); });
      await tick;
      if (fired) continue;
      // Return from the sentinel batch's own flush, NOT from a later tick, which would let a longer
      // timer queue more after it. The tick only bounds the wait for a batch that is already dead.
      if (!await Promise.race([flushed, nodeTick().then(() => false)])) {
        throw new Error(
          "Zero-delay window timers had stopped firing before this cleanup ran: the window was aborted "
          + "while one was pending, and happy-dom never flushes that batch again (#2113).",
        );
      }
      if (queued === 0) return;
    }
  } finally {
    stopCounting();
  }
  throw new Error(
    `Zero-delay window timers were still queueing more after ${ZERO_DELAY_SETTLE_ROUNDS} rounds. `
    + "Aborting now would leave every later zero-delay window timer in this file dead (#2113).",
  );
}

/**
 * The drain itself, exported so its failure handling can be tested without a `node:test` hook.
 *
 * Round three of this PR's review found the guarded-finalizer fix MISSING from a commit whose
 * message claimed it — an unrelated `git checkout` had taken it back and nothing caught that. A
 * commit message is not evidence. This is what makes the behaviour checkable.
 */
export async function runDomTestCleanup(
  domWindow: DomTestWindow,
  disposers: Array<() => void | Promise<void>>,
  options: { reset?: () => void } = {},
): Promise<unknown[]> {
  const failures: unknown[] = [];
  try {
    // `splice` first so a disposer that throws cannot be retried, and reverse so the newest fixture
    // unwinds before whatever it was layered on.
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        await dispose();
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    // Every finalizer is guarded, and none may skip the ones after it. Same shape as the disposer
    // loop, for the same reason: an unguarded `abort()` rejection would skip the body clear and the
    // reset, and a throw inside a `finally` REPLACES the failures collected above rather than adding
    // to them — losing the very error the run was reporting.
    for (const finalize of [
      () => settleZeroDelayWindowTimers(domWindow),
      () => domWindow.happyDOM.abort(),
      () => { domWindow.document.body.innerHTML = ""; },
      () => options.reset?.(),
    ]) {
      try {
        await finalize();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  return failures;
}

/**
 * Guarantees that a DOM test file cannot outlive its own tests.
 *
 * A test that mounts `StoreProvider` starts the store's shared stall clock: a `setTimeout` that
 * reschedules itself every `ACTIVITY_BUCKET_MS` and is cleaned up only by that effect's teardown.
 * Every one of these files tore down as the closing statements of each test body, so an assertion
 * that threw skipped it, the clock kept rescheduling, and the process could not exit. The symptom
 * was not a slow test but a misleading one: a plain assertion failure presented as a hung suite,
 * for minutes, past the `--test-timeout` that is supposed to bound it (#680, #690).
 *
 * `happyDOM.abort()` cancels every task the window still has pending, which is strictly more than
 * React teardown would have reached — it also catches a timer leaked by any other route. Measured:
 * it stops a self-rescheduling timer and leaves the window usable for the next test, which matters
 * because these files share one module-level window across every test in them. The one exception
 * is a pending zero-delay timer, which an abort leaves the window unable to run ever again, so the
 * drain lets those fire first (`settleZeroDelayWindowTimers`).
 *
 * Register a disposer with the returned `cleanup` when a fixture owns something `abort()` cannot
 * reach, such as a spy that must be restored. Disposers run before the abort, newest first, and one
 * that throws does not stop the rest — the whole point is that cleanup completes unconditionally.
 *
 * Pass `reset` for per-test state that must be restored no matter what, such as a module-level
 * viewport flag. It belongs here rather than in the file's own `afterEach`, because Node SKIPS every
 * later `afterEach` once one throws: a reset registered separately would be silently dropped in
 * exactly the failure this helper exists to survive.
 */
export function installDomTestCleanup(
  domWindow: DomTestWindow,
  options: { reset?: () => void } = {},
): { cleanup: (dispose: () => void | Promise<void>) => void } {
  const disposers: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    const failures = await runDomTestCleanup(domWindow, disposers, options);
    // Cleanup that genuinely broke is still a failure — reported after cleanup, not instead of it.
    // Node reports the test body's own assertion error in preference to this one.
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "DOM test cleanup failed");
  });

  return { cleanup: (dispose) => { disposers.push(dispose); } };
}
