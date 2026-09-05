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
 * because these files share one module-level window across every test in them.
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
