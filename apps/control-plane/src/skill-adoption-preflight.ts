import { runnerSupportsProtocol, type MachineSkillCandidate } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { resolveDesiredSkillSnapshot, validateSkillPayload } from "./skills.js";

/** Read-only prerequisite report, never a capability or authorization to mutate a source. */
export function skillAdoptionPreflight(db: ControlPlaneDb, runnerId: string, candidate: MachineSkillCandidate, digest: string,
  executablePaths: string[] = []) {
  const blockers: string[] = [];
  const skill = db.getSkillByName(candidate.name);
  const desired = resolveDesiredSkillSnapshot(db, runnerId).find((entry) => entry.name === candidate.name);
  const version = desired ? db.getSkillVersion(desired.versionId) : null;
  if (!skill) blockers.push("library_skill_missing");
  if (executablePaths.length) blockers.push("executable_mode_adoption_unsupported");
  if (!desired || desired.targets.length === 0) blockers.push("effective_assignment_missing");
  if (desired && (!version || version.digest !== digest)) blockers.push("assigned_version_mismatch");
  if (version) {
    const payload = validateSkillPayload({ name: candidate.name, files: version.files });
    if (!payload.ok || payload.digest !== version.digest) blockers.push("library_version_invalid");
  }
  const runner = db.getRunner(runnerId);
  const agents = runner?.agents ?? [];
  const piEnabled = runnerSupportsProtocol(runner?.protocolVersion, "piHarness");
  const directory = (driver: string | undefined) => driver === "claude-code" ? ".claude/skills"
    : driver === "codex" || driver === "codex-app-server" ? ".codex/skills"
      : driver === "pi" ? ".pi/agent/skills" : null;
  const account = candidate.providerAccountId
    ? runner?.providerAccounts?.find((entry) => entry.id === candidate.providerAccountId)
    : undefined;
  const provider = (driver: string | undefined) => driver === "claude-code" ? "claude"
    : driver === "codex" || driver === "codex-app-server" ? "codex" : null;
  if (candidate.providerAccountId &&
      (!runnerSupportsProtocol(runner?.protocolVersion, "accountScopedAgentSkills") || !account)) {
    blockers.push("provider_account_scope_unavailable");
  }
  const sameContext = (agent: typeof agents[number]) => candidate.context?.kind === "wsl"
    ? agent.context?.kind === "wsl" && agent.context.distro === candidate.context.distro
    : (agent.context?.kind ?? "native") === "native";
  const readers = agents.filter((agent) =>
    (candidate.providerAccountId
      ? provider(agent.driver) === account?.provider && sameContext(agent)
      : (agent.context?.kind ?? "native") === "native") &&
    (agent.driver !== "pi" || piEnabled) && directory(agent.driver) &&
    (candidate.sourceDirectory === ".agents/skills" || directory(agent.driver) === candidate.sourceDirectory));
  const targets = (desired?.targets ?? []).map((target) => ({ ...target,
    sourceReader: readers.some((agent) => agent.id === target.agentId),
  }));
  if (!targets.some((target) => target.sourceReader)) blockers.push("source_not_targeted");
  if (targets.some((target) => target.sourceReader && target.invocation === "manual" &&
    agents.find((agent) => agent.id === target.agentId)?.driver !== "claude-code")) blockers.push("invocation_unsupported");
  if (targets.some((target) => target.sourceReader && target.invocation === "manual")) {
    blockers.push("manual_variant_adoption_unsupported");
  }
  const sourceClaudeTargets = targets.filter((target) => target.sourceReader &&
    agents.find((agent) => agent.id === target.agentId)?.driver === "claude-code");
  if (sourceClaudeTargets.some((target) => target.invocation === "manual") &&
    sourceClaudeTargets.some((target) => target.invocation === "agent")) blockers.push("shared_invocation_conflict");
  return {
    status: blockers.length ? "blocked" as const : "prerequisites_met" as const,
    mutationSupported: false as const,
    blockers,
    advisories: candidate.sourceDirectory === ".claude/skills" && sourceClaudeTargets.some((target) => target.invocation === "manual")
      ? ["manual_variant_may_change_content"] : [],
    skillId: skill?.id ?? null,
    version: version ? { id: version.id, digest: version.digest } : null,
    targets,
    // A disabled or unassigned sibling can still read a shared harness directory. Report it,
    // rather than promising per-agent isolation that the filesystem cannot provide.
    sharedReaders: readers.filter((agent) => !targets.some((target) => target.agentId === agent.id)).map((agent) => agent.id),
  };
}
