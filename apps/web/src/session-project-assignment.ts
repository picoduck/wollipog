import type { ProjectView, SessionView } from "@wollipog/protocol";

export interface SessionProjectChoice {
  id: string;
  name: string;
  audience?: ProjectView["audience"];
  compatible: boolean;
  linkable: boolean;
  current: boolean;
}

export function shouldSubmitProjectAssignment(
  currentProjectId: string | null | undefined,
  targetProjectId: string | null,
  linkLocation: boolean,
): boolean {
  return linkLocation || targetProjectId !== (currentProjectId ?? null);
}

/**
 * Persist a Project assignment without treating the mutation response as a live session snapshot.
 * The control plane broadcasts an authoritative, queue-decorated `session_upsert` before replying;
 * dispatching the DB-built HTTP response afterward could erase a newer active turn or queue clear.
 */
export async function persistProjectAssignment(
  setProject: (
    sessionId: string,
    projectId: string | null,
    options: { linkLocation?: boolean },
  ) => Promise<unknown>,
  sessionId: string,
  projectId: string | null,
  linkLocation: boolean,
): Promise<void> {
  await setProject(sessionId, projectId, { linkLocation });
}

export function projectAudienceLabel(audience: ProjectView["audience"]): string | null {
  return audience === "team" ? "Team Project"
    : audience === "organization" ? "Organization Project"
      : audience === "user" ? "Personal Project" : null;
}

export function projectAudienceVisibilityLabel(audience: ProjectView["audience"]): string | null {
  return audience === "team" ? "Everyone on the Owning Team"
    : audience === "organization" ? "Everyone in Your Organization"
      : audience === "user" ? "Only the Project Owner" : null;
}

export function projectAudienceVisibilitySummary(audience: ProjectView["audience"]): string | null {
  const label = projectAudienceVisibilityLabel(audience);
  return label ? `Project Visibility: ${label}` : null;
}

/** Require consent for the supported personal-to-team share and fail closed when an older control
 * plane omits either audience, since the client cannot prove the move preserves transcript access. */
export function projectAssignmentAudienceConfirmation(
  session: SessionView,
  project: ProjectView,
): "team" | "unknown" | null {
  if (session.audience === undefined || project.audience === undefined) return "unknown";
  return session.audience === "user" && project.audience === "team" ? "team" : null;
}

/** Projects that can organize a session at its existing exact Location. Project names are display
 * only; compatibility is determined solely from stable runner/workspace Location identity. */
export function sessionProjectChoices(
  session: SessionView,
  projects: Iterable<ProjectView>,
): SessionProjectChoice[] {
  const currentId = session.projectId ?? null;
  const byId = new Map([...projects].map((project) => [project.id, project]));
  const choices = [...byId.values()]
    .map((project) => {
      const compatible = session.workspaceId !== null && project.locations.some((location) =>
        location.runnerId === session.runnerId && location.workspaceId === session.workspaceId);
      return {
        project,
        compatible,
        // Linking mutates Project structure, so older control planes and non-managers fail closed.
        linkable: session.adopted && session.importLocationReady === true &&
          !compatible && project.canManage === true,
      };
    })
    .filter(({ project, compatible }) => compatible || project.id === currentId || session.adopted)
    .sort((left, right) => left.project.name.localeCompare(right.project.name) ||
      left.project.id.localeCompare(right.project.id))
    .map(({ project, compatible, linkable }) => ({
      id: project.id,
      name: project.name,
      audience: project.audience,
      compatible,
      linkable,
      current: project.id === currentId,
    }));

  const currentChoice = currentId ? choices.find((choice) => choice.id === currentId) : undefined;
  if (currentChoice && !currentChoice.compatible) {
    return [currentChoice, ...choices.filter((choice) => choice.id !== currentId)];
  }
  if (!currentId || currentChoice) return choices;
  const current = byId.get(currentId);
  return [{
    id: currentId,
    name: current?.name ?? session.projectName ?? "Current Project",
    audience: current?.audience,
    compatible: false,
    linkable: false,
    current: true,
  }, ...choices];
}
