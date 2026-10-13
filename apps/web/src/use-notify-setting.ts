import { useReducer, useState, useSyncExternalStore } from "react";
import { notifier } from "./notify.js";

export interface NotifySetting {
  supported: boolean;
  on: boolean;
  /**
   * The browser's answer for this site. `"denied"` means turning alerts on cannot work until the
   * person changes it in the browser, which no page can do for them.
   */
  permission: NotificationPermission;
  disabled?: boolean;
  toggle: () => void;
  /** Re-read the permission, after the person has changed it in the browser's settings. */
  recheck: () => void;
}

/**
 * The permission is the browser's, not ours: it changes in the browser's own settings, and in the
 * prompt Push Notifications shows when it turns on, neither of which tells this hook. So it is read
 * as an external store — on every render (the shell re-renders when push settles), when the window
 * regains focus (back from the browser's settings), and on the Permissions API's change event
 * where the browser has one.
 */
function subscribePermission(onChange: () => void): () => void {
  window.addEventListener("focus", onChange);
  let status: PermissionStatus | null = null;
  let closed = false;
  void navigator.permissions?.query({ name: "notifications" }).then((result) => {
    if (closed) return;
    status = result;
    status.addEventListener("change", onChange);
  }, () => undefined);
  return () => {
    closed = true;
    window.removeEventListener("focus", onChange);
    status?.removeEventListener("change", onChange);
  };
}

export function useNotifySetting(): NotifySetting {
  const [enabled, setOn] = useState(notifier.enabled);
  const permission = useSyncExternalStore(subscribePermission, () => notifier.permission,
    (): NotificationPermission => "default");
  // Try Again re-renders, which is all a re-read needs.
  const [, recheck] = useReducer((reads: number) => reads + 1, 0);
  // On only while the browser still allows it: `notifier.show` sends nothing without "granted", so a
  // saved choice the browser has since revoked reads as off rather than as alerts that never come.
  const on = enabled && permission === "granted";
  return {
    supported: notifier.supported,
    on,
    permission,
    toggle: () => {
      if (on) {
        notifier.disable();
        setOn(false);
      } else {
        // A refusal in the prompt this may show leaves `enabled` false, which re-renders nothing, so
        // the permission is re-read explicitly: it shows as blocked at once rather than as a switch
        // that snapped back off.
        void notifier.enable().then((value) => {
          setOn(value);
          recheck();
        });
      }
    },
    recheck,
  };
}
