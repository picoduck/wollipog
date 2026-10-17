import { useMemo, type Ref, type UIEventHandler } from "react";
import type { ProjectView } from "@wollipog/protocol";
import {
  projectAvailabilityMeta,
  projectMachineSummary,
  projectUnavailableStatus,
  projectVisibilityCounts,
  type LocationMachineName,
  type ProjectVisibilityFilter,
} from "../project-management.js";
import { SearchIcon } from "./Icons.js";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";
import { SegmentedControl } from "./ui/ChoiceControls.js";

/** Skeleton rows while the snapshot loads (§12.3): the two-line row's height and anatomy. */
const SKELETON_ROWS = 5;

const FILTER_LABELS: Record<ProjectVisibilityFilter, string> = { all: "All", shown: "Shown", hidden: "Hidden" };

export interface ProjectListProps {
  /** Every project, unfiltered; null while the snapshot loads. */
  projects: readonly ProjectView[] | null;
  /** The projects the search and filter leave, in order (`filterManagedProjects`). */
  shown: readonly ProjectView[];
  query: string;
  onQueryChange: (query: string) => void;
  visibility: ProjectVisibilityFilter;
  onVisibilityChange: (visibility: ProjectVisibilityFilter) => void;
  /** The machine each location is on, which rows name and the search matches. */
  machineName: LocationMachineName;
  selectedId: string | null;
  onSelect: (projectId: string) => void;
  /** The list's one scroll container, which the page restores on a phone's Back. */
  bodyRef?: Ref<HTMLDivElement>;
  onBodyScroll?: UIEventHandler<HTMLDivElement>;
}

/**
 * The Projects list pane (docs/design-system.md §5.2, §6, #2957): the search field and the Sessions
 * Tabs filter with plain counts over equal two-line rows. A search with no match is one inline row.
 * The page owns the search and filter, for as long as it is open.
 */
export function ProjectList({
  projects, shown, query, onQueryChange: setQuery, visibility, onVisibilityChange: setVisibility,
  machineName, selectedId, onSelect, bodyRef, onBodyScroll,
}: ProjectListProps) {
  const counts = useMemo(() => projects ? projectVisibilityCounts(projects, query, machineName) : null,
    [machineName, projects, query]);
  const trimmedQuery = query.trim();

  return (
    <aside className="master-detail-list" aria-label="Projects" data-focus-zone="list" tabIndex={-1}>
      <div className="master-detail-list-head project-list-head">
        <label className="input-affix" title="Searches project names and the machines they are on.">
          <span className="input-affix-text" aria-hidden="true"><SearchIcon size={14} /></span>
          <input
            type="search"
            aria-label="Search Projects"
            placeholder="Search projects"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {/* "Shown" and "Hidden" say whether a project has a Sessions tab, the detail's words too. */}
        <SegmentedControl
          className="block"
          label="Sessions Tabs"
          value={visibility}
          options={(["all", "shown", "hidden"] as const).map((value) => ({
            value,
            label: FILTER_LABELS[value],
            ...(counts ? { count: counts[value] } : {}),
          }))}
          onChange={setVisibility}
        />
      </div>
      <div ref={bodyRef} className="master-detail-list-body clip-focus" onScroll={onBodyScroll}>
        {projects === null ? (
          <div className="skeleton" role="status" aria-live="polite">
            <span className="sr-only">Loading projects</span>
            <div aria-hidden="true">
              {Array.from({ length: SKELETON_ROWS }, (_, index) => (
                <div className="row row-2 project-row-skeleton" key={index}>
                  <span className="row-body">
                    <span className="skeleton-bar title" />
                    <span className="skeleton-bar" />
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : shown.length === 0 ? (
          <State
            variant="no-results"
            compact
            className="project-list-no-results"
            actions={trimmedQuery
              ? <button type="button" className="btn sm" onClick={() => setQuery("")}>Clear Search</button>
              : <button type="button" className="btn sm" onClick={() => setVisibility("all")}>Show All Projects</button>}
          >
            <SearchIcon size={16} aria-hidden="true" />
            <span>{trimmedQuery
              ? `No projects match “${trimmedQuery}”.`
              : `No projects match the ${FILTER_LABELS[visibility]} filter.`}</span>
          </State>
        ) : shown.map((project) => (
          <ProjectRow
            key={project.id}
            project={project}
            machineName={machineName}
            selected={project.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </aside>
  );
}

/**
 * One project (§5.2): its name, a status only when none of its locations is reachable, and a
 * trailing plain count of its unarchived sessions; under them, the machine it is on.
 */
function ProjectRow({ project, machineName, selected, onSelect }: {
  project: ProjectView;
  machineName: LocationMachineName;
  selected: boolean;
  onSelect: (projectId: string) => void;
}) {
  const unavailable = projectUnavailableStatus(project);
  const machine = projectMachineSummary(project, machineName);
  const sessions = project.unarchivedSessionCount;
  return (
    <button
      type="button"
      className={`row row-2${selected ? " is-selected" : ""}`}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(project.id)}
    >
      <span className="row-body">
        <span className="row-line">
          <span className="row-title">{project.name}</span>
          {unavailable && <StatusBadge meta={projectAvailabilityMeta(unavailable)} />}
          <span className="row-trail">
            <span aria-hidden="true">{sessions}</span>
            <span className="sr-only">{`, ${sessions} ${sessions === 1 ? "session" : "sessions"}`}</span>
          </span>
        </span>
        <span className="row-sub">
          {project.hidden && "Hidden tab · "}
          {machine ?? "No locations yet"}
        </span>
      </span>
    </button>
  );
}
