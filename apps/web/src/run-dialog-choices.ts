import type { AgentDefinition, ProjectLocationView, ProjectView, RunnerView, WorkflowDefinition } from "@wollipog/protocol";
import { agentOptions, agentSetupReason, type AgentOption } from "./components/agent-options.js";
import { titleCaseLabel } from "./format.js";
import { liveLocationAvailability } from "./project-session-selection.js";
import type { RunWorkMode } from "./workflow-presets.js";

/**
 * What New Multi-Agent Run offers (#2978): the agents a comparison can choose and which start
 * chosen, each Location as a folder on a Machine, the roles a workflow binds, and why the primary
 * is unavailable. Pure, so the dialog and its tests read the same rules.
 */

/** The sentence under the type switch, for the selected type. */
export const RUN_TYPE_DESCRIPTION: Record<RunWorkMode, string> = {
  parallel: "Each agent gets the same task in its own worktree.",
  workflow: "Agents take turns as roles, and you approve between steps.",
};

/** The agent's provider says it is signed out. Such an agent can start, but its first turn fails. */
export function agentSignedOut(agent: AgentDefinition): boolean {
  return agent.authStatus === "unauthenticated" || agent.claudeCode?.status === "unauthenticated" ||
    agent.claudeCode?.auth.status === "unauthenticated";
}

export interface RunAgentChoice {
  option: AgentOption;
  /** "<Machine> · Signed in", or the reason it cannot be chosen. */
  description: string;
  disabledReason?: string;
}

/**
 * Every agent the Machine offers, in agentOptions' order: the ones that can run with a meta line
 * naming the Machine and, when known, the sign-in, and the ones that cannot as disabled rows with
 * their fix. A signed-out agent is refused here, though New Session lets it start: a run would
 * start it unattended, beside the others, only to fail its first turn.
 */
export function runAgentChoices(
  agents: AgentDefinition[],
  machine: string,
  availabilityVerified: boolean,
): RunAgentChoice[] {
  return agentOptions(agents).map((option) => {
    const { agent } = option;
    if (option.disabled) {
      const disabledReason = agentSetupReason(agent, machine, availabilityVerified);
      return { option, description: disabledReason, disabledReason };
    }
    if (agentSignedOut(agent)) {
      const disabledReason = `Sign in on ${machine} first.`;
      return { option, description: disabledReason, disabledReason };
    }
    const signedIn = agent.authStatus === "authenticated" || agent.claudeCode?.auth.status === "authenticated";
    return { option, description: signedIn ? `${machine} · Signed in` : machine };
  });
}

/** The ids a comparison can run: available, interactive (agentOptions never offers the retired
 * non-interactive Codex exec) and not signed out. */
export function selectableRunAgentIds(agents: AgentDefinition[]): string[] {
  return agentOptions(agents)
    .filter((option) => !option.disabled && !agentSignedOut(option.agent))
    .map((option) => option.agent.id);
}

/** The most agents a new comparison starts with; a large Machine would otherwise start six. */
export const DEFAULT_RUN_AGENT_LIMIT = 3;

/**
 * The agents Compare Agents starts with: at most three that can run, one per driver first (so a
 * comparison compares different harnesses), then the rest in agentOptions' order.
 */
export function defaultRunAgentIds(agents: AgentDefinition[]): string[] {
  const selectable = new Set(selectableRunAgentIds(agents));
  const candidates = agentOptions(agents).filter((option) => selectable.has(option.agent.id)).map((option) => option.agent);
  const chosen: AgentDefinition[] = [];
  const drivers = new Set<string>();
  for (const agent of candidates) {
    const driver = agent.driver ?? "acp";
    if (chosen.length < DEFAULT_RUN_AGENT_LIMIT && !drivers.has(driver)) {
      chosen.push(agent);
      drivers.add(driver);
    }
  }
  for (const agent of candidates) {
    if (chosen.length >= DEFAULT_RUN_AGENT_LIMIT) break;
    if (!chosen.includes(agent)) chosen.push(agent);
  }
  // In the list's order, so the request names them as the rows read.
  return candidates.filter((agent) => chosen.includes(agent)).map((agent) => agent.id);
}

/** A folder's own name: the last segment of its path. */
export function folderName(path: string): string {
  return path.split(/[\\/]+/u).filter(Boolean).at(-1) ?? path;
}

export interface RunLocationOption {
  value: string;
  /** "<folder> on <Machine>"; the folder alone when this device cannot name its Machine. */
  label: string;
  /** The full path. */
  description: string;
  disabled?: boolean;
  disabledReason?: string;
}

/**
 * A Project's Locations as "<folder> on <Machine>" with the full path below. One that cannot host
 * the run stays listed, disabled with its reason. Machines are named by `machineNames`, which never
 * falls back to a connection id (#2978).
 */
export function runLocationOptions(
  project: ProjectView,
  runners: ReadonlyMap<string, RunnerView>,
  machineNames: ReadonlyMap<string, string>,
): RunLocationOption[] {
  return project.locations.map((location) => {
    const machine = machineNames.get(location.runnerId);
    const folder = folderName(location.path);
    const disabledReason = runLocationUnavailableReason(location, runners, machine);
    return {
      value: location.id,
      label: machine ? `${folder} on ${machine}` : folder,
      description: location.path,
      ...(disabledReason ? { disabled: true, disabledReason } : {}),
    };
  });
}

function runLocationUnavailableReason(
  location: ProjectLocationView,
  runners: ReadonlyMap<string, RunnerView>,
  machine: string | undefined,
): string | undefined {
  switch (liveLocationAvailability(location, runners)) {
    case "available": return undefined;
    case "runner_removed": return "Its machine was removed.";
    case "workspace_missing": return `${machine ?? "Its machine"} no longer has this folder.`;
    case "runner_offline": return `${machine ?? "Its machine"} is offline.`;
  }
}

/**
 * Who can see the agents' sessions in the chosen Project, in one sentence under the Project field.
 * It names the sessions, not the run: a run itself is listed to every administrator, and only its
 * members' sessions and transcripts take the Project's audience (CR-1.1 of #3566).
 */
export function runVisibilitySentence(project: ProjectView | null, noProject: boolean): string | null {
  if (noProject) return "This run won't be added to a project.";
  if (!project) return null;
  switch (project.audience) {
    case "user": return "Only the project owner can see the agents' sessions.";
    case "team": return "Everyone on the owning team can see the agents' sessions.";
    case "organization": return "Everyone in your organization can see the agents' sessions.";
    default: return "Wollipog can't show who can see the agents' sessions.";
  }
}

export interface WorkflowRoleField {
  /** The binding key: the agent id the definition's agent steps name. */
  key: string;
  /** The steps it takes, in Title Case: "Builder Agent", or "Builder and Remediator Agent". */
  label: string;
}

const roleWords = (role: string) => titleCaseLabel(role.replace(/[_-]+/gu, " ").trim());

function joinWords(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * One field per agent the workflow binds, labelled by the roles of the steps it takes rather than
 * by its id: the built-in Build and independent review binds `claude` to Builder and Remediator.
 * A key whose steps name no role falls back to the key itself.
 */
export function workflowRoleFields(definition: WorkflowDefinition | undefined): WorkflowRoleField[] {
  if (!definition) return [];
  const roles = new Map<string, string[]>();
  for (const node of definition.nodes) {
    if (node.kind !== "agent" || !node.agentId) continue;
    const list = roles.get(node.agentId) ?? [];
    const words = roleWords(node.role);
    if (words && !list.includes(words)) list.push(words);
    roles.set(node.agentId, list);
  }
  return [...roles].map(([key, words]) => {
    const name = words.length ? joinWords(words) : roleWords(key) || key;
    return { key, label: /\bAgent$/u.test(name) ? name : `${name} Agent` };
  });
}

/** The workflow's human steps, by role, in definition order: the person answers them in the run. */
export function workflowHumanRoles(definition: WorkflowDefinition | undefined): string[] {
  if (!definition) return [];
  return [...new Set(definition.nodes
    .filter((node) => node.kind === "human_gate")
    .map((node) => roleWords(node.role) || "Approver"))];
}

export interface NewRunBlockInput {
  task: string;
  machinesOnline: boolean;
  /** No Project, or a control plane without projects: the run is placed by Machine and Folder. */
  placedByMachine: boolean;
  projectChosen: boolean;
  project: ProjectView | null;
  location: ProjectLocationView | null;
  runners: ReadonlyMap<string, RunnerView>;
  runnerId: string;
  workspaceId: string;
  mode: RunWorkMode;
  agentCount: number;
  workflowChosen: boolean;
  workflowBound: boolean;
}

/** Why the primary is unavailable, in the order the fields read, or null once the run can start. */
export function newRunBlockedReason(input: NewRunBlockInput): string | null {
  if (!input.machinesOnline) return "Bring a machine online to continue.";
  if (!input.task.trim()) return "Enter a task to continue.";
  if (input.placedByMachine) {
    if (!input.runnerId) return "Choose a machine to continue.";
    if (!input.workspaceId) return "Choose a folder to continue.";
  } else {
    if (!input.projectChosen) return "Choose a project to continue.";
    if (!input.project) return "Choose another project to continue.";
    if (input.project.locations.length === 0) return "Add a location to this project to continue.";
    const launchable = (location: ProjectLocationView) => liveLocationAvailability(location, input.runners) === "available";
    if (!input.project.locations.some(launchable)) return "Bring one of this project's machines online to continue.";
    if (!input.location) return "Choose a location to continue.";
    if (!launchable(input.location)) return "Choose an available location to continue.";
  }
  if (input.mode === "parallel") return input.agentCount > 0 ? null : "Choose at least one agent.";
  if (!input.workflowChosen) return "Choose a workflow to continue.";
  return input.workflowBound ? null : "Choose an agent for every role.";
}
