import React from "react";
import { useWindowTitle, windowDragRegion } from "../desktop-window.js";
import { useInstances } from "../instances-context.js";
import { InstanceSelector } from "./InstanceSelector.js";
import { InstancesPanel } from "./InstancesPanel.js";
import { RailDragStrip } from "./Rail.js";

/** The desktop app's screen while the active instance is loading, opening, failed or missing. */
export function InstanceRecoveryShell() {
  const instances = useInstances();
  const loading = instances.phase === "loading" || instances.phase === "opening";
  const activeAvailability = instances.statusByProfile[instances.activeProfile.id]?.availability;
  const repairable = instances.phase === "failed" && instances.activeProfile.kind === "remote"
    && (activeAvailability === "authentication-required" || activeAvailability === "missing-credential");
  useWindowTitle("Instances");
  return (
    <div className="app instance-recovery-app">
      <aside className="instance-recovery-nav" aria-label="Instance Navigation">
        <div className="brand">
          <img className="brand-mark" src="/icons/icon-192.png" alt="" aria-hidden="true" />
          <div className="brand-name">Wollipog</div>
        </div>
        <InstanceSelector labelled />
        <RailDragStrip />
      </aside>
      <main className="main">
        <header className="topbar" {...windowDragRegion()}><h1>Instances</h1></header>
        <div className="main-body instance-recovery-body">
          {loading ? (
            <div className="instance-recovery-state" role="status" aria-live="polite">
              <h2>{instances.phase === "loading" ? "Loading Instances" : `Connecting to ${instances.activeProfile.label}`}</h2>
              <p>{instances.phase === "loading" ? "Loading saved Wollipog instances…" : "Opening a secure connection…"}</p>
            </div>
          ) : (
            <>
              <div className="instance-recovery-state" role={instances.phase === "missing" ? "alert" : "status"}>
                <h2>{instances.phase === "missing" ? "Instance Not Found" : `${instances.activeProfile.label} Is Unavailable`}</h2>
                <p>
                  {instances.phase === "missing"
                    ? "This saved instance no longer exists. Choose another instance before opening this resource."
                    : instances.error ?? "Wollipog could not open this instance."}
                </p>
                <div className="toolbar-actions">
                  {/* A rejected or missing credential cannot be retried away: Re-Pair… opens the
                      provider's dialog for this instance (#3003). */}
                  {repairable ? (
                    <button
                      type="button"
                      className="btn primary"
                      aria-haspopup="dialog"
                      onClick={(event) => instances.openInstanceDialog({
                        mode: "repair",
                        profileId: instances.activeProfile.id,
                        returnFocus: event.currentTarget,
                      })}
                    >
                      Re-Pair…
                    </button>
                  ) : instances.phase !== "missing" && (
                    <button type="button" className="btn primary" onClick={() => void instances.retryActive()}>Retry</button>
                  )}
                  {(instances.phase === "missing" || instances.activeProfile.id !== "local") && (
                    <button type="button" className="btn" onClick={() => void instances.goToThisMachine()}>Go to This Machine</button>
                  )}
                </div>
              </div>
              <InstancesPanel />
            </>
          )}
        </div>
      </main>
    </div>
  );
}
