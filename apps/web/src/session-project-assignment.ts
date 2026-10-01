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

/** What the Move to Project primary does, named by its outcome (#2163). Sharing wins over linking:
 * a team or unknown audience is the consequence a person must see in the button they press. */
export interface ProjectMovePlan {
  primary: "Move Session" | "Add Folder and Move" | "Move and Share";
  linkLocation: boolean;
  audience: "team" | "unknown" | null;
}

export function projectMovePlan(
  session: SessionView,
  target: ProjectView | undefined,
  choice: SessionProjectChoice | undefined,
): ProjectMovePlan {
  const linkLocation = Boolean(choice && !choice.current && choice.linkable);
  const audience = target ? projectAssignmentAudienceConfirmation(session, target) : null;
  return {
    primary: audience ? "Move and Share" : linkLocation ? "Add Folder and Move" : "Move Session",
    linkLocation,
    audience,
  };
}

/** The owning team's name, when the Project is team-owned and the person can read its teams. */
export function projectTeamName(
  project: ProjectView | undefined,
  teams: readonly { teamId: string; name: string }[] | undefined,
): string | null {
  const owner = project?.scope?.owner;
  if (owner?.kind !== "team") return null;
  return teams?.find((team) => team.teamId === owner.teamId)?.name ?? null;
}

function teamPhrase(teamName: string | null): string {
  return teamName ? `the ${teamName} team` : "the owning team";
}

/** A Move to Project row's one line: whether it includes this folder, then who it is shared with. */
export function projectMoveRowDescription(choice: SessionProjectChoice, teamName: string | null): string {
  const folder = choice.compatible ? "Includes this folder."
    : choice.current ? "Doesn't include this folder."
      : "Adds this folder to the project.";
  return choice.audience === "team" ? `${folder} Shared with ${teamPhrase(teamName)}.` : folder;
}

/** Why a row cannot be chosen, in plain words; null when it can. */
export function projectMoveRowRefusal(session: SessionView, choice: SessionProjectChoice): string | null {
  if (choice.current || choice.compatible || choice.linkable) return null;
  return session.adopted && session.importLocationReady !== true
    ? "Waiting for the machine to check this folder."
    : "Only people who manage this project can add this folder.";
}

/** The inline notice for the selected row, replacing the separate consent dialog (#2163). */
export function projectMoveNotice(
  plan: ProjectMovePlan,
  projectName: string,
  folder: string,
  teamName: string | null,
): { tone: "info" | "warning"; text: string } | null {
  const link = plan.linkLocation
    ? `${projectName} will include ${folder}. New sessions in that folder may be filed there too.`
    : null;
  const sharing = plan.audience === "team"
    ? `Members of ${teamPhrase(teamName)} will be able to read this conversation. Moving it out later doesn't remove their access.`
    : plan.audience === "unknown"
      ? "This Wollipog doesn't report who can read this project, so moving the session may change who can read this conversation."
      : null;
  if (sharing) return { tone: "warning", text: link ? `${link} ${sharing}` : sharing };
  return link ? { tone: "info", text: link } : null;
}
