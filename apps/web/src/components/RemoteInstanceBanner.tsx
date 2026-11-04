import React, { useState } from "react";
import { useInstances } from "../instances-context.js";
import { lastConnection } from "./InstancesPanel.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";

/**
 * The page banner for an active remote instance whose connection is lost or whose credential was
 * rejected. The rail's instance tile says the same thing while it shows (#1970).
 *
 * It names the instance and, while it can't be reached, when it last connected, which says whether
 * to wait; the address is the Instances row's and the recovery screen's (#3005). Each state has its
 * resolving action, Retry or Re-Pair…, and Open Instances; neither leaves the page to resolve it.
 */
export function RemoteInstanceBanner({ authenticationRequired = false }: { authenticationRequired?: boolean }) {
  const instances = useInstances();
  const profile = instances.activeProfile;
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await instances.retryActive();
    } catch {
      // The banner stays while the instance can't be reached; it is already the failure's message.
    } finally {
      setRetrying(false);
    }
  };
  const openInstances = (
    <button type="button" className="btn sm ghost" onClick={instances.manageInstances}>Open Instances</button>
  );
  return (
    <Notice pageBanner tone="warning" role="status" actions={(
      <>
        {authenticationRequired ? (
          // Opens the provider's Re-Pair Instance dialog in place (#3003), not the Instances tab.
          <button
            type="button"
            className="btn primary sm"
            aria-haspopup="dialog"
            onClick={(event) => instances.openInstanceDialog({
              mode: "repair",
              profileId: profile.id,
              returnFocus: event.currentTarget,
            })}
          >
            Re-Pair…
          </button>
        ) : (
          <BusyButton className="btn sm" busy={retrying} progress={`Retrying ${profile.label}…`} onClick={() => void retry()}>
            Retry
          </BusyButton>
        )}
        {openInstances}
      </>
    )}>
      {authenticationRequired
        ? `${profile.label} needs a new pairing before it can reconnect.`
        : `Can't reach ${profile.label}. ${lastConnection(profile)}.`}
    </Notice>
  );
}
