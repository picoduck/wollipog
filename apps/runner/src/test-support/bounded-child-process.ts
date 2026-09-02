import {
  execFileSync as nodeExecFileSync,
  spawnSync as nodeSpawnSync,
  type ExecFileSyncOptions,
  type SpawnSyncOptions,
} from "node:child_process";

/**
 * Drop-in replacements for the synchronous `node:child_process` helpers that apply a default
 * timeout.
 *
 * A synchronous spawn owns the event loop for its whole duration, so the test runner's
 * `--test-timeout` cannot interrupt one — its timer never gets to fire. That was verified while
 * fixing #545: a never-exiting child survived `--test-timeout=3000` well past a 15-second wall
 * clock and only died once the spawn itself carried a bound. The bound therefore has to live on
 * the call, and these wrappers are how the runner tests get it without repeating an option at
 * every call site.
 *
 * Import these instead of `node:child_process` in test files. A caller that passes its own
 * `timeout` or `killSignal` keeps it; the defaults only fill the gap.
 */

/**
 * Generous on purpose. These calls are short-lived local `git` and Node invocations that normally
 * finish in milliseconds, so this is a deadlock bound rather than a performance budget: it must
 * never fire for a merely slow-but-correct call on a loaded CI runner. It still fails a stuck
 * child fast enough to name the offending test, instead of letting the 30-minute CI job timeout
 * report nothing more specific than the whole job.
 */
export const TEST_CHILD_TIMEOUT_MS = 120_000;

/**
 * SIGTERM is catchable, and a child that installs a handler without exiting defeats the timeout
 * entirely: Node sends the kill signal at the deadline and then keeps waiting, so the synchronous
 * call never returns. Verified — with the default signal a SIGTERM-ignoring child ran past a
 * 15-second outer cap; with SIGKILL the same call returned in 2.0s. A deadline that a child can
 * decline is not a bound, so the default has to be non-ignorable.
 */
export const TEST_CHILD_KILL_SIGNAL = "SIGKILL";

/** Escape hatch for the test that pins the default path end-to-end; read per call, not at import. */
const TIMEOUT_OVERRIDE_ENV = "WOLLIPOG_TEST_CHILD_TIMEOUT_MS";

type BoundedOptions = {
  timeout?: number | undefined;
  killSignal?: NodeJS.Signals | number | undefined;
};

function defaultTimeoutMs(): number {
  const override = Number(process.env[TIMEOUT_OVERRIDE_ENV]);
  return Number.isFinite(override) && override > 0 ? override : TEST_CHILD_TIMEOUT_MS;
}

/** Exported so the defaults are pinned by a test rather than only implied by the wrappers. */
export function withDefaultTimeout<T extends object>(
  options: T | undefined,
): Omit<T, "timeout" | "killSignal"> & {
  timeout: number;
  killSignal: NodeJS.Signals | number;
} {
  const chosen = options as BoundedOptions | undefined;
  return {
    ...(options ?? ({} as T)),
    timeout: chosen?.timeout ?? defaultTimeoutMs(),
    killSignal: chosen?.killSignal ?? TEST_CHILD_KILL_SIGNAL,
  } as Omit<T, "timeout" | "killSignal"> & {
    timeout: number;
    killSignal: NodeJS.Signals | number;
  };
}

/**
 * Both native functions accept `(file, options)` as well as `(file, args, options)`. Passing the
 * options through as the third argument in the options-only case would be worse than doing
 * nothing: Node takes the second argument as the options and silently discards the third, so the
 * call would look bounded and not be. Splitting here keeps every overload bounded.
 */
function splitInvocation<O>(
  args: readonly string[] | O | undefined,
  options: O | undefined,
): { args: readonly string[]; options: O | undefined } {
  return Array.isArray(args)
    ? { args, options }
    : { args: [], options: (args as O | undefined) ?? options };
}

export const execFileSync = ((
  file: string,
  args?: readonly string[] | ExecFileSyncOptions,
  options?: ExecFileSyncOptions,
) => {
  const call = splitInvocation<ExecFileSyncOptions>(args, options);
  return nodeExecFileSync(file, call.args, withDefaultTimeout(call.options));
}) as typeof nodeExecFileSync;

export const spawnSync = ((
  file: string,
  args?: readonly string[] | SpawnSyncOptions,
  options?: SpawnSyncOptions,
) => {
  const call = splitInvocation<SpawnSyncOptions>(args, options);
  const result = nodeSpawnSync(file, call.args, withDefaultTimeout(call.options));
  const error = result.error as NodeJS.ErrnoException | undefined;

  // A timed-out spawnSync does not throw: it returns status null with error ETIMEDOUT. Several
  // callers assert `notEqual(result.status, 0)` to mean "the child rejected bad input" — and null
  // satisfies that, so a bound alone would quietly turn a hang into a passing test. execFileSync
  // already throws on timeout; this makes spawnSync agree. Only ETIMEDOUT is escalated, because
  // other spawn errors (ENOENT for a missing binary, say) are results some tests assert on, and
  // ETIMEDOUT could not occur at these call sites before a timeout existed.
  if (error?.code === "ETIMEDOUT") {
    error.message = `${error.message} (${file} ${call.args.join(" ")})`;
    throw error;
  }

  return result;
}) as typeof nodeSpawnSync;
