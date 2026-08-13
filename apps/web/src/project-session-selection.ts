import type { ProjectLocationView, ProjectView, RunnerView } from "@wollipog/protocol";

export const NO_PROJECT_SELECTION = "__no_project__";

export function projectFallbacksAwaitingStore(
  stored: ReadonlyMap<string, ProjectView>,
  fallbacks: ReadonlyMap<string, ProjectView>,
): Map<string, ProjectView> {
  const pending = new Map<string, ProjectView>();
  for (const [id, project] of fallbacks) {
    const authoritative = stored.get(id);
    if (!authoritative || project.updatedAt > authoritative.updatedAt) pending.set(id, project);
  }
  return pending;
}

/** Inline mutation responses bridge the socket round trip. The store wins at equal/newer revisions,
 * while a newer response remains visible until its matching Project upsert arrives. */
export function projectInventoryWithFallbacks(
  stored: ReadonlyMap<string, ProjectView>,
  fallbacks: ReadonlyMap<string, ProjectView>,
): Map<string, ProjectView> {
  const projects = new Map(stored);
  for (const [id, project] of projectFallbacksAwaitingStore(stored, fallbacks)) projects.set(id, project);
  return projects;
}

export interface ProjectSessionPreset {
  projectId?: string | null;
  projectLocationId?: string;
  runnerId?: string;
  workspaceId?: string;
}

/** Map an optional launch preset to the Project selector's initial value. */
export function initialProjectSelectionForPreset(
  projectsSupported: boolean,
  presetProject: ProjectView | null,
  preset: ProjectSessionPreset | undefined,
): string {
  if (!projectsSupported) return "";
  if (preset?.projectId === null) return NO_PROJECT_SELECTION;
  return presetProject?.id ?? "";
}

/** A Location is launchable only while both the durable Project view and live runner catalog
 * agree that the exact runner/workspace pair is available. */
export function isLaunchableProjectLocation(
  location: ProjectLocationView,
  runners: ReadonlyMap<string, RunnerView>,
): boolean {
  const runner = runners.get(location.runnerId);
  return location.availability === "available" && runner?.status === "online" &&
    runner.workspaces.some((workspace) => workspace.id === location.workspaceId);
}

/** Preserve an exact preset when supplied. Otherwise choose an available default, or the sole
 * available Location. Multiple available Locations without a default require an explicit choice. */
export function suggestedProjectLocation(
  project: ProjectView,
  runners: ReadonlyMap<string, RunnerView>,
  presetLocationId?: string,
): ProjectLocationView | null {
  if (presetLocationId) {
    return project.locations.find((location) => location.id === presetLocationId) ?? null;
  }
  const available = project.locations.filter((location) => isLaunchableProjectLocation(location, runners));
  return available.find((location) => location.isDefault) ?? (available.length === 1 ? available[0]! : null);
}

/** Resolve older exact runner/workspace presets without ever comparing Project display names. */
export function projectForSessionPreset(
  projects: Iterable<ProjectView>,
  preset: ProjectSessionPreset | undefined,
): ProjectView | null {
  if (!preset || preset.projectId === null) return null;
  const list = [...projects];
  if (preset.projectId !== undefined) return list.find((project) => project.id === preset.projectId) ?? null;
  if (!preset.runnerId || !preset.workspaceId) return null;
  return list.find((project) => project.locations.some((location) =>
    location.runnerId === preset.runnerId && location.workspaceId === preset.workspaceId)) ?? null;
}

export function projectLocationForSessionPreset(
  project: ProjectView,
  preset: ProjectSessionPreset | undefined,
): ProjectLocationView | null {
  if (!preset) return null;
  if (preset.projectLocationId) {
    return project.locations.find((location) => location.id === preset.projectLocationId) ?? null;
  }
  if (!preset.runnerId || !preset.workspaceId) return null;
  return project.locations.find((location) =>
    location.runnerId === preset.runnerId && location.workspaceId === preset.workspaceId) ?? null;
}

export function projectSelectionLabel(project: ProjectView, duplicateName: boolean): string {
  if (!duplicateName) return project.name;
  const location = project.locations.find((candidate) => candidate.isDefault) ?? project.locations[0];
  return location
    ? `${project.name} — ${location.path} · ${location.runnerId}`
    : `${project.name} — ${project.id.slice(-6)}`;
}

export interface ProjectSessionPlacement {
  runnerId: string;
  workspaceId: string;
  projectId?: string | null;
  projectLocationId?: string | null;
}

/** Build the identity-bearing portion of CreateSessionRequest. Project-aware control planes get
 * either the exact durable pair or explicit nulls; legacy control planes omit both fields. */
export function projectSessionPlacement(
  projectsSupported: boolean,
  project: ProjectView | null,
  location: ProjectLocationView | null,
  fallback: Pick<ProjectSessionPlacement, "runnerId" | "workspaceId">,
): ProjectSessionPlacement {
  if (!projectsSupported) return fallback;
  if (!project || !location) return { ...fallback, projectId: null, projectLocationId: null };
  return {
    runnerId: location.runnerId,
    workspaceId: location.workspaceId,
    projectId: project.id,
    projectLocationId: location.id,
  };
}

/** Explain why a Project-aware run cannot launch yet. No Project deliberately leaves runner and
 * workspace validation to the caller so legacy placement behavior stays unchanged. */
export function projectRunPlacementIssue(
  projectsSupported: boolean,
  projectSelection: string,
  project: ProjectView | null,
  location: ProjectLocationView | null,
  runners: ReadonlyMap<string, RunnerView>,
): string | null {
  if (!projectsSupported || projectSelection === NO_PROJECT_SELECTION) return null;
  if (!projectSelection) return "Choose a Project or No Project.";
  if (!project) return "The selected Project is no longer available. Choose another Project.";
  if (project.locations.length === 0) return "This Project has no Locations. Add a Location before starting a run.";
  if (!project.locations.some((candidate) => isLaunchableProjectLocation(candidate, runners))) {
    return "No Project Locations are currently available.";
  }
  if (!location) return "Choose an available Project Location.";
  if (!isLaunchableProjectLocation(location, runners)) return "The selected Project Location is unavailable.";
  return null;
}
