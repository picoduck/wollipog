import React from "react";
import { useInstances } from "../instances-context.js";
import { Notice } from "./Notice.js";

/**
 * The page banner for an active remote instance whose connection is lost or whose credential was
 * rejected. The rail's instance tile says the same thing while it shows (#1970).
 */
export function RemoteInstanceBanner({ authenticationRequired = false }: { authenticationRequired?: boolean }) {
  const instances = useInstances();
  return (
    <Notice pageBanner tone="warning" role="status" actions={(
      <>
        {!authenticationRequired && (
          <button type="button" className="btn primary sm" onClick={() => void instances.retryActive()}>Retry</button>
        )}
        <button type="button" className="btn sm" onClick={instances.manageInstances}>
          {authenticationRequired ? "Re-Pair in Instances" : "Manage Instances"}
        </button>
      </>
    )}>
      {authenticationRequired
        ? `${instances.activeProfile.label} requires a new pairing credential.`
        : `Can't reach ${instances.activeProfile.label} at ${instances.activeProfile.origin}.`}
    </Notice>
  );
}
