import type { ProjectLocationAvailability, ProjectLocationView, ProjectView, ResourceScope, RunnerView } from "@wollipog/protocol";
import { statusMeta, type StatusMeta } from "./status-meta.js";
import { workspaceLocationKey } from "./projects.js";

/** The Projects list's filter: whether a project has a Sessions tab (#2957). */
export type ProjectVisibilityFilter = "all" | "shown" | "hidden";

/** The name of the machine a location is on, as the Projects list shows and searches it. */
export type LocationMachineName = (location: ProjectLocationView) => string;

export interface ProjectLocationLink {
  projectId: string;
  locationId: string;
  availability: ProjectLocationAvailability;
}

export interface ProjectLocationCandidate {
  key: string;
  runnerId: string;
  workspaceId: string;
  name: string;
  path: string;
  availability: ProjectLocationAvailability;
  scope?: ResourceScope;
  canManage?: boolean;
  /** Project-specific memberships for this physical machine/workspace pair. */
  links: ProjectLocationLink[];
}

export function projectLocationMembershipState(
  candidate: ProjectLocationCandidate,
  projectId: string,
): {
  alreadyAdded: boolean;
  relinkRequired: boolean;
} {
  const targetLink = candidate.links.find((link) => link.projectId === projectId);
  const relinkRequired = targetLink?.availability === "runner_removed" &&
    candidate.availability !== "runner_removed";
  return {
    alreadyAdded: Boolean(targetLink && !relinkRequired),
    relinkRequired,
  };
}

export function projectAvailabilityMeta(availability: ProjectLocationAvailability): StatusMeta {
  return statusMeta("project_location", availability);
}

export function projectAvailabilityLabel(availability: ProjectLocationAvailability): string {
  return projectAvailabilityMeta(availability).label;
}

/** Projects matching the list's search and filter, by name. The search matches each project's name
 * and the machines its locations are on (#2957). */
export function filterManagedProjects(
  projects: Iterable<ProjectView>,
  query: string,
  visibility: ProjectVisibilityFilter,
  machineName?: LocationMachineName,
): ProjectView[] {
  return projectsMatchingSearch(projects, query, machineName)
    .filter((project) => visibility === "all" || (visibility === "hidden") === project.hidden);
}

function projectsMatchingSearch(
  projects: Iterable<ProjectView>,
  query: string,
  machineName?: LocationMachineName,
): ProjectView[] {
  const normalized = query.trim().toLocaleLowerCase();
  return [...projects]
    .filter((project) => !normalized || project.name.toLocaleLowerCase().includes(normalized) ||
      Boolean(machineName && project.locations.some((location) => machineName(location).toLocaleLowerCase().includes(normalized))))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

/** Each filter option's plain count. The counts follow the search, as Sessions' tab counts do (§8.4). */
export function projectVisibilityCounts(
  projects: Iterable<ProjectView>,
  query: string,
  machineName?: LocationMachineName,
): Record<ProjectVisibilityFilter, number> {
  const matching = projectsMatchingSearch(projects, query, machineName);
  const hidden = matching.filter((project) => project.hidden).length;
  return { all: matching.length, shown: matching.length - hidden, hidden };
}

/**
 * The machine a project row names on its sub-line: its default location's, or, with no default,
 * each machine its locations are on. Null when it has no locations yet.
 */
export function projectMachineSummary(project: ProjectView, machineName: LocationMachineName): string | null {
  const defaultLocation = project.locations.find((location) => location.isDefault);
  if (defaultLocation) return machineName(defaultLocation);
  const machines = [...new Set(project.locations.map(machineName))];
  return machines.length ? machines.join(", ") : null;
}

/**
 * The status a project row shows when none of its locations is available: its default location's
 * (or its first location's) reachability. Null while any location is available, or with none.
 */
export function projectUnavailableStatus(project: ProjectView): ProjectLocationAvailability | null {
  if (project.locations.length === 0 || project.locations.some((location) => location.availability === "available")) return null;
  return (project.locations.find((location) => location.isDefault) ?? project.locations[0]!).availability;
}

/** Build one exact candidate per runner/workspace. Project links remain separate so one physical
 * Location can be added to several Projects without losing any membership. */
export function buildProjectLocationCandidates(
  projects: Iterable<ProjectView>,
  runners: Iterable<RunnerView>,
): ProjectLocationCandidate[] {
  const candidates = new Map<string, ProjectLocationCandidate>();
  for (const project of projects) {
    for (const location of project.locations) {
      const key = workspaceLocationKey(location.runnerId, location.workspaceId);
      const existing = candidates.get(key);
      const link = {
        projectId: project.id,
        locationId: location.id,
        availability: location.availability,
      };
      candidates.set(key, existing ? {
        ...existing,
        links: [...existing.links, link],
      } : {
        key,
        runnerId: location.runnerId,
        workspaceId: location.workspaceId,
        name: location.name,
        path: location.path,
        availability: location.availability,
        ...(location.scope ? { scope: location.scope } : {}),
        ...(location.canManage !== undefined ? { canManage: location.canManage } : {}),
        links: [link],
      });
    }
  }
  for (const runner of runners) {
    for (const workspace of runner.workspaces) {
      const key = workspaceLocationKey(runner.runnerId, workspace.id);
      const linked = candidates.get(key);
      candidates.set(key, linked ? {
        ...linked,
        name: workspace.name,
        path: workspace.path,
        availability: runner.status === "online" ? "available" : "runner_offline",
        ...(workspace.scope ? { scope: workspace.scope } : {}),
        ...(workspace.canManage !== undefined ? { canManage: workspace.canManage } : {}),
      } : {
        key,
        runnerId: runner.runnerId,
        workspaceId: workspace.id,
        name: workspace.name,
        path: workspace.path,
        availability: runner.status === "online" ? "available" : "runner_offline",
        ...(workspace.scope ? { scope: workspace.scope } : {}),
        ...(workspace.canManage !== undefined ? { canManage: workspace.canManage } : {}),
        links: [],
      });
    }
  }
  return [...candidates.values()].sort((left, right) =>
    left.runnerId.localeCompare(right.runnerId) || left.path.localeCompare(right.path) ||
    left.workspaceId.localeCompare(right.workspaceId));
}

export function projectAfterRemoval(
  projects: readonly ProjectView[],
  removedProjectId: string,
): ProjectView | null {
  const index = projects.findIndex((project) => project.id === removedProjectId);
  if (index === -1) return projects[0] ?? null;
  return projects[index + 1] ?? projects[index - 1] ?? null;
}

export function locationSessionCount(location: ProjectLocationView): number | null {
  return typeof location.totalSessionCount === "number" ? location.totalSessionCount : null;
}
