import { runnerSupportsProtocol, type AgentDefinition, type RunnerView } from "@wollipog/protocol";
import { accountLabelText } from "./personal-identifiers.js";
import {
  invocationLabel,
  skillEligibleAgents,
  type RunnerSkillsResponse,
  type SkillAgentSelector,
  type SkillAssignmentView,
} from "./skills.js";

/** A rule that can target a skill: one of its own assignments, or (with `groupId`) its group's. */
export type SkillRule = Pick<SkillAssignmentView, "id" | "scopeKind" | "runnerId" | "agentSelector" | "enabled" | "invocation" | "updatedAt"> & {
  groupId?: string;
};

function selectorMatches(selector: SkillAgentSelector, agent: Pick<AgentDefinition, "id" | "driver">): boolean {
  if (selector.kind === "all") return true;
  if (selector.kind === "driver") return (agent.driver ?? "acp") === selector.driver;
  return agent.id === selector.agentId;
}

/** The control plane's ranking (resolveDesiredSkillSnapshot): runner scope beats instance scope,
 * an agent selector beats a driver selector beats all, then a skill's own rule beats its group's,
 * then the newest update. */
function ruleRank(rule: SkillRule): number {
  return (rule.scopeKind === "runner" ? 10 : 0) +
    (rule.agentSelector.kind === "agent" ? 3 : rule.agentSelector.kind === "driver" ? 2 : 1);
}

/** The one rule that decides whether and how a skill reaches this agent on this machine, as the
 * control plane resolves it, or undefined when no rule matches. */
export function winningSkillRule<T extends SkillRule>(rules: ReadonlyArray<T>, runnerId: string,
  agent: Pick<AgentDefinition, "id" | "driver">): T | undefined {
  return rules
    .filter((rule) => (rule.scopeKind === "instance" || rule.runnerId === runnerId) && selectorMatches(rule.agentSelector, agent))
    .sort((a, b) => ruleRank(b) - ruleRank(a) || Number(Boolean(a.groupId)) - Number(Boolean(b.groupId)) ||
      (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || (a.id < b.id ? 1 : -1))[0];
}

/** Agents a Manual Only rule targets but cannot reach: only Claude Code enforces manual-only
 * invocation, so a machine skips every other agent it is assigned to (the runner's rule). */
export interface SkillManualOnlyError<T extends SkillRule = SkillRule> {
  /** The rule that targets them, or null when it is not among the rules this page has read. */
  rule: T | null;
  /** The machines that skip them, in the order given. */
  runnerIds: string[];
  /** The skipped agents, in the order found. */
  agents: Array<Pick<AgentDefinition, "id" | "name" | "driver">>;
}

/** Every Manual Only rule that leaves agents unable to run this skill, one entry per rule, in the
 * order its first skipped agent appears. Read from what each machine is told to deploy, so it is
 * right before the machine reports, and it clears as soon as the rule changes.
 *
 * `rulesComplete` is false while some rule that could win has not been read (the skill's group's,
 * still loading or unreadable): a lower-ranked rule must never be blamed, so no rule is named. */
export function skillManualOnlyErrors<T extends SkillRule>(
  skillName: string,
  runners: ReadonlyArray<Pick<RunnerView, "runnerId" | "agents">>,
  machineSkills: Readonly<Record<string, RunnerSkillsResponse | undefined>>,
  rules: ReadonlyArray<T>,
  rulesComplete = true,
): SkillManualOnlyError<T>[] {
  const byRule = new Map<string, SkillManualOnlyError<T>>();
  for (const runner of runners) {
    const state = machineSkills[runner.runnerId];
    if (!state || state.loadError) continue;
    const desired = state.desired.find((entry) => entry.name === skillName);
    for (const target of desired?.targets ?? []) {
      if (target.invocation !== "manual") continue;
      const agent = runner.agents.find((candidate) => candidate.id === target.agentId);
      if (!agent || agent.driver === "claude-code") continue;
      const winner = rulesComplete ? winningSkillRule(rules, runner.runnerId, agent) : undefined;
      // The rules this page read disagree with what the machine was told: say so without a fix.
      const rule = winner?.enabled && winner.invocation === "manual" ? winner : null;
      const key = rule ? `rule:${rule.id}` : "unknown";
      const entry = byRule.get(key) ?? { rule, runnerIds: [], agents: [] };
      if (!entry.runnerIds.includes(runner.runnerId)) entry.runnerIds.push(runner.runnerId);
      entry.agents.push({ id: agent.id, name: agent.name, driver: agent.driver });
      byRule.set(key, entry);
    }
  }
  return [...byRule.values()];
}

/** A machine that reports a deployment error for this skill: the list's Error status, per machine. */
export interface SkillDeploymentError {
  runnerId: string;
  /** The machine's own words, sanitized by the runner. */
  detail?: string;
}

/** Machines that deploy this skill and report an error for an agent that can receive it, in the
 * order given. A machine whose report has not loaded says nothing. */
export function skillDeploymentErrors(
  skillName: string,
  runners: ReadonlyArray<RunnerView>,
  machineSkills: Readonly<Record<string, RunnerSkillsResponse | undefined>>,
): SkillDeploymentError[] {
  const errors: SkillDeploymentError[] = [];
  for (const runner of runners) {
    const state = machineSkills[runner.runnerId];
    if (!state || state.loadError) continue;
    // A machine-wide sync error is this skill's only on a machine that deploys it.
    const deploys = state.desired.some((entry) => entry.name === skillName) ||
      Boolean(state.reported?.deployed?.some((entry) => entry.name === skillName));
    if (!deploys) continue;
    const failed = runner.agents
      .map((agent) => skillAgentMatrixCell(runner, agent, skillName, state))
      .find((cell) => cell.desired !== "Unavailable" && cell.reported === "Error");
    if (failed) errors.push({ runnerId: runner.runnerId, ...(failed.detail ? { detail: failed.detail } : {}) });
  }
  return errors;
}

/** Display configuration separately from the last reported link; a shared harness may expose a
 * skill even when this specific agent has no desired target. Never infer successful removal. */
export function skillAgentMatrixCell(runner: RunnerView, agent: AgentDefinition, skillName: string, state?: RunnerSkillsResponse): { desired: string; reported: string; detail?: string } {
  if (!state || state.loadError) return { desired: "Unknown", reported: "Unknown", detail: state?.loadError ?? "Skills status has not loaded." };
  const desired = state.desired.find(skill => skill.name === skillName);
  const target = desired?.targets.find(target => target.agentId === agent.id);
  const deployed = state.reported?.deployed?.filter(skill => skill.name === skillName) ?? [];
  const provider = agent.driver === "claude-code"
    ? "claude"
    : agent.driver === "codex" || agent.driver === "codex-app-server" ? "codex" : undefined;
  const account = (providerAccountId: string | undefined) => providerAccountId
    ? runner.providerAccounts?.find(candidate => candidate.id === providerAccountId)
    : undefined;
  const contextKind = agent.context?.kind ?? "native";
  const relevant = deployed.filter(row =>
    row.links.some(link => link.agentId === agent.id) ||
    (row.providerAccountId
      ? contextKind === "native" && account(row.providerAccountId)?.provider === provider
      : Boolean(row.error)));
  const scopedDetail = (row: (typeof deployed)[number], detail: string | undefined) => {
    if (!row.providerAccountId) return detail;
    const label = accountLabelText(account(row.providerAccountId)?.label ?? "Provider Account");
    return `${label}: ${detail ?? "deployment did not succeed"}`;
  };
  const linkedRows = relevant.flatMap(row => row.links
    .filter(link => link.agentId === agent.id)
    .map(link => ({ row, link })));
  const platformSupported = contextKind === "wsl"
    ? runner.os === "windows" && runnerSupportsProtocol(runner.protocolVersion, "wslMachineSkills")
    : contextKind === "native" && (runner.os !== "windows" ||
      runnerSupportsProtocol(runner.protocolVersion, "nativeWindowsSkillDeployment"));
  const eligible = runnerSupportsProtocol(runner.protocolVersion, "agentSkills") && platformSupported &&
    skillEligibleAgents([agent], contextKind === "wsl").length > 0;
  const requested = !eligible ? "Unavailable" : target ? invocationLabel(target.invocation) : "Not Assigned";
  if (state.reported?.error) {
    return { desired: requested, reported: "Error", detail: state.reported.error };
  }
  const conflicted = linkedRows.find(({ link }) => link.status === "conflict");
  if (conflicted) return { desired: requested, reported: "Conflict",
    detail: scopedDetail(conflicted.row, conflicted.link.detail) };
  const failedRow = relevant.find(row => row.error);
  const failedLink = linkedRows.find(({ link }) => link.status === "error");
  if (failedRow || failedLink) return {
    desired: requested,
    reported: "Error",
    detail: failedRow
      ? scopedDetail(failedRow, failedRow.error)
      : scopedDetail(failedLink!.row, failedLink!.link.detail),
  };
  const unsupported = linkedRows.find(({ link }) => link.status === "unsupported");
  if (unsupported) return { desired: requested, reported: "Unsupported",
    detail: scopedDetail(unsupported.row, unsupported.link.detail) };
  const missing = relevant.find(row => !row.links.some(link => link.agentId === agent.id));
  if (!linkedRows.length || missing) return {
    desired: requested,
    reported: "Not Reported",
    ...(!eligible
      ? { detail: "This execution target cannot receive managed skill links." }
      : missing ? { detail: scopedDetail(missing, "No link state was reported.") } : {}),
  };
  if (!target) return { desired: requested, reported: "Linked (Not Targeted)",
    detail: "A previously deployed or shared harness link may still expose this skill. Not targeted does not mean removed." };
  if (relevant.some(row => row.digest !== desired?.versionDigest)) {
    return { desired: requested, reported: "Version Pending" };
  }
  return { desired: requested, reported: "Linked", detail: undefined };
}
