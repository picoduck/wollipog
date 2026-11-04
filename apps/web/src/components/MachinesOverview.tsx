import { useId, useMemo } from "react";
import {
  MACHINE_CAPACITY_UNIT_NOTE,
  MACHINES_OVERVIEW_ALL_READY,
  machineCapacityMeterLabel,
  machinesOverviewAttention,
  machinesOverviewCapacity,
  machinesOverviewSummary,
  type MachineCapacityRow,
  type MachinesOverviewAttentionItem,
} from "../machines-overview.js";
import type { MachineListEntry } from "../runners.js";
import { statusMeta } from "../status-meta.js";
import type { MachineOperations } from "./MachineDetail.js";
import { StatusBadge } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";

export interface MachinesOverviewProps {
  /** Every machine, sorted (`machineListEntries`). */
  entries: readonly MachineListEntry[];
  /** Unarchived sessions with work in flight, by runner id (`activeSessionCounts`). */
  activeSessions: ReadonlyMap<string, number>;
  /** An organization owner or admin: offered each row's own fix, where everyone else gets Review. */
  canManage: boolean;
  onOpen: (runnerId: string) => void;
  onRepair: (runnerId: string) => void;
  /** The machines' requests in flight and their one Reconnect, shared with the machine detail (#3525). */
  machines: MachineOperations;
}

/**
 * The Machines tab's default detail on desktop and compact widths (docs/design-system.md §6.1,
 * #2986): which machine needs the person, and where there is room to run more. A phone has none;
 * its list is the overview, sorted by attention with every row's badge.
 */
export function MachinesOverview({ entries, activeSessions, canManage, onOpen, onRepair, machines }: MachinesOverviewProps) {
  const id = useId().replace(/:/g, "");
  const now = Date.now();
  const attention = machinesOverviewAttention(entries, activeSessions, canManage, now);
  const capacity = useMemo(() => machinesOverviewCapacity(entries), [entries]);

  return (
    <div className="machines-overview">
      <header className="machines-overview-head">
        <h2 className="machines-overview-title">All Machines</h2>
        <p className="machines-overview-summary">{machinesOverviewSummary(entries)}</p>
      </header>

      <section className="section" aria-labelledby={`${id}-attention`}>
        <div className="section-head">
          <h3 className="section-title" id={`${id}-attention`}>
            Needs Attention
            {attention.length > 0 && <span className="machines-overview-count">{attention.length}</span>}
          </h3>
        </div>
        {attention.length > 0 ? (
          <div className="surface">
            {attention.map((item) => (
              <AttentionRow key={item.entry.runnerId} item={item} onOpen={onOpen} onRepair={onRepair} machines={machines} />
            ))}
          </div>
        ) : (
          <p className="machines-overview-ok">
            <span className="machines-overview-dot" aria-hidden="true" />
            <span>{MACHINES_OVERVIEW_ALL_READY}</span>
          </p>
        )}
      </section>

      <section className="section" aria-labelledby={`${id}-capacity`}>
        <div className="section-head">
          <h3 className="section-title" id={`${id}-capacity`}>Capacity</h3>
          <span className="machines-overview-columns">Units in Use / Limit</span>
        </div>
        <div className="surface">
          {capacity.rows.map((row) => <CapacityRow key={row.entry.runnerId} row={row} onOpen={onOpen} />)}
          {capacity.rest && (
            <div className="row machine-capacity-row machine-capacity-rest">
              <span className="row-title">
                {`and ${capacity.rest.count} more ${capacity.rest.count === 1 ? "machine" : "machines"}`}
              </span>
              {capacity.rest.units && (
                <span className="machine-capacity-figures">{`${capacity.rest.units.used} / ${capacity.rest.units.limit}`}</span>
              )}
            </div>
          )}
        </div>
        <p className="section-note">{MACHINE_CAPACITY_UNIT_NOTE}</p>
      </section>
    </div>
  );
}

/** A Needs Attention row (§5.2): the name and its badge, the top reason, and what resolves it. */
function AttentionRow({ item, onOpen, onRepair, machines }: {
  item: MachinesOverviewAttentionItem;
  onOpen: (runnerId: string) => void;
  onRepair: (runnerId: string) => void;
  machines: MachineOperations;
}) {
  const { entry } = item;
  const operation = machines.operations[entry.runnerId];
  return (
    <div className="row row-2 machines-overview-row">
      <span className="row-body">
        <span className="row-line">
          <span className="row-title" title={entry.name}>{entry.name}</span>
          <StatusBadge meta={statusMeta("machine", entry.status)} />
        </span>
        <span className="row-sub" title={item.reason}>{item.reason}</span>
      </span>
      {item.action === "repair" ? (
        <button type="button" className="btn sm" aria-label={`Repair Connection to ${entry.name}…`}
          onClick={() => onRepair(entry.runnerId)}>Repair Connection…</button>
      ) : item.action === "reconnect" ? (
        <BusyButton className="btn sm" busy={operation === "reconnect"} progress={`Reconnecting ${entry.name}…`}
          disabled={operation !== undefined && operation !== "reconnect"}
          aria-label={`Reconnect ${entry.name}`} onClick={() => machines.reconnect(entry)}>Reconnect</BusyButton>
      ) : (
        <button type="button" className="btn sm" aria-label={`Review ${entry.name}`}
          onClick={() => onOpen(entry.runnerId)}>Review</button>
      )}
    </div>
  );
}

/**
 * A Capacity row, which opens the machine: its name, a meter (§11.6) in the warning tone from 75%,
 * and the figures. The meter names the level, so the figures beside it are not read twice.
 */
function CapacityRow({ row, onOpen }: { row: MachineCapacityRow; onOpen: (runnerId: string) => void }) {
  const { entry } = row;
  return (
    <button type="button" className="row machine-capacity-row" onClick={() => onOpen(entry.runnerId)}>
      <span className="row-title" title={entry.name}>{entry.name}</span>
      {row.kind === "meter" ? (
        <>
          <span className={`meter${row.warning ? " t-warning" : ""}`} role="img" aria-label={machineCapacityMeterLabel(row.used, row.limit)}>
            <span style={{ width: `${row.limit > 0 ? Math.min(100, (row.used / row.limit) * 100) : 0}%` }} />
          </span>
          <span className="machine-capacity-figures" aria-hidden="true">{`${row.used} / ${row.limit}`}</span>
          {row.queued > 0 && <span className="machine-capacity-queued">{`${row.queued} Queued`}</span>}
        </>
      ) : row.kind === "offline" ? (
        <>
          <span className="meter" role="img" aria-label="Offline"><span style={{ width: "0%" }} /></span>
          <span className="machine-capacity-figures is-faint" aria-hidden="true">Offline</span>
        </>
      ) : (
        <span className="machine-capacity-unknown">Capacity Unknown</span>
      )}
    </button>
  );
}
