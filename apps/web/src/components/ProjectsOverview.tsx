import { useId, useMemo } from "react";
import type { ProjectView } from "@wollipog/protocol";
import { projectAvailabilityMeta, projectMachineSummary, type LocationMachineName } from "../project-management.js";
import {
  PROJECTS_GET_STARTED_BELOW,
  projectActivitySummary,
  projectsMostActive,
  projectsOverviewSummary,
  type ProjectsOverviewAttentionItem,
} from "../projects-overview.js";
import { StatusBadge } from "./StatusBadge.js";

export interface ProjectsOverviewProps {
  /** Every project, unfiltered: a search changes only the list. */
  projects: readonly ProjectView[];
  /** Needs Attention, from `projectsOverviewAttention()`: the page counts the same list on a phone. */
  attention: ProjectsOverviewAttentionItem[];
  machineName: LocationMachineName;
  /** False on a phone, where the detail bar already names the route. */
  showTitle: boolean;
  onOpenProject: (projectId: string) => void;
  onAddLocation: (projectId: string) => void;
  /** Opens the project with its Name field focused. */
  onRename: (projectId: string) => void;
  onNewProject: () => void;
  onConnectMachine: () => void;
}

/**
 * The Projects default detail (docs/design-system.md §6.1, #2958), at `/projects` beside the list and
 * at `/projects/overview` on a phone: the counts, what keeps a project from starting sessions or
 * from being told apart, the most active projects, and, while there are few, how to add more.
 */
export function ProjectsOverview({
  projects, attention, machineName, showTitle, onOpenProject, onAddLocation, onRename, onNewProject, onConnectMachine,
}: ProjectsOverviewProps) {
  const id = useId().replace(/:/g, "");
  const mostActive = useMemo(() => projectsMostActive(projects), [projects]);

  return (
    <div className="projects-overview">
      <header className="projects-overview-head">
        {showTitle && <h2 className="projects-overview-title">Projects Overview</h2>}
        <p className="projects-overview-summary">{projectsOverviewSummary(projects)}</p>
      </header>

      <section className="section" aria-labelledby={`${id}-attention`}>
        <div className="section-head">
          <h3 className="section-title" id={`${id}-attention`}>
            Needs Attention
            {attention.length > 0 && <span className="projects-overview-count">{attention.length}</span>}
          </h3>
        </div>
        {attention.length > 0 ? (
          <div className="surface">
            {attention.map((item) => (
              <AttentionRow key={`${item.kind}:${item.kind === "duplicate-name" ? item.target.id : item.project.id}`}
                item={item} onOpenProject={onOpenProject} onAddLocation={onAddLocation} onRename={onRename} />
            ))}
          </div>
        ) : (
          <p className="projects-overview-ok">
            <span className="projects-overview-dot" aria-hidden="true" />
            <span>Every project can start sessions.</span>
          </p>
        )}
      </section>

      {mostActive.length > 0 && (
        <section className="section" aria-labelledby={`${id}-active`}>
          <div className="section-head">
            <h3 className="section-title" id={`${id}-active`}>Most Active</h3>
          </div>
          <div className="surface">
            {mostActive.map((project) => (
              <button type="button" className="row row-2 projects-overview-row" key={project.id}
                onClick={() => onOpenProject(project.id)}>
                <span className="row-body">
                  <span className="row-line">
                    <span className="row-title">{project.name}</span>
                    <span className="row-trail">{projectActivitySummary(project)}</span>
                  </span>
                  <span className="row-sub">{projectMachineSummary(project, machineName) ?? "No locations yet"}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {projects.length < PROJECTS_GET_STARTED_BELOW && (
        <section className="section" aria-labelledby={`${id}-start`}>
          <div className="section-head">
            <h3 className="section-title" id={`${id}-start`}>Get Started</h3>
          </div>
          <ul className="projects-get-started">
            <li>
              <button type="button" className="btn" onClick={onNewProject}>New Project</button>
              <span className="projects-overview-hint">Group the sessions for a repository and choose the folders where they run.</span>
            </li>
            <li>
              <button type="button" className="btn" onClick={onConnectMachine}>Connect a Machine</button>
              <span className="projects-overview-hint">Run sessions on another computer, then add its folders to a project.</span>
            </li>
          </ul>
        </section>
      )}
    </div>
  );
}

/** A Needs Attention row (§5.2): what is wrong on two lines, and the one action that fixes it. A
 * project the person can't change offers Open instead. */
function AttentionRow({ item, onOpenProject, onAddLocation, onRename }: {
  item: ProjectsOverviewAttentionItem;
  onOpenProject: (projectId: string) => void;
  onAddLocation: (projectId: string) => void;
  onRename: (projectId: string) => void;
}) {
  const project = item.kind === "duplicate-name" ? item.target : item.project;
  const manageable = project.canManage !== false;
  const title = item.kind === "duplicate-name" ? `${item.projects.length} Projects Named ${item.name}` : project.name;
  const open = <button type="button" className="btn sm" aria-label={`Open ${project.name}`}
    onClick={() => onOpenProject(project.id)}>Open</button>;
  return (
    <div className="row row-2 projects-overview-row">
      <span className="row-body">
        <span className="row-line">
          <span className="row-title" title={title}>{title}</span>
          {item.kind === "unavailable" && <StatusBadge meta={projectAvailabilityMeta(item.status)} />}
        </span>
        <span className="row-sub" title={item.reason}>{item.reason}</span>
      </span>
      {item.kind === "no-locations" && manageable ? (
        <button type="button" className="btn sm" aria-label={`Add Location to ${project.name}`}
          onClick={() => onAddLocation(project.id)}>Add Location…</button>
      ) : item.kind === "duplicate-name" && manageable ? (
        <button type="button" className="btn sm" aria-label={`Rename ${project.name}`}
          onClick={() => onRename(project.id)}>Rename…</button>
      ) : open}
    </div>
  );
}
