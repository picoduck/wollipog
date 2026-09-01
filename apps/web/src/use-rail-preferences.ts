import { useSyncExternalStore } from "react";
import {
  getRailPreferences,
  subscribeRailPreferences,
  type RailPreferences,
} from "./rail-preferences.js";
import { useInstanceScope } from "./instance-scope.js";

/**
 * The active instance's rail preferences, live across every subscriber on the page.
 *
 * A hook over a module store rather than a provider, for the same reason as useExperiments:
 * the rail, the shell's digit handlers, the shortcut reference, and Settings all read this,
 * and it carries no render-scoped state of its own.
 */
export function useRailPreferences(): RailPreferences {
  const instanceScope = useInstanceScope();
  return useSyncExternalStore(
    subscribeRailPreferences,
    () => getRailPreferences(instanceScope),
    () => getRailPreferences(instanceScope),
  );
}
