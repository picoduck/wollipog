import type {
  AgentDefinition,
  SkillAdoptionMessage,
  SkillAdoptionResultMessage,
} from "@wollipog/protocol";
import { adoptMachineSkill } from "./skill-adoption.js";
import type { MachineSkillSnapshots } from "./skill-snapshots.js";
import { SKILL_DIRS, type ReconcileSkillEntry } from "./skills.js";

export interface SkillAdoptionCommandOptions {
  message: SkillAdoptionMessage;
  runnerId: string;
  home: string;
  dataDir: string;
  agents: AgentDefinition[];
  snapshots: MachineSkillSnapshots;
  desired: ReconcileSkillEntry[] | null;
  acquireProviderHomeLease: () => void;
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
export function handleSkillAdoption(options: SkillAdoptionCommandOptions): SkillAdoptionResultMessage {
  const { message, runnerId, agents } = options;
  if (message.runnerId !== runnerId || message.confirmation !== "explicit") {
    return rejected(message, runnerId, "Adoption requires an explicitly confirmed command for this runner.");
  }
  const candidate = options.snapshots.resolveCandidate(message.candidate);
  if (!candidate) return rejected(message, runnerId, "The machine discovery expired or changed. Discover it again.");
  const desired = options.desired?.find((entry) =>
    entry.name === candidate.name && entry.versionDigest === message.digest);
  if (!desired) return rejected(message, runnerId, "The approved skill version is no longer assigned to this machine.");

  const readers = agents.filter((agent) => {
    if (agent.id === "conductor" || (agent.context?.kind ?? "native") !== "native") return false;
    const directory = SKILL_DIRS[agent.driver ?? "acp"];
    return directory && (candidate.sourceDirectory === ".agents/skills" || directory === candidate.sourceDirectory);
  });
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
    const current = options.desired?.find((entry) => entry.name === candidate.name);
    if (!current || current.versionDigest !== message.digest) throw new Error();
    const currentTargets = current.targets.filter((target) => readers.some((reader) => reader.id === target.agentId));
    if (!currentTargets.length || currentTargets.some((target) => target.invocation !== "agent")) throw new Error();
    const currentShared = readers.some((reader) => !currentTargets.some((target) => target.agentId === reader.id));
    if (currentShared && message.acceptSharedImpact !== true) throw new Error();
    return undefined;
  };
  const result = adoptMachineSkill({
    home: options.home,
    dataDir: options.dataDir,
    agents,
    candidate,
    digest: message.digest,
    acquireProviderHomeLease: () => { options.acquireProviderHomeLease(); return undefined; },
    assertAuthorized: stillAuthorized,
  });
  return { type: "skill_adoption_result", runnerId, requestId: message.requestId, ...result };
}
