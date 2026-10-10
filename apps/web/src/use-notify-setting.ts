import { useState } from "react";
import { notifier } from "./notify.js";

export interface NotifySetting {
  supported: boolean;
  on: boolean;
  disabled?: boolean;
  toggle: () => void;
}

export function useNotifySetting(): NotifySetting {
  const [on, setOn] = useState(notifier.enabled);
  return {
    supported: notifier.supported,
    on,
    toggle: () => {
      if (on) {
        notifier.disable();
        setOn(false);
      } else {
        void notifier.enable().then(setOn);
      }
    },
  };
}

