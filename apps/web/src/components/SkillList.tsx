import { useId, useMemo, useState, type Ref, type UIEventHandler } from "react";
import type { RunnerView } from "@wollipog/protocol";
import { statusMeta } from "../status-meta.js";
import {
  filterSkillList,
  groupSkillList,
  skillAttention,
  skillListDescription,
  type RunnerSkillsResponse,
  type SkillAttention,
  type SkillGroupView,
  type SkillListGrouping,
  type SkillListShow,
  type SkillSummary,
} from "../skills.js";
import { CountBadge } from "./CountBadge.js";
import { SearchIcon, TuningIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { ListFoot } from "./ListFoot.js";
import { MenuItem, MenuLabel, MenuSeparator, MenuSurface } from "./Menu.js";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";

const SHOW_OPTIONS: ReadonlyArray<{ value: SkillListShow; label: string }> = [
  { value: "all", label: "All Skills" },
  { value: "attention", label: "Needs Attention" },
  { value: "git", label: "Imported from Git" },
  { value: "built_in", label: "Built-In" },
  { value: "unassigned", label: "Not Assigned" },
];
const GROUPING_OPTIONS: ReadonlyArray<{ value: SkillListGrouping; label: string }> = [
  { value: "group", label: "Group" },
  { value: "none", label: "None" },
];

/** Skeleton rows while the library loads (§12.3): the two-line row's height and anatomy. */
const SKELETON_ROWS = 5;

export interface SkillListProps {
  /** Null while the library loads. */
  skills: SkillSummary[] | null;
  groups: SkillGroupView[];
  runners: RunnerView[];
  machineSkills: Record<string, RunnerSkillsResponse>;
  selectedId: string | null;
  onSelect: (skillId: string) => void;
  /** The Orphaned Copies entry at the list's foot, shown only while there is something to review. */
  orphans: { shown: boolean; count: number; selected: boolean; onOpen: () => void };
  /** The phone's first row, which opens the Library Overview route with its attention count. */
  overview?: { count: number; onOpen: () => void };
  /** The list's one scroll container, which the page restores on a phone's Back. */
  bodyRef?: Ref<HTMLDivElement>;
  onBodyScroll?: UIEventHandler<HTMLDivElement>;
}

/**
 * The Agent Skills list pane (docs/design-system.md §5.2, §6): a filter and View Options over
 * equal two-line rows in groups, each row with at most one status, and the Orphaned Copies entry at
 * its foot. The filter and view choices live only as long as the page.
 */
export function SkillList({ skills, groups, runners, machineSkills, selectedId, onSelect, orphans, overview, bodyRef, onBodyScroll }: SkillListProps) {
  const [query, setQuery] = useState("");
  const [show, setShow] = useState<SkillListShow>("all");
  const [grouping, setGrouping] = useState<SkillListGrouping>("group");
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useAccessibleMenu(menuOpen, setMenuOpen, "skill-view-options");
  const listId = useId().replace(/:/g, "");
  const orphansDescriptionId = `skill-orphans-${listId}`;
  const overviewDescriptionId = `skill-overview-${listId}`;

  const attention = useMemo(() => {
    const byId = new Map<string, SkillAttention | null>();
    for (const skill of skills ?? []) byId.set(skill.id, skillAttention(skill, runners, machineSkills));
    return byId;
  }, [skills, runners, machineSkills]);
  const shown = useMemo(() => groupSkillList(
    filterSkillList(skills ?? [], { query, show, attention: (skill) => attention.get(skill.id) ?? null }),
    groups,
    grouping,
  ), [skills, groups, grouping, query, show, attention]);

  const choose = (apply: () => void) => {
    apply();
    menu.close(true);
  };
  const trimmedQuery = query.trim();
  const showLabel = SHOW_OPTIONS.find((option) => option.value === show)!.label;

  return (
    <aside className="master-detail-list" aria-label="Skills" data-focus-zone="list" tabIndex={-1}>
      <div className="master-detail-list-head toolbar">
        <label className="input-affix skill-list-filter">
          <span className="input-affix-text" aria-hidden="true"><SearchIcon size={14} /></span>
          <input
            type="search"
            aria-label="Filter Skills"
            placeholder="Filter skills"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          ref={menu.triggerRef}
          type="button"
          className="icon-btn"
          aria-label="View Options"
          title="View Options"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menu.menuId : undefined}
          onClick={menu.toggle}
          onKeyDown={menu.onTriggerKeyDown}
        >
          <TuningIcon />
        </button>
        {menuOpen && (
          <MenuSurface
            surfaceRef={menu.menuRef}
            anchor={{ trigger: menu.triggerRef }}
            id={menu.menuId}
            label="View Options"
            align="end"
            onDismiss={() => menu.close(true)}
            onKeyDown={menu.onMenuKeyDown}
          >
            <div role="group" aria-label="Show">
              <MenuLabel>Show</MenuLabel>
              {SHOW_OPTIONS.map((option) => (
                <MenuItem key={option.value} role="menuitemradio" checked={show === option.value}
                  onClick={() => choose(() => setShow(option.value))}>
                  {option.label}
                </MenuItem>
              ))}
            </div>
            <MenuSeparator />
            <div role="group" aria-label="Group By">
              <MenuLabel>Group By</MenuLabel>
              {GROUPING_OPTIONS.map((option) => (
                <MenuItem key={option.value} role="menuitemradio" checked={grouping === option.value}
                  onClick={() => choose(() => setGrouping(option.value))}>
                  {option.label}
                </MenuItem>
              ))}
            </div>
          </MenuSurface>
        )}
      </div>
      <div ref={bodyRef} className="master-detail-list-body clip-focus" onScroll={onBodyScroll}>
        {skills !== null && overview && (
          <>
            <button
              type="button"
              className="row skill-list-overview"
              aria-describedby={overview.count > 0 ? overviewDescriptionId : undefined}
              onClick={overview.onOpen}
            >
              <span className="row-title">Library Overview</span>
              <CountBadge count={overview.count} />
            </button>
            {overview.count > 0 && (
              <span id={overviewDescriptionId} className="sr-only">
                {overview.count} {overview.count === 1 ? "item needs" : "items need"} attention
              </span>
            )}
          </>
        )}
        {skills === null ? (
          <div className="skeleton" role="status" aria-live="polite">
            <span className="sr-only">Loading skills</span>
            <div aria-hidden="true">
              {Array.from({ length: SKELETON_ROWS }, (_, index) => (
                <div className="row row-2 skill-row-skeleton" key={index}>
                  <span className="row-body">
                    <span className="skeleton-bar title" />
                    <span className="skeleton-bar" />
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : shown.length === 0 && skills.length > 0 ? (
          <State
            variant="no-results"
            compact
            className="skill-list-no-results"
            actions={trimmedQuery
              ? <button type="button" className="btn sm" onClick={() => setQuery("")}>Clear Search</button>
              : <button type="button" className="btn sm" onClick={() => setShow("all")}>Show All Skills</button>}
          >
            <SearchIcon size={16} aria-hidden="true" />
            <span>{trimmedQuery ? `No skills match “${trimmedQuery}”.` : `No skills match the ${showLabel} view.`}</span>
          </State>
        ) : shown.map((group) => (
          <div className="skill-list-group" role="group" aria-label={group.name ?? "Skills"} key={group.key}>
            {group.name !== null && (
              <h3 className="skill-list-group-title">
                {group.name}
                <span className="skill-list-group-count">{group.skills.length}</span>
              </h3>
            )}
            {group.skills.map((skill) => (
              <SkillRow
                key={skill.id}
                skill={skill}
                attention={attention.get(skill.id) ?? null}
                selected={selectedId === skill.id}
                onSelect={onSelect}
              />
            ))}
          </div>
        ))}
        {skills !== null && orphans.shown && (
          <ListFoot>
            <button
              type="button"
              className={`row skill-list-orphans${orphans.selected ? " is-selected" : ""}`}
              aria-current={orphans.selected ? "true" : undefined}
              aria-describedby={orphans.count > 0 ? orphansDescriptionId : undefined}
              onClick={orphans.onOpen}
            >
              <span className="row-title">Orphaned Copies</span>
              <CountBadge count={orphans.count} />
            </button>
            {orphans.count > 0 && (
              <span id={orphansDescriptionId} className="sr-only">
                {orphans.count} {orphans.count === 1 ? "copy" : "copies"}
              </span>
            )}
          </ListFoot>
        )}
      </div>
    </aside>
  );
}

function SkillRow({ skill, attention, selected, onSelect }: {
  skill: SkillSummary;
  attention: SkillAttention | null;
  selected: boolean;
  onSelect: (skillId: string) => void;
}) {
  const description = skillListDescription(skill);
  return (
    <button
      type="button"
      className={`row row-2 skill-row${selected ? " is-selected" : ""}`}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(skill.id)}
    >
      <span className="row-body">
        <span className="row-line">
          <span className="row-title">{skill.name}</span>
          {skill.builtIn && <StatusBadge tone="neutral" noDot label="Built-In" />}
          {attention && <StatusBadge meta={statusMeta("skill", attention)} className="skill-row-status" />}
        </span>
        {description !== null && (
          <span className={`row-sub${description ? "" : " is-empty"}`}>{description || "No description"}</span>
        )}
      </span>
    </button>
  );
}
