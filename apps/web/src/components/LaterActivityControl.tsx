import { useLayoutEffect, useRef } from "react";
import { BusyButton } from "./ui/BusyButton.js";
import { Notice } from "./Notice.js";
import { useRemovedFocus } from "./useRemovedFocus.js";

/** Reader-driven reach-forward stays outside the scroll region: scrolling to a button at the
 * loaded slice's physical bottom would otherwise resume following before it could be pressed. */
export function LaterActivityControl({ gap, onLoad, onJump, onFocusLost }: {
  gap: { loading: boolean; error: string | null } | undefined;
  onLoad: () => boolean;
  onJump: () => void;
  onFocusLost: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const removedFocus = useRemovedFocus(rootRef);
  useLayoutEffect(() => {
    if (removedFocus()) onFocusLost();
  });
  if (!gap) return null;
  return (
    <div ref={rootRef} data-later-activity-gap="available">
        <Notice compact tone={gap.error ? "danger" : "info"} role="region" ariaLabel="Later Activity" actions={(
          <>
            <BusyButton className="btn sm" busy={gap.loading}
              progress="Loading later activity…" onClick={onLoad}>
              {gap.error ? "Retry" : "Load Later Activity"}
            </BusyButton>
            <button className="btn sm ghost" type="button" onClick={onJump}>Jump to Latest</button>
          </>
        )}>
          {gap.error ?? "Newer activity is available. Some activity between here and the latest is not loaded."}
        </Notice>
    </div>
  );
}
