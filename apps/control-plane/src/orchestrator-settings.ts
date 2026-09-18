import {
  DEFAULT_ORCHESTRATOR_DEFAULTS,
  WORKFLOW_DECISION_CATEGORIES,
  type AgentCapabilities,
  type AgentHarnessIdentity,
  type AgentModel,
  type OrchestratorCampaignOverrides,
  type OrchestratorCampaignPolicy,
  type OrchestratorDefaults,
  type OrchestratorExecutionDefaults,
  type OrchestratorPolicySource,
  type OrchestratorSettingsCapabilities,
  type OrchestratorHarnessCapability,
  type OrchestratorSettingsView,
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
  const childHarness = behavior.childHarness === null
    ? null
    : parseAgentHarnessIdentity(behavior.childHarness);
  if (behavior.childHarness !== null && !childHarness) return null;
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
  identity: AgentHarnessIdentity;
  name: string;
  capabilities: AgentCapabilities;
}>): OrchestratorHarnessCapability[] {
  const grouped = new Map<string, OrchestratorHarnessCapability>();
  for (const installation of installations) {
    const key = agentHarnessIdentityKey(installation.identity);
    const visible = installation.capabilities.models.filter((model) => model.id !== "default" && !model.hidden);
    const pairs = visible.map((model) => ({
      modelId: model.id,
      effortLevels: [...new Set(model.efforts?.length
        ? model.efforts
        : installation.capabilities.effortLevels)].sort(),
    }));
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, {
        ...installation.identity,
        name: installation.name,
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
    if (installation.name.localeCompare(current.name) < 0) current.name = installation.name;
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
    const installations = this.db.listRunnersForPrincipal(principal).filter((runner) => runner.status === "online").flatMap((runner) =>
      runner.agents.filter((agent) => agent.available === true && agent.capabilities)
        .map((agent) => ({
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
        name: defaults.behavior.childHarness.agentId,
        models: [], effortLevels: [], supportedPairs: [], installations: 0,
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
    return {
      harnesses,
      models,
      effortLevels,
      supportedPairs,
      installations: installations.length,
      compatibleInstallations,
      status,
      ...(status === "unavailable" ? {
        reason: installations.length === 0
          ? "No current Agent Harness installation advertises child model and effort capabilities. Connect or update a runner, then retry."
          : "The saved Child Harness, Child Model, and Child Effort are not supported together by a current installation. Choose Automatic or another advertised combination.",
      } : {}),
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
      ? capabilities.reason ?? "No current installation supports this campaign policy."
      : null;
  }

  update(principal: HumanPrincipal, request: unknown, now = Date.now()): OrchestratorSettingsView {
    const defaults = parseOrchestratorDefaults((request as { defaults?: unknown } | null)?.defaults);
    if (!defaults) throw new OrchestratorSettingsInputError("a complete valid Orchestrator default is required");
    const capabilities = this.capabilities(principal, defaults);
    if ((defaults.behavior.childHarness !== null || defaults.behavior.childModel !== null ||
        defaults.behavior.childEffort !== null) &&
        capabilities.compatibleInstallations === 0) {
      throw new OrchestratorSettingsUnavailableError(capabilities.reason ?? "The fixed child model and effort are unavailable.");
    }
    this.db.setOrchestratorDefaults(principal.userId, defaults, now);
    return this.view(principal);
  }
}

export class OrchestratorSettingsInputError extends Error {}
export class OrchestratorSettingsUnavailableError extends Error {}
