import { useState } from "react";
import { notifier } from "./notify.js";

export interface NotifySetting {
  supported: boolean;
  on: boolean;
  /**
   * The browser's answer for this site, read when the setting mounts, after each toggle and on
   * `recheck`. `"denied"` means turning alerts on cannot work until the person changes it in the
   * browser, which no page can do for them.
   */
  permission: NotificationPermission;
  disabled?: boolean;
  toggle: () => void;
  /** Re-read the permission, after the person has changed it in the browser's settings. */
  recheck: () => void;
}

export function useNotifySetting(): NotifySetting {
  const [enabled, setOn] = useState(notifier.enabled);
  const [permission, setPermission] = useState(() => notifier.permission);
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
        // The prompt this may show is the only place the answer changes from inside the page, so a
        // refusal there shows as blocked at once rather than as a switch that snapped back off.
        void notifier.enable().then((enabled) => {
          setOn(enabled);
          setPermission(notifier.permission);
        });
      }
    },
    recheck: () => setPermission(notifier.permission),
  };
}
