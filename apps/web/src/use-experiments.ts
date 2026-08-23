import { useCallback, useSyncExternalStore } from "react";
import {
  getExperimentFlags,
  setExperimentFlag,
  subscribeExperimentFlags,
  type ExperimentFlags,
  type ExperimentId,
} from "./experiments.js";
import { useInstanceScope } from "./instance-scope.js";

/**
 * The active instance's experiment flags, live across every subscriber on the page.
 *
 * A hook over a module store rather than a provider: the flags are read from the shell, the
 * rail, the palette, and dialogs alike, and threading a context past all of them adds a
 * provider whose only job would be to forward a module-level value.
 */
export function useExperiments(): { flags: ExperimentFlags; setFlag: (id: ExperimentId, enabled: boolean) => void } {
  const instanceScope = useInstanceScope();
  // The server snapshot is the same getter: tests renderToString these components, and the
  // store already returns a stable object per scope, so both environments read one value.
  const flags = useSyncExternalStore(
    subscribeExperimentFlags,
    () => getExperimentFlags(instanceScope),
    () => getExperimentFlags(instanceScope),
  );
  const setFlag = useCallback(
    (id: ExperimentId, enabled: boolean) => setExperimentFlag(id, enabled, instanceScope),
    [instanceScope],
  );
  return { flags, setFlag };
}
