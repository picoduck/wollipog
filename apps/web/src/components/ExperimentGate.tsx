import React, { useEffect, useRef, type ReactNode } from "react";
import { EXPERIMENT_COPY, type ExperimentId } from "../experiments.js";
import { useExperiments } from "../use-experiments.js";
import { ExperimentIcon } from "./Icons.js";
import { PageHeader } from "./PageHeader.js";
import { State } from "./State.js";

/**
 * A route that belongs to an experiment: the feature while it is on, and while it is off, the page
 * that says so and lets the person turn it on where they are.
 *
 * The route still parses, so a bookmark never silently becomes the Inbox, and the page keeps its
 * header: it is the shell's anchor and the focus rescue's target (§4.2). Turn On goes through the
 * same setter as Settings › Experimental, so the rail, the palette and this page all update from
 * the one store, and the feature mounts in place without a navigation.
 */
export function ExperimentGate({
  experiment,
  pageTitle,
  onOpenSettings,
  children,
}: {
  experiment: ExperimentId;
  pageTitle: string;
  onOpenSettings: () => void;
  children: ReactNode;
}) {
  const { flags, setFlag } = useExperiments();
  const enabled = flags[experiment];
  // Turn On unmounts the button that had focus, and the path does not change, so the shell's
  // view-change rescue never runs. Hand focus to the feature's page title, as that rescue would.
  const turnedOnHere = useRef(false);
  useEffect(() => {
    if (!enabled || !turnedOnHere.current) return;
    turnedOnHere.current = false;
    const active = document.activeElement;
    if (active && active !== document.body && (active as HTMLElement).isConnected) return;
    document.getElementById("page-title")?.focus();
  }, [enabled]);
  if (enabled) return <>{children}</>;
  const copy = EXPERIMENT_COPY[experiment];
  return (
    <div className="page">
      <PageHeader title={pageTitle} />
      <State
        className="experiment-off"
        icon={<ExperimentIcon />}
        headingLevel={2}
        title={copy.offTitle}
        actions={
          <>
            <button type="button" className="btn primary" onClick={() => {
              turnedOnHere.current = true;
              setFlag(experiment, true);
            }}>
              Turn On
            </button>
            <button type="button" className="btn" onClick={onOpenSettings}>
              Open Experimental Settings
            </button>
          </>
        }
      >
        {copy.offBody}
      </State>
    </div>
  );
}
