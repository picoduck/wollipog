import { useCallback, useSyncExternalStore } from "react";
import { useInstanceScope } from "./instance-scope.js";
import {
  getSessionsPreviewLayout,
  setSessionsPreviewLayout,
  subscribeSessionsPreviewLayout,
  type SessionsPreviewLayout,
} from "./sessions-preview-layout.js";

/**
 * The active instance's Sessions preview layout, live across the Sessions header control and the
 * Settings row: both write the one key, and each re-renders when the other changes it (#2219).
 */
export function useSessionsPreviewLayout(): [SessionsPreviewLayout, (layout: SessionsPreviewLayout) => void] {
  const instanceScope = useInstanceScope();
  const layout = useSyncExternalStore(
    subscribeSessionsPreviewLayout,
    () => getSessionsPreviewLayout(instanceScope),
    () => getSessionsPreviewLayout(instanceScope),
  );
  const setLayout = useCallback(
    (next: SessionsPreviewLayout) => setSessionsPreviewLayout(next, instanceScope),
    [instanceScope],
  );
  return [layout, setLayout];
}
