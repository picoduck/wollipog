import { runnerSupportsProtocol, type AgentDefinition, type RunnerView } from "@wollipog/protocol";
import { invocationLabel, skillEligibleAgents, type RunnerSkillsResponse } from "./skills.js";

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
    const label = account(row.providerAccountId)?.label ?? "Provider Account";
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
