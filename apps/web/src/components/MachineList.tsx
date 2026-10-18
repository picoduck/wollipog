import { useMemo, useState, type Ref, type UIEventHandler } from "react";
import {
  filterMachineList,
  groupMachineList,
  machineCapacityLabel,
  MACHINE_LIST_GROUPING_THRESHOLD,
  type MachineListEntry,
} from "../runners.js";
import { statusMeta } from "../status-meta.js";
import { CapacityIcon, ComputerIcon, GlobeIcon, SearchIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { StaleContent } from "./StaleContent.js";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";

/** Skeleton rows before the first snapshot (§12.3): the two-line row's height and anatomy. */
const SKELETON_ROWS = 3;

export interface MachineListProps {
  /** Every machine, sorted (`machineListEntries`); null before the first snapshot. */
  entries: readonly MachineListEntry[] | null;
  /** The selected machine's runner id; a phone passes none, since its list never shows one (§5.2). */
  selectedId: string | null;
  onSelect: (runnerId: string) => void;
  /** Disconnected: the rows are last-known, dimmed under a Reconnecting… line (§12.5). */
  stale: boolean;
  /** The list's one scroll container, which the page restores on a phone's Back. */
  bodyRef?: Ref<HTMLDivElement>;
  onBodyScroll?: UIEventHandler<HTMLDivElement>;
}

/**
 * The Machines list pane (docs/design-system.md §5.2, §6, #2985): one two-line row per machine,
 * sorted by what needs the person. Past eight machines the head offers a filter and the rows sit
 * under Needs Attention, Online and Offline. The filter lives only as long as the page.
 */
export function MachineList({ entries, selectedId, onSelect, stale, bodyRef, onBodyScroll }: MachineListProps) {
  const [query, setQuery] = useState("");
  const grouped = entries !== null && entries.length > MACHINE_LIST_GROUPING_THRESHOLD;
  // A query typed while the list was long stops applying once it is short again.
  const shown = useMemo(() => entries === null ? [] : grouped ? filterMachineList(entries, query) : [...entries],
    [entries, grouped, query]);
  const groups = useMemo(() => grouped ? groupMachineList(shown) : null, [grouped, shown]);
  const trimmedQuery = query.trim();
  const row = (entry: MachineListEntry) => (
    <MachineRow key={entry.runnerId} entry={entry} selected={entry.runnerId === selectedId} onSelect={onSelect} />
  );

  return (
    <aside className="master-detail-list" aria-label="Machines" data-focus-zone="list" tabIndex={-1}>
      {(stale || grouped) && (
        <div className="master-detail-list-head machine-list-head">
          {/* The line says why the rows are dim, so it stays out of the dimming itself (§12.5). */}
          {stale && <Notice compact tone="neutral" role="status">Reconnecting…</Notice>}
          {grouped && (
            <label className="input-affix">
              <span className="input-affix-text" aria-hidden="true"><SearchIcon size={14} /></span>
              <input
                type="search"
                aria-label="Filter Machines"
                placeholder="Filter machines"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          )}
        </div>
      )}
      <div ref={bodyRef} className="master-detail-list-body clip-focus" onScroll={onBodyScroll}>
        {entries === null ? (
          <div className="skeleton" role="status" aria-live="polite">
            <span className="sr-only">Loading machines</span>
            <div aria-hidden="true">
              {Array.from({ length: SKELETON_ROWS }, (_, index) => (
                <div className="row row-2 machine-row-skeleton" key={index}>
                  <span className="row-body">
                    <span className="skeleton-bar title" />
                    <span className="skeleton-bar" />
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <StaleContent stale={stale}>
            {entries.length === 0 ? null : shown.length === 0 ? (
              <State
                variant="no-results"
                compact
                className="machine-list-no-results"
                actions={<button type="button" className="btn sm" onClick={() => setQuery("")}>Clear Filter</button>}
              >
                <SearchIcon size={16} aria-hidden="true" />
                <span>{`No machines match “${trimmedQuery}”.`}</span>
              </State>
            ) : groups ? groups.map((group) => (
              <div className="machine-list-group" role="group" aria-label={group.label} key={group.key}>
                <h3 className="group-label">
                  {group.label}
                  <span className="count">{group.entries.length}</span>
                </h3>
                {group.entries.map(row)}
              </div>
            )) : shown.map(row)}
          </StaleContent>
        )}
      </div>
    </aside>
  );
}

/**
 * One machine (§5.2): its name and its one status on line 1 (§11.1), and as meta (§11.3) its kind
 * and, when the runner reports it, its Runner Capacity.
 */
function MachineRow({ entry, selected, onSelect }: {
  entry: MachineListEntry;
  selected: boolean;
  onSelect: (runnerId: string) => void;
}) {
  return (
    <button
      type="button"
      className={`row row-2${selected ? " is-selected" : ""}`}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(entry.runnerId)}
    >
      <span className="row-body">
        <span className="row-line">
          <span className="row-title" title={entry.name}>{entry.name}</span>
          <StatusBadge meta={statusMeta("machine", entry.status)} className="machine-row-status" />
        </span>
        <span className="row-sub machine-row-meta">
          <span>
            {entry.kind === "ssh" ? <GlobeIcon size={14} aria-hidden="true" /> : <ComputerIcon size={14} aria-hidden="true" />}
            {entry.kind === "ssh" ? "SSH" : "Native Runner"}
          </span>
          {entry.capacity && (
            <span>
              <CapacityIcon size={14} aria-hidden="true" />
              {machineCapacityLabel(entry.capacity)}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}
