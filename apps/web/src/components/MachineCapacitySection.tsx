import { useId } from "react";
import { runnerSupportsProtocol, type RunnerCapacityBlocker, type RunnerView } from "@wollipog/protocol";
import { MACHINE_CAPACITY_WARNING_SHARE, machineCapacityMeterLabel } from "../machines-overview.js";
import { Notice } from "./Notice.js";

/** What Capacity shows until the machine reports its live usage. */
export const CAPACITY_WAITING = "Waiting for live capacity from this machine.";

/** One item of the meta line under the figure: a short label and its tabular value. */
export interface CapacityMetaItem {
  label: string;
  value: string;
}

/** The meta line (§11.3), from the dimensions a runner reports; empty without them. */
export function capacityMetaItems(capacity: RunnerView["capacity"]): CapacityMetaItem[] {
  const dimensions = capacity?.dimensions;
  if (!dimensions) return [];
  return [
    { label: "Active Turns", value: `${dimensions.activeTurns.used} of ${dimensions.activeTurns.limit}` },
    { label: "Queued", value: `${capacity.queuedSessions ?? 0}` },
    { label: "Idle Resumable", value: `${dimensions.retainedSessions.used}` },
    { label: "Parked", value: `${dimensions.parkedSessions}` },
  ];
}

/** A blocker as one sentence with its waiting count: "Claude is using 4 of 4 provider slots. 3 sessions waiting." */
export function capacityBlockerSentence(blocker: Pick<RunnerCapacityBlocker, "description" | "waitingSessions">): string {
  const text = blocker.description.trim();
  const sentence = `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/u.test(text) ? "" : "."}`;
  const waiting = blocker.waitingSessions ?? 0;
  return waiting > 0 ? `${sentence} ${waiting} ${waiting === 1 ? "session" : "sessions"} waiting.` : sentence;
}

/**
 * A machine's Capacity (#2989, docs/design-system.md §4.5, §11.3, §11.6, §13.2): the units in use
 * beside a meter, warning from 75%, then the dimensions as one meta line and any blockers in one
 * compact warning notice. Change Limit… opens Machine Settings for those who may change it. Until
 * an online machine reports its usage the section says it is waiting.
 */
export function MachineCapacitySection({ runner, onChangeLimit }: {
  runner: RunnerView;
  /** Opens Machine Settings, or undefined when the person may not change the limit. */
  onChangeLimit?: () => void;
}) {
  const id = `capacity-${useId().replace(/:/g, "")}`;
  const capacity = runner.capacity;
  if (!capacity && !runner.runtime) return null;
  const canChange = onChangeLimit && runner.canManage === true &&
    runnerSupportsProtocol(runner.protocolVersion, "machineRunnerCapacity");
  // A machine that is offline reports nothing live, so its last figure would only look current.
  const used = runner.status === "online" ? capacity?.usedUnits : undefined;
  const limit = capacity?.configuredUnits ?? 0;
  const meta = capacityMetaItems(capacity);
  const blockers = capacity?.blockers ?? [];
  return (
    <section className="section" aria-labelledby={id}>
      <div className="section-head">
        <h3 id={id} className="section-title">Capacity</h3>
        {canChange && (
          <div className="actions">
            <button type="button" className="btn sm" onClick={onChangeLimit}>Change Limit…</button>
          </div>
        )}
      </div>
      {used === undefined || !capacity ? (
        <p className="machine-section-state">{CAPACITY_WAITING}</p>
      ) : (
        <>
          <div className="machine-capacity-level">
            <span className="machine-capacity-figure">{machineCapacityMeterLabel(used, limit)}</span>
            <span
              className={`meter${limit > 0 && used / limit >= MACHINE_CAPACITY_WARNING_SHARE ? " t-warning" : ""}`}
              role="progressbar"
              aria-label="Units in Use"
              aria-valuemin={0}
              aria-valuemax={limit}
              aria-valuenow={Math.min(used, limit)}
            >
              <span style={{ width: `${limit > 0 ? Math.min(100, (used / limit) * 100) : 0}%` }} />
            </span>
          </div>
          {meta.length > 0 && (
            <ul className="machine-capacity-meta" aria-label="Capacity Breakdown">
              {meta.map((item) => (
                <li key={item.label}><span className="machine-capacity-meta-label">{item.label}</span> {item.value}</li>
              ))}
            </ul>
          )}
          {blockers.length > 0 && (
            <Notice tone="warning" compact>
              {blockers.map((blocker, index) => (
                <p key={`${blocker.kind}:${blocker.agentId ?? ""}:${blocker.targetId ?? ""}:${index}`}>
                  {capacityBlockerSentence(blocker)}
                </p>
              ))}
            </Notice>
          )}
        </>
      )}
    </section>
  );
}
