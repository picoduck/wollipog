import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { validSkillName, type AgentDefinition, type MachineSkillCandidate } from "@wollipog/protocol";
import { runContextCommand } from "./context-command.js";
import type { SkillAdoptionResult } from "./skill-adoption.js";
import { parseRecoveryInspection, type RecoveryDirectoryFacts } from "./skill-adoption-platform.js";
import { SKILL_DIRS } from "./skills.js";
import { validWslDistroName } from "./wsl-context.js";
import { bootstrapWslSkillsHelper, type WslRun } from "./wsl-skills.js";

const REJECTED = "Adoption authorization, source or stored version could not be validated. No source directory was replaced.";
const RECOVERY = "Adoption stopped. Inspect the private journal and preserved original; no automatic restore or cleanup was attempted.";
const UNCERTAIN = "The WSL helper returned no output, so the adoption outcome is unknown. Inspect recovery before retrying; no automatic restore or cleanup was attempted.";
const OWNER = /^[0-9a-f]{64}$/u;

/** Runner-owned inputs for the in-distro helper. The helper leases the distro HOME itself, exactly
 * like WSL reconciliation, because the native provider-home lease cannot own a Linux home. */
export interface WslAdoptionEnvironment {
  ownerHash: string;
  dataDir: string;
  run?: WslRun;
  /** Test seam; production translates the canonical native store with wslpath. */
  storeRoot?: (distro: string) => Promise<string>;
}

/** Harness directories an agent in this distro reads; `.agents/skills` is always canonical. */
export function wslAdoptionDirectories(agents: AgentDefinition[], distro: string): string[] {
  return [...new Set([".agents/skills", ...agents.flatMap((agent) => {
    const directory = SKILL_DIRS[agent.driver ?? "acp"];
    return agent.context?.kind === "wsl" && agent.context.distro === distro && directory ? [directory] : [];
  })])];
}

/** Every distro with an agent that reads a harness directory. */
export function wslAdoptionDistros(agents: AgentDefinition[]): string[] {
  return [...new Set(agents.flatMap((agent) => agent.context?.kind === "wsl" && validWslDistroName(agent.context.distro) &&
    SKILL_DIRS[agent.driver ?? "acp"] ? [agent.context.distro] : []))];
}

/** The store as the distro sees it, named through the data directory like the native helpers, so
 * recovery still recognizes a managed link after the store itself is lost. The store below the data
 * directory contains no links, so this equals reconciliation's translated store root. */
async function translatedStore(dataDir: string, distro: string, run: WslRun): Promise<string> {
  const result = await run({ kind: "wsl", distro }, "wslpath", ["-a", realpathSync(dataDir)], {
    cwd: "/", timeoutMs: 5_000, maxBuffer: 16 * 1024,
  });
  const path = result.stdout.trim().replace(/\/+$/u, "");
  if (!path.startsWith("/") || path.length > 4096 || /[\0\r\n]/u.test(path)) throw new Error("invalid store path");
  return `${path}/skills/store`;
}

async function helper(environment: WslAdoptionEnvironment, distro: string) {
  if (!OWNER.test(environment.ownerHash) || !validWslDistroName(distro)) throw new Error("invalid WSL helper scope");
  const run = environment.run ?? runContextCommand;
  const [path, storeRoot] = await Promise.all([
    bootstrapWslSkillsHelper(distro, environment.ownerHash, run),
    environment.storeRoot ? environment.storeRoot(distro) : translatedStore(environment.dataDir, distro, run),
  ]);
  return {
    storeRoot,
    /** Returns every stdout line even when the helper exits non-zero; progress lines decide whether
     * recovery evidence may exist. */
    call: async (specification: Record<string, unknown>) => {
      try {
        const result = await run({ kind: "wsl", distro }, "python3", [path], {
          cwd: "/", timeoutMs: 120_000, maxBuffer: 4 * 1024 * 1024,
          stdin: JSON.stringify({ ...specification, ownerHash: environment.ownerHash, storeRoot }),
        });
        return { stdout: result.stdout, succeeded: true };
      } catch (error) {
        const stdout = (error as { stdout?: unknown }).stdout;
        return { stdout: typeof stdout === "string" ? stdout : "", succeeded: false };
      }
    },
  };
}

const lines = (stdout: string) => stdout.split(/\r?\n/u);

export interface WslAdoptionOptions extends WslAdoptionEnvironment {
  agents: AgentDefinition[];
  candidate: MachineSkillCandidate;
  digest: string;
  /** Required synchronous guard, checked before and after preparing the helper. */
  assertAuthorized: () => undefined;
}

/** Adopt one WSL candidate inside its distro. The helper repeats every source, store, journal, and
 * link check under its own pinned descriptors and publishes the managed link inside the distro. */
export async function adoptWslSkill(options: WslAdoptionOptions): Promise<SkillAdoptionResult> {
  const { candidate, digest } = options;
  const distro = candidate?.context?.kind === "wsl" ? candidate.context.distro : "";
  if (!candidate || !distro || !validWslDistroName(distro) || candidate.providerAccountId !== undefined ||
      !validSkillName(candidate.name) || !/^[0-9a-f]{64}$/u.test(digest) || !/^[0-9a-f]{64}$/u.test(candidate.generation) ||
      !wslAdoptionDirectories(options.agents, distro).includes(candidate.sourceDirectory)) {
    return { status: "rejected", error: "Invalid adoption source or digest." };
  }
  const authorized = () => {
    try { return options.assertAuthorized() === undefined; } catch { return false; }
  };
  if (!authorized()) return { status: "rejected", error: REJECTED };
  let prepared;
  try { prepared = await helper(options, distro); }
  catch { return { status: "rejected", error: REJECTED }; }
  if (!authorized()) return { status: "rejected", error: REJECTED };
  const operationId = randomUUID();
  const run = await prepared.call({ operation: "adopt", localSourceDirectory: candidate.sourceDirectory,
    sourceDirectory: candidate.sourceDirectory, name: candidate.name, generation: candidate.generation, digest,
    operationId });
  const output = lines(run.stdout);
  const recovery = { operationId, backupDirectory: `${candidate.sourceDirectory}/.wollipog-adoption-${operationId}` };
  if (run.succeeded && output.includes("adopted")) return { status: "adopted", ...recovery };
  if (output.includes("journal")) return { status: "recovery_required", ...recovery, error: RECOVERY };
  // The helper reports "journal" before its first mutation and prints an error record on every
  // handled failure, so only a run that returned nothing at all (for example, wsl.exe or the
  // distro dying with the output unread) cannot prove the source is untouched.
  if (run.stdout.trim() === "") return { status: "recovery_required", ...recovery, error: UNCERTAIN };
  return { status: "rejected", error: REJECTED };
}

export async function inspectWslSkillRecovery(environment: WslAdoptionEnvironment, distro: string,
  sourceDirectory: string, operationId?: string): Promise<RecoveryDirectoryFacts> {
  const prepared = await helper(environment, distro);
  const run = await prepared.call({ operation: "inspect", localSourceDirectory: sourceDirectory,
    ...(operationId ? { operationId } : {}) });
  if (!run.succeeded) throw new Error("WSL recovery inspection failed");
  return parseRecoveryInspection(JSON.parse(run.stdout));
}

export async function restoreWslSkillRecovery(environment: WslAdoptionEnvironment, distro: string, request: {
  sourceDirectory: string; operationId: string; name: string; digest: string; parentIdentity: string;
  sourceIdentity: string;
}): Promise<{ leased: boolean; restored: boolean }> {
  let prepared;
  try { prepared = await helper(environment, distro); }
  catch { return { leased: false, restored: false }; }
  const run = await prepared.call({ operation: "restore", localSourceDirectory: request.sourceDirectory,
    operationId: request.operationId, name: request.name, digest: request.digest,
    parentIdentity: request.parentIdentity, sourceIdentity: request.sourceIdentity });
  const output = lines(run.stdout);
  return { leased: output.includes("leased"), restored: run.succeeded && output.includes("restored") };
}
