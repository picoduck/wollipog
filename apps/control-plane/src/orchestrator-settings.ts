import {
  DEFAULT_ORCHESTRATOR_DEFAULTS,
  WORKFLOW_DECISION_CATEGORIES,
  builtInAgentHarnessName,
  canonicalAgentHarnessIdentity,
  exactAgentHarnessIdentityKey,
  isRestartOnlyCodexExec,
  modelResolutionDrift,
  resolveAgentHarnessRow,
  type AgentCapabilities,
  type AgentHarnessIdentity,
  type AgentModel,
  type OrchestratorCampaignOverrides,
  type OrchestratorCampaignPolicy,
  type OrchestratorChildHarnessAgent,
  type OrchestratorChildModelMachine,
  type OrchestratorDefaults,
  type OrchestratorExecutionDefaults,
  type OrchestratorPolicySource,
  type OrchestratorSettingsCapabilities,
  type OrchestratorHarnessCapability,
  type OrchestratorSettingsView,
  type RunnerView,
} from "@wollipog/protocol";
import {
  agentHarnessIdentityFor,
  agentHarnessIdentityKey,
  parseAgentHarnessIdentity,
} from "./agent-harness-defaults.js";
import type { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";

function identifier(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value === value.trim() && !/[\0-\x1f\x7f]/u.test(value);
}

/** Every execution policy field, in one place, so the parser, the override allowlist, and the
 * provenance map cannot drift apart when another policy is added. */
const EXECUTION_KEYS = ["strictProjectIsolation", "integrationIsolation"] as const;

export function parseOrchestratorDefaults(value: unknown): OrchestratorDefaults | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Partial<OrchestratorDefaults>;
  if (Object.keys(input).some((key) => !["behavior", "delegation", "execution"].includes(key))) return null;
  const behavior = input.behavior;
  const delegation = input.delegation;
  const execution = input.execution;
  if (!behavior || typeof behavior !== "object" || Array.isArray(behavior) ||
      !delegation || typeof delegation !== "object" || Array.isArray(delegation) ||
      !execution || typeof execution !== "object" || Array.isArray(execution)) return null;
  if (Object.keys(behavior).some((key) => ![
    "childHarness", "childModel", "childEffort", "maximumConcurrentChildren", "followUps", "completion",
  ].includes(key)) || Object.keys(delegation).some((key) => !["parentControl", "decisions"].includes(key))) return null;
  if (!Object.hasOwn(behavior, "childHarness")) return null;
  const parsedHarness = behavior.childHarness === null
    ? null
    : parseAgentHarnessIdentity(behavior.childHarness);
  if (behavior.childHarness !== null && !parsedHarness) return null;
  const childHarness = parsedHarness && canonicalAgentHarnessIdentity(parsedHarness);
  if ((behavior.childModel !== null && !identifier(behavior.childModel)) ||
      (behavior.childEffort !== null && !identifier(behavior.childEffort, 64)) ||
      !Number.isSafeInteger(behavior.maximumConcurrentChildren) ||
      (behavior.maximumConcurrentChildren as number) < 0 ||
      (behavior.maximumConcurrentChildren as number) > 64 ||
      (behavior.followUps !== "recommend_only" && behavior.followUps !== "execute_approved") ||
      (behavior.completion !== "retain" && behavior.completion !== "stop_and_archive") ||
      (delegation.parentControl !== "off" && delegation.parentControl !== "questions" &&
        delegation.parentControl !== "questions_and_approvals") ||
      Object.keys(execution).length !== EXECUTION_KEYS.length ||
      typeof execution.strictProjectIsolation !== "boolean" ||
      typeof execution.integrationIsolation !== "boolean") return null;
  const decisions = delegation.decisions as Record<string, unknown> | undefined;
  if (!decisions || Array.isArray(decisions) || Object.keys(decisions).length !== WORKFLOW_DECISION_CATEGORIES.length ||
      !WORKFLOW_DECISION_CATEGORIES.every((category) =>
        decisions[category] === "human" || decisions[category] === "orchestrator")) return null;
  return {
    behavior: {
      childHarness,
      childModel: behavior.childModel,
      childEffort: behavior.childEffort,
      maximumConcurrentChildren: behavior.maximumConcurrentChildren as number,
      followUps: behavior.followUps,
      completion: behavior.completion,
    },
    delegation: {
      parentControl: delegation.parentControl,
      decisions: decisions as OrchestratorDefaults["delegation"]["decisions"],
    },
    execution: {
      strictProjectIsolation: execution.strictProjectIsolation,
      integrationIsolation: execution.integrationIsolation,
    },
  };
}

export function parseOrchestratorOverrides(value: unknown): OrchestratorCampaignOverrides | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as OrchestratorCampaignOverrides;
  if (Object.keys(input).some((key) => !["behavior", "delegation", "execution"].includes(key))) return null;
  if (input.behavior !== undefined && (!input.behavior || typeof input.behavior !== "object" || Array.isArray(input.behavior))) {
    return null;
  }
  if (input.delegation !== undefined && (!input.delegation || typeof input.delegation !== "object" || Array.isArray(input.delegation))) {
    return null;
  }
  if (input.execution !== undefined && (!input.execution || typeof input.execution !== "object" ||
      Array.isArray(input.execution))) return null;
  if (input.delegation?.decisions !== undefined &&
      (!input.delegation.decisions || typeof input.delegation.decisions !== "object" || Array.isArray(input.delegation.decisions))) {
    return null;
  }
  const complete: OrchestratorDefaults = {
    behavior: { ...DEFAULT_ORCHESTRATOR_DEFAULTS.behavior, ...(input.behavior ?? {}) },
    delegation: {
      parentControl: input.delegation?.parentControl ?? DEFAULT_ORCHESTRATOR_DEFAULTS.delegation.parentControl,
      decisions: { ...DEFAULT_ORCHESTRATOR_DEFAULTS.delegation.decisions, ...(input.delegation?.decisions ?? {}) },
    },
    execution: { ...DEFAULT_ORCHESTRATOR_DEFAULTS.execution, ...(input.execution ?? {}) },
  };
  const normalized = parseOrchestratorDefaults(complete);
  if (!normalized) return null;
  if (input.behavior && Object.keys(input.behavior).some((key) => ![
    "childHarness", "childModel", "childEffort", "maximumConcurrentChildren", "followUps", "completion",
  ].includes(key))) return null;
  if (input.delegation && Object.keys(input.delegation).some((key) => !["parentControl", "decisions"].includes(key))) return null;
  if (input.delegation?.decisions && Object.keys(input.delegation.decisions).some((key) =>
    !WORKFLOW_DECISION_CATEGORIES.includes(key as (typeof WORKFLOW_DECISION_CATEGORIES)[number]))) return null;
  if (input.execution && Object.keys(input.execution).some((key) =>
    !(EXECUTION_KEYS as readonly string[]).includes(key))) return null;
  return {
    ...(input.behavior ? {
      behavior: {
        ...input.behavior,
        ...(Object.hasOwn(input.behavior, "childHarness")
          ? { childHarness: normalized.behavior.childHarness }
          : {}),
      },
    } : {}),
    ...(input.delegation ? { delegation: input.delegation } : {}),
    ...(input.execution ? { execution: input.execution } : {}),
  };
}

// Reasons speak of machines and Connections, the words Settings uses, never of installations or runners.
const NO_MACHINE_REASON = "No connected machine reports which models and efforts child agents can use. " +
  "Connect a machine or update Wollipog on it in Connections, then try again.";
const UNSUPPORTED_COMBINATION_REASON = "No connected machine supports this Child Harness, Child Model and " +
  "Child Effort together. Choose Automatic or another combination.";

function sameHarness(left: AgentHarnessIdentity, right: AgentHarnessIdentity): boolean {
  return agentHarnessIdentityKey(left) === agentHarnessIdentityKey(right);
}

function installationSupportsBehavior(
  installation: { identity: AgentHarnessIdentity; capabilities: AgentCapabilities },
  defaults: OrchestratorDefaults["behavior"],
): boolean {
  if (defaults.childHarness && !sameHarness(installation.identity, defaults.childHarness)) return false;
  const capabilities = installation.capabilities;
  const visible = capabilities.models.filter((model) => model.id !== "default" && !model.hidden);
  const model = defaults.childModel ? visible.find((candidate) => candidate.id === defaults.childModel) : undefined;
  if (defaults.childModel && !model) return false;
  if (!defaults.childEffort) return true;
  const effort = defaults.childEffort;
  if (model) return (model.efforts?.length ? model.efforts : capabilities.effortLevels).includes(effort);
  return capabilities.effortLevels.includes(effort) ||
    visible.some((candidate) => candidate.efforts?.includes(effort));
}

function harnessCatalogs(installations: Array<{
  runnerId: string;
  identity: AgentHarnessIdentity;
  name: string;
  capabilities: AgentCapabilities;
}>): OrchestratorHarnessCapability[] {
  const grouped = new Map<string, OrchestratorHarnessCapability>();
  const machines = new Map<string, Set<string>>();
  for (const installation of installations) {
    const builtInName = builtInAgentHarnessName(installation.identity.driver);
    const key = agentHarnessIdentityKey(installation.identity);
    const visible = installation.capabilities.models.filter((model) => model.id !== "default" && !model.hidden);
    const pairs = visible.map((model) => ({
      modelId: model.id,
      effortLevels: [...new Set(model.efforts?.length
        ? model.efforts
        : installation.capabilities.effortLevels)].sort(),
    }));
    const current = grouped.get(key);
    machines.set(key, (machines.get(key) ?? new Set()).add(installation.runnerId));
    if (!current) {
      grouped.set(key, {
        ...canonicalAgentHarnessIdentity(installation.identity),
        name: builtInName ?? installation.name,
        models: mergeModels([installation.capabilities]),
        effortLevels: [...new Set([
          ...installation.capabilities.effortLevels,
          ...visible.flatMap((model) => model.efforts ?? []),
        ])].sort(),
        supportedPairs: pairs,
        installations: 1,
      });
      continue;
    }
    current.installations += 1;
    if (!builtInName && installation.name.localeCompare(current.name) < 0) current.name = installation.name;
    current.models = mergeModels([
      { ...installation.capabilities, models: current.models },
      installation.capabilities,
    ]);
    current.effortLevels = [...new Set([
      ...current.effortLevels,
      ...installation.capabilities.effortLevels,
      ...visible.flatMap((model) => model.efforts ?? []),
    ])].sort();
    current.supportedPairs.push(...pairs);
  }
  for (const [key, harness] of grouped) harness.machines = machines.get(key)!.size;
  return [...grouped.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || agentHarnessIdentityKey(left).localeCompare(agentHarnessIdentityKey(right)));
}

function mergeModels(installations: AgentCapabilities[]): AgentModel[] {
  const models = new Map<string, AgentModel>();
  for (const capabilities of installations) {
    for (const model of capabilities.models) {
      if (model.id === "default" || model.hidden) continue;
      const current = models.get(model.id);
      models.set(model.id, current ? {
        ...current,
        efforts: [...new Set([...(current.efforts ?? []), ...(model.efforts ?? [])])],
      } : model);
    }
  }
  return [...models.values()].sort((left, right) =>
    (left.displayName ?? left.id).localeCompare(right.displayName ?? right.id) || left.id.localeCompare(right.id));
}

export function resolveOrchestratorCampaignPolicy(
  defaults: OrchestratorDefaults,
  baseSource: Extract<OrchestratorPolicySource,
    "system_default" | "user_default" | "legacy_session" | "active_campaign">,
  overrides: OrchestratorCampaignOverrides = {},
): OrchestratorCampaignPolicy {
  const behavior = { ...defaults.behavior, ...(overrides.behavior ?? {}) };
  const decisions = { ...defaults.delegation.decisions, ...(overrides.delegation?.decisions ?? {}) };
  const execution = { ...defaults.execution, ...(overrides.execution ?? {}) };
  const behaviorSources = Object.fromEntries(
    (Object.keys(defaults.behavior) as Array<keyof OrchestratorDefaults["behavior"]>).map((key) => [
      key,
      Object.hasOwn(overrides.behavior ?? {}, key) ? "session_override" : baseSource,
    ]),
  ) as OrchestratorCampaignPolicy["sources"]["behavior"];
  const executionSources = Object.fromEntries(EXECUTION_KEYS.map((key) => [
    key,
    Object.hasOwn(overrides.execution ?? {}, key) ? "session_override" : baseSource,
  ])) as OrchestratorCampaignPolicy["sources"]["execution"];
  // Strict Project Isolation removes every integration by construction, so the stored policy names
  // `true` and attributes it to the boundary that implied it rather than to a default nobody chose.
  if (impliesIntegrationIsolation(execution) && !execution.integrationIsolation) {
    execution.integrationIsolation = true;
    executionSources.integrationIsolation = executionSources.strictProjectIsolation;
  }
  return {
    version: 1,
    childHarnessMatch: "harness",
    behavior,
    delegation: {
      parentControl: overrides.delegation?.parentControl ?? defaults.delegation.parentControl,
      decisions,
    },
    execution,
    sources: {
      behavior: behaviorSources,
      delegation: {
        parentControl: Object.hasOwn(overrides.delegation ?? {}, "parentControl")
          ? "session_override"
          : baseSource,
        decisions: Object.fromEntries(WORKFLOW_DECISION_CATEGORIES.map((category) => [
          category,
          Object.hasOwn(overrides.delegation?.decisions ?? {}, category) ? "session_override" : baseSource,
        ])) as OrchestratorCampaignPolicy["sources"]["delegation"]["decisions"],
      },
      execution: executionSources,
    },
  };
}

/**
 * Strict Project Isolation already launches without any user integration: its harness shapes
 * replace the whole provider surface. Record that truthfully rather than storing a `false` the
 * launch would contradict — the effective value is `true`, and its provenance is the provenance of
 * the boundary that implied it, so the interface can name where it came from.
 */
export function impliesIntegrationIsolation(
  execution: Pick<OrchestratorExecutionDefaults, "strictProjectIsolation">,
): boolean {
  return execution.strictProjectIsolation;
}

export class OrchestratorSettings {
  constructor(private readonly db: ControlPlaneDb) {}

  private capabilities(principal: HumanPrincipal, defaults: OrchestratorDefaults): OrchestratorSettingsCapabilities {
    const onlineRunners = this.db.listRunnersForPrincipal(principal).filter((runner) => runner.status === "online");
    const installations = onlineRunners.flatMap((runner) =>
      // A saved child harness on the restart-only exec row still renders through the stale entry below.
      runner.agents.filter((agent) => agent.available === true && agent.capabilities && !isRestartOnlyCodexExec(agent))
        .map((agent) => ({
          runnerId: runner.runnerId,
          machineName: machineName(runner),
          launchable: agent.installation?.selection !== "other" && agent.harnessSelectionBlocked !== true,
          identity: agentHarnessIdentityFor(agent),
          name: agent.name,
          capabilities: agent.capabilities!,
        })),
    );
    const harnesses = harnessCatalogs(installations);
    if (defaults.behavior.childHarness && !harnesses.some((harness) =>
      sameHarness(harness, defaults.behavior.childHarness!))) {
      harnesses.push({
        ...defaults.behavior.childHarness,
        name: builtInAgentHarnessName(defaults.behavior.childHarness.driver) ?? defaults.behavior.childHarness.agentId,
        models: [], effortLevels: [], supportedPairs: [], installations: 0, machines: 0,
      });
    }
    const models = mergeModels(installations.map((installation) => installation.capabilities));
    const effortLevels = [...new Set(installations.flatMap((capabilities) => [
      ...capabilities.capabilities.effortLevels,
      ...capabilities.capabilities.models.flatMap((model) => model.efforts ?? []),
    ]))].sort();
    const supportedPairs = installations.flatMap((capabilities) =>
      capabilities.capabilities.models.filter((model) => model.id !== "default" && !model.hidden).map((model) => ({
        modelId: model.id,
        effortLevels: [...new Set(model.efforts?.length ? model.efforts : capabilities.capabilities.effortLevels)].sort(),
      })),
    );
    const compatibleInstallations = installations.filter((capabilities) =>
      installationSupportsBehavior(capabilities, defaults.behavior)).length;
    const fixed = defaults.behavior.childHarness !== null || defaults.behavior.childModel !== null ||
      defaults.behavior.childEffort !== null;
    const status = installations.length > 0 && (!fixed || compatibleInstallations > 0)
      ? "available" as const
      : "unavailable" as const;
    // Per Machine, not per installation: a Machine can run children when any of its rows can (#3248).
    // Every connected Machine counts, including one with no usable row, as get_campaign does.
    const machines = new Map(onlineRunners.map((runner) => [runner.runnerId, { name: machineName(runner), supported: false }]));
    for (const installation of installations) {
      const machine = machines.get(installation.runnerId) ?? { name: installation.machineName, supported: false };
      // A row the Machine's installation choice excludes cannot launch, so it supports nothing.
      machine.supported ||= installation.launchable && installationSupportsBehavior(installation, defaults.behavior);
      machines.set(installation.runnerId, machine);
    }
    const unsupported = [...machines.values()].filter((machine) => !machine.supported).map((machine) => machine.name).sort();
    const childModelDrift = defaults.behavior.childModel ? modelResolutionDrift(installations
      .filter((installation) => installation.launchable &&
        (!defaults.behavior.childHarness || sameHarness(installation.identity, defaults.behavior.childHarness)))
      .map((installation) => ({ machineName: installation.machineName, models: installation.capabilities.models })),
    defaults.behavior.childModel) : null;
    return {
      harnesses,
      models,
      effortLevels,
      supportedPairs,
      installations: installations.length,
      compatibleInstallations,
      status,
      ...(status === "unavailable" ? {
        reason: installations.length === 0 ? NO_MACHINE_REASON : UNSUPPORTED_COMBINATION_REASON,
      } : {}),
      ...(fixed && installations.length > 0 ? { machineSupport: {
        supported: machines.size - unsupported.length,
        total: machines.size,
        unsupportedMachines: unsupported,
      } } : {}),
      ...(childModelDrift ? { childModelDrift } : {}),
    };
  }

  view(principal: HumanPrincipal): OrchestratorSettingsView {
    const record = this.db.getOrchestratorDefaults(principal.userId);
    const defaults = record?.defaults ?? structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS);
    return {
      defaults,
      source: record ? "user_default" : "system_default",
      capabilities: this.capabilities(principal, defaults),
    };
  }

  compatibilityError(principal: HumanPrincipal, defaults: OrchestratorDefaults): string | null {
    const capabilities = this.capabilities(principal, defaults);
    return capabilities.status === "unavailable"
      ? capabilities.reason ?? UNSUPPORTED_COMBINATION_REASON
      : null;
  }

  update(principal: HumanPrincipal, request: unknown, now = Date.now()): OrchestratorSettingsView {
    const defaults = parseOrchestratorDefaults((request as { defaults?: unknown } | null)?.defaults);
    if (!defaults) throw new OrchestratorSettingsInputError("a complete valid Orchestrator default is required");
    const capabilities = this.capabilities(principal, defaults);
    if ((defaults.behavior.childHarness !== null || defaults.behavior.childModel !== null ||
        defaults.behavior.childEffort !== null) &&
        capabilities.compatibleInstallations === 0) {
      throw new OrchestratorSettingsUnavailableError(capabilities.reason ?? UNSUPPORTED_COMBINATION_REASON);
    }
    this.db.setOrchestratorDefaults(principal.userId, defaults, now);
    return this.view(principal);
  }
}

export class OrchestratorSettingsInputError extends Error {}
export class OrchestratorSettingsUnavailableError extends Error {}

/** Whether a child launch satisfies the campaign's fixed Child Harness. Campaigns created before
 * #3247 carry no match marker and keep enforcing the exact Machine-local agent id. */
export function childHarnessAdmits(
  policy: Pick<OrchestratorCampaignPolicy, "behavior" | "childHarnessMatch">,
  launch: AgentHarnessIdentity,
): boolean {
  const fixed = policy.behavior.childHarness;
  if (!fixed) return true;
  return policy.childHarnessMatch === "harness"
    ? agentHarnessIdentityKey(launch) === agentHarnessIdentityKey(fixed)
    : exactAgentHarnessIdentityKey(launch) === exactAgentHarnessIdentityKey(fixed);
}

export function childHarnessRefusal(policy: Pick<OrchestratorCampaignPolicy, "behavior" | "childHarnessMatch">): string {
  const fixed = policy.behavior.childHarness!;
  const context = fixed.context.kind === "wsl" ? `WSL ${fixed.context.distro}` : "native";
  const name = builtInAgentHarnessName(fixed.driver);
  return policy.childHarnessMatch === "harness" && name
    ? `child harness is fixed by campaign policy at ${name} (${context}); use the agent get_campaign lists for this machine in childHarnessAgents`
    : `child harness is fixed by campaign policy at ${fixed.agentId} (${fixed.driver}, ${context})`;
}

/** The agent each online Machine uses for a fixed Child Harness, so an Orchestrator never has to
 * guess a Machine-local agent id from the policy (#3247). Absent while the harness is Automatic. */
export function childHarnessAgents(
  policy: Pick<OrchestratorCampaignPolicy, "behavior" | "childHarnessMatch">,
  runners: readonly RunnerView[],
): OrchestratorChildHarnessAgent[] | undefined {
  const fixed = policy.behavior.childHarness;
  if (!fixed) return undefined;
  return runners.filter((runner) => runner.status === "online").map((runner) => {
    // A pre-#3247 campaign admits only its exact agent id, so look that row up rather than the
    // harness's preferred row on the Machine.
    const agent = policy.childHarnessMatch === "harness"
      ? resolveAgentHarnessRow(runner.agents, fixed)
      : resolveAgentHarnessRow(runner.agents.filter((candidate) => candidate.id === fixed.agentId), fixed);
    return {
      runnerId: runner.runnerId,
      machineName: machineName(runner),
      agentId: agent && childHarnessAdmits(policy, agentHarnessIdentityFor(agent)) ? agent.id : null,
    };
  }).sort((left, right) => left.machineName.localeCompare(right.machineName) || left.runnerId.localeCompare(right.runnerId));
}

function machineName(runner: Pick<RunnerView, "displayName" | "hostname" | "runnerId">): string {
  return runner.displayName || runner.hostname || runner.runnerId;
}

/** Whether each online Machine can run children with the campaign's fixed Child Model and Effort,
 * through a row its Child Harness admits (#3248). Absent while both are Automatic. */
export function childModelMachines(
  policy: Pick<OrchestratorCampaignPolicy, "behavior" | "childHarnessMatch">,
  runners: readonly RunnerView[],
): OrchestratorChildModelMachine[] | undefined {
  if (policy.behavior.childModel === null && policy.behavior.childEffort === null) return undefined;
  // The harness is checked by childHarnessAdmits, which knows how this campaign matches it.
  const pair = { ...policy.behavior, childHarness: null };
  return runners.filter((runner) => runner.status === "online").map((runner) => ({
    runnerId: runner.runnerId,
    machineName: machineName(runner),
    supported: runner.agents.some((agent) => {
      // A row the Machine's installation choice excludes cannot launch (getAgentLaunch refuses it).
      if (agent.available !== true || !agent.capabilities || isRestartOnlyCodexExec(agent) ||
          agent.installation?.selection === "other" || agent.harnessSelectionBlocked === true) return false;
      const identity = agentHarnessIdentityFor(agent);
      return childHarnessAdmits(policy, identity) &&
        installationSupportsBehavior({ identity, capabilities: agent.capabilities }, pair);
    }),
  })).sort((left, right) => left.machineName.localeCompare(right.machineName) || left.runnerId.localeCompare(right.runnerId));
}
