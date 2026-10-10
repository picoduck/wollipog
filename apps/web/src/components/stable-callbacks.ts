import { useRef } from "react";

type Callback = (...args: never[]) => unknown;

/** Calls `callback`, when there is one, with `args`. */
function invoke(callback: Callback | undefined, args: never[]): unknown {
  return callback?.(...args);
}

/**
 * `props` with every callback replaced by a function that keeps its identity across renders and
 * calls the callback of the latest render. A memoized child then does not render merely because its
 * parent made new closures (#2872). A callback that is absent stays absent, so the child still sees
 * which actions exist.
 */
export function useStableCallbacks<T extends object>(props: T): T {
  const latest = useRef(props);
  latest.current = props;
  const stable = useRef(new Map<string, Callback>());
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value !== "function") {
      result[key] = value;
      continue;
    }
    let callback = stable.current.get(key);
    if (!callback) {
      callback = (...args: never[]) => invoke((latest.current as Record<string, Callback | undefined>)[key], args);
      stable.current.set(key, callback);
    }
    result[key] = callback;
  }
  return result as T;
}
