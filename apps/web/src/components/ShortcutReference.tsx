import React, { useRef, useState } from "react";
import { Modal } from "./common.js";
import { State } from "./State.js";
import { useIsMobile, useIsTabletOrSmaller } from "./useIsMobile.js";
import {
  railViewForShortcut,
  shortcutDisplay,
  shortcutReferenceGroups,
  type ShortcutDefinition,
  type ShortcutReferenceGroup,
  type ShortcutScope,
} from "../shortcuts.js";
import { railDigits, visibleRailViews } from "../rail-preferences.js";
import { useExperiments } from "../use-experiments.js";
import { useRailPreferences } from "../use-rail-preferences.js";

function shortcutGroupId(group: string): string {
  return `shortcut-${group.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/** A group's height in rows, for balancing columns: its rows plus its heading and note. */
function groupWeight(group: ShortcutReferenceGroup): number {
  return group.rows.length + 1.5 + (group.note ? 0.5 : 0);
}

/**
 * Split the groups into two columns. Each group goes, in reading order, to the shorter column, so
 * the first two groups (the current page's and Navigation, or Navigation and Actions) head the two
 * columns and the long Session groups balance under them instead of pushing the small ones below
 * the fold.
 */
export function shortcutReferenceColumns(groups: readonly ShortcutReferenceGroup[]): [ShortcutReferenceGroup[], ShortcutReferenceGroup[]] {
  const columns: [ShortcutReferenceGroup[], ShortcutReferenceGroup[]] = [[], []];
  const heights = [0, 0];
  for (const group of groups) {
    const column = heights[1]! < heights[0]! ? 1 : 0;
    columns[column].push(group);
    heights[column]! += groupWeight(group);
  }
  return columns;
}

function ShortcutGroupSection({ group }: { group: ShortcutReferenceGroup }) {
  const id = shortcutGroupId(group.group);
  return (
    <section
      className="shortcut-group"
      aria-labelledby={id}
      aria-describedby={group.note ? `${id}-note` : undefined}
    >
      <h3 id={id}>
        {group.group}
        {/* The space keeps the heading's accessible name two words apart; the flex gap draws it. */}
        {group.current && <>{" "}<span className="shortcut-current">Current Page</span></>}
      </h3>
      {group.note && <p id={`${id}-note`} className="shortcut-group-note">{group.note}</p>}
      <dl className="shortcut-list">
        {group.rows.map((row) => (
          <div className={`shortcut-row${group.note || row.reason ? " is-unavailable" : ""}`} key={row.id}>
            <dt>{row.label}</dt>
            {row.reason && <dd className="shortcut-reason" title={row.reason}>{row.reason}</dd>}
            <dd className="shortcut-keys"><kbd>{row.keys}</kbd></dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ShortcutReference({
  onClose,
  scope = "Global",
  sessionOpen,
  terminalSupported,
  filesSupported,
  conversationSteeringSupported,
  turnInterruptionSupported,
}: {
  onClose: () => void;
  /** The shortcut scope of the page and focus the reference was opened from. */
  scope?: ShortcutScope;
  sessionOpen: boolean;
  terminalSupported: boolean;
  filesSupported: boolean;
  conversationSteeringSupported: boolean;
  turnInterruptionSupported: boolean;
}) {
  const [query, setQuery] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const phone = useIsMobile();
  const oneColumn = useIsTabletOrSmaller();
  // A switched-off experiment's bindings are dead — their handlers live inside the hidden
  // surfaces — so the reference must say so rather than advertise a working key.
  const { flags: experimentFlags } = useExperiments();
  // Navigation digits derive from the visible rail order (#385); the reference reads the same
  // derived mapping as the rail keycaps and the key handler, so the three cannot disagree.
  const railPreferences = useRailPreferences();
  const derivedDigits = railDigits(visibleRailViews(railPreferences, experimentFlags));
  const keys = (definition: ShortcutDefinition) => {
    const railView = railViewForShortcut(definition.id);
    return railView === null ? shortcutDisplay(definition.id) : derivedDigits.get(railView) ?? "—";
  };
  const groups = shortcutReferenceGroups({
    scope,
    availability: {
      sessionOpen,
      terminalSupported,
      filesSupported,
      conversationSteeringSupported,
      turnInterruptionSupported,
      experimentFlags,
      hiddenRailViews: railPreferences.hidden,
    },
    keys,
    query,
  });
  const columns = oneColumn ? [groups] : shortcutReferenceColumns(groups);
  return (
    <Modal
      title="Keyboard Shortcuts"
      description={phone
        ? "These shortcuts need a hardware keyboard. Shortcuts pause while a terminal has focus."
        : "Shortcuts pause while a terminal has focus."}
      size="lg"
      onClose={onClose}
      footer={(
        <>
          <p className="shortcut-reference-note">Digits follow your rail order. Change it in Settings, Appearance.</p>
          <button type="button" className="btn" onClick={onClose}>Done</button>
        </>
      )}
    >
      <input
        ref={filterRef}
        type="search"
        className="shortcut-filter"
        aria-label="Filter Shortcuts"
        placeholder="Filter by name or key"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {groups.length === 0 ? (
        <State
          variant="no-results"
          compact
          actions={<button type="button" className="btn sm" onClick={() => {
            // The button leaves with the empty state; focus goes back to the field it cleared.
            setQuery("");
            filterRef.current?.focus();
          }}>Clear Filter</button>}
        >
          No shortcuts match “{query.trim()}”.
        </State>
      ) : (
        <div className="shortcut-columns">
          {columns.map((column, index) => (
            <div className="shortcut-column" key={index}>
              {column.map((group) => <ShortcutGroupSection key={group.group} group={group} />)}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
