import { afterEach } from "node:test";

/**
 * Minimal shape of the happy-dom window these tests build. Typed structurally rather than imported
 * so this helper does not force a happy-dom dependency on anything that only needs the contract.
 */
interface DomTestWindow {
  document: { body: { innerHTML: string } };
  happyDOM: { abort: () => Promise<void> | void };
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
 * because these files share one module-level window across every test in them.
 *
 * Register a disposer with the returned `cleanup` when a fixture owns something `abort()` cannot
 * reach, such as a spy that must be restored. Disposers run before the abort, newest first, and one
 * that throws does not stop the rest — the whole point is that cleanup completes unconditionally.
 */
export function installDomTestCleanup(domWindow: DomTestWindow): { cleanup: (dispose: () => void | Promise<void>) => void } {
  const disposers: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    const failures: unknown[] = [];
    try {
      // `splice` first so a disposer that throws cannot be retried, and reverse so the newest
      // fixture unwinds before whatever it was layered on.
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          await dispose();
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      // Runs whatever the disposers did, because this is the part that actually stops the clock.
      await domWindow.happyDOM.abort();
      domWindow.document.body.innerHTML = "";
    }
    // A disposer that genuinely broke is still a failure — reported after cleanup, not instead of
    // it. Node reports the test body's own assertion error in preference to this one.
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "DOM test disposers failed");
  });

  return { cleanup: (dispose) => { disposers.push(dispose); } };
}
