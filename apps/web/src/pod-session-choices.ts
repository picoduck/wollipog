import { isTerminal, type BoxView, type PodView, type ProjectView, type RunnerView, type SessionView } from "@wollipog/protocol";
import { sessionAgentLabel } from "./components/agent-options.js";
import { sshTargetHost } from "./runners.js";

/**
 * The sessions a pod can take (#2982), shared by New Pod and a pod's Add Member (#2983): what makes
 * a session eligible, how its row names it, and what Filter Sessions matches.
 */

/** The rule, said once under the list. */
export const POD_SESSION_RULE = "Only sessions with their own worktree that aren't in another pod can join.";

/** A session can join when it has its own worktree, has not ended and is in no active pod. Newest
 * activity first. */
export function podEligibleSessions(
  sessions: Iterable<SessionView>,
  pods: Iterable<PodView>,
): SessionView[] {
  const occupied = new Set([...pods]
    .filter((pod) => pod.status === "active")
    .flatMap((pod) => pod.members.map((member) => member.sessionId)));
  return [...sessions]
    .filter((session) => session.useWorktree && !isTerminal(session.status) && !occupied.has(session.id))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** One row of the list: the title on line one, "<Agent> · <Project> · <Machine>" on line two. */
export interface PodSessionChoice {
  sessionId: string;
  title: string;
  agent: string;
  description: string;
  /** Its worktree is still being created: the row says "Worktree starting…". */
  worktreeStarting: boolean;
}

/**
 * Each Machine's name without its id: the name its owner gave it, else its SSH host or hostname.
 * Two Machines that read alike add their hostname, as `machineOptionLabels` does, but its last resort
 * (and `runnerDisplay`'s first fallback) is the runner id, which no row here may print (#2982). Two
 * Machines that still read alike keep one name; their sessions' other parts tell them apart.
 */
export function podMachineNames(
  runners: Iterable<Pick<RunnerView, "runnerId" | "hostname" | "displayName">>,
  boxFor: (runnerId: string) => Pick<BoxView, "sshTarget" | "displayName"> | undefined = () => undefined,
): Map<string, string> {
  const named = [...runners].map((runner) => {
    const box = boxFor(runner.runnerId);
    const hostname = runner.hostname?.trim() ?? "";
    const name = runner.displayName?.trim() || box?.displayName?.trim() || (box ? sshTargetHost(box.sshTarget) : "") || hostname;
    return { runnerId: runner.runnerId, name, hostname };
  }).filter((machine) => machine.name);
  const counts = new Map<string, number>();
  for (const machine of named) counts.set(normalize(machine.name), (counts.get(normalize(machine.name)) ?? 0) + 1);
  return new Map(named.map(({ runnerId, name, hostname }) => [runnerId,
    (counts.get(normalize(name)) ?? 0) > 1 && hostname && normalize(hostname) !== normalize(name) ? `${name} · ${hostname}` : name]));
}

/**
 * Names each session by display names only (§17): the agent's label, the project's name and the
 * Machine's name. A part this device cannot name (a project or Machine it has not loaded) is left
 * out rather than shown as an id.
 */
export function podSessionChoices(
  sessions: readonly SessionView[],
  context: {
    runners: ReadonlyMap<string, RunnerView>;
    boxes?: ReadonlyMap<string, BoxView>;
    projects?: ReadonlyMap<string, ProjectView>;
  },
): PodSessionChoice[] {
  const boxByRunner = new Map([...(context.boxes?.values() ?? [])].map((box) => [box.runnerId, box]));
  const machines = podMachineNames(context.runners.values(), (runnerId) => boxByRunner.get(runnerId));
  return sessions.map((session) => {
    const agent = sessionAgentLabel(session.agentName, session.driver, session.agentId);
    const project = session.projectId
      ? context.projects?.get(session.projectId)?.name
      : session.workspaceId ? session.workspaceName : undefined;
    const machine = machines.get(session.runnerId);
    return {
      sessionId: session.id,
      title: session.title.trim() || "Untitled Session",
      agent,
      description: [agent, project?.trim(), machine].filter(Boolean).join(" · "),
      worktreeStarting: !session.worktreePath,
    };
  });
}

/** Filter Sessions matches a row's title and agent, ignoring case and spacing. */
export function podSessionMatches(choice: Pick<PodSessionChoice, "title" | "agent">, query: string): boolean {
  const words = normalize(query).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const haystack = normalize(`${choice.title} ${choice.agent}`);
  return words.every((word) => haystack.includes(word));
}

const normalize = (text: string) => text.toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();

/** The most sessions a pod holds; the control plane refuses more ("a pod requires 2 to 12 sessions"). */
export const POD_MAX_SESSIONS = 12;

/** Why Create Pod is unavailable, or null once it can run. Sessions come first: when none can join,
 * a name would not help. */
export function newPodBlockedReason(name: string, chosen: number): string | null {
  if (chosen < 2) return "Choose at least 2 sessions.";
  if (chosen > POD_MAX_SESSIONS) return `Choose at most ${POD_MAX_SESSIONS} sessions.`;
  if (!name.trim()) return "Enter a name.";
  return null;
}
