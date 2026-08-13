import type { ProjectView } from "@wollipog/protocol";

export interface AutomationPlacementTarget {
  runnerId: string;
  workspaceId: string;
}

export interface AutomationProjectPlacement {
  projectId?: string | null;
  projectLocationId?: string | null;
}

/** Resolve automation placement only from the exact runner/workspace Location identity. */
export function automationProjectPlacement(
  projectsSupported: boolean,
  projects: Iterable<ProjectView>,
  target: AutomationPlacementTarget,
): AutomationProjectPlacement {
  if (!projectsSupported) return {};
  const matches = [...projects].flatMap((project) => project.locations
    .filter((location) => location.runnerId === target.runnerId && location.workspaceId === target.workspaceId)
    .map((location) => ({ projectId: project.id, projectLocationId: location.id })));
  if (matches.length > 1) {
    throw new Error("This exact runner and workspace belongs to more than one Project. Fix the Project Locations before saving.");
  }
  return matches[0] ?? { projectId: null, projectLocationId: null };
}

/** Durable alternates must remain within one Project, or both remain explicitly outside Projects. */
export function validateAutomationAlternatePlacement(
  projectsSupported: boolean,
  primary: AutomationProjectPlacement,
  alternate: AutomationProjectPlacement,
): void {
  if (!projectsSupported) return;
  if (primary.projectId === null && primary.projectLocationId === null &&
      alternate.projectId === null && alternate.projectLocationId === null) {
    return;
  }
  if (!primary.projectId || !primary.projectLocationId) {
    throw new Error("An alternate target requires the primary workspace to be a Project Location.");
  }
  if (alternate.projectId !== primary.projectId || !alternate.projectLocationId) {
    throw new Error("The alternate target must be another Location in the same Project.");
  }
  if (alternate.projectLocationId === primary.projectLocationId) {
    throw new Error("The alternate target must be a different Location in the same Project.");
  }
}
