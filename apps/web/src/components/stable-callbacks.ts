import { useInsertionEffect, useRef } from "react";

type Callback = (...args: never[]) => unknown;

/** Calls `callback`, when there is one, with `args`. */
function invoke(callback: Callback | undefined, args: never[]): unknown {
  return callback?.(...args);
}

/**
 * `props` with every callback replaced by a function that keeps its identity across renders and
 * calls the callback of the latest committed render. A memoized child then does not render merely
 * because its parent made new closures (#2872). A callback that is absent stays absent, so the child
 * still sees which actions exist.
 *
 * The callbacks are taken at commit, before any layout effect, so an event never reaches a render
 * that was not committed (one React set aside for a more urgent update) and no effect, a child's
 * included, sees a callback older than its own render. Once a callback is absent, its function
 * keeps calling the last one it stood for, which is what an effect's cleanup holding it expects.
 */
export function useStableCallbacks<T extends object>(props: T): T {
  const committed = useRef(new Map<string, Callback>());
  const stable = useRef(new Map<string, Callback>());
  useInsertionEffect(() => {
    for (const [key, value] of Object.entries(props)) {
      if (typeof value === "function") committed.current.set(key, value as Callback);
    }
  });
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value !== "function") {
      result[key] = value;
      continue;
    }
    let callback = stable.current.get(key);
    if (!callback) {
      // Nothing can call it before the render that hands it out commits.
      callback = (...args: never[]) => invoke(committed.current.get(key), args);
      stable.current.set(key, callback);
    }
    result[key] = callback;
  }
  return result as T;
}
