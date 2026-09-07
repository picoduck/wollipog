import { runnerSupportsProtocol, type AgentDefinition, type RunnerView } from "@wollipog/protocol";
import { invocationLabel, skillEligibleAgents, type RunnerSkillsResponse } from "./skills.js";

/** Display configuration separately from the last reported link; a shared harness may expose a
 * skill even when this specific agent has no desired target. Never infer successful removal. */
export function skillAgentMatrixCell(runner: RunnerView, agent: AgentDefinition, skillName: string, state?: RunnerSkillsResponse): { desired: string; reported: string; detail?: string } {
  if (!state || state.loadError) return { desired: "Unknown", reported: "Unknown", detail: state?.loadError ?? "Skills status has not loaded." };
  const desired = state.desired.find(skill => skill.name === skillName);
  const target = desired?.targets.find(target => target.agentId === agent.id);
  const deployed = state.reported?.deployed?.find(skill => skill.name === skillName);
  const link = deployed?.links.find(link => link.agentId === agent.id);
  const eligible = runnerSupportsProtocol(runner.protocolVersion, "agentSkills") && skillEligibleAgents([agent]).length > 0 && runner.os !== "windows";
  const requested = !eligible ? "Unavailable" : target ? invocationLabel(target.invocation) : "Not Assigned";
  if (state.reported?.error || deployed?.error) return { desired: requested, reported: "Error", detail: deployed?.error ?? state.reported?.error };
  if (!link) return { desired: requested, reported: "Not Reported", ...(!eligible ? { detail: "This execution target cannot receive managed skill links." } : {}) };
  if (link.status === "linked") return { desired: requested, reported: !target ? "Linked (Not Targeted)" : deployed?.digest !== desired?.versionDigest ? "Version Pending" : "Linked", detail: !target ? "A previously deployed or shared harness link may still expose this skill. Not targeted does not mean removed." : undefined };
  return { desired: requested, reported: ({ conflict: "Conflict", unsupported: "Unsupported", error: "Error" })[link.status] ?? "Unknown", detail: link.detail };
}
