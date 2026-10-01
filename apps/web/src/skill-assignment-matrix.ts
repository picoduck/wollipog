import { runnerSupportsProtocol, type AgentDefinition, type RunnerView } from "@wollipog/protocol";
import { accountLabelText } from "./personal-identifiers.js";
import type { SkillInvocationPolicy } from "@wollipog/protocol";
import {
  invocationLabel,
  reportedSkillDrift,
  skillEligibleAgents,
  supportsManualOnly,
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
 * order given: the machines whose Deployment rows show Error for a reason the machine reported. A
 * machine whose report has not loaded says nothing. A skipped Manual Only agent is
 * `skillManualOnlyErrors`', which the notice ranks first. */
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
      .map((agent) => skillAgentDeployment(runner, agent, skillName, state))
      .find((row) => row.eligible && row.status === "error" && !row.manualOnly);
    if (failed) errors.push({ runnerId: runner.runnerId, ...(failed.reason ? { detail: failed.reason } : {}) });
  }
  return errors;
}

/** One agent's row in Deployment: one status from the skill vocabulary (§11.2), and anything more
 * specific as the row's one-line reason. */
export type SkillAgentStatus = "linked" | "pending" | "edited" | "error";

export interface SkillAgentDeployment {
  agent: AgentDefinition;
  /** Whether skill deployment can reach this agent at all; the rest fold into one disclosure. */
  eligible: boolean;
  /** The invocation this machine was told to deploy for the agent; null when it is not targeted. */
  invocation: SkillInvocationPolicy | null;
  /** Null when there is nothing to report: not targeted and nothing linked, or not yet loaded. */
  status: SkillAgentStatus | null;
  /** One line saying more than the status can: the machine's own words, or a sentence of ours. */
  reason?: string;
  /** The Error is a Manual Only target this agent cannot run (the notice slot's first notice). */
  manualOnly?: boolean;
}

/** Why an agent cannot receive managed skills, for its row in the ineligible disclosure. */
function ineligibleReason(runner: RunnerView, agent: AgentDefinition): string {
  if (!runnerSupportsProtocol(runner.protocolVersion, "agentSkills")) return "Update this machine's runner to deploy skills.";
  if (!skillEligibleAgents([{ ...agent, context: undefined }]).length) return "This agent type can't load managed skills.";
  const contextKind = agent.context?.kind ?? "native";
  if (runner.os === "windows" && contextKind === "wsl") return "Update this machine's runner to deploy skills to WSL.";
  if (runner.os === "windows" && contextKind === "native") return "Update this machine's runner to deploy skills on Windows.";
  return "Its execution context can't load managed skills.";
}

/**
 * One agent on one machine, as Deployment shows it: Error (with the machine's words, or a Manual Only
 * target the agent cannot run), Edited, Pending or Linked. Unsupported and Conflict are Errors with
 * their reason; version pending, not reported and linked without a target are reasons under Pending
 * or Linked. A machine whose report has not loaded shows no status.
 */
export function skillAgentDeployment(runner: RunnerView, agent: AgentDefinition, skillName: string,
  state?: RunnerSkillsResponse): SkillAgentDeployment {
  const eligible = skillAgentEligible(runner, agent);
  const target = state && !state.loadError
    ? state.desired.find((skill) => skill.name === skillName)?.targets.find((candidate) => candidate.agentId === agent.id)
    : undefined;
  const base = { agent, eligible, invocation: target?.invocation ?? null };
  if (!eligible) return { ...base, status: null, reason: ineligibleReason(runner, agent) };
  if (!state || state.loadError) return { ...base, status: null };
  const cell = skillAgentMatrixCell(runner, agent, skillName, state);
  const reported = cell.reported;
  // An agent nothing targets is this skill's only while it still holds a link: a machine-wide error
  // or an unreported link says nothing about it.
  const holdsLink = Boolean(state.reported?.deployed?.some((row) => row.name === skillName &&
    row.links.some((link) => link.agentId === agent.id)));
  if (!target && !holdsLink) return { ...base, status: null };
  // The machine's own error first: it is what Sync Now in the notice is for.
  if (reported === "Error") return { ...base, status: "error", reason: cell.detail ?? "Deployment didn't succeed." };
  // Then what the machine was told, before it reports: only Claude Code enforces Manual Only, so the
  // runner skips any other agent a Manual Only rule targets (skillManualOnlyErrors).
  if (target?.invocation === "manual" && !supportsManualOnly(agent.driver)) {
    return { ...base, status: "error", reason: "Can't run manual-only skills.", manualOnly: true };
  }
  // An edited copy the runner holds its links on reports them as conflicts: the edit is the news. A
  // held edit holds every link of the skill's name, whichever variant this agent uses.
  const drift = reportedSkillDrift(state.reported, skillName);
  const edited = drift.find((entry) => entry.variant === (target?.invocation ?? "agent")) ??
    drift.find((entry) => entry.held);
  if (edited) {
    return { ...base, status: "edited", reason: edited.held
      ? "Edited on this machine. Updates wait until you import or restore it."
      : "An edited copy is kept on this machine." };
  }
  // The machine's own words, as the notice shows them.
  if (reported === "Conflict") return { ...base, status: "error", reason: cell.detail ?? "A file on this machine blocks the link." };
  if (reported === "Unsupported") return { ...base, status: "error", reason: cell.detail ?? "This agent can't load this skill." };
  if (reported === "Not Reported") {
    return { ...base, status: "pending", reason: cell.detail ?? "Not reported yet." };
  }
  if (reported === "Version Pending") return { ...base, status: "pending", reason: "An older version is linked. Sync to update it." };
  if (reported === "Linked (Not Targeted)") {
    return { ...base, status: "linked", reason: "Not assigned. A link from before, or a shared skills folder, still exposes it." };
  }
  const unreported = target ? unreportedAccount(runner, agent, skillName, state) : undefined;
  if (unreported) return { ...base, status: "pending", reason: `${unreported}: Not reported yet.` };
  return { ...base, status: "linked" };
}

/** The label of a provider account this agent deploys into that the report has no link from, when
 * the machine reports per account: each of a native agent's accounts gets its own copy. */
function unreportedAccount(runner: RunnerView, agent: AgentDefinition, skillName: string,
  state: RunnerSkillsResponse): string | undefined {
  const deployed = state.reported?.deployed?.filter((row) => row.name === skillName) ?? [];
  if ((agent.context?.kind ?? "native") !== "native" || !deployed.some((row) => row.providerAccountId)) return undefined;
  const provider = agent.driver === "claude-code" ? "claude"
    : agent.driver === "codex" || agent.driver === "codex-app-server" ? "codex" : undefined;
  const missing = (runner.providerAccounts ?? []).find((account) => provider && account.provider === provider &&
    !deployed.some((row) => row.providerAccountId === account.id &&
      row.links.some((link) => link.agentId === agent.id && link.status === "linked")));
  return missing ? accountLabelText(missing.label) : undefined;
}

/** The rule responsible for a targeted agent: "Direct" for the skill's own assignment, the group's
 * name for its group's, or null when it is not targeted or the rule that won is not known here. */
export function skillAssignedBy<T extends SkillRule>(
  row: Pick<SkillAgentDeployment, "agent" | "invocation">,
  runnerId: string,
  rules: ReadonlyArray<T>,
  rulesComplete: boolean,
  groupName: (groupId: string) => string | undefined,
): string | null {
  if (!row.invocation) return null;
  const winner = winningSkillRule(rules, runnerId, row.agent);
  // An unread group rule could outrank the skill's own: name none rather than the wrong one.
  if (!winner || !winner.enabled || (!rulesComplete && !winner.groupId)) return null;
  return winner.groupId ? groupName(winner.groupId) ?? null : "Direct";
}

/** One machine in Deployment: its agent rows, eligible first, and the Linked count over the agents
 * that have a status. */
export interface SkillMachineDeployment {
  rows: SkillAgentDeployment[];
  ineligible: SkillAgentDeployment[];
  linked: number;
  /** Eligible agents with a status: targeted, or reporting something for this skill. */
  total: number;
}

export function skillMachineDeployment(runner: RunnerView, skillName: string, state?: RunnerSkillsResponse): SkillMachineDeployment {
  const all = runner.agents.map((agent) => skillAgentDeployment(runner, agent, skillName, state));
  const rows = all.filter((row) => row.eligible);
  const counted = rows.filter((row) => row.status !== null);
  return {
    rows,
    ineligible: all.filter((row) => !row.eligible),
    linked: counted.filter((row) => row.status === "linked").length,
    total: counted.length,
  };
}

/** Whether skill deployment can reach this agent on this machine: a deployable agent type, in a
 * context this runner deploys to. */
export function skillAgentEligible(runner: Pick<RunnerView, "os" | "protocolVersion">, agent: AgentDefinition): boolean {
  const contextKind = agent.context?.kind ?? "native";
  const platformSupported = contextKind === "wsl"
    ? runner.os === "windows" && runnerSupportsProtocol(runner.protocolVersion, "wslMachineSkills")
    : contextKind === "native" && (runner.os !== "windows" ||
      runnerSupportsProtocol(runner.protocolVersion, "nativeWindowsSkillDeployment"));
  return runnerSupportsProtocol(runner.protocolVersion, "agentSkills") && platformSupported &&
    skillEligibleAgents([agent], contextKind === "wsl").length > 0;
}

/** Agents an enabled rule decides for that cannot get the skill from it (#1982). */
export interface SkillRuleUnreachableAgents {
  /** Agents the rule names, by agent or by type, that skill deployment can't reach. */
  ineligible: Array<{ runnerId: string; agent: AgentDefinition }>;
  /** Agents a Manual Only rule reaches that aren't Claude Code, which the runner skips. */
  manualOnly: Array<{ runnerId: string; agent: AgentDefinition }>;
}

/**
 * What `rule` aims at but cannot deploy to, on the machines it covers, counting only agents it wins
 * among `rules` (a higher-ranked rule decides for the rest). An All Agents rule never names an agent
 * deployment can't reach, so those agents are not held against it. A turned-off rule deploys
 * nothing, so it reaches nobody.
 */
export function skillRuleUnreachableAgents<T extends SkillRule>(
  rule: T,
  rules: ReadonlyArray<T>,
  runners: ReadonlyArray<Pick<RunnerView, "runnerId" | "os" | "protocolVersion" | "agents">>,
): SkillRuleUnreachableAgents {
  const result: SkillRuleUnreachableAgents = { ineligible: [], manualOnly: [] };
  if (!rule.enabled) return result;
  for (const runner of runners) {
    if (rule.scopeKind === "runner" && rule.runnerId !== runner.runnerId) continue;
    for (const agent of runner.agents) {
      if (!selectorMatches(rule.agentSelector, agent) || winningSkillRule(rules, runner.runnerId, agent) !== rule) continue;
      if (!skillAgentEligible(runner, agent)) {
        if (rule.agentSelector.kind !== "all") result.ineligible.push({ runnerId: runner.runnerId, agent });
      } else if (rule.invocation === "manual" && !supportsManualOnly(agent.driver)) {
        result.manualOnly.push({ runnerId: runner.runnerId, agent });
      }
    }
  }
  return result;
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
  const eligible = skillAgentEligible(runner, agent);
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
