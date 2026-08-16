import type { ProjectLocationAvailability, ProjectLocationView, ProjectView, ResourceScope, RunnerView } from "@wollipog/protocol";
import { workspaceLocationKey } from "./projects.js";

export type ProjectVisibilityFilter = "all" | "visible" | "hidden";

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

export function projectAvailabilityLabel(availability: ProjectLocationAvailability): string {
  switch (availability) {
    case "available": return "Available";
    case "runner_offline": return "Runner Offline";
    case "workspace_missing": return "Workspace Missing";
    case "runner_removed": return "Runner Removed";
  }
}

export function filterManagedProjects(
  projects: Iterable<ProjectView>,
  query: string,
  visibility: ProjectVisibilityFilter,
): ProjectView[] {
  const normalized = query.trim().toLocaleLowerCase();
  return [...projects]
    .filter((project) => visibility === "all" || (visibility === "hidden") === project.hidden)
    .filter((project) => !normalized || project.name.toLocaleLowerCase().includes(normalized) ||
      project.locations.some((location) => `${location.name} ${location.path}`.toLocaleLowerCase().includes(normalized)))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
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
