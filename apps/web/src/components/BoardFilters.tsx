import React, { useMemo, useState, type ReactNode } from "react";
import type { BoxView, SessionView } from "@wollipog/protocol";
import { useStoreActions, useStoreSelector, type Filters } from "../store.js";
import { machineOptionLabels, runnerDisplay } from "../runners.js";
import { ChevronDownIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuLabel, MenuSeparator, MenuSurface } from "./Menu.js";
import { useIsCompact, useIsMobile } from "./useIsMobile.js";

/**
 * The Board's Machine and Agent filters (#2201): menu buttons in the Sessions tab row's tools
 * (docs/design-system.md §9.1, §10.1). The state is the store's per-instance `filters`; the option
 * lists and the menu rows are exported apart from the buttons so the phone Board's Filters sheet
 * (#2216) draws the same rows.
 */

const NO_FILTERS: Filters = { runnerId: null, agentId: null };

/** The sessions the Board shows once its Machine and Agent filters apply. */
export function filterBoardSessions(sessions: readonly SessionView[], filters: Filters): SessionView[] {
  return sessions.filter((session) =>
    (!filters.runnerId || session.runnerId === filters.runnerId) &&
    (!filters.agentId || session.agentId === filters.agentId));
}

/** How many of the two filters are set. */
export function activeBoardFilterCount(filters: Filters): number {
  return (filters.runnerId ? 1 : 0) + (filters.agentId ? 1 : 0);
}

/** "Filters, 1 Active": the compact Filters button's accessible name (§17.1). */
export function boardFiltersButtonName(active: number): string {
  return active > 0 ? `Filters, ${active} Active` : "Filters";
}

export interface MachineFilterOption {
  runnerId: string;
  /** The disambiguated name: two machines may share a display name (§10.1). */
  label: string;
}

export interface AgentFilterOption {
  agentId: string;
  name: string;
  /** Why the machine reports the agent unavailable, or null when it can be used. */
  unavailableReason: string | null;
}

/** One machine's agents, under its name. */
export interface AgentFilterGroup {
  runnerId: string;
  machine: string;
  agents: AgentFilterOption[];
}

export interface BoardFilterOptions {
  machines: MachineFilterOption[];
  agentGroups: AgentFilterGroup[];
  /** The chosen machine's name, falling back to its id for a machine that has since gone. */
  machineLabel: (runnerId: string) => string;
  /** The chosen agent's name, falling back to its id for an agent no machine reports now. */
  agentLabel: (agentId: string) => string;
}

/** The Machine and Agent choices, read from the machines the store knows. */
export function useBoardFilterOptions(): BoardFilterOptions {
  const runners = useStoreSelector((s) => s.runners);
  const boxes = useStoreSelector((s) => s.boxes);
  return useMemo(() => {
    const boxByRunner = new Map<string, BoxView>();
    for (const box of boxes.values()) boxByRunner.set(box.runnerId, box);
    const list = [...runners.values()];
    const machineLabels = machineOptionLabels(list, (runnerId) => boxByRunner.get(runnerId));
    const machineLabel = (runnerId: string) =>
      machineLabels.get(runnerId) ?? runnerDisplay(runners.get(runnerId), boxByRunner.get(runnerId), runnerId).name;
    const names = new Map<string, string>();
    const agentGroups: AgentFilterGroup[] = [];
    for (const runner of list) {
      const machine = machineLabel(runner.runnerId);
      const seen = new Set<string>();
      const agents: AgentFilterOption[] = [];
      for (const agent of runner.agents) {
        if (seen.has(agent.id)) continue;
        seen.add(agent.id);
        if (!names.has(agent.id)) names.set(agent.id, agent.name);
        agents.push({
          agentId: agent.id,
          name: agent.name,
          // Unverified (undefined) is not unavailable: only a machine's own "no" disables the row.
          unavailableReason: agent.available === false
            ? agent.unavailableReason?.trim() || `Not available on ${machine}.`
            : null,
        });
      }
      if (agents.length > 0) agentGroups.push({ runnerId: runner.runnerId, machine, agents });
    }
    return {
      machines: list.map((runner) => ({ runnerId: runner.runnerId, label: machineLabel(runner.runnerId) })),
      agentGroups,
      machineLabel,
      agentLabel: (agentId: string) => names.get(agentId) ?? agentId,
    };
  }, [boxes, runners]);
}

/** All Machines, then one `menuitemradio` row per machine, the current one checked (§9.1). */
export function MachineFilterItems({ machines, current, onChoose }: {
  machines: readonly MachineFilterOption[];
  current: string | null;
  onChoose: (runnerId: string | null) => void;
}) {
  return (
    <>
      <MenuItem role="menuitemradio" checked={current === null} data-menu-label="All Machines" onClick={() => onChoose(null)}>
        All Machines
      </MenuItem>
      {machines.map((machine) => (
        <MenuItem
          key={machine.runnerId}
          role="menuitemradio"
          checked={current === machine.runnerId}
          title={machine.label}
          data-menu-label={machine.label}
          onClick={() => onChoose(machine.runnerId)}
        >
          {machine.label}
        </MenuItem>
      ))}
    </>
  );
}

/**
 * All Agents, then each machine's agents under its name. An agent its machine reports unavailable
 * is an `aria-disabled` row with the reason as its second line, still reachable from the keyboard so
 * the reason is heard; choosing it does nothing.
 */
export function AgentFilterItems({ groups, current, onChoose }: {
  groups: readonly AgentFilterGroup[];
  current: string | null;
  onChoose: (agentId: string | null) => void;
}) {
  return (
    <>
      <MenuItem role="menuitemradio" checked={current === null} data-menu-label="All Agents" onClick={() => onChoose(null)}>
        All Agents
      </MenuItem>
      {groups.map((group) => (
        <div role="group" aria-label={group.machine} key={group.runnerId}>
          <MenuLabel>{group.machine}</MenuLabel>
          {group.agents.map((agent) => (
            <MenuItem
              key={agent.agentId}
              role="menuitemradio"
              checked={current === agent.agentId}
              title={agent.name}
              data-menu-label={agent.name}
              aria-disabled={agent.unavailableReason === null ? undefined : true}
              description={agent.unavailableReason ?? undefined}
              onClick={() => {
                if (agent.unavailableReason === null) onChoose(agent.agentId);
              }}
            >
              {agent.name}
            </MenuItem>
          ))}
        </div>
      ))}
    </>
  );
}

/** A `.btn.sm.ghost` menu button that names its choice and is pressed while a filter is set. */
function FilterMenuButton({ label, menuLabel, ariaLabel, pressed, filter, children }: {
  /** The visible text: the current choice, or "All Machines". */
  label: ReactNode;
  /** The menu's accessible name (§9.1). */
  menuLabel: string;
  ariaLabel?: string;
  pressed: boolean;
  /** Which filter the button sets, for tests and evidence: "machine", "agent" or "both". */
  filter: "machine" | "agent" | "both";
  children: (choose: (apply: () => void) => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "board-filter-menu", "item", { reachUnavailable: true });
  const choose = (apply: () => void) => {
    menu.close(false);
    menu.triggerRef.current?.focus();
    apply();
  };
  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        className="btn sm ghost board-filter"
        data-board-filter={filter}
        aria-label={ariaLabel}
        aria-pressed={pressed}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
      >
        {label}
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label={menuLabel}
          align="end"
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          {children(choose)}
        </MenuSurface>
      )}
    </>
  );
}

/**
 * The Board's tools in the Sessions tab row (#2201): "All Machines ▾" and "All Agents ▾", which name
 * the choice once one is set. Below 1100px they fold into one Filters button that opens both groups
 * (§15.2). A set filter adds a quiet "10 of 29" note and Clear; in the folded Filters menu, Clear is
 * its last row, so the row keeps room for the group tabs.
 */
export function BoardFilterTools({ sessions }: {
  /** The Board's scope before its own filters: what "of 29" counts. */
  sessions: readonly SessionView[];
}) {
  const filters = useStoreSelector((s) => s.filters);
  const { setFilters } = useStoreActions();
  const options = useBoardFilterOptions();
  const compact = useIsCompact();
  const phone = useIsMobile();
  // Phones fold the same way until the phone Board's Filters sheet (#2216).
  const folded = compact || phone;
  const active = activeBoardFilterCount(filters);
  const shown = useMemo(() => filterBoardSessions(sessions, filters).length, [filters, sessions]);
  const machineChoice = filters.runnerId ? options.machineLabel(filters.runnerId) : null;
  const agentChoice = filters.agentId ? options.agentLabel(filters.agentId) : null;
  const clear = () => setFilters(NO_FILTERS);
  const note = active > 0 && (
    <span className="board-filter-note" title={`${shown} of ${sessions.length} sessions match the filters.`}>
      {shown} of {sessions.length}
    </span>
  );

  if (folded) {
    return (
      <>
        <FilterMenuButton
          filter="both"
          label={<>Filters{active > 0 && <span className="count" aria-hidden="true">{active}</span>}</>}
          ariaLabel={boardFiltersButtonName(active)}
          menuLabel="Filters"
          pressed={active > 0}
        >
          {(choose) => (
            <>
              <div role="group" aria-label="Machine">
                <MenuLabel>Machine</MenuLabel>
                <MachineFilterItems machines={options.machines} current={filters.runnerId}
                  onChoose={(runnerId) => choose(() => setFilters({ runnerId }))} />
              </div>
              <MenuSeparator />
              <div role="group" aria-label="Agent">
                <MenuLabel>Agent</MenuLabel>
                <AgentFilterItems groups={options.agentGroups} current={filters.agentId}
                  onChoose={(agentId) => choose(() => setFilters({ agentId }))} />
              </div>
              {active > 0 && (
                <>
                  <MenuSeparator />
                  <MenuItem data-menu-label="Clear Filters" onClick={() => choose(clear)}>Clear Filters</MenuItem>
                </>
              )}
            </>
          )}
        </FilterMenuButton>
        {note}
      </>
    );
  }

  return (
    <>
      <FilterMenuButton
        filter="machine"
        label={<span className="board-filter-text">{machineChoice ?? "All Machines"}</span>}
        menuLabel="Machine"
        pressed={machineChoice !== null}
      >
        {(choose) => (
          <MachineFilterItems machines={options.machines} current={filters.runnerId}
            onChoose={(runnerId) => choose(() => setFilters({ runnerId }))} />
        )}
      </FilterMenuButton>
      <FilterMenuButton
        filter="agent"
        label={<span className="board-filter-text">{agentChoice ?? "All Agents"}</span>}
        menuLabel="Agent"
        pressed={agentChoice !== null}
      >
        {(choose) => (
          <AgentFilterItems groups={options.agentGroups} current={filters.agentId}
            onChoose={(agentId) => choose(() => setFilters({ agentId }))} />
        )}
      </FilterMenuButton>
      {note}
      {active > 0 && (
        <button type="button" className="btn sm ghost" onClick={clear}>Clear</button>
      )}
    </>
  );
}
