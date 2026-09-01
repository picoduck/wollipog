import { useEffect } from "react";
import type { View } from "./navigation.js";
import { saveSessionsViewMode, sessionsViewModeForView } from "./sessions-view-mode.js";

/**
 * Records whichever Sessions mode is current as the destination's last-used mode.
 *
 * The route is the source of truth, so every entry path — toggle, `b`, digit, palette, deep
 * link — funnels through here, and an expanded session deliberately records nothing (see
 * sessions-view-mode.ts). Shared with the sessions-board e2e harness so the spec pins the
 * hook the app shell actually mounts, not a fixture copy (#527).
 */
export function useSessionsViewModeMemory(view: View, instanceScope: string): void {
  const mode = sessionsViewModeForView(view);
  useEffect(() => {
    if (mode) saveSessionsViewMode(mode, instanceScope);
  }, [mode, instanceScope]);
}
