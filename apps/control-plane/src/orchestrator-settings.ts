import {
  DEFAULT_ORCHESTRATOR_DEFAULTS,
  WORKFLOW_DECISION_CATEGORIES,
  type AgentCapabilities,
  type AgentModel,
  type OrchestratorCampaignOverrides,
  type OrchestratorCampaignPolicy,
  type OrchestratorDefaults,
  type OrchestratorPolicySource,
  type OrchestratorSettingsCapabilities,
  type OrchestratorSettingsView,
} from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";

function identifier(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value === value.trim() && !/[\0-\x1f\x7f]/u.test(value);
}

export function parseOrchestratorDefaults(value: unknown): OrchestratorDefaults | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Partial<OrchestratorDefaults>;
  if (Object.keys(input).some((key) => !["behavior", "delegation"].includes(key))) return null;
  const behavior = input.behavior;
  const delegation = input.delegation;
  if (!behavior || typeof behavior !== "object" || Array.isArray(behavior) ||
      !delegation || typeof delegation !== "object" || Array.isArray(delegation)) return null;
  if (Object.keys(behavior).some((key) => ![
    "childModel", "childEffort", "maximumConcurrentChildren", "followUps", "completion",
  ].includes(key)) || Object.keys(delegation).some((key) => !["parentControl", "decisions"].includes(key))) return null;
  if ((behavior.childModel !== null && !identifier(behavior.childModel)) ||
      (behavior.childEffort !== null && !identifier(behavior.childEffort, 64)) ||
      !Number.isSafeInteger(behavior.maximumConcurrentChildren) ||
      (behavior.maximumConcurrentChildren as number) < 0 ||
      (behavior.maximumConcurrentChildren as number) > 64 ||
      (behavior.followUps !== "recommend_only" && behavior.followUps !== "execute_approved") ||
      (behavior.completion !== "retain" && behavior.completion !== "stop_and_archive") ||
      (delegation.parentControl !== "off" && delegation.parentControl !== "questions" &&
        delegation.parentControl !== "questions_and_approvals")) return null;
  const decisions = delegation.decisions as Record<string, unknown> | undefined;
  if (!decisions || Array.isArray(decisions) || Object.keys(decisions).length !== WORKFLOW_DECISION_CATEGORIES.length ||
      !WORKFLOW_DECISION_CATEGORIES.every((category) =>
        decisions[category] === "human" || decisions[category] === "orchestrator")) return null;
  return {
    behavior: {
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
  };
}

export function parseOrchestratorOverrides(value: unknown): OrchestratorCampaignOverrides | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as OrchestratorCampaignOverrides;
  if (Object.keys(input).some((key) => !["behavior", "delegation"].includes(key))) return null;
  if (input.behavior !== undefined && (!input.behavior || typeof input.behavior !== "object" || Array.isArray(input.behavior))) {
    return null;
  }
  if (input.delegation !== undefined && (!input.delegation || typeof input.delegation !== "object" || Array.isArray(input.delegation))) {
    return null;
  }
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
  };
  if (!parseOrchestratorDefaults(complete)) return null;
  if (input.behavior && Object.keys(input.behavior).some((key) => ![
    "childModel", "childEffort", "maximumConcurrentChildren", "followUps", "completion",
  ].includes(key))) return null;
  if (input.delegation && Object.keys(input.delegation).some((key) => !["parentControl", "decisions"].includes(key))) return null;
  if (input.delegation?.decisions && Object.keys(input.delegation.decisions).some((key) =>
    !WORKFLOW_DECISION_CATEGORIES.includes(key as (typeof WORKFLOW_DECISION_CATEGORIES)[number]))) return null;
  return input;
}

function installationSupportsBehavior(capabilities: AgentCapabilities, defaults: OrchestratorDefaults["behavior"]): boolean {
  const visible = capabilities.models.filter((model) => model.id !== "default" && !model.hidden);
  const model = defaults.childModel ? visible.find((candidate) => candidate.id === defaults.childModel) : undefined;
  if (defaults.childModel && !model) return false;
  if (!defaults.childEffort) return true;
  const effort = defaults.childEffort;
  if (model) return (model.efforts?.length ? model.efforts : capabilities.effortLevels).includes(effort);
  return capabilities.effortLevels.includes(effort) ||
    visible.some((candidate) => candidate.efforts?.includes(effort));
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
  const behaviorSources = Object.fromEntries(
    (Object.keys(defaults.behavior) as Array<keyof OrchestratorDefaults["behavior"]>).map((key) => [
      key,
      Object.hasOwn(overrides.behavior ?? {}, key) ? "session_override" : baseSource,
    ]),
  ) as OrchestratorCampaignPolicy["sources"]["behavior"];
  return {
    version: 1,
    behavior,
    delegation: {
      parentControl: overrides.delegation?.parentControl ?? defaults.delegation.parentControl,
      decisions,
    },
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
    },
  };
}

export class OrchestratorSettings {
  constructor(private readonly db: ControlPlaneDb) {}

  private capabilities(principal: HumanPrincipal, defaults: OrchestratorDefaults): OrchestratorSettingsCapabilities {
    const installations = this.db.listRunnersForPrincipal(principal).filter((runner) => runner.status === "online").flatMap((runner) =>
      runner.agents.filter((agent) => agent.id !== "conductor" && agent.available !== false && agent.capabilities)
        .map((agent) => agent.capabilities!),
    );
    const models = mergeModels(installations);
    const effortLevels = [...new Set(installations.flatMap((capabilities) => [
      ...capabilities.effortLevels,
      ...capabilities.models.flatMap((model) => model.efforts ?? []),
    ]))].sort();
    const supportedPairs = installations.flatMap((capabilities) =>
      capabilities.models.filter((model) => model.id !== "default" && !model.hidden).map((model) => ({
        modelId: model.id,
        effortLevels: [...new Set(model.efforts?.length ? model.efforts : capabilities.effortLevels)].sort(),
      })),
    );
    const compatibleInstallations = installations.filter((capabilities) =>
      installationSupportsBehavior(capabilities, defaults.behavior)).length;
    const fixed = defaults.behavior.childModel !== null || defaults.behavior.childEffort !== null;
    const status = installations.length > 0 && (!fixed || compatibleInstallations > 0)
      ? "available" as const
      : "unavailable" as const;
    return {
      models,
      effortLevels,
      supportedPairs,
      installations: installations.length,
      compatibleInstallations,
      status,
      ...(status === "unavailable" ? {
        reason: installations.length === 0
          ? "No current Agent Harness installation advertises child model and effort capabilities. Connect or update a runner, then retry."
          : "The saved fixed child model and effort are not supported together by a current installation. Choose Automatic or another advertised combination.",
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
    if ((defaults.behavior.childModel !== null || defaults.behavior.childEffort !== null) &&
        capabilities.compatibleInstallations === 0) {
      throw new OrchestratorSettingsUnavailableError(capabilities.reason ?? "The fixed child model and effort are unavailable.");
    }
    this.db.setOrchestratorDefaults(principal.userId, defaults, now);
    return this.view(principal);
  }
}

export class OrchestratorSettingsInputError extends Error {}
export class OrchestratorSettingsUnavailableError extends Error {}
