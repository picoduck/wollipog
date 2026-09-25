import type {
  AgentDefinition,
  SkillAdoptionMessage,
  SkillAdoptionResultMessage,
} from "@wollipog/protocol";
import { adoptMachineSkill } from "./skill-adoption.js";
import type { RunnerProviderAccount } from "./config.js";
import { providerAccountAgentContextCompatible, providerForDriver } from "./provider-accounts.js";
import type { MachineSkillSnapshots } from "./skill-snapshots.js";
import { SKILL_DIRS, type ReconcileSkillEntry } from "./skills.js";
import { adoptWslSkill, type WslAdoptionEnvironment } from "./wsl-skill-adoption.js";

export interface SkillAdoptionCommandOptions {
  message: SkillAdoptionMessage;
  runnerId: string;
  home: string;
  dataDir: string;
  agents: AgentDefinition[];
  /** Live agents, read again after any asynchronous boundary so a newly discovered reader still
   * needs shared-impact consent. */
  currentAgents?: () => AgentDefinition[];
  providerAccounts?: () => RunnerProviderAccount[];
  snapshots: MachineSkillSnapshots;
  desired: ReconcileSkillEntry[] | null;
  /** Live desired state, read again after any asynchronous boundary. */
  currentDesired?: () => ReconcileSkillEntry[] | null;
  acquireProviderHomeLease: (home: string) => void;
  /** Present on a Windows runner whose control plane can receive WSL adoption results. */
  wsl?: WslAdoptionEnvironment;
}

const rejected = (message: SkillAdoptionMessage, runnerId: string, error: string): SkillAdoptionResultMessage => ({
  type: "skill_adoption_result",
  runnerId,
  requestId: message.requestId,
  status: "rejected",
  error,
});

/** Execute only after the runner's reconcile queue has applied the current desired snapshot.
 * The opaque candidate, desired version/targets and shared-reader consent are all checked again
 * locally; an HTTP preflight or control-plane command is never sufficient by itself. */
export async function handleSkillAdoption(options: SkillAdoptionCommandOptions): Promise<SkillAdoptionResultMessage> {
  const { message, runnerId, agents } = options;
  if (message.runnerId !== runnerId || message.confirmation !== "explicit") {
    return rejected(message, runnerId, "Adoption requires an explicitly confirmed command for this runner.");
  }
  const candidate = options.snapshots.resolveCandidate(message.candidate);
  if (!candidate) return rejected(message, runnerId, "The machine discovery expired or changed. Discover it again.");
  if (candidate.context?.kind === "wsl") {
    if (!options.wsl) return rejected(message, runnerId, "Adoption of WSL locations is not available on this runner.");
    // WSL deployment manages only the distro's own HOME, so an account home there has no managed link.
    if (candidate.providerAccountId) {
      return rejected(message, runnerId, "Adoption of an account-scoped WSL location is not supported.");
    }
  }
  const account = candidate.providerAccountId
    ? options.providerAccounts?.().find((entry) => entry.id === candidate.providerAccountId)
    : undefined;
  if (candidate.providerAccountId && !account) {
    return rejected(message, runnerId, "The selected provider account is no longer configured. Discover it again.");
  }
  if (account && candidate.sourceDirectory !== (account.provider === "claude" ? ".claude/skills" : ".codex/skills")) {
    return rejected(message, runnerId, "The selected provider account no longer matches this skill source.");
  }
  const desired = options.desired?.find((entry) =>
    entry.name === candidate.name && entry.versionDigest === message.digest);
  if (!desired) return rejected(message, runnerId, "The approved skill version is no longer assigned to this machine.");

  const sameContext = (agent: AgentDefinition) => candidate.context?.kind === "wsl"
    ? agent.context?.kind === "wsl" && agent.context.distro === candidate.context.distro
    : (agent.context?.kind ?? "native") === "native";
  const readersOf = (list: AgentDefinition[]) => list.filter((agent) => {
    if (!sameContext(agent)) return false;
    if (account && (providerForDriver(agent.driver ?? "acp") !== account.provider ||
        !providerAccountAgentContextCompatible(account, agent))) return false;
    const directory = SKILL_DIRS[agent.driver ?? "acp"];
    return directory && (candidate.sourceDirectory === ".agents/skills" || directory === candidate.sourceDirectory);
  });
  const readers = readersOf(agents);
  const targets = desired.targets.filter((target) => readers.some((reader) => reader.id === target.agentId));
  if (!targets.length) return rejected(message, runnerId, "The source is no longer targeted at an agent that reads it.");
  // The current transaction publishes the byte-identical base version. A manual Claude variant
  // can differ in frontmatter and must not be silently substituted.
  if (targets.some((target) => target.invocation !== "agent")) {
    return rejected(message, runnerId, "Adoption of a manual invocation variant is not supported.");
  }
  const sharedReaders = readers.filter((reader) => !targets.some((target) => target.agentId === reader.id));
  if (sharedReaders.length && message.acceptSharedImpact !== true) {
    return rejected(message, runnerId, "Confirm the shared harness-directory impact before adoption.");
  }

  const stillAuthorized = () => {
    if (account) {
      const currentAccount = options.providerAccounts?.().find((entry) => entry.id === account.id);
      if (!currentAccount || currentAccount.provider !== account.provider ||
          currentAccount.directory !== account.directory) throw new Error();
    }
    const current = (options.currentDesired ? options.currentDesired() : options.desired)
      ?.find((entry) => entry.name === candidate.name);
    if (!current || current.versionDigest !== message.digest) throw new Error();
    const currentReaders = options.currentAgents ? readersOf(options.currentAgents()) : readers;
    const currentTargets = current.targets.filter((target) =>
      currentReaders.some((reader) => reader.id === target.agentId));
    if (!currentTargets.length || currentTargets.some((target) => target.invocation !== "agent")) throw new Error();
    const currentShared = currentReaders.some((reader) =>
      !currentTargets.some((target) => target.agentId === reader.id));
    if (currentShared && message.acceptSharedImpact !== true) throw new Error();
    return undefined;
  };
  if (candidate.context?.kind === "wsl") {
    // Reread the source through the runner's no-follow Windows reader immediately before the
    // in-distro transaction: its discovery generation and content must still match the approval.
    const reread = options.snapshots.handle({ type: "skill_snapshot", runnerId, requestId: message.requestId,
      operation: "read", candidateId: candidate.id });
    if (reread.snapshot?.digest !== message.digest) {
      return rejected(message, runnerId, "The source changed after preview. Discover it again.");
    }
    const result = await adoptWslSkill({ ...options.wsl!, agents, candidate, digest: message.digest,
      assertAuthorized: stillAuthorized });
    return { type: "skill_adoption_result", runnerId, requestId: message.requestId, ...result };
  }
  const result = adoptMachineSkill({
    home: account?.directory ?? options.home,
    dataDir: options.dataDir,
    agents,
    candidate,
    ...(account ? { localSourceDirectory: "skills" } : {}),
    digest: message.digest,
    acquireProviderHomeLease: () => {
      options.acquireProviderHomeLease(account?.directory ?? options.home);
      return undefined;
    },
    assertAuthorized: stillAuthorized,
  });
  return { type: "skill_adoption_result", runnerId, requestId: message.requestId, ...result };
}
